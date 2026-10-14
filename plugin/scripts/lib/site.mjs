// Talking to codeplate.io (or a stand-in): the base URL, fetching, the catalog.
//
// The base URL comes from --base-url, then the CODEPLATE_BASE_URL environment
// variable, then https://codeplate.io. It may be http(s):// or file:// (a folder
// laid out like the site: catalog.json, t/<id>/<version>.zip), which the tests
// and offline evals use.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_URL = 'https://codeplate.io';

export class SiteError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function baseUrl(flag, env = process.env) {
  const raw = (flag || env.CODEPLATE_BASE_URL || DEFAULT_BASE_URL).trim();
  let url;
  try {
    url = new URL(raw.endsWith('/') ? raw : `${raw}/`);
  } catch {
    throw new SiteError(`not a valid base URL: ${raw}`, { code: 'config' });
  }
  if (!['https:', 'http:', 'file:'].includes(url.protocol)) throw new SiteError(`unsupported base URL scheme: ${url.protocol}`, { code: 'config' });
  return url;
}

/** Resolves a site path ("/catalog.json") or a catalog URL (any origin) against the base URL, keeping path and query. */
export function siteUrl(base, pathOrUrl) {
  const u = new URL(pathOrUrl, 'https://codeplate.io/');
  return new URL(`.${u.pathname}${u.search}`, base);
}

/** GET a URL. Returns { status, type, bytes }. Never follows redirects to another origin. */
export async function get(url, { fetchImpl = globalThis.fetch, accept = '*/*' } = {}) {
  if (url.protocol === 'file:') {
    try {
      const bytes = readFileSync(fileURLToPath(url));
      return { status: 200, type: url.pathname.endsWith('.json') ? 'application/json' : url.pathname.endsWith('.zip') ? 'application/zip' : 'text/plain', bytes };
    } catch {
      return { status: 404, type: 'text/plain', bytes: Buffer.from('not found') };
    }
  }
  let res;
  let target = url;
  for (let hop = 0; ; hop++) {
    try {
      res = await fetchImpl(target, { headers: { accept, 'user-agent': 'codeplate-claude-plugin' }, redirect: 'manual' });
    } catch (e) {
      throw new SiteError(`couldn't reach ${target.origin} (${e.cause?.code ?? e.message})`, { code: 'network' });
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc && hop < 5) {
      const next = new URL(loc, target);
      if (next.origin !== url.origin) throw new SiteError(`refusing a redirect to another site (${next.origin})`, { code: 'redirect' });
      target = next;
      continue;
    }
    break;
  }
  return { status: res.status, type: res.headers.get('content-type') ?? '', bytes: Buffer.from(await res.arrayBuffer()) };
}

/** Loads and checks catalog.json. */
export async function loadCatalog(base, opts = {}) {
  const url = siteUrl(base, '/catalog.json');
  const res = await get(url, { ...opts, accept: 'application/json' });
  if (res.status !== 200) {
    throw new SiteError(`${url.href} answered ${res.status}. The catalog isn't available right now${base.href.startsWith(DEFAULT_BASE_URL) ? ' (codeplate.io may be offline)' : ''}.`, { status: res.status, code: 'catalog' });
  }
  let data;
  try {
    data = JSON.parse(res.bytes.toString('utf8'));
  } catch {
    throw new SiteError(`${url.href} didn't return JSON (the site may be showing a holding page).`, { code: 'catalog' });
  }
  if (!data || !Array.isArray(data.templates)) throw new SiteError(`${url.href} isn't a CodePlate catalog.`, { code: 'catalog' });
  return data;
}

const text = (t) => [t.id, t.name, t.summary, t.kind, t.tier, ...(t.tags ?? []), ...(t.stack ?? []).map((s) => s.name)].join(' ').toLowerCase();

/** Filters catalog templates. Every word of `query` must appear somewhere in the template's text. */
export function filterTemplates(templates, { query, tier, kind, stack } = {}) {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return templates.filter((t) =>
    (!tier || t.tier === tier) &&
    (!kind || t.kind === kind) &&
    (!stack || (t.stack ?? []).some((s) => s.name === stack.toLowerCase())) &&
    words.every((w) => text(t).includes(w)));
}

export function findTemplate(catalog, id) {
  return catalog.templates.find((t) => t.id === id) ?? null;
}

/** Template ids closest to `id`, for "did you mean". */
export function suggest(catalog, id) {
  const q = id.toLowerCase();
  return catalog.templates.map((t) => t.id).filter((x) => x.includes(q) || q.includes(x) || q.split('-').some((p) => p.length > 2 && x.includes(p))).slice(0, 5);
}

export const stackLabel = (stack = []) => stack.map((s) => `${s.name} ${s.version}`).join(', ');
