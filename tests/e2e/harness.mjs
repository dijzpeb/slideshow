// E2E harness: static server for the app + in-process mock Drive API + Playwright helpers.
//
//   import { startServers } from './harness.mjs';
//   const env = await startServers({ appPort: 0, drivePort: 0, maxPageSize: 4 });
//   // env.appUrl, env.driveUrl, env.admin.reveal('img_hidden_berries'), env.manifest ...
//   await env.close();
//
// CLI (manual testing):  node tests/e2e/harness.mjs [--app-port 8080] [--drive-port 8787] [--max-page-size 4]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startMockDrive, adminClient, DEFAULT_FIXTURES_DIR } from '../mock-drive/server.mjs';
import { addLocalOriginsToCsp, apiBaseOrigin } from '../../scripts/dev-csp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, '../..');
export const FIXTURES_DIR = DEFAULT_FIXTURES_DIR;
export const GENERATOR = path.resolve(HERE, '../fixtures/generate.py');
export const TEST_TOKEN = 'test-token';
export const TEST_KEY = 'TESTKEY';
export { adminClient };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/**
 * Minimal static file server (no cache, directory → index.html, correct MIME types).
 * HTML pages keep their Content-Security-Policy meta, extended (connect-src, img-src, media-src) with the
 * loopback origins from `cspOrigins()` and the page's own `?apiBase=` (scripts/dev-csp.mjs), so the app
 * runs under its production CSP while talking to the local mock.
 * @param {object} [o]
 * @param {() => string[]} [o.cspOrigins] extra (loopback) origins for the CSP, e.g. the mock Drive URL
 * @returns {Promise<{url:string, port:number, server:http.Server, close:()=>Promise<void>}>}
 */
