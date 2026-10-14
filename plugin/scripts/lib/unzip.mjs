// Minimal, safe zip reader for CodePlate template zips (Node built-ins only).
//
// Supports what CodePlate publishes: stored (0) and deflated (8) entries, an
// optional zip comment (Pro downloads carry one), no zip64, no encryption.
// Every entry name is checked before anything touches the disk: no absolute
// paths, no drive letters, no backslashes, no "." or ".." segments.
import { inflateRawSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

// Generous upper bounds: a template is at most 100 MB and files at most 10 MB
// (spec §7); these only stop a hostile archive from filling the disk.
export const LIMITS = { totalBytes: 512 * 1024 * 1024, fileBytes: 64 * 1024 * 1024, entries: 20000 };

export class ZipError extends Error {}

function findEnd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD && i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  throw new ZipError('not a zip file (no end record)');
}

/** Rejects names that could escape the target folder. Returns the name split into segments. */
export function safeSegments(name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new ZipError(`unsafe path in zip: ${JSON.stringify(name)}`);
  }
  const parts = name.split('/');
  if (parts.at(-1) === '') parts.pop(); // directory entry
  if (parts.some((p) => p === '' || p === '.' || p === '..' || /[<>:"|?*]/.test(p))) {
    throw new ZipError(`unsafe path in zip: ${JSON.stringify(name)}`);
  }
  return parts;
}

/** Lists the entries of a zip buffer: [{ name, dir, method, crc, size, compressedSize, offset }]. */
export function listEntries(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const end = findEnd(buf);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  if (count > LIMITS.entries) throw new ZipError(`too many entries (${count})`);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) throw new ZipError('corrupt central directory');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    if (flags & 1) throw new ZipError(`encrypted entry: ${name}`);
    if (method !== 0 && method !== 8) throw new ZipError(`unsupported compression ${method}: ${name}`);
    out.push({ name, dir: name.endsWith('/'), method, crc, size, compressedSize, offset });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Returns the bytes of one entry, checking its size and CRC. */
export function readEntry(input, entry) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const at = entry.offset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) throw new ZipError(`corrupt local header: ${entry.name}`);
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const body = buf.subarray(start, start + entry.compressedSize);
  if (body.length !== entry.compressedSize) throw new ZipError(`truncated entry: ${entry.name}`);
  if (entry.size > LIMITS.fileBytes) throw new ZipError(`entry too large: ${entry.name}`);
  const data = entry.method === 8 ? inflateRawSync(body, { maxOutputLength: LIMITS.fileBytes + 1 }) : body;
  if (data.length !== entry.size) throw new ZipError(`size mismatch: ${entry.name}`);
  if ((crc32(data) >>> 0) !== entry.crc) throw new ZipError(`CRC mismatch: ${entry.name}`);
  return data;
}

/**
 * Extracts a template zip whose entries all sit under one top-level folder
 * (`<id>/` in CodePlate zips) into `dest`, dropping that folder. Returns
 * { top, files } where `top` is the folder name that was dropped.
 * Validates every entry (names, sizes, CRCs) before writing anything.
 */
export function extractTemplateZip(input, dest) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const entries = listEntries(buf);
  if (!entries.length) throw new ZipError('empty zip');
  const tops = new Set(entries.map((e) => safeSegments(e.name)[0]));
  if (tops.size !== 1) throw new ZipError('expected every file under one top-level folder');
  const [top] = tops;
  const files = [];
  let total = 0;
  for (const e of entries) {
    const parts = safeSegments(e.name).slice(1);
    if (e.dir || !parts.length) continue;
    const data = readEntry(buf, e);
    total += data.length;
    if (total > LIMITS.totalBytes) throw new ZipError('zip expands to more than the size limit');
    files.push({ rel: parts.join('/'), data });
  }
  const root = resolve(dest);
  for (const f of files) {
    const target = resolve(join(root, ...f.rel.split('/')));
    if (!target.startsWith(root + sep)) throw new ZipError(`unsafe path in zip: ${f.rel}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.data);
  }
  return { top, files: files.map((f) => f.rel) };
}
