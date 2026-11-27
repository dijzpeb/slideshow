#!/usr/bin/env node
// Mock of the Google Drive API v3 (read-only subset) for E2E tests. Node built-ins only.
//
//   node tests/mock-drive/server.mjs --port 8787 --fixtures tests/fixtures/out \
//        [--max-page-size 4] [--host 127.0.0.1] [--thumb-auth none|required] \
//        [--tokens test-token,other] [--keys TESTKEY] [--latency 0] \
//        [--inaccessible-list 404|empty] [--verbose]
//
// In-process:  const { url, close, admin } = await startMockDrive({ port: 0, fixturesDir });
//
// See tests/README.md for the full contract.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURES_DIR = path.resolve(HERE, '../fixtures/out');
export const DEFAULT_TOKENS = ['test-token'];
export const DEFAULT_KEYS = ['TESTKEY'];
const MYDRIVE_ALIAS = 'root';

const MIME_FOLDER = 'application/vnd.google-apps.folder';
const RESOURCE_KEY_HEADER = 'x-goog-drive-resource-keys';

// --------------------------------------------------------------------------------------
// Drive v3 schema (used to validate `fields` like the real API does)
// --------------------------------------------------------------------------------------
const ANY = '*';
const FILE_SCHEMA = {
  kind: 1, id: 1, name: 1, mimeType: 1, description: 1, starred: 1, trashed: 1,
  explicitlyTrashed: 1, trashingUser: ANY, trashedTime: 1, parents: 1, properties: ANY,
  appProperties: ANY, spaces: 1, version: 1, webContentLink: 1, webViewLink: 1, iconLink: 1,
  hasThumbnail: 1, thumbnailLink: 1, thumbnailVersion: 1, viewedByMe: 1, viewedByMeTime: 1,
  createdTime: 1, modifiedTime: 1, modifiedByMeTime: 1, modifiedByMe: 1, sharedWithMeTime: 1,
  sharingUser: ANY, owners: ANY, teamDriveId: 1, driveId: 1, lastModifyingUser: ANY, shared: 1,
  ownedByMe: 1, capabilities: ANY, viewersCanCopyContent: 1, copyRequiresWriterPermission: 1,
  writersCanShare: 1, permissions: ANY, permissionIds: 1, hasAugmentedPermissions: 1,
  folderColorRgb: 1, originalFilename: 1, fullFileExtension: 1, fileExtension: 1,
  md5Checksum: 1, sha1Checksum: 1, sha256Checksum: 1, size: 1, quotaBytesUsed: 1,
  headRevisionId: 1, contentHints: ANY, isAppAuthorized: 1, exportLinks: ANY,
  contentRestrictions: ANY, resourceKey: 1, linkShareMetadata: ANY, labelInfo: ANY,
  inheritedPermissionsDisabled: 1, downloadRestrictions: ANY,
  imageMediaMetadata: {
    width: 1, height: 1, rotation: 1, time: 1, cameraMake: 1, cameraModel: 1,
    exposureTime: 1, aperture: 1, flashUsed: 1, focalLength: 1, isoSpeed: 1, meteringMode: 1,
    sensor: 1, exposureMode: 1, colorSpace: 1, whiteBalance: 1, exposureBias: 1,
    maxApertureValue: 1, subjectDistance: 1, lens: 1,
    location: { latitude: 1, longitude: 1, altitude: 1 },
  },
  videoMediaMetadata: { width: 1, height: 1, durationMillis: 1 },
  shortcutDetails: { targetId: 1, targetMimeType: 1, targetResourceKey: 1 },
};
const LIST_SCHEMA = { kind: 1, nextPageToken: 1, incompleteSearch: 1, files: FILE_SCHEMA };
const DEFAULT_FILE_FIELDS = 'kind,id,name,mimeType';
const DEFAULT_LIST_FIELDS = 'kind,nextPageToken,incompleteSearch,files(kind,id,name,mimeType)';
const ORDER_KEYS = new Set(['createdTime', 'folder', 'modifiedByMeTime', 'modifiedTime', 'name',
  'name_natural', 'quotaBytesUsed', 'recency', 'sharedWithMeTime', 'starred', 'viewedByMeTime']);

// --------------------------------------------------------------------------------------
// Google-style errors
// --------------------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, body, headers = {}) {
    super(body?.error?.message || String(status));
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

function gErr(code, message, { reason, domain = 'global', location, locationType, status, extra, itemMessage } = {}) {
  const e = { message: itemMessage || message, domain, reason };
  if (location) { e.location = location; e.locationType = locationType || 'parameter'; }
  const body = { error: { code, message, errors: [e] } };
  if (status) body.error.status = status;
  if (extra) Object.assign(body.error, extra);
  return body;
}