export async function startStaticServer({ root = APP_ROOT, port = 0, host = '127.0.0.1', cspOrigins = () => [] } = {}) {
  const rootAbs = path.resolve(root);
  const server = http.createServer((req, res) => {
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'Method Not Allowed');
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return send(400, 'Bad Request');
    }
    if (pathname.includes('\0')) return send(400, 'Bad Request');
    let file = path.resolve(rootAbs, '.' + pathname);
    if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) return send(403, 'Forbidden');
    let st;
    try {
      st = fs.statSync(file);
      if (st.isDirectory()) {
        if (!pathname.endsWith('/')) {
          res.writeHead(301, { location: pathname + '/' + (new URL(req.url, 'http://x').search), 'cache-control': 'no-store' });
          return res.end();
        }
        file = path.join(file, 'index.html');
        st = fs.statSync(file);
      }
    } catch {
      return send(404, 'Not Found');
    }
    const ext = path.extname(file).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
      let html;
      try {
        html = fs.readFileSync(file, 'utf8');
      } catch {
        return send(404, 'Not Found');
      }
      const body = Buffer.from(addLocalOriginsToCsp(html, [...cspOrigins(), apiBaseOrigin(req.url)].filter(Boolean)));
      res.writeHead(200, { 'content-type': MIME[ext], 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    return undefined;
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const actual = server.address().port;
  return {
    url: `http://${host}:${actual}`,
    port: actual,
    server,
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

/** Load tests/fixtures/out/manifest.json (generating the fixtures first if missing). */
export function loadManifest(fixturesDir = FIXTURES_DIR) {
  ensureFixtures({ fixturesDir });
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf8'));
}

/** Run the Python generator when manifest.json is missing (or always with force). */
export function ensureFixtures({ fixturesDir = FIXTURES_DIR, force = false } = {}) {
  if (!force && fs.existsSync(path.join(fixturesDir, 'manifest.json'))) return;
  const r = spawnSync('python3', [GENERATOR, '--out', fixturesDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`fixture generation failed (exit ${r.status}); run: python3 tests/fixtures/generate.py`);
}

/**
 * Start the app static server and the mock Drive API.
 * @param {object} [o]
 * @param {number} [o.appPort=0]     0 = ephemeral
 * @param {number} [o.drivePort=0]   0 = ephemeral
 * @param {string} [o.host='127.0.0.1']
 * @param {string} [o.appRoot]       defaults to the repository root
 * @param {string} [o.fixturesDir]   defaults to tests/fixtures/out
 * @param {number} [o.maxPageSize]   cap Drive page size (forces pagination)
 * @param {object} [o.driveOptions]  extra startMockDrive() options (thumbAuth, tokens, keys, latencyMs, ...)
 */
export async function startServers({
  appPort = 0, drivePort = 0, host = '127.0.0.1', appRoot = APP_ROOT,
  fixturesDir = FIXTURES_DIR, maxPageSize, driveOptions = {},
} = {}) {
  ensureFixtures({ fixturesDir });
  let drive;
  // the CSP of index.html is extended with the mock's origin (thumbnails, media) and the page's ?apiBase=
  const app = await startStaticServer({ root: appRoot, port: appPort, host, cspOrigins: () => (drive ? [drive.url] : []) });
  try {
    drive = await startMockDrive({ port: drivePort, host, fixturesDir, maxPageSize, ...driveOptions });
  } catch (e) {
    await app.close();
    throw e;
  }
  return {
    appUrl: app.url,
    driveUrl: drive.url,
    app,
    drive,
    admin: drive.admin,
    manifest: drive.manifest,
    /** URL of the app pointed at the mock (the app honours ?apiBase= on localhost). */
    appUrlFor(params = {}) {
      const u = new URL(app.url + '/');
      u.searchParams.set('apiBase', drive.url);
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
      return u.toString();
    },
    close: async () => { await Promise.all([app.close(), drive.close()]); },
  };
}

// --------------------------------------------------------------------------------------
// Playwright helpers
// --------------------------------------------------------------------------------------

/** require('playwright') from an ES module (works with a global install / NODE_PATH). */
export function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const candidates = ['playwright', 'playwright-core', '@playwright/test'];
  const extra = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of candidates) {
    try { return req(name); } catch { /* try next */ }
    for (const dir of extra) {
      try { return createRequire(path.join(dir, 'noop.js'))(name); } catch { /* next */ }
    }
  }
  throw new Error('playwright not found (npm i -D playwright, or set NODE_PATH to the global node_modules)');
}

/**
 * Redirect real Google endpoints to the mock, for running the unmodified app.
 * Covers www.googleapis.com/drive/** and content.googleapis.com/drive/**.
 * (CORS preflights for intercepted requests are answered by Playwright itself.)
 * @param {import('playwright').BrowserContext|import('playwright').Page} target
 */
export async function routeGoogleApis(target, driveUrl, { hosts = ['www.googleapis.com', 'content.googleapis.com'] } = {}) {
  const pattern = new RegExp(`^https://(${hosts.map((h) => h.replace(/\./g, '\\.')).join('|')})/drive/`);
  await target.route(pattern, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const to = driveUrl.replace(/\/+$/, '') + u.pathname + u.search;
    const headers = { ...req.headers() };
    let origin = headers.origin;
    if (!origin) {
      try { origin = new URL(req.frame().url()).origin; } catch { origin = undefined; }
    }
    if (origin && origin !== 'null') headers.origin = origin;
    try {
      const resp = await route.fetch({ url: to, headers, maxRedirects: 0 });
      const h = { ...resp.headers() };
      if (origin) h['access-control-allow-origin'] = origin;
      await route.fulfill({ response: resp, headers: h });
    } catch (e) {
      await route.abort('failed').catch(() => {});
    }
  });
}

/** Ids in the slideshow order the app should produce. variant: default | reveal | canonFix | true */
export function expectedOrder(manifest, variant = 'default', { skipOptional = false } = {}) {
  const key = { default: 'expectedOrderDefault', reveal: 'expectedOrderWithReveal', canonFix: 'expectedOrderCanonFix', true: 'expectedOrderTrue' }[variant];
  if (!key) throw new Error(`unknown variant ${variant}`);
  const ids = manifest[key];
  return skipOptional ? ids.filter((id) => !manifest.optionalIds.includes(id)) : ids;
}

/** Map of id → Drive file record (with `_test`). */
export function filesById(manifest) {
  return Object.fromEntries(manifest.files.map((f) => [f.id, f]));
}

// --------------------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const env = await startServers({
    appPort: Number(opt('app-port', 8080)),
    drivePort: Number(opt('drive-port', 8787)),
    maxPageSize: opt('max-page-size') ? Number(opt('max-page-size')) : undefined,
    driveOptions: { verbose: args.includes('--verbose'), thumbAuth: opt('thumb-auth', 'none') },
  });
  console.log(`app:   ${env.appUrl}/`);
  console.log(`drive: ${env.driveUrl}`);
  console.log(`open:  ${env.appUrlFor({ folder: env.manifest.rootFolderId, key: TEST_KEY })}`);
  const stop = () => env.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
