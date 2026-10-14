// Tests for the CodePlate Claude Code plugin: run with `node --test plugin/test/`.
// Everything runs against a local fake site or file:// fixtures, never codeplate.io.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main, parseArgs } from '../scripts/codeplate.mjs';
import { extractTemplateZip, listEntries, safeSegments, ZipError } from '../scripts/lib/unzip.mjs';
import { baseUrl, filterTemplates, siteUrl } from '../scripts/lib/site.mjs';
import { describeProject, findProjectRoot, requirements, withGodot } from '../scripts/lib/project.mjs';
import { decide, hookOutput, isSecretEnv } from '../scripts/guard.mjs';
import { removeTempDirs, capture, fakeSite, GOOD_GRANT, tempDir, templateFiles, templateZip, writeTree, zip, sha256 } from './helpers.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(PLUGIN, '..');
after(removeTempDirs);

async function run(argv, { env = {}, cwd, fetchImpl } = {}) {
  const out = capture();
  const err = capture();
  const code = await main(argv, { out: out.stream, err: err.stream, env: { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot, ...env }, cwd: cwd ?? tempDir(), ...(fetchImpl ? { fetchImpl } : {}) });
  return { code, out: out.text, err: err.text };
}

// ---------------------------------------------------------------- zip reader

describe('unzip', () => {
  test('rejects names that could escape the folder', () => {
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', 'a/./b', 'a/b:c']) {
      assert.throws(() => safeSegments(bad), ZipError, bad);
    }
    assert.deepEqual(safeSegments('id/docs/'), ['id', 'docs']);
  });

  test('extracts under one top folder and drops it', () => {
    const dest = tempDir();
    const { top, files } = extractTemplateZip(templateZip({ id: 't1' }), dest);
    assert.equal(top, 't1');
    assert.ok(files.includes('docs/project.md'));
    assert.match(readFileSync(join(dest, 'codeplate.json'), 'utf8'), /"id": "t1"/);
  });

  test('refuses zip-slip entries before writing anything', () => {
    const dest = tempDir();
    const evil = zip([{ name: 't1/ok.txt', data: 'ok' }, { name: 't1/../../evil.txt', data: 'x' }]);
    assert.throws(() => extractTemplateZip(evil, dest), ZipError);
    assert.deepEqual(readdirSync(dest), []);
  });

  test('refuses several top-level folders', () => {
    assert.throws(() => extractTemplateZip(zip([{ name: 'a/x', data: '1' }, { name: 'b/y', data: '2' }]), tempDir()), /one top-level folder/);
  });

  test('detects a corrupted entry (CRC)', () => {
    const z = zip([{ name: 't/a.txt', data: Buffer.alloc(200, 65) }]);
    const e = listEntries(z)[0];
    const crcAt = z.length - 22 - (46 + 't/a.txt'.length) + 16;
    z.writeUInt32LE((e.crc ^ 1) >>> 0, crcAt);
    assert.throws(() => extractTemplateZip(z, tempDir()), /CRC/);
  });

  test('reads zips with a comment (Pro downloads carry one)', () => {
    const dest = tempDir();
    extractTemplateZip(templateZip({ id: 't2' }, 'CodePlate Pro License, license ID CP-0000-0000-0000'), dest);
    assert.ok(existsSync(join(dest, 'AGENTS.md')));
  });

  test("reads the repo's real packed and stamped zips", async (t) => {
    const pack = join(REPO, 'tools', 'lib', 'pack.mjs');
    const stamp = join(REPO, 'site', 'stamp.mjs');
    const fixture = join(REPO, 'tools', 'test', 'fixtures', 'fixture-game');
    if (!existsSync(pack) || !existsSync(stamp) || !existsSync(fixture)) return t.skip('not inside the CodePlate repo');
    const { packTemplate } = await import(pathToFileURL(pack).href);
    const { stampZip } = await import(pathToFileURL(stamp).href);
    const out = tempDir();
    const entry = packTemplate(fixture, out);
    const bytes = readFileSync(join(out, entry.file));
    const stamped = Buffer.from(stampZip(bytes, 'fixture-game/CODEPLATE-LICENSE.txt', 'License ID: CP-1A2B-3C4D-5E6F\n', 'CodePlate Pro License, license ID CP-1A2B-3C4D-5E6F'));
    const dest = tempDir();
    const { top, files } = extractTemplateZip(stamped, dest);
    assert.equal(top, 'fixture-game');
    assert.equal(files.length, entry.files + 1);
    assert.equal(describeProject(dest).licenseId, null, 'the fixture manifest is Free, so no Pro license ID is claimed');
    assert.match(readFileSync(join(dest, 'CODEPLATE-LICENSE.txt'), 'utf8'), /CP-1A2B-3C4D-5E6F/);
  });
});