const ERR = {
  unauthenticated: () => new ApiError(401, gErr(401,
    'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.',
    { reason: 'authError', itemMessage: 'Invalid Credentials', location: 'Authorization', locationType: 'header', status: 'UNAUTHENTICATED' }),
  { 'www-authenticate': 'Bearer realm="https://accounts.google.com/", error="invalid_token"' }),
  unregistered: () => new ApiError(403, gErr(403,
    "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.",
    { reason: 'dailyLimitExceededUnreg', domain: 'usageLimits', status: 'PERMISSION_DENIED' })),
  badKey: () => new ApiError(400, gErr(400, 'API key not valid. Please pass a valid API key.', {
    reason: 'badRequest', status: 'INVALID_ARGUMENT',
    extra: { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID',
      domain: 'googleapis.com', metadata: { service: 'drive.googleapis.com' } }] },
  })),
  notFound: (id) => new ApiError(404, gErr(404, `File not found: ${id}.`,
    { reason: 'notFound', location: 'fileId' })),
  invalid: (location, message = 'Invalid Value') => new ApiError(400, gErr(400, message,
    { reason: 'invalid', location })),
  invalidFields: (sel) => new ApiError(400, gErr(400, `Invalid field selection ${sel}`,
    { reason: 'invalidParameter', location: 'fields' })),
  notDownloadable: () => new ApiError(403, gErr(403,
    'Only files with binary content can be downloaded. Use Export with Docs Editors files.',
    { reason: 'fileNotDownloadable', location: 'alt' })),
  rangeNotSatisfiable: (size) => new ApiError(416, gErr(416, 'Request range not satisfiable',
    { reason: 'requestedRangeNotSatisfiable' }), { 'content-range': `bytes */${size}` }),
  methodNotAllowed: () => new ApiError(405, gErr(405, 'Method not allowed by the mock (read-only API)',
    { reason: 'methodNotAllowed' })),
  injected: (status) => {
    const map = {
      500: ['Internal Error', 'backendError'],
      502: ['Bad Gateway', 'backendError'],
      503: ['The service is currently unavailable.', 'backendError'],
      429: ['Rate Limit Exceeded', 'rateLimitExceeded'],
      403: ['User rate limit exceeded.', 'userRateLimitExceeded'],
      401: ['Invalid Credentials', 'authError'],
      404: ['File not found.', 'notFound'],
    };
    const [msg, reason] = map[status] || ['Injected failure', 'backendError'];
    const extra = status === 401
      ? { 'www-authenticate': 'Bearer realm="https://accounts.google.com/", error="invalid_token"' } : {};
    return new ApiError(status, gErr(status, msg, { reason }), extra);
  },
};

// --------------------------------------------------------------------------------------
// `fields` (partial response) parsing / validation / selection
// --------------------------------------------------------------------------------------
export function parseFields(str) {
  const s = String(str);
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const name = () => {
    ws();
    const m = /^[A-Za-z0-9_*@.-]+/.exec(s.slice(i));
    if (!m) throw new Error(`bad fields at ${i}`);
    i += m[0].length;
    return m[0];
  };
  const merge = (node, key, sub) => {
    if (node[key] === true || sub === true) { node[key] = true; return; }
    node[key] = node[key] || {};
    for (const [k, v] of Object.entries(sub)) merge(node[key], k, v);
  };
  const list = (closing) => {
    const tree = {};
    for (;;) {
      ws();
      const names = [name()];
      ws();
      while (s[i] === '/') { i++; names.push(name()); ws(); }
      let sub = true;
      if (s[i] === '(') { i++; sub = list(')'); ws(); if (s[i] !== ')') throw new Error('missing )'); i++; ws(); }
      let node = tree;
      for (const n of names.slice(0, -1)) {
        if (node[n] === true) { node = null; break; }
        node[n] = node[n] || {};
        node = node[n];
      }
      if (node) merge(node, names[names.length - 1], sub);
      if (s[i] === ',') { i++; continue; }
      if (i >= s.length || s[i] === closing) return tree;
      throw new Error(`unexpected ${s[i]}`);
    }
  };
  const t = list(null);
  if (i < s.length) throw new Error('trailing input');
  return t;
}

