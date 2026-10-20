// Test helpers: a tiny zip writer, fixture templates, a fake codeplate.io, captured output.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { crc32, deflateRawSync } from 'node:zlib';

/** Builds a zip from [{ name, data }] (deflate, no comment unless given). */
export function zip(entries, comment = '') {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data: raw } of entries) {
    const data = Buffer.from(raw);
    const n = Buffer.from(name, 'utf8');
    const body = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, body);
    centrals.push(central, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const c = Buffer.from(comment, 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(c.length, 20);
  return Buffer.concat([...locals, cd, end, c]);
}

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const STUB = '# Project\n\n<!-- codeplate:project-stub -->\n';

/** The files of a minimal template; `pass` decides what its checks print. */
export function templateFiles({ id, tier = 'free', version = '1.0.0', pass = true, requires = ['node'], extra = {} }) {
  const manifest = {
    spec: 0, id, name: `Fixture ${id}`, version, kind: 'app', summary: `A fixture ${tier} template.`, tags: ['fixture', 'web'],
    stack: [{ name: 'node', version: '24.0.0' }],
    checks: { command: 'node checks/run.mjs', requires },
    license: tier === 'pro' ? 'CodePlate-Pro-1.5' : 'CodePlate-Free-1.3', tier,
  };
  return {
    'codeplate.json': JSON.stringify(manifest, null, 2),
    'AGENTS.md': '# Brief\n\n## Start here\n\n## Interview\n',
    'CLAUDE.md': 'Read AGENTS.md first.\n',
    'docs/project.md': STUB,
    'checks/run.mjs': pass
      ? "console.log('1 passed');\nconsole.log('CODEPLATE CHECKS: PASS');\n"
      : "console.log('CODEPLATE CHECKS: FAIL (1 failed)');\nprocess.exit(1);\n",
    ...extra,
  };
}

export function templateZip(opts, comment) {
  const files = templateFiles(opts);
  return zip(Object.entries(files).map(([rel, data]) => ({ name: `${opts.id}/${rel}`, data })), comment);
}

export function writeTree(root, files) {
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(join(root, ...rel.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...rel.split('/')), data);
  }
}

const made = [];
export const tempDir = (p = 'cp-plugin-') => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
export const removeTempDirs = () => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); };

export const GOOD_GRANT = 'fixture-pro.1.0.0.CP-1A2B-3C4D-5E6F.9999999999999.' + 'a'.repeat(64);

/**
 * A fake codeplate.io: /catalog.json, /t/<id>/<version>.zip, /download/<id>/<version>?grant=…
 * (GOOD_GRANT works, anything else gets the Worker's 403 page). `holding: true` serves an HTML
 * holding page for every path, like the site while it's offline.
 */
export async function fakeSite({ holding = false, tamper = false } = {}) {
  const free = templateZip({ id: 'fixture-free' });
  const pro = templateZip({ id: 'fixture-pro', tier: 'pro', extra: { 'CODEPLATE-LICENSE.txt': 'CodePlate Pro License\nLicense ID: CP-1A2B-3C4D-5E6F\n' } }, 'CodePlate Pro License, license ID CP-1A2B-3C4D-5E6F');
  let origin;
  const entry = (id, tier, z, extra = {}) => ({
    id, name: `Fixture ${id}`, version: '1.0.0', kind: 'app', summary: `A fixture ${tier} template.`, tags: ['fixture', 'web'],
    stack: [{ name: 'node', version: '24.0.0' }], tier, license: tier === 'pro' ? 'CodePlate-Pro-1.5' : 'CodePlate-Free-1.3',
    page: `https://codeplate.io/t/${id}/`,
    download: tier === 'pro' ? `https://codeplate.io/download/${id}/1.0.0` : `https://codeplate.io/t/${id}/1.0.0.zip`,
    latest: tier === 'pro' ? `https://codeplate.io/download/${id}/latest` : `https://codeplate.io/t/${id}/latest.zip`,
    bytes: z.length, sha256: tamper ? '0'.repeat(64) : sha256(z), checks: 'node checks/run.mjs', media: [], ...extra,
  });
  const catalog = {
    spec: 0, updated: '2026-10-14',
    templates: [
      entry('fixture-free', 'free', free),
      entry('fixture-pro', 'pro', pro, { plan: 'plus', requires: 'An active CodePlate plan that includes it: Plus or Max.' }),
      { ...entry('fixture-game', 'free', free), kind: 'game', stack: [{ name: 'godot', version: '4.7.2' }], tags: ['match-3', 'puzzle'], summary: 'A fixture game.' },
    ],
  };
  const requests = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, origin);
    requests.push(u.pathname + u.search);
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
    if (holding) return send(200, 'text/html; charset=utf-8', '<!doctype html><title>CodePlate</title><p>Back soon.</p>');
    if (u.pathname === '/catalog.json') return send(200, 'application/json', JSON.stringify(catalog));
    if (u.pathname === '/t/fixture-free/1.0.0.zip' || u.pathname === '/t/fixture-free/latest.zip') return send(200, 'application/zip', free);
    if (u.pathname === '/away') { res.writeHead(302, { location: 'https://example.com/x.zip' }); return res.end(); }
    if (u.pathname === '/download/fixture-pro/1.0.0') {
      if (u.searchParams.get('grant') === GOOD_GRANT) return send(200, 'application/zip', pro);
      return send(403, 'text/html; charset=utf-8', "<h1>That download link didn't work</h1>");
    }
    send(404, 'text/html; charset=utf-8', '<h1>This plate is empty.</h1>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, catalog, free, pro, close: () => new Promise((r) => server.close(r)) };
}

export function capture() {
  let text = '';
  const stream = new Writable({ write(chunk, _enc, cb) { text += chunk.toString(); cb(); } });
  return { stream, get text() { return text; } };
}