// ---------------------------------------------------------------- site / catalog

describe('site', () => {
  test('base URL: flag, then CODEPLATE_BASE_URL, then codeplate.io', () => {
    assert.equal(baseUrl(undefined, {}).href, 'https://codeplate.io/');
    assert.equal(baseUrl(undefined, { CODEPLATE_BASE_URL: 'http://127.0.0.1:8811' }).href, 'http://127.0.0.1:8811/');
    assert.equal(baseUrl('http://localhost:1/sub', { CODEPLATE_BASE_URL: 'http://x' }).href, 'http://localhost:1/sub/');
    assert.throws(() => baseUrl('ftp://x', {}), /scheme/);
  });

  test('catalog URLs are re-rooted on the base URL', () => {
    const base = baseUrl('http://127.0.0.1:9/', {});
    assert.equal(siteUrl(base, 'https://codeplate.io/t/a/1.0.0.zip').href, 'http://127.0.0.1:9/t/a/1.0.0.zip');
    assert.equal(siteUrl(base, '/download/a/1.0.0?grant=g').href, 'http://127.0.0.1:9/download/a/1.0.0?grant=g');
  });

  test('filters by words, tier, kind and stack', () => {
    const ts = [
      { id: 'godot-match3', name: 'Match 3', summary: 'Puzzle', kind: 'game', tier: 'free', tags: ['match-3'], stack: [{ name: 'godot' }] },
      { id: 'web-saas-starter', name: 'SaaS', summary: 'Next.js SaaS', kind: 'app', tier: 'free', tags: ['saas'], stack: [{ name: 'nextjs' }] },
      { id: 'godot-idle', name: 'Idle', summary: 'Idle game', kind: 'game', tier: 'pro', tags: [], stack: [{ name: 'godot' }] },
    ];
    assert.deepEqual(filterTemplates(ts, { stack: 'Godot' }).map((t) => t.id), ['godot-match3', 'godot-idle']);
    assert.deepEqual(filterTemplates(ts, { tier: 'pro' }).map((t) => t.id), ['godot-idle']);
    assert.deepEqual(filterTemplates(ts, { query: 'next saas' }).map((t) => t.id), ['web-saas-starter']);
    assert.deepEqual(filterTemplates(ts, { kind: 'game', query: 'puzzle' }).map((t) => t.id), ['godot-match3']);
  });

  test('argument parsing', () => {
    assert.deepEqual(parseArgs(['list', 'godot', '--tier=free', '--json']), { cmd: 'list', args: ['godot'], opts: { tier: 'free', json: true } });
    assert.throws(() => parseArgs(['get', '--nope']), /unknown option/);
    assert.throws(() => parseArgs(['get', '--dir']), /needs a value/);
  });
});

// ---------------------------------------------------------------- CLI against a fake site

