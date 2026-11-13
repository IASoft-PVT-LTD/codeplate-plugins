#!/usr/bin/env node
// CodePlate for coding agents: browse the catalog, install a template the user downloaded, check a project.
// Node 18+ built-ins only, so it runs the same on Windows, macOS and Linux.
//
//   node codeplate.mjs list [words...] [--tier free|pro] [--kind game|app|document] [--stack godot] [--json]
//   node codeplate.mjs show <id> [--json]
//   node codeplate.mjs get <id>                                               where to download it (exit 3)
//   node codeplate.mjs get --zip <file>  [--dir <parent>] [--name <folder>]   the template.zip the user downloaded from itch.io
//   node codeplate.mjs status [dir] [--json]
//   node codeplate.mjs check  [dir]
//
// Every command takes --base-url <url> (else $CODEPLATE_BASE_URL, else https://codeplate.io).
// Exit codes: 0 ok, 1 failed, 2 usage, 3 needs the user (a template to download from itch.io, a missing tool).
// Nothing downloads from codeplate.io (since 2026-11-12): every template, Free and Pro, comes from its
// itch.io page, and only the user can download it there.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseUrl, filterTemplates, findTemplate, loadCatalog, siteUrl, stackLabel, suggest, SiteError } from './lib/site.mjs';
import { extractTemplateZip, ZipError } from './lib/unzip.mjs';
import { describeProject, findProjectRoot, readManifest, requirements, runChecks, FREE_CREDIT } from './lib/project.mjs';

const USAGE = `usage: codeplate <command> [options]
  list [words...] [--tier free|pro] [--kind game|app|document] [--stack <name>] [--json]
  show <id> [--json]
  get <id> | --zip <file> [--dir <parent>] [--name <folder>]
  status [dir] [--json]
  check [dir]
options: --base-url <url> (default: $CODEPLATE_BASE_URL or https://codeplate.io)`;

const FLAGS_WITH_VALUE = new Set(['--tier', '--kind', '--stack', '--dir', '--name', '--zip', '--base-url']);
const BOOL_FLAGS = new Set(['--json', '--help']);

export function parseArgs(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.split(/=(.*)/s, 2);
      if (FLAGS_WITH_VALUE.has(k)) {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new UsageError(`${k} needs a value`);
        opts[k.slice(2)] = v;
      } else if (BOOL_FLAGS.has(k)) opts[k.slice(2)] = true;
      else throw new UsageError(`unknown option ${k}`);
    } else pos.push(a);
  }
  return { cmd: pos[0], args: pos.slice(1), opts };
}

class UsageError extends Error {}
class NeedsUser extends Error {}

// "Free", or "Pro" (sold on itch.io).
const tierLabel = (t) => (t.tier === 'pro' ? 'Pro' : 'Free');

function printTemplateLine(t, out) {
  out.write(`${t.id.padEnd(28)} ${tierLabel(t).padEnd(7)} ${String(t.kind).padEnd(4)} v${String(t.version).padEnd(7)} ${stackLabel(t.stack)}\n`);
  out.write(`${''.padEnd(28)} ${t.summary}\n`);
}

async function cmdList({ args, opts }, io, base) {
  const catalog = await loadCatalog(base, io);
  const list = filterTemplates(catalog.templates, { query: args.join(' '), tier: opts.tier, kind: opts.kind, stack: opts.stack });
  if (opts.json) {
    io.out.write(JSON.stringify({ updated: catalog.updated, count: list.length, templates: list }, null, 2) + '\n');
    return 0;
  }
  if (!list.length) {
    io.out.write(`No templates match. ${catalog.templates.length} in the catalog; try "list" with no filters.\n`);
    return 0;
  }
  for (const t of list) printTemplateLine(t, io.out);
  const pro = list.filter((t) => t.tier === 'pro').length;
  io.out.write(`\n${list.length} template${list.length === 1 ? '' : 's'} (${list.length - pro} free, ${pro} Pro). Every template downloads from its itch.io page, and only the user can download it ("show <id>" gives the page). Free ones cost nothing, need no account and need the credit "${FREE_CREDIT}". Pro ones are bought there first.\n`);
  return 0;
}

async function needTemplate(id, io, base) {
  if (!id) throw new UsageError('which template? Give its id (see "list").');
  const catalog = await loadCatalog(base, io);
  const t = findTemplate(catalog, id);
  if (!t) {
    const close = suggest(catalog, id);
    throw new SiteError(`no template "${id}" in the catalog.${close.length ? ` Did you mean: ${close.join(', ')}?` : ' Run "list" to see them all.'}`, { code: 'unknown' });
  }
  return { catalog, t };
}