function validateFields(tree, schema, prefix = '') {
  for (const [k, sub] of Object.entries(tree)) {
    if (k === '*') continue;
    const sk = schema[k];
    const full = prefix ? `${prefix}/${k}` : k;
    if (sk === undefined) return full;
    if (sub !== true && sk === 1) return full;
    if (sub !== true && typeof sk === 'object') {
      const bad = validateFields(sub, sk, full);
      if (bad) return bad;
    }
  }
  return null;
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

export function selectFields(value, tree) {
  if (tree === true || (isPlainObject(tree) && tree['*'] === true && Object.keys(tree).length === 1)) {
    return structuredClone(value);
  }
  if (Array.isArray(value)) return value.map((v) => selectFields(v, tree));
  if (!isPlainObject(value)) return value;
  const out = tree['*'] === true ? structuredClone(value) : {};
  for (const [k, sub] of Object.entries(tree)) {
    if (k === '*' || !(k in value)) continue;
    const v = selectFields(value[k], sub);
    if (isPlainObject(v) && Object.keys(v).length === 0) continue; // real API omits empty objects
    out[k] = v;
  }
  return out;
}

function fieldsFor(raw, schema, def) {
  const str = raw === null || raw === undefined || raw === '' ? def : raw;
  let tree;
  try {
    tree = parseFields(str);
  } catch {
    throw ERR.invalidFields(str);
  }
  const bad = validateFields(tree, schema);
  if (bad) throw ERR.invalidFields(bad);
  return tree;
}

// --------------------------------------------------------------------------------------
// `q` parsing (subset of the Drive query language)
// --------------------------------------------------------------------------------------
function tokenize(q) {
  const toks = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') {
      let v = '';
      i++;
      while (i < q.length && q[i] !== c) {
        if (q[i] === '\\' && i + 1 < q.length) { v += q[i + 1]; i += 2; } else { v += q[i++]; }
      }
      if (q[i] !== c) throw new Error('unterminated string');
      i++;
      toks.push({ t: 'str', v });
      continue;
    }
    if (c === '(' || c === ')') { toks.push({ t: c }); i++; continue; }
    const op = /^(!=|<=|>=|=|<|>)/.exec(q.slice(i));
    if (op) { toks.push({ t: 'op', v: op[1] }); i += op[1].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(q.slice(i));
    if (id) { toks.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    throw new Error(`unexpected character ${c}`);
  }
  return toks;
}

const STRING_FIELDS = new Set(['name', 'mimeType']);
const BOOL_FIELDS = new Set(['trashed', 'starred']);
const TIME_FIELDS = new Set(['createdTime', 'modifiedTime']);

export function parseQuery(q) {
  const toks = tokenize(q);
  let p = 0;
  const peek = () => toks[p];
  const kw = (w) => peek() && peek().t === 'id' && peek().v.toLowerCase() === w;
  const expr = () => {
    let left = andExpr();
    while (kw('or')) { p++; left = { type: 'or', a: left, b: andExpr() }; }
    return left;
  };
  const andExpr = () => {
    let left = unary();
    while (kw('and')) { p++; left = { type: 'and', a: left, b: unary() }; }
    return left;
  };
  const unary = () => {
    if (kw('not')) { p++; return { type: 'not', a: unary() }; }
    if (peek() && peek().t === '(') {
      p++;
      const e = expr();
      if (!peek() || peek().t !== ')') throw new Error('missing )');
      p++;
      return e;
    }
    return clause();
  };
  const clause = () => {
    const a = toks[p++];
    if (!a) throw new Error('unexpected end');
    if (a.t === 'str') {
      if (!kw('in')) throw new Error('expected in');
      p++;
      const coll = toks[p++];
      if (!coll || coll.t !== 'id' || coll.v !== 'parents') throw new Error('unsupported collection');
      return { type: 'inParents', id: a.v === MYDRIVE_ALIAS ? null : a.v, alias: a.v === MYDRIVE_ALIAS };
    }
    if (a.t !== 'id') throw new Error('expected field');
    const field = a.v;
    const opTok = toks[p++];
    if (!opTok) throw new Error('expected operator');
    const op = opTok.t === 'op' ? opTok.v : (opTok.t === 'id' && opTok.v.toLowerCase() === 'contains' ? 'contains' : null);
    if (!op) throw new Error('expected operator');
    const val = toks[p++];
    if (!val) throw new Error('expected value');
    if (STRING_FIELDS.has(field)) {
      if (val.t !== 'str' || !['=', '!=', 'contains'].includes(op)) throw new Error('bad string clause');
      return { type: 'cmp', field, op, value: val.v };
    }
    if (BOOL_FIELDS.has(field)) {
      if (val.t !== 'id' || !['true', 'false'].includes(val.v) || !['=', '!='].includes(op)) throw new Error('bad bool clause');
      return { type: 'cmp', field, op, value: val.v === 'true' };
    }
    if (TIME_FIELDS.has(field)) {
      if (val.t !== 'str' || op === 'contains' || Number.isNaN(Date.parse(val.v))) throw new Error('bad time clause');
      return { type: 'cmp', field, op, value: Date.parse(val.v) };
    }
    throw new Error(`unsupported field ${field}`);
  };
  if (!toks.length) return null;
  const e = expr();
  if (p !== toks.length) throw new Error('trailing tokens');
  return e;
}

function evalQuery(node, f, myDriveId) {
  if (!node) return true;
  switch (node.type) {
    case 'and': return evalQuery(node.a, f, myDriveId) && evalQuery(node.b, f, myDriveId);
    case 'or': return evalQuery(node.a, f, myDriveId) || evalQuery(node.b, f, myDriveId);
    case 'not': return !evalQuery(node.a, f, myDriveId);
    case 'inParents': return (f.parents || []).includes(node.alias ? myDriveId : node.id);
    case 'cmp': {
      let v = f[node.field];
      if (BOOL_FIELDS.has(node.field)) v = Boolean(v);
      if (TIME_FIELDS.has(node.field)) v = Date.parse(v);
      const x = node.value;
      switch (node.op) {
        case '=': return v === x;
        case '!=': return v !== x;
        case 'contains': return String(v ?? '').toLowerCase().includes(String(x).toLowerCase());
        case '<': return v < x;
        case '<=': return v <= x;
        case '>': return v > x;
        case '>=': return v >= x;
        default: return false;
      }
    }
    default: return false;
  }
}

function positiveParentIds(node, out = [], negated = false) {
  if (!node) return out;
  if (node.type === 'not') return positiveParentIds(node.a, out, !negated);
  if (node.type === 'and' || node.type === 'or') {
    positiveParentIds(node.a, out, negated);
    positiveParentIds(node.b, out, negated);
  } else if (node.type === 'inParents' && !negated) {
    out.push(node.alias ? null : node.id);
  }
  return out;
}

// --------------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------------
function parseRange(header, size) {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null; // unsupported/multi-range: ignore → 200
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    if (m[2] !== '' && Number(m[2]) < start) return null; // syntactically invalid → ignore
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

function parseResourceKeys(header) {
  const set = new Set();
  if (!header) return set;
  for (const part of String(header).split(',')) {
    const t = part.trim();
    if (t) set.add(t);
  }
  return set;
}

function compareStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function makeComparator(orderBy) {
  const parts = orderBy
    ? orderBy.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [key, dir, ...rest] = s.split(/\s+/);
      if (!ORDER_KEYS.has(key) || rest.length || (dir && !/^(asc|desc)$/i.test(dir))) {
        throw ERR.invalid('orderBy', `Invalid sort field: ${s}`);
      }
      return { key, desc: /^desc$/i.test(dir || '') };
    })
    : [{ key: 'name', desc: false }];
  return (a, b) => {
    for (const { key, desc } of parts) {
      let c = 0;
      switch (key) {
        case 'name': c = compareStr(a.name, b.name); break;
        case 'name_natural': c = collator.compare(a.name, b.name); break;
        case 'createdTime': c = compareStr(a.createdTime, b.createdTime); break;
        case 'modifiedTime': case 'recency': case 'modifiedByMeTime':
          c = compareStr(a.modifiedTime, b.modifiedTime); break;
        case 'folder': c = (b.mimeType === MIME_FOLDER) - (a.mimeType === MIME_FOLDER); break;
        case 'quotaBytesUsed': c = Number(a.size || 0) - Number(b.size || 0); break;
        case 'starred': c = Number(Boolean(b.starred)) - Number(Boolean(a.starred)); break;
        default: c = 0;
      }
      if (c) return desc ? -c : c;
    }
    return compareStr(a.id, b.id);
  };
}