describe('cli', () => {
  let site;
  let env;
  before(async () => {
    site = await fakeSite();
    env = { CODEPLATE_BASE_URL: site.origin };
  });
  after(() => site.close());

  test('list shows every template with tier and stack', async () => {
    const r = await run(['list'], { env });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /fixture-free\s+Free/);
    assert.match(r.out, /fixture-pro\s+Plus/, 'a Pro template shows the cheapest plan that includes it');
    assert.doesNotMatch(r.out, /Pro subscription/);
    assert.match(r.out, /3 templates \(2 free, 1 Pro\)/);
    assert.match(r.out, new RegExp(`${site.origin}/pricing/`));
  });

  test('show names the plan a Pro template needs', async () => {
    const r = await run(['show', 'fixture-pro'], { env });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Tier:\s+Pro, Plus plan \(needs an active CodePlate plan that includes it, Plus or higher; no credit needed\)/);
  });

  test('list filters and prints JSON', async () => {
    const r = await run(['list', '--stack', 'godot', '--json'], { env });
    assert.equal(r.code, 0);
    const j = JSON.parse(r.out);
    assert.deepEqual(j.templates.map((t) => t.id), ['fixture-game']);
  });

  test('show prints details; unknown ids get suggestions', async () => {
    const r = await run(['show', 'fixture-pro'], { env });
    assert.equal(r.code, 0);
    assert.match(r.out, /Tier:\s+Pro/);
    assert.match(r.out, new RegExp(`Page:\\s+${site.origin}/t/fixture-pro/`));
    const u = await run(['show', 'fixture'], { env });
    assert.equal(u.code, 1);
    assert.match(u.err, /Did you mean: fixture-free/);
  });

  test('get <free id> downloads, verifies and installs, then points at AGENTS.md', async () => {
    const cwd = tempDir();
    const r = await run(['get', 'fixture-free', '--name', 'my-app'], { env, cwd });
    assert.equal(r.code, 0, r.err);
    const dest = join(cwd, 'my-app');
    assert.ok(existsSync(join(dest, 'AGENTS.md')));
    assert.match(r.out, /Read AGENTS.md there first/);
    assert.match(r.out, /Interview/);
    assert.match(r.out, /Built with CodePlate \(codeplate\.io\)/);
    // A second get into the same folder is refused, and nothing is overwritten.
    const again = await run(['get', 'fixture-free', '--name', 'my-app'], { env, cwd });
    assert.equal(again.code, 2);
    assert.match(again.err, /isn't empty/);
  });

  test('get refuses a zip whose SHA-256 differs from the catalog', async () => {
    const bad = await fakeSite({ tamper: true });
    try {
      const cwd = tempDir();
      const r = await run(['get', 'fixture-free'], { env: { CODEPLATE_BASE_URL: bad.origin }, cwd });
      assert.equal(r.code, 1);
      assert.match(r.err, /SHA-256 mismatch/);
      assert.equal(existsSync(join(cwd, 'fixture-free')), false);
    } finally {
      await bad.close();
    }
  });

  test('get <pro id> explains the browser steps and never asks for a password', async () => {
    const r = await run(['get', 'fixture-pro'], { env });
    assert.equal(r.code, 3);
    assert.match(r.out, new RegExp(`Open ${site.origin}/t/fixture-pro/ in their browser`));
    assert.match(r.out, /get --zip/);
    assert.match(r.out, /Never ask the user for a password/);
    assert.ok(!site.requests.some((p) => p.startsWith('/download/')), 'no download attempted without a grant');
  });

  test('get --url with a valid grant installs the Pro copy and hides the grant', async () => {
    const cwd = tempDir();
    const link = `${site.origin}/download/fixture-pro/1.0.0?grant=${encodeURIComponent(GOOD_GRANT)}`;
    const r = await run(['get', '--url', link], { env, cwd });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /CodePlate Pro License \(license ID CP-1A2B-3C4D-5E6F/);
    assert.match(r.out, /No credit needed/);
    assert.ok(!(r.out + r.err).includes(GOOD_GRANT), 'the grant is never printed');
    assert.ok(existsSync(join(cwd, 'fixture-pro', 'CODEPLATE-LICENSE.txt')));
  });

  test('get --url: expired grants, other sites and odd paths are refused', async () => {
    const expired = await run(['get', '--url', `${site.origin}/download/fixture-pro/1.0.0?grant=old`], { env });
    assert.equal(expired.code, 1);
    assert.match(expired.err, /press Download on the template page again/);
    const other = await run(['get', '--url', 'https://evil.example/download/fixture-pro/1.0.0?grant=x'], { env });
    assert.equal(other.code, 2);
    assert.match(other.err, /only links from/);
    const odd = await run(['get', '--url', `${site.origin}/catalog.json`], { env });
    assert.equal(odd.code, 2);
    const nogrant = await run(['get', '--url', `${site.origin}/download/fixture-pro/1.0.0`], { env });
    assert.equal(nogrant.code, 2);
    assert.match(nogrant.err, /no grant/);
  });

  test('get --url for a public free zip checks its hash too', async () => {
    const cwd = tempDir();
    const r = await run(['get', '--url', `${site.origin}/t/fixture-free/latest.zip`, '--name', 'x'], { env, cwd });
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(cwd, 'x', 'codeplate.json')));
  });

  test('redirects to another site are refused', async () => {
    const r = await run(['get', '--url', `${site.origin}/t/fixture-free/1.0.0.zip`], {
      env,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://example.com/x.zip' } }),
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /redirect to another site/);
  });

  test('get --zip installs a zip the user downloaded', async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'dl.zip'), site.pro);
    const r = await run(['get', '--zip', 'dl.zip', '--dir', 'projects'], { env, cwd });
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(cwd, 'projects', 'fixture-pro', 'AGENTS.md')));
    const notzip = join(cwd, 'x.zip');
    writeFileSync(notzip, '<html>');
    assert.equal((await run(['get', '--zip', notzip], { env, cwd })).code, 1);
  });

  test('--name must be a plain folder name', async () => {
    const r = await run(['get', 'fixture-free', '--name', '../up'], { env });
    assert.equal(r.code, 2);
  });

  test('a holding page instead of the catalog gives a clear error', async () => {
    const holding = await fakeSite({ holding: true });
    try {
      const r = await run(['list'], { env: { CODEPLATE_BASE_URL: holding.origin } });
      assert.equal(r.code, 1);
      assert.match(r.err, /didn't return JSON/);
    } finally {
      await holding.close();
    }
  });

  test('an unreachable site gives a clear error', async () => {
    const r = await run(['list'], { env: { CODEPLATE_BASE_URL: 'http://127.0.0.1:9' } });
    assert.equal(r.code, 1);
    assert.match(r.err, /couldn't reach/);
  });
});