async function cmdShow({ args, opts }, io, base) {
  const { t } = await needTemplate(args[0], io, base);
  if (opts.json) {
    io.out.write(JSON.stringify(t, null, 2) + '\n');
    return 0;
  }
  const lines = [
    `${t.name} (${t.id}) v${t.version}`,
    t.summary,
    '',
    `Tier:     ${t.tier === 'pro' ? `Pro, ${t.price ?? 'paid'} on itch.io (no credit needed)` : `Free (no account needed; credit "${FREE_CREDIT}" required)`}`,
    `Kind:     ${t.kind}`,
    `Stack:    ${stackLabel(t.stack)}`,
    `Tags:     ${(t.tags ?? []).join(', ')}`,
    `Checks:   ${t.checks}`,
    `Page:     ${siteUrl(base, t.page).href}`,
    ...(t.demo ? [`Demo:     ${siteUrl(base, t.demo).href}`] : []),
    ...(t.itch ? [`itch.io:  ${t.itch}`] : []),
    `Get it:   the user downloads template.zip from its itch.io page${t.tier === 'pro' ? ' after buying it' : ' (free)'}; then codeplate get --zip <file>`,
  ];
  io.out.write(lines.join('\n') + '\n');
  return 0;
}

/** The folder a template goes into; refuses one that already has files in it. */
function destination(opts, fallbackName, cwd) {
  const name = opts.name ?? fallbackName;
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name) || name.includes('..')) throw new UsageError(`--name must be a plain folder name, not ${JSON.stringify(name)}`);
  const dest = resolve(opts.dir ? resolve(cwd, opts.dir) : cwd, name);
  if (existsSync(dest) && (!statSync(dest).isDirectory() || readdirSync(dest).length)) {
    throw new UsageError(`${dest} already exists and isn't empty. Pick another --name or --dir.`);
  }
  return dest;
}

function installZip(bytes, { dest, expectId }, io) {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new ZipError("that isn't a zip file");
  mkdirSync(dest, { recursive: true });
  const { top, files } = extractTemplateZip(bytes, dest);
  if (!existsSync(resolve(dest, 'codeplate.json'))) throw new ZipError('the zip has no codeplate.json: not a CodePlate template');
  const m = readManifest(dest);
  if (expectId && m.id !== expectId) throw new ZipError(`expected template ${expectId}, the zip holds ${m.id}`);
  if (top !== m.id) io.err.write(`note: the zip's folder (${top}) differs from the template id (${m.id})\n`);
  const p = describeProject(dest);
  io.out.write([
    `Installed ${m.name} v${m.version} into ${dest} (${files.length} files).`,
    p.proLicensed
      ? 'License: CodePlate Pro License. No credit needed.'
      : `License: CodePlate Free License. Anything shipped from it must show "${FREE_CREDIT}" (e.g. on an About or credits screen).`,
    'Next:',
    `  1. Work inside ${dest}. Read AGENTS.md there first, all of it.`,
    `  2. ${p.interviewDone ? 'docs/project.md already has decisions: follow them.' : 'docs/project.md is still the stub: run the Interview from AGENTS.md before changing anything.'}`,
    `  3. Verify with: codeplate check "${dest}"  (runs: ${m.checks.command})`,
  ].join('\n') + '\n');
  return 0;
}

/** What the agent tells the user: download template.zip from the template's itch.io page, then hand it over. */
export function downloadGuidance(t, base) {
  const page = t.itch ?? siteUrl(base, t.page).href;
  const pro = t.tier === 'pro';
  return [
    pro
      ? `${t.name} is a Pro template, sold on itch.io${t.price ? ` (${t.price})` : ''}. You can't buy or download it yourself, and never ask the user for a password or card details. Ask them to:`
      : `${t.name} is a free template. It downloads from itch.io ($0, no account needed), and you can't download it yourself. Ask the user to:`,
    `  1. ${pro ? 'Buy it on its itch.io page' : 'Open its itch.io page'}, ${page}, and download template.zip${pro ? '' : ' (choose "No thanks, just take me to the downloads" to skip the donation)'}.`,
    '  2. Tell you where the zip was saved. Then run:  codeplate get --zip "<path to the zip>"',
    '     (If they already unzipped it, work in that folder: codeplate status "<folder>")',
    ...(pro ? [] : [`It comes under the CodePlate Free License: what they ship must show "${FREE_CREDIT}".`]),
  ].join('\n');
}