function b64url(s) { return Buffer.from(s).toString('base64url'); }
function sig(...parts) { return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 10); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new ApiError(400, { error: { code: 400, message: 'Body must be JSON' } }); }
}

// --------------------------------------------------------------------------------------
// Server
// --------------------------------------------------------------------------------------
/**
 * Start the mock Drive server.
 * @param {object} [opts]
 * @param {number} [opts.port=8787]  0 = ephemeral port
 * @param {string} [opts.host='127.0.0.1']
 * @param {string} [opts.fixturesDir] directory containing manifest.json
 * @param {number} [opts.maxPageSize=1000] cap for pageSize (force pagination with e.g. 4)
 * @param {'none'|'required'} [opts.thumbAuth='none']
 * @param {string[]} [opts.tokens] allowed bearer tokens
 * @param {string[]} [opts.keys] allowed API keys
 * @param {number} [opts.latencyMs=0]
 * @param {'404'|'empty'} [opts.inaccessibleList='404'] files.list on a folder the caller may not see
 * @param {boolean} [opts.verbose=false] log every request to stdout
 * @returns {Promise<{url:string, port:number, server:http.Server, manifest:object, state:object, admin:object, close:()=>Promise<void>}>}
 */
export async function startMockDrive(opts = {}) {
  const options = {
    port: opts.port ?? 8787,
    host: opts.host ?? '127.0.0.1',
    fixturesDir: path.resolve(opts.fixturesDir ?? DEFAULT_FIXTURES_DIR),
    maxPageSize: Math.max(1, Number(opts.maxPageSize ?? 1000)),
    thumbAuth: opts.thumbAuth ?? 'none',
    tokens: opts.tokens ?? DEFAULT_TOKENS,
    keys: opts.keys ?? DEFAULT_KEYS,
    latencyMs: Number(opts.latencyMs ?? 0),
    inaccessibleList: String(opts.inaccessibleList ?? '404'),
    verbose: Boolean(opts.verbose),
    logLimit: opts.logLimit ?? 5000,
  };
  const manifestPath = path.join(options.fixturesDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${manifestPath}\nRun: python3 tests/fixtures/generate.py`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const myDriveId = manifest.myDriveRootId || 'mydrive_root';

  const state = {};
  function reset() {
    state.files = new Map(manifest.files.map((f) => [f.id, structuredClone(f)]));
    state.tokens = new Set(options.tokens);
    state.keys = new Set(options.keys);
    state.latencyMs = options.latencyMs;
    state.fails = new Map();
    state.log = [];
  }
  reset();

  const visible = (f) => f && !f._test?.hiddenUntilRevealed && !f._deleted;
  const get = (id) => {
    const f = state.files.get(id);
    return visible(f) ? f : null;
  };

  function canAccess(f, auth, rkeys) {
    if (!visible(f)) return false;
    if (auth.mode === 'bearer') return true;
    if (!f._test?.public) return false;
    if (f.resourceKey && !rkeys.has(`${f.id}/${f.resourceKey}`)) return false;
    return true;
  }

  function publicView(f, host) {
    const { _test, _deleted, ...rest } = f;
    const out = structuredClone(rest);
    if (out.thumbnailLink) out.thumbnailLink = out.thumbnailLink.replace('{BASE_URL}', `http://${host}`);
    return out;
  }

  function authenticate(req, u) {
    const h = req.headers.authorization;
    let token = null;
    if (h !== undefined) {
      const m = /^Bearer\s+(.*)$/i.exec(h);
      token = m ? m[1].trim() : '';
    } else if (u.searchParams.has('access_token')) {
      token = u.searchParams.get('access_token');
    }
    if (token !== null) return { kind: 'bearer', mode: state.tokens.has(token) ? 'bearer' : null, error: state.tokens.has(token) ? null : ERR.unauthenticated() };
    if (u.searchParams.has('key')) {
      const ok = state.keys.has(u.searchParams.get('key'));
      return { kind: 'key', mode: ok ? 'key' : null, error: ok ? null : ERR.badKey() };
    }
    return { kind: 'none', mode: null, error: ERR.unregistered() };
  }

  // ---------------- response helpers ----------------
  function baseHeaders(req, extra = {}) {
    const h = {
      date: new Date().toUTCString(),
      server: 'ESF',
      vary: 'Origin, X-Origin, Referer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'x-xss-protection': '0',
      ...extra,
    };
    const origin = req.headers.origin;
    if (origin) h['access-control-allow-origin'] = origin;
    return h;
  }

  function finalize(req, headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) if (v !== undefined && v !== null) out[k.toLowerCase()] = v;
    if (req.headers.origin) {
      // like googleapis.com: expose every response header name
      out['access-control-expose-headers'] = Object.keys(out).join(',');
    }
    return out;
  }

  function sendJson(req, res, status, obj, extra = {}) {
    const body = Buffer.from(JSON.stringify(obj, null, 2) + '\n');
    const headers = baseHeaders(req, {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'private, max-age=0, must-revalidate, no-transform',
      expires: new Date().toUTCString(),
      'content-length': String(body.length),
      ...extra,
    });
    res.writeHead(status, finalize(req, headers));
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function sendError(req, res, err) {
    sendJson(req, res, err.status, err.body, err.headers);
  }

  // ---------------- Drive endpoints ----------------
  function handleList(req, res, u, auth) {
    const sp = u.searchParams;
    const tree = fieldsFor(sp.get('fields'), LIST_SCHEMA, DEFAULT_LIST_FIELDS);
    let pageSize = 100;
    if (sp.has('pageSize')) {
      const n = Number(sp.get('pageSize'));
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        throw ERR.invalid('pageSize', `Invalid value '${sp.get('pageSize')}'. Values must be within the range: [1, 1000]`);
      }
      pageSize = n;
    }
    pageSize = Math.min(pageSize, options.maxPageSize);
    const q = sp.get('q') || '';
    let ast;
    try {
      ast = parseQuery(q);
    } catch {
      throw ERR.invalid('q');
    }
    const orderBy = sp.get('orderBy') || '';
    const cmp = makeComparator(orderBy);
    const rkeys = parseResourceKeys(req.headers[RESOURCE_KEY_HEADER]);
    const signature = sig(q, orderBy, auth.mode);
    let offset = 0;
    if (sp.get('pageToken')) {
      try {
        const tok = JSON.parse(Buffer.from(sp.get('pageToken'), 'base64url').toString('utf8'));
        if (tok.s !== signature || !Number.isInteger(tok.o) || tok.o < 0) throw new Error('mismatch');
        offset = tok.o;
      } catch {
        throw ERR.invalid('pageToken');
      }
    }
    // parent folders named in q must exist and be accessible
    const parentIds = positiveParentIds(ast).map((id) => id ?? myDriveId);
    const grantedParents = new Set();
    for (const pid of parentIds) {
      if (pid === myDriveId) {
        if (auth.mode === 'bearer') grantedParents.add(pid);
        else if (options.inaccessibleList !== 'empty') throw ERR.notFound(MYDRIVE_ALIAS);
        continue;
      }
      const pf = state.files.get(pid);
      if (!canAccess(pf, auth, rkeys)) {
        if (options.inaccessibleList === 'empty' && auth.mode === 'key') continue;
        throw ERR.notFound(pid);
      }
      grantedParents.add(pid);
    }
    const all = [];
    for (const f of state.files.values()) {
      if (!visible(f)) continue;
      if (!evalQuery(ast, f, myDriveId)) continue;
      if (auth.mode === 'key') {
        if (!f._test?.public) continue;
        const viaParent = (f.parents || []).some((p) => grantedParents.has(p));
        if (f.resourceKey && !viaParent && !rkeys.has(`${f.id}/${f.resourceKey}`)) continue;
      }
      all.push(f);
    }
    all.sort(cmp);
    const page = all.slice(offset, offset + pageSize);
    const host = req.headers.host || `${options.host}:${state.port}`;
    const resp = { kind: 'drive#fileList', incompleteSearch: false, files: page.map((f) => publicView(f, host)) };
    if (offset + pageSize < all.length) {
      resp.nextPageToken = b64url(JSON.stringify({ o: offset + pageSize, s: signature }));
    }
    // keep the real key order: nextPageToken, kind, incompleteSearch, files
    const ordered = {};
    for (const k of ['nextPageToken', 'kind', 'incompleteSearch', 'files']) if (k in resp) ordered[k] = resp[k];
    sendJson(req, res, 200, selectFields(ordered, tree));
  }

  function handleGet(req, res, u, auth, id) {
    const sp = u.searchParams;
    const alt = sp.get('alt') || 'json';
    if (!['json', 'media'].includes(alt)) throw ERR.invalid('alt');
    const rkeys = parseResourceKeys(req.headers[RESOURCE_KEY_HEADER]);
    const f = state.files.get(id);
    if (!canAccess(f, auth, rkeys)) throw ERR.notFound(id);
    if (alt === 'json') {
      const tree = fieldsFor(sp.get('fields'), FILE_SCHEMA, DEFAULT_FILE_FIELDS);
      const host = req.headers.host || `${options.host}:${state.port}`;
      sendJson(req, res, 200, selectFields(publicView(f, host), tree));
      return;
    }
    // ---- alt=media ----
    if (!f._test?.path) throw ERR.notDownloadable();
    const fail = state.fails.get(id);
    if (fail && fail.remaining > 0) {
      fail.remaining -= 1;
      if (fail.remaining <= 0) state.fails.delete(id);
      throw ERR.injected(fail.status);
    }
    const file = path.join(options.fixturesDir, f._test.path);
    const size = fs.statSync(file).size;
    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') throw ERR.rangeNotSatisfiable(size);
    const md5b64 = f.md5Checksum ? Buffer.from(f.md5Checksum, 'hex').toString('base64') : undefined;
    const common = {
      'content-type': f.mimeType,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=0, must-revalidate',
      'x-goog-hash': md5b64 ? `md5=${md5b64}` : undefined,
      'x-goog-stored-content-length': String(size),
      'last-modified': new Date(f.modifiedTime).toUTCString(),
    };
    let status = 200;
    let start = 0;
    let end = size - 1;
    if (range) {
      status = 206;
      ({ start, end } = range);
      common['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    common['content-length'] = String(size === 0 ? 0 : end - start + 1);
    res.writeHead(status, finalize(req, baseHeaders(req, common)));
    if (req.method === 'HEAD' || size === 0) { res.end(); return; }
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  function handleThumb(req, res, u) {
    const m = /^\/thumb\/([^/=]+)(?:=(.*))?$/.exec(decodeURIComponent(u.pathname));
    const fail404 = () => {
      const body = Buffer.from('Not Found');
      res.writeHead(404, finalize(req, baseHeaders(req, { 'content-type': 'text/html; charset=UTF-8', 'content-length': String(body.length), 'access-control-allow-origin': req.headers.origin || '*' })));
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (!m) return fail404();
    const [, id, spec = ''] = m;
    if (options.thumbAuth === 'required') {
      const h = req.headers.authorization;
      const token = h ? (/^Bearer\s+(.*)$/i.exec(h)?.[1] || '') : u.searchParams.get('access_token');
      if (!token || !state.tokens.has(token)) {
        const body = Buffer.from('Forbidden');
        res.writeHead(403, finalize(req, baseHeaders(req, { 'content-type': 'text/html; charset=UTF-8', 'content-length': String(body.length), 'access-control-allow-origin': req.headers.origin || '*' })));
        res.end(req.method === 'HEAD' ? undefined : body);
        return undefined;
      }
    }
    const f = get(id);
    if (!f || !f.hasThumbnail || !f._test?.thumbs) return fail404();
    let n = 220;
    const s = /(?:^|-)s(\d+)/.exec(spec);
    const w = /(?:^|-)w(\d+)/.exec(spec);
    const hh = /(?:^|-)h(\d+)/.exec(spec);
    if (s) n = Number(s[1]);
    else if (w || hh) n = Math.max(Number(w?.[1] || 0), Number(hh?.[1] || 0));
    const which = n > 0 && n <= 220 ? 's220' : 's1024';
    const file = path.join(options.fixturesDir, f._test.thumbs[which]);
    const body = fs.readFileSync(file);
    res.writeHead(200, finalize(req, baseHeaders(req, {
      'content-type': 'image/jpeg',
      'content-length': String(body.length),
      'cache-control': 'private, max-age=86400, no-transform',
      'access-control-allow-origin': req.headers.origin || '*',
    })));
    res.end(req.method === 'HEAD' ? undefined : body);
    return undefined;
  }

  // ---------------- admin ----------------
  async function handleAdmin(req, res, u) {
    const route = u.pathname.replace(/^\/__admin\/?/, '');
    const sp = u.searchParams;
    const post = req.method === 'POST';
    const body = post ? await readBody(req) : {};
    const ok = (extra = {}) => sendJson(req, res, 200, { ok: true, ...extra });
    const need = (cond) => { if (!cond) throw ERR.methodNotAllowed(); };
    const idParam = () => {
      const id = sp.get('id') || body.id;
      if (!id || !state.files.has(id)) throw ERR.notFound(id || '');
      return id;
    };
    switch (route) {
      case 'health': return ok({ url: state.url });
      case 'reveal': { need(post); const id = idParam(); state.files.get(id)._test.hiddenUntilRevealed = false; return ok({ id }); }
      case 'reveal-all': {
        need(post);
        const ids = [];
        for (const f of state.files.values()) if (f._test?.hiddenUntilRevealed) { f._test.hiddenUntilRevealed = false; ids.push(f.id); }
        return ok({ ids });
      }
      case 'hide': { need(post); const id = idParam(); state.files.get(id)._test.hiddenUntilRevealed = true; return ok({ id }); }
      case 'trash': case 'untrash': {
        need(post);
        const id = idParam();
        const f = state.files.get(id);
        f.trashed = route === 'trash';
        f.explicitlyTrashed = f.trashed;
        return ok({ id, trashed: f.trashed });
      }
      case 'delete': { need(post); const id = idParam(); state.files.get(id)._deleted = true; return ok({ id }); }
      case 'tokens':
        if (post) {
          if (!Array.isArray(body.tokens)) throw ERR.invalid('tokens', 'body must be {"tokens":[...]}');
          state.tokens = new Set(body.tokens.map(String));
        }
        return ok({ tokens: [...state.tokens] });
      case 'keys':
        if (post) {
          if (!Array.isArray(body.keys)) throw ERR.invalid('keys', 'body must be {"keys":[...]}');
          state.keys = new Set(body.keys.map(String));
        }
        return ok({ keys: [...state.keys] });
      case 'reset': need(post); reset(); return ok();
      case 'log':
        if (post) throw ERR.methodNotAllowed();
        return sendJson(req, res, 200, state.log);
      case 'log/clear': need(post); state.log = []; return ok();
      case 'latency': {
        if (post) {
          const ms = Number(sp.get('ms') ?? body.ms ?? 0);
          if (!Number.isFinite(ms) || ms < 0) throw ERR.invalid('ms');
          state.latencyMs = ms;
        }
        return ok({ ms: state.latencyMs });
      }
      case 'fail': {
        need(post);
        const id = sp.get('id') || body.id;
        if (!id) throw ERR.invalid('id');
        const status = Number(sp.get('status') ?? body.status ?? 500);
        const times = Number(sp.get('times') ?? body.times ?? 1);
        if (times <= 0) state.fails.delete(id); else state.fails.set(id, { status, remaining: times });
        return ok({ id, status, times });
      }
      case 'state':
        return sendJson(req, res, 200, {
          tokens: [...state.tokens], keys: [...state.keys], latencyMs: state.latencyMs,
          maxPageSize: options.maxPageSize, thumbAuth: options.thumbAuth,
          inaccessibleList: options.inaccessibleList,
          hidden: [...state.files.values()].filter((f) => f._test?.hiddenUntilRevealed).map((f) => f.id),
          fails: Object.fromEntries(state.fails), logLength: state.log.length,
        });
      case 'manifest':
        return sendJson(req, res, 200, manifest);
      default:
        return sendJson(req, res, 404, { error: { code: 404, message: `unknown admin endpoint ${route}` } });
    }
  }

  // ---------------- dispatcher ----------------
  async function handle(req, res) {
    const u = new URL(req.url, 'http://mock.local');
    const isAdmin = u.pathname.startsWith('/__admin');
    const auth = { kind: 'none' };
    let entry = null;
    if (!isAdmin) {
      entry = {
        method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams),
        range: req.headers.range || null, auth: 'none', authOk: false, status: null,
        ts: new Date().toISOString(), resourceKeys: req.headers[RESOURCE_KEY_HEADER] || null,
        origin: req.headers.origin || null,
      };
      state.log.push(entry);
      if (state.log.length > options.logLimit) state.log.splice(0, state.log.length - options.logLimit);
      res.on('finish', () => {
        entry.status = res.statusCode;
        entry.durationMs = Date.now() - Date.parse(entry.ts);
        if (options.verbose) {
          console.log(`${entry.method} ${req.url} → ${res.statusCode} [${entry.auth}${entry.range ? ` ${entry.range}` : ''}]`);
        }
      });
    }
    try {
      if (req.method === 'OPTIONS') {
        const headers = baseHeaders(req, {
          'access-control-allow-origin': req.headers.origin || '*',
          'access-control-allow-methods': isAdmin ? 'GET,HEAD,POST,OPTIONS' : 'GET,HEAD,OPTIONS',
          'access-control-allow-headers': req.headers['access-control-request-headers'] || undefined,
          'access-control-max-age': '3600',
          'content-length': '0',
          'content-type': 'text/html; charset=UTF-8',
        });
        if (!isAdmin && state.latencyMs) await sleep(state.latencyMs);
        res.writeHead(200, finalize(req, headers));
        res.end();
        return;
      }
      if (isAdmin) { await handleAdmin(req, res, u); return; }
      if (state.latencyMs) await sleep(state.latencyMs);
      if (u.pathname.startsWith('/thumb/')) {
        if (!['GET', 'HEAD'].includes(req.method)) throw ERR.methodNotAllowed();
        handleThumb(req, res, u);
        return;
      }
      const m = /^\/drive\/v3\/files(?:\/([^/]+))?\/?$/.exec(u.pathname);
      if (!m) {
        const body = Buffer.from('<!DOCTYPE html><title>Error 404 (Not Found)</title><p>The requested URL was not found on this server.</p>');
        res.writeHead(404, finalize(req, baseHeaders(req, { 'content-type': 'text/html; charset=UTF-8', 'content-length': String(body.length) })));
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw ERR.methodNotAllowed();
      const a = authenticate(req, u);
      entry.auth = a.kind;
      entry.authOk = !a.error;
      if (a.error) throw a.error;
      Object.assign(auth, a);
      if (m[1] === undefined) handleList(req, res, u, auth);
      else handleGet(req, res, u, auth, decodeURIComponent(m[1]));
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof ApiError) { sendError(req, res, err); return; }
      console.error('[mock-drive] internal error', err);
      sendError(req, res, new ApiError(500, gErr(500, 'Internal Error', { reason: 'backendError' })));
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => { server.off('error', reject); resolve(); });
  });
  const port = server.address().port;
  const hostForUrl = options.host.includes(':') ? `[${options.host}]` : options.host;
  const url = `http://${hostForUrl === '0.0.0.0' ? '127.0.0.1' : hostForUrl}:${port}`;
  state.port = port;
  state.url = url;

  return {
    url,
    port,
    server,
    manifest,
    state,
    options,
    admin: adminClient(url),
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

/** Small fetch-based client for the /__admin endpoints. */
export function adminClient(baseUrl) {
  const call = async (method, p, body) => {
    const r = await fetch(baseUrl + p, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json();
    if (!r.ok) throw new Error(`admin ${p} → ${r.status}: ${JSON.stringify(json)}`);
    return json;
  };
  const q = encodeURIComponent;
  return {
    reveal: (id) => call('POST', `/__admin/reveal?id=${q(id)}`),
    revealAll: () => call('POST', '/__admin/reveal-all'),
    hide: (id) => call('POST', `/__admin/hide?id=${q(id)}`),
    trash: (id) => call('POST', `/__admin/trash?id=${q(id)}`),
    untrash: (id) => call('POST', `/__admin/untrash?id=${q(id)}`),
    remove: (id) => call('POST', `/__admin/delete?id=${q(id)}`),
    setTokens: (tokens) => call('POST', '/__admin/tokens', { tokens }),
    setKeys: (keys) => call('POST', '/__admin/keys', { keys }),
    reset: () => call('POST', '/__admin/reset'),
    log: () => call('GET', '/__admin/log'),
    clearLog: () => call('POST', '/__admin/log/clear'),
    setLatency: (ms) => call('POST', `/__admin/latency?ms=${q(ms)}`),
    fail: (id, status = 500, times = 1) => call('POST', `/__admin/fail?id=${q(id)}&status=${q(status)}&times=${q(times)}`),
    state: () => call('GET', '/__admin/state'),
    manifest: () => call('GET', '/__admin/manifest'),
  };
}

// --------------------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=', 2);
    const next = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    out[k] = next;
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log('usage: node tests/mock-drive/server.mjs [--port 8787] [--host 127.0.0.1] '
      + '[--fixtures tests/fixtures/out] [--max-page-size N] [--thumb-auth none|required] '
      + '[--tokens a,b] [--keys K1,K2] [--latency MS] [--inaccessible-list 404|empty] [--verbose]');
    process.exit(0);
  }
  const split = (v) => (v === undefined ? undefined : String(v).split(',').map((s) => s.trim()).filter(Boolean));
  try {
    const srv = await startMockDrive({
      port: a.port !== undefined ? Number(a.port) : 8787,
      host: a.host,
      fixturesDir: a.fixtures ? path.resolve(a.fixtures) : undefined,
      maxPageSize: a['max-page-size'] !== undefined ? Number(a['max-page-size']) : undefined,
      thumbAuth: a['thumb-auth'],
      tokens: split(a.tokens),
      keys: split(a.keys),
      latencyMs: a.latency !== undefined ? Number(a.latency) : undefined,
      inaccessibleList: a['inaccessible-list'],
      verbose: a.verbose === 'true',
    });
    console.log(`Mock Drive API listening on ${srv.url}  (fixtures: ${srv.options.fixturesDir}, `
      + `maxPageSize ${srv.options.maxPageSize}, thumbAuth ${srv.options.thumbAuth})`);
    const stop = () => srv.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
