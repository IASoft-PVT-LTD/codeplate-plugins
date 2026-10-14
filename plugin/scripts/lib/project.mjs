// A CodePlate project on disk: find it, describe it, run its checks.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export const PROJECT_STUB_MARKER = '<!-- codeplate:project-stub -->';
export const FREE_CREDIT = 'Built with CodePlate (codeplate.io)';
export const PASS_LINE = /^CODEPLATE CHECKS: PASS\s*$/m;

/** The nearest folder at or above `start` that has a codeplate.json, or null. */
export function findProjectRoot(start) {
  let dir = resolve(start);
  for (let i = 0; i < 64; i++) {
    const f = join(dir, 'codeplate.json');
    try {
      if (statSync(f).isFile()) return dir;
    } catch { /* keep looking */ }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

export function readManifest(root) {
  return JSON.parse(readFileSync(join(root, 'codeplate.json'), 'utf8'));
}

/** Finds an executable on PATH (with PATHEXT on Windows). */
export function which(name, env = process.env, platform = process.platform) {
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        if (statSync(p).isFile()) return p;
      } catch { /* not here */ }
    }
  }
  return null;
}

/** Where the checks' tools are, as far as we can tell without running them. */
export function requirements(manifest, env = process.env, platform = process.platform) {
  const out = [];
  for (const r of manifest.checks?.requires ?? []) {
    if (r === 'node') out.push({ name: 'node', found: process.execPath, note: `Node ${process.version}` });
    else if (r === 'godot') {
      const pinned = (manifest.stack ?? []).find((s) => s.name === 'godot')?.version;
      const fromEnv = env.GODOT && existsSync(env.GODOT) ? env.GODOT : null;
      const found = fromEnv ?? ['godot', 'godot4'].map((n) => which(n, env, platform)).find(Boolean) ?? null;
      out.push({ name: 'godot', found, note: found ? `${fromEnv ? 'GODOT' : 'PATH'}` : `Godot ${pinned ?? '4.x'} not found: set GODOT to the binary (AGENTS.md, "Finding Godot", lists the usual install paths)` });
    } else if (r === 'rust') {
      const found = which('cargo', env, platform);
      out.push({ name: 'rust', found, note: found ? 'cargo on PATH' : 'cargo not found: install Rust from https://rustup.rs' });
    } else if (r === 'unity') {
      out.push({ name: 'unity', found: env.UNITY || null, note: "the template's checks find the pinned Unity editor themselves (or set UNITY)" });
    } else out.push({ name: r, found: which(r, env, platform), note: '' });
  }
  return out;
}

/** Everything an agent needs to know about a CodePlate project folder. */
export function describeProject(root) {
  const m = readManifest(root);
  const project = existsSync(join(root, 'docs', 'project.md')) ? readFileSync(join(root, 'docs', 'project.md'), 'utf8') : null;
  const pro = /^CodePlate-Pro-/.test(m.license ?? '');
  const licenseFile = join(root, 'CODEPLATE-LICENSE.txt');
  return {
    root,
    id: m.id,
    name: m.name,
    version: m.version,
    kind: m.kind,
    tier: m.tier,
    license: m.license,
    stack: m.stack,
    proLicensed: pro,
    licenseId: pro && existsSync(licenseFile) ? (readFileSync(licenseFile, 'utf8').match(/CP-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}/)?.[0] ?? null) : null,
    creditRequired: !pro,
    credit: pro ? null : FREE_CREDIT,
    brief: existsSync(join(root, 'AGENTS.md')) ? 'AGENTS.md' : null,
    interviewDone: project != null && !project.includes(PROJECT_STUB_MARKER),
    checks: m.checks,
  };
}

/** Puts $GODOT in place of each `godot` command word (same rule as tools/codeplate.mjs). */
export function withGodot(command, binary) {
  return command.replace(/(^|&&\s*)godot(?=\s)/g, (_, pre) => `${pre}"${binary}"`);
}

export function checksCommand(manifest, env = process.env) {
  let command = manifest.checks.command;
  if (env.GODOT) command = withGodot(command, env.GODOT);
  return command;
}

/**
 * Runs the project's checks command from its root, streaming output to `out`.
 * Resolves { passed, code, command }: passed only if it exits 0 and printed CODEPLATE CHECKS: PASS.
 */
export function runChecks(root, { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const command = checksCommand(readManifest(root), env);
  return new Promise((resolveRun) => {
    const child = spawn(command, { cwd: root, shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    child.stdout.on('data', (d) => {
      out.write(d);
      tail = (tail + d.toString('utf8')).slice(-64 * 1024);
    });
    child.stderr.on('data', (d) => err.write(d));
    child.on('error', (e) => resolveRun({ passed: false, code: null, command, error: e.message }));
    child.on('close', (code) => resolveRun({ passed: code === 0 && PASS_LINE.test(tail), code, command }));
  });
}