async function cmdGet({ args, opts }, io, base) {
  const cwd = io.cwd;
  if ([args[0], opts.zip].filter(Boolean).length !== 1) throw new UsageError('get takes one of: <id> (where to download it), --zip <file> (install the downloaded template.zip)');

  if (opts.zip) {
    const file = resolve(cwd, opts.zip);
    if (!existsSync(file)) throw new UsageError(`no such file: ${file}`);
    const bytes = readFileSync(file);
    const id = guessId(bytes);
    return installZip(bytes, { dest: destination(opts, id, cwd) }, io);
  }

  const { t } = await needTemplate(args[0], io, base);
  throw new NeedsUser(downloadGuidance(t, base));
}

function guessId(bytes) {
  // The template's folder name inside the zip, before extraction (validated again on extract).
  try {
    const name = bytes.toString('utf8', 30, 30 + bytes.readUInt16LE(26));
    const top = name.split('/')[0];
    if (/^[a-z0-9-]{3,40}$/.test(top)) return top;
  } catch { /* fall through */ }
  return 'codeplate-template';
}

function projectRootOrThrow(dir, cwd) {
  const start = resolve(cwd, dir ?? '.');
  const root = findProjectRoot(start);
  if (!root) throw new UsageError(`no codeplate.json in ${start} or any folder above it: not a CodePlate project`);
  return root;
}

function cmdStatus({ args, opts }, io) {
  const root = projectRootOrThrow(args[0], io.cwd);
  const p = describeProject(root);
  const reqs = requirements(readManifest(root), io.env);
  if (opts.json) {
    io.out.write(JSON.stringify({ ...p, requirements: reqs }, null, 2) + '\n');
    return 0;
  }
  io.out.write([
    `${p.name} (${p.id}) v${p.version} at ${p.root}`,
    `License:   ${p.proLicensed ? 'CodePlate Pro License: no credit needed' : `CodePlate Free License: ship the credit "${p.credit}"`}`,
    `Brief:     ${p.brief ? 'AGENTS.md (read it before changing anything)' : 'missing AGENTS.md!'}`,
    `Interview: ${p.interviewDone ? 'done (docs/project.md has decisions)' : 'not done yet (docs/project.md is the stub)'}`,
    `Checks:    ${p.checks.command}`,
    ...reqs.map((r) => `  needs ${r.name.padEnd(6)} ${r.found ? `ok (${r.note || r.found})` : `MISSING: ${r.note}`}`),
  ].join('\n') + '\n');
  return 0;
}

async function cmdCheck({ args }, io) {
  const root = projectRootOrThrow(args[0], io.cwd);
  const manifest = readManifest(root);
  const missing = requirements(manifest, io.env).filter((r) => !r.found && r.name !== 'unity');
  if (missing.length) throw new NeedsUser(`can't run the checks yet:\n${missing.map((r) => `  ${r.name}: ${r.note}`).join('\n')}`);
  const r = await runChecks(root, { env: io.env, out: io.out, err: io.err });
  io.out.write(r.passed
    ? `\ncodeplate: checks passed (${manifest.id})\n`
    : `\ncodeplate: checks FAILED (${r.error ?? `exit ${r.code}`}${r.code === 0 ? ', no "CODEPLATE CHECKS: PASS" line' : ''}). Fix the first failure above, then run the checks again.\n`);
  return r.passed ? 0 : 1;
}

export async function main(argv, io = {}) {
  io = { out: process.stdout, err: process.stderr, env: process.env, cwd: process.cwd(), ...io };
  try {
    const parsed = parseArgs(argv);
    if (!parsed.cmd || parsed.opts.help || parsed.cmd === 'help') {
      io.out.write(USAGE + '\n');
      return parsed.cmd || parsed.opts.help ? 0 : 2;
    }
    const base = baseUrl(parsed.opts['base-url'], io.env);
    switch (parsed.cmd) {
      case 'list': case 'search': return await cmdList(parsed, io, base);
      case 'show': return await cmdShow(parsed, io, base);
      case 'get': return await cmdGet(parsed, io, base);
      case 'status': return cmdStatus(parsed, io);
      case 'check': return await cmdCheck(parsed, io);
      default: throw new UsageError(`unknown command "${parsed.cmd}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err.write(`codeplate: ${e.message}\n${USAGE}\n`);
      return 2;
    }
    if (e instanceof NeedsUser) {
      io.out.write(e.message + '\n');
      return 3;
    }
    if (e instanceof SiteError || e instanceof ZipError) {
      io.err.write(`codeplate: ${e.message}\n`);
      return 1;
    }
    io.err.write(`codeplate: unexpected error: ${e.stack ?? e}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