describe('cli with a file:// base (offline fixtures)', () => {
  test('list and get work from a folder laid out like the site', async () => {
    const root = tempDir();
    const z = templateZip({ id: 'offline-one' });
    writeTree(root, { 't/offline-one/1.0.0.zip': z });
    writeFileSync(join(root, 'catalog.json'), JSON.stringify({ spec: 0, templates: [{ id: 'offline-one', name: 'Offline', version: '1.0.0', kind: 'app', summary: 's', tags: [], stack: [], tier: 'free', page: 'https://codeplate.io/t/offline-one/', download: 'https://codeplate.io/t/offline-one/1.0.0.zip', sha256: sha256(z), checks: 'node checks/run.mjs' }] }));
    const env = { CODEPLATE_BASE_URL: pathToFileURL(root).href };
    assert.match((await run(['list'], { env })).out, /offline-one/);
    const cwd = tempDir();
    assert.equal((await run(['get', 'offline-one'], { env, cwd })).code, 0);
    assert.ok(existsSync(join(cwd, 'offline-one', 'AGENTS.md')));
  });
});

// ---------------------------------------------------------------- status / check

describe('project', () => {
  test('status: license, interview and requirements', async () => {
    const root = tempDir();
    writeTree(root, templateFiles({ id: 'p1' }));
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    assert.equal(findProjectRoot(join(root, 'src', 'deep')), root);
    const r = await run(['status', join(root, 'src', 'deep')]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /CodePlate Free License: ship the credit "Built with CodePlate \(codeplate\.io\)"/);
    assert.match(r.out, /Interview: not done yet/);
    writeFileSync(join(root, 'docs', 'project.md'), '# Project\n\n- Name: Brightside\n');
    const j = JSON.parse((await run(['status', root, '--json'])).out);
    assert.equal(j.interviewDone, true);
    assert.equal(j.creditRequired, true);
  });

  test('status outside a project fails with usage', async () => {
    assert.equal((await run(['status', tempDir()])).code, 2);
  });

  test('check passes only on exit 0 with the PASS line', async () => {
    const ok = tempDir();
    writeTree(ok, templateFiles({ id: 'p2' }));
    const pass = await run(['check', ok]);
    assert.equal(pass.code, 0, pass.err + pass.out);
    assert.match(pass.out, /CODEPLATE CHECKS: PASS/);
    assert.match(pass.out, /checks passed/);

    const bad = tempDir();
    writeTree(bad, templateFiles({ id: 'p3', pass: false }));
    const fail = await run(['check', bad]);
    assert.equal(fail.code, 1);
    assert.match(fail.out, /checks FAILED/);

    const silent = tempDir();
    writeTree(silent, { ...templateFiles({ id: 'p4' }), 'checks/run.mjs': "console.log('all good');\n" });
    const r = await run(['check', silent]);
    assert.equal(r.code, 1);
    assert.match(r.out, /no "CODEPLATE CHECKS: PASS" line/);
  });

  test('check stops early when Godot is missing, and uses $GODOT when set', async () => {
    const root = tempDir();
    writeTree(root, templateFiles({ id: 'g1', requires: ['godot'] }));
    const r = await run(['check', root], { env: { PATH: tempDir() } });
    assert.equal(r.code, 3);
    assert.match(r.out, /Finding Godot/);
    const m = JSON.parse(readFileSync(join(root, 'codeplate.json'), 'utf8'));
    assert.deepEqual(requirements(m, { GODOT: process.execPath, PATH: '' }).map((x) => !!x.found), [true]);
    assert.equal(withGodot('godot --headless --path . --import && godot --headless --script x', '/g'), '"/g" --headless --path . --import && "/g" --headless --script x');
  });

  test('which() finds tools on PATH', () => {
    const dir = tempDir();
    const name = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
    writeFileSync(join(dir, name), '');
    const m = { checks: { requires: ['rust'] } };
    assert.ok(requirements(m, { PATH: dir + delimiter, PATHEXT: '.EXE' })[0].found);
    assert.equal(requirements(m, { PATH: tempDir(), PATHEXT: '.EXE' })[0].found, null);
  });
});

