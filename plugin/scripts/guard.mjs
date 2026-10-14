#!/usr/bin/env node
// PreToolUse hook: two guard rails inside CodePlate projects (folders with a
// codeplate.json at or above the file). Outside them it does nothing.
//
//   1. Don't let the agent read or edit .env files (secrets). .env.example and
//      friends are fine: templates document every variable there.
//   2. Ask before editing the vendored CodePlate Godot add-on (addons/codeplate/):
//      the template's checks run on it, and a template update replaces it.
//
// It sees the file tools (Read, Edit, MultiEdit, Write, NotebookEdit) and Grep
// (a path or glob aimed at .env). Shell commands are not inspected: matching them reliably across bash, PowerShell
// and cmd isn't possible, so this is a guard rail, not a sandbox.
// Any error means "no opinion" (exit 0, no output): a broken hook must never
// block work.
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from './lib/project.mjs';

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const SAFE_ENV = /^\.env\.(example|sample|template|defaults)$/i;

export function isSecretEnv(file) {
  const name = basename(file);
  return /^\.env($|\.)/i.test(name) && !SAFE_ENV.test(name);
}

/** Returns null (no opinion) or { decision: 'deny'|'ask', reason }. */
export function decide(input) {
  const tool = input?.tool_name;
  if (tool === 'Grep') return decideGrep(input);
  if (!FILE_TOOLS.has(tool)) return null;
  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof raw !== 'string' || !raw) return null;
  const file = resolve(input.cwd ?? process.cwd(), raw);
  const root = findProjectRoot(dirname(file));
  if (!root) return null;

  if (isSecretEnv(file)) {
    return {
      decision: 'deny',
      reason: `CodePlate guard: ${basename(file)} holds the user's secrets, so don't read or edit it. Use .env.example to see which variables exist, and ask the user to set values in ${basename(file)} themselves.`,
    };
  }
  const rel = relative(root, file).split(sep).join('/');
  if (EDIT_TOOLS.has(tool) && rel.startsWith('addons/codeplate/')) {
    return {
      decision: 'ask',
      reason: `CodePlate guard: ${rel} is part of the vendored CodePlate add-on. The template's checks run on it and a template update replaces it, so project code belongs elsewhere (see AGENTS.md). Allow this edit only if you really mean to change the add-on.`,
    };
  }
  return null;
}

/**
 * Grep prints file contents, so it can read a .env too: deny a search whose path is a
 * .env file or whose glob targets .env files. (A project-wide search with no glob is
 * left alone; it can't be told apart from a normal code search.)
 */
function decideGrep(input) {
  const ti = input.tool_input ?? {};
  const cwd = input.cwd ?? process.cwd();
  const target = resolve(cwd, typeof ti.path === 'string' && ti.path ? ti.path : '.');
  const pathIsEnv = isSecretEnv(target);
  const glob = typeof ti.glob === 'string' ? ti.glob : '';
  const globIsEnv = /\.env/i.test(glob) && !/\.env\.(example|sample|template|defaults)\b/i.test(glob);
  if (!pathIsEnv && !globIsEnv) return null;
  if (!findProjectRoot(pathIsEnv ? dirname(target) : target)) return null;
  return {
    decision: 'deny',
    reason: "CodePlate guard: .env files hold the user's secrets, so don't search or read them. Use .env.example to see which variables exist, and ask the user to check or set values in .env themselves.",
  };
}

export function hookOutput(result) {
  if (!result) return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: result.decision,
      permissionDecisionReason: result.reason,
    },
  });
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const out = hookOutput(decide(JSON.parse(await readStdin())));
    if (out) process.stdout.write(out + '\n');
  } catch {
    // no opinion
  }
  process.exitCode = 0;
}