// ---------------------------------------------------------------- guard hook

describe('guard hook', () => {
  const project = () => {
    const root = tempDir();
    writeTree(root, { ...templateFiles({ id: 'h1' }), '.env': 'SECRET=1\n', '.env.example': 'SECRET=\n', 'addons/codeplate/checks/run.gd': 'extends SceneTree\n' });
    return root;
  };

  test('secret .env names', () => {
    for (const f of ['.env', '.env.local', '.env.production', '/x/.ENV']) assert.ok(isSecretEnv(f), f);
    for (const f of ['.env.example', '.env.sample', '.env.template', 'env.ts', '.envrc.md', 'my.env']) assert.ok(!isSecretEnv(f), f);
  });

  test('denies reading or editing .env inside a CodePlate project', () => {
    const root = project();
    assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: join(root, '.env') } }).decision, 'deny');
    assert.equal(decide({ tool_name: 'Edit', tool_input: { file_path: join(root, '.env') } }).decision, 'deny');
    assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: join(root, '.env.example') } }), null);
    assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: '.env' }, cwd: root }).decision, 'deny', 'relative paths resolve against cwd');
  });

  test('denies Grep aimed at .env (path or glob), allows normal searches', () => {
    const root = project();
    assert.equal(decide({ tool_name: 'Grep', tool_input: { pattern: 'KEY', glob: '.env', output_mode: 'content' }, cwd: root }).decision, 'deny');
    assert.equal(decide({ tool_name: 'Grep', tool_input: { pattern: 'KEY', glob: '**/.env*' }, cwd: root }).decision, 'deny');
    assert.equal(decide({ tool_name: 'Grep', tool_input: { pattern: 'KEY', path: join(root, '.env.local') } }).decision, 'deny');
    assert.equal(decide({ tool_name: 'Grep', tool_input: { pattern: 'KEY', glob: '.env.example' }, cwd: root }), null);
    assert.equal(decide({ tool_name: 'Grep', tool_input: { pattern: 'KEY', glob: '*.ts' }, cwd: root }), null);
    assert.equal(decide({ tool_name: 'Grep', tool_input: { pattern: 'KEY', glob: '.env' }, cwd: tempDir() }), null, 'outside projects');
  });

  test('asks before editing addons/codeplate, but reading it is fine', () => {
    const root = project();
    const f = join(root, 'addons', 'codeplate', 'checks', 'run.gd');
    assert.equal(decide({ tool_name: 'Edit', tool_input: { file_path: f } }).decision, 'ask');
    assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: f } }).decision, 'ask');
    assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: f } }), null);
    assert.equal(decide({ tool_name: 'Edit', tool_input: { file_path: join(root, 'src', 'main.gd') } }), null);
  });

  test('does nothing outside CodePlate projects or for other tools', () => {
    const plain = tempDir();
    writeFileSync(join(plain, '.env'), 'X=1');
    assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: join(plain, '.env') } }), null);
    assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'cat .env' } }), null);
    assert.equal(decide({}), null);
    assert.equal(hookOutput(null), '');
  });

  test('runs as a hook: JSON on stdin, decision JSON on stdout, exit 0', () => {
    const root = project();
    const script = join(PLUGIN, 'scripts', 'guard.mjs');
    const deny = spawnSync(process.execPath, [script], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(root, '.env') }, cwd: root }), encoding: 'utf8' });
    assert.equal(deny.status, 0);
    const out = JSON.parse(deny.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    const allow = spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(root, 'AGENTS.md') } }), encoding: 'utf8' });
    assert.equal(allow.status, 0);
    assert.equal(allow.stdout, '');
    const garbage = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' });
    assert.equal(garbage.status, 0, 'a broken input never blocks');
    assert.equal(garbage.stdout, '');
  });
});

// ---------------------------------------------------------------- plugin files

describe('plugin layout', () => {
  test('manifests parse and agree', () => {
    const plugin = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(plugin.name, 'codeplate');
    const mpPath = join(REPO, '.claude-plugin', 'marketplace.json');
    if (existsSync(mpPath)) {
      const mp = JSON.parse(readFileSync(mpPath, 'utf8'));
      const entry = mp.plugins.find((p) => p.name === plugin.name);
      assert.ok(entry, 'marketplace lists the plugin under the same name');
      assert.equal(entry.source, './plugin');
      assert.equal(entry.version, plugin.version);
    }
    const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
    const h = hooks.hooks.PreToolUse[0].hooks[0];
    assert.equal(h.command, 'node');
    assert.equal(h.args[0], '${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs');
  });

  test('skills have a name and description, and only reference scripts that exist', () => {
    for (const s of ['codeplate', 'workflow']) {
      const text = readFileSync(join(PLUGIN, 'skills', s, 'SKILL.md'), 'utf8');
      const fm = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
      assert.match(fm, new RegExp(`^name: ${s}$`, 'm'));
      assert.match(fm, /^description: .{40,}/m);
      for (const [, rel] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s`]+)/g)) {
        assert.ok(existsSync(join(PLUGIN, rel)), `${s} references ${rel}`);
      }
    }
  });

  test('plugin files are UTF-8 without a BOM (the icon aside)', () => {
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'results' ? [] : walk(join(d, e.name))) : [join(d, e.name)]));
    for (const f of walk(PLUGIN).filter((f) => !f.endsWith('.png'))) {
      const b = readFileSync(f);
      assert.ok(!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf), `${f} has a BOM`);
      assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(b), f);
    }
  });

  test('the icon in plugin.json is a PNG inside the plugin', () => {
    const icon = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).icon;
    assert.equal(icon, './logo.png');
    assert.deepEqual([...readFileSync(join(PLUGIN, icon)).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });
});
