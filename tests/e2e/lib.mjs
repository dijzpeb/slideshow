// Shared helpers for the Playwright E2E suite (tests/e2e/*.test.mjs).
// Not a test file itself (node --test only picks up *.test.mjs).
//
//   const suite = await openSuite({ maxPageSize: 4 });       // servers + Chromium (per test file)
//   const app = await suite.newApp({ params: { folder: 'folder_root' }, settings: { videoMaxSeconds: 2 } });
//   await app.waitForPlayer();
//   ... assertions on app.page / suite.env.admin.log() ...
//   await app.close(); await suite.close();
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startServers, loadPlaywright, expectedOrder, filesById, TEST_KEY, TEST_TOKEN } from './harness.mjs';

export { expectedOrder, filesById, TEST_KEY, TEST_TOKEN, assert };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = path.join(HERE, 'out');
export const SETTINGS_KEY = 'finland-slideshow.settings.v1';
export const META_CACHE_KEY = 'finland-slideshow.meta.v1';

/** Settings seeded into localStorage (only if nothing is stored yet) so every test runs fast. */
export const FAST_SETTINGS = Object.freeze({
  photoSeconds: 1,
  videoMaxSeconds: 2,
  transition: 'fade',
  kenBurns: true,
  blurBackground: true,
  refreshMinutes: 0,
});

/** Minimal stand-in for Google Identity Services (token model). */
export const GIS_STUB = `
(() => {
  window.__gis = { requests: [], inits: 0 };
  window.google = window.google || {};
  window.google.accounts = window.google.accounts || {};
  window.google.accounts.oauth2 = {
    initTokenClient(cfg) {
      window.__gis.inits++;
      window.__gis.clientId = cfg.client_id;
      window.__gis.scope = cfg.scope;
      return {
        requestAccessToken(o) {
          window.__gis.requests.push(o || {});
          const token = window.__nextToken || 'test-token';
          if (window.__nextTokenError) {
            const err = window.__nextTokenError;
            window.__nextTokenError = null;
            setTimeout(() => (err.type ? cfg.error_callback && cfg.error_callback(err) : cfg.callback(err)), 0);
            return;
          }
          setTimeout(() => cfg.callback({ access_token: token, expires_in: window.__nextExpiresIn || 3599,
            scope: 'https://www.googleapis.com/auth/drive.readonly', token_type: 'Bearer' }), 0);
        },
      };
    },
    hasGrantedAllScopes() { return true; },
    revoke(t, cb) { cb && cb({ successful: true }); },
  };
})();`;

/**
 * Init script installed in every page: records which slides became visible (in order),
 * toasts, video progress, and samples the corner colour of each displayed photo.
 */
const RECORDER = `
(() => {
  window.__slideLog = [];
  window.__toasts = [];
  window.__video = {};
  const seen = new WeakSet();
  function sample(el, entry) {
    const img = el.querySelector('img.photo');
    if (!img) return;
    const go = () => {
      try {
        entry.src = img.currentSrc || img.src;
        entry.nw = img.naturalWidth; entry.nh = img.naturalHeight;
        const c = document.createElement('canvas');
        c.width = 1; c.height = 1;
        const g = c.getContext('2d');
        // a pixel 3 % in from the top-left corner (outer 10 % of every fixture is background)
        g.drawImage(img, Math.floor(img.naturalWidth * 0.03), Math.floor(img.naturalHeight * 0.03), 1, 1, 0, 0, 1, 1);
        entry.color = Array.from(g.getImageData(0, 0, 1, 1).data.slice(0, 3));
      } catch (e) { entry.colorError = String(e && e.message || e); }
    };
    if (img.complete && img.naturalWidth) go(); else img.addEventListener('load', go, { once: true });
  }
  function check(el) {
    if (!el || el.nodeType !== 1 || !el.classList.contains('slide') || !el.classList.contains('visible') || seen.has(el)) return;
    seen.add(el);
    const entry = { kind: el.dataset.kind || (el.classList.contains('slide-message') ? 'message' : '?'),
      id: el.dataset.id || null, day: el.dataset.day || null, t: performance.now(),
      cls: el.className, text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) };
    const cap = document.querySelector('#player .caption');
    entry.caption = cap ? cap.textContent : '';
    if (el.querySelector('iframe.drive-embed')) entry.embed = el.querySelector('iframe.drive-embed').src;
    if (el.classList.contains('slide-video-fallback')) entry.fallback = true;
    const v = el.querySelector('video');
    if (v) entry.videoSrc = v.currentSrc || v.src;
    window.__slideLog.push(entry);
    sample(el, entry);
  }
  function onVideo(e) {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    const host = v.closest('[data-id]');
    const id = host ? host.dataset.id : '?';
    const r = window.__video[id] || (window.__video[id] = { maxTime: 0, events: [], src: '', videoWidth: 0, muted: null });
    r.maxTime = Math.max(r.maxTime, v.currentTime || 0);
    r.src = v.currentSrc || v.src || r.src;
    r.videoWidth = Math.max(r.videoWidth, v.videoWidth || 0);
    r.muted = v.muted;
    if (e.type !== 'timeupdate' && r.events.length < 50) r.events.push(e.type);
  }
  for (const type of ['timeupdate', 'playing', 'loadeddata', 'ended', 'error', 'pause'])
    document.addEventListener(type, onVideo, true);
  document.addEventListener('DOMContentLoaded', () => {
    const player = document.getElementById('player');
    if (!player) return; // other documents (e.g. the Drive preview iframe)
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') check(m.target);
        else for (const n of m.addedNodes) check(n);
      }
    }).observe(player, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.id === 'toasts') for (const t of n.children) window.__toasts.push({ text: t.textContent, cls: t.className, t: performance.now() });
        else if (n.classList.contains('toast')) window.__toasts.push({ text: n.textContent, cls: n.className, t: performance.now() });
      }
    }).observe(document.body, { subtree: true, childList: true });
  });
})();`;

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** true when the sampled colour is within `tol` of the fixture background colour */
export function colorNear(rgb, hex, tol = 28) {
  if (!rgb) return false;
  const want = hexToRgb(hex);
  return rgb.every((v, i) => Math.abs(v - want[i]) <= tol);
}

/** Collapse consecutive duplicates (a failed video is swapped for its fallback with the same id). */
export function dedupeSlides(log) {
  const out = [];
  for (const e of log) {
    const key = `${e.kind}|${e.id || e.day || ''}`;
    const prev = out[out.length - 1];
    if (prev && `${prev.kind}|${prev.id || prev.day || ''}` === key) continue;
    out.push(e);
  }
  return out;
}

export function safeName(s) {
  return String(s).replace(/[^\w.-]+/g, '_').slice(0, 120);
}

/**
 * Start the servers and Chromium for one test file.
 * @param {object} [o]
 * @param {number} [o.maxPageSize]
 * @param {object} [o.driveOptions]
 */
export async function openSuite({ maxPageSize, driveOptions } = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const env = await startServers({ appPort: 0, drivePort: 0, maxPageSize, driveOptions });
  const { chromium } = loadPlaywright();
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    await env.close();
    throw e;
  }
  const byId = filesById(env.manifest);
  const apps = new Set();

  /**
   * New isolated browser context + page with the recorder, GIS stub and drive.google.com stub.
   * @param {object} [o]
   * @param {object} [o.params]      app URL parameters (apiBase is added automatically)
   * @param {object|null} [o.settings] localStorage settings seeded before the first load (merged over FAST_SETTINGS)
   * @param {object} [o.contextOptions] extra browser.newContext() options
   * @param {boolean} [o.navigate=true]
   */
  async function newApp({ params = {}, settings = {}, contextOptions = {}, navigate = true } = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...contextOptions });
    const errors = [];
    const consoleMsgs = [];
    const previewRequests = [];
    const gisLoads = [];
    if (settings !== null) {
      const seeded = JSON.stringify({ ...FAST_SETTINGS, ...settings });
      await context.addInitScript(({ key, value }) => {
        try {
          if (!localStorage.getItem(key)) localStorage.setItem(key, value);
        } catch { /* ignore */ }
      }, { key: SETTINGS_KEY, value: seeded });
    }
    await context.addInitScript(RECORDER);
    await context.route('https://accounts.google.com/gsi/client', (route) => {
      gisLoads.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: GIS_STUB });
    });
    await context.route('https://drive.google.com/**', (route) => {
      previewRequests.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body style="margin:0;background:#202020;color:#eee;font:20px sans-serif">Drive preview stub</body></html>',
      });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e && e.stack ? e.stack : e)));
    page.on('console', (m) => consoleMsgs.push({ type: m.type(), text: m.text() }));
    const app = {
      context,
      page,
      errors,
      consoleMsgs,
      previewRequests,
      gisLoads,
      url: env.appUrlFor(params),
      async goto(p = params) {
        app.url = env.appUrlFor(p);
        await page.goto(app.url);
      },
      /** wait until the player screen shows (and the item list is built) */
      async waitForPlayer(timeout = 30000) {
        await page.waitForFunction(() => window.__slideshow && window.__slideshow.screen === 'player' && window.__slideshow.items.length > 0, null, { timeout });
      },
      itemIds: () => page.evaluate(() => window.__slideshow.items.map((i) => i.id)),
      items: () => page.evaluate(() => window.__slideshow.items.map((i) => ({ id: i.id, epoch: i.epoch, iso: new Date(i.epoch).toISOString(), timeSource: i.timeSource, group: i.group, kind: i.kind, day: i.day, offsetMinutes: i.offsetMinutes }))),
      slideLog: () => page.evaluate(() => window.__slideLog.map((e) => ({ ...e }))),
      toasts: () => page.evaluate(() => window.__toasts.map((e) => ({ ...e }))),
      videoInfo: () => page.evaluate(() => JSON.parse(JSON.stringify(window.__video))),
      /** {kind,id} of the newest visible slide */
      current: () => page.evaluate(() => {
        const els = [...document.querySelectorAll('#player .slide.visible:not(.leaving)')];
        const el = els[els.length - 1];
        const p = window.__slideshow.player;
        return {
          kind: el ? el.dataset.kind || null : null,
          id: el ? el.dataset.id || null : null,
          day: el ? el.dataset.day || null : null,
          index: p ? p.index : -1,
          slideKey: p && p.slides[p.index] ? p.slides[p.index].key : null,
          playing: p ? p.playing : null,
        };
      }),
      /** wait until a slide with the given media id (or kind) is the visible one */
      async waitForSlide({ id, kind, day } = {}, timeout = 20000) {
        await page.waitForFunction(({ id, kind, day }) => {
          const els = [...document.querySelectorAll('#player .slide.visible:not(.leaving)')];
          const el = els[els.length - 1];
          if (!el) return false;
          if (id && el.dataset.id !== id) return false;
          if (kind && el.dataset.kind !== kind) return false;
          if (day && el.dataset.day !== day) return false;
          return true;
        }, { id, kind, day }, { timeout });
      },
      /** wait until the slide log contains an entry matching pred (serialisable function source) */
      async waitForLog(predSrc, timeout = 30000) {
        await page.waitForFunction((src) => {
          const pred = new Function('e', `return (${src})(e);`);
          return window.__slideLog.some((e) => pred(e));
        }, predSrc, { timeout });
      },
      /** OAuth flow: open the setup page in OAuth mode and press 「スライドショーを開始」 (GIS is stubbed) */
      async startOAuth(folder, extra = {}) {
        await app.goto({ mode: 'oauth', clientId: 'test-client', folder, interval: 1, ...extra });
        await page.waitForSelector('#setup:not([hidden])');
        await page.click('#btn-start');
        await app.waitForPlayer();
      },
      /** open the grid with the G key and click the tile of `id` */
      async jumpViaGrid(id) {
        await page.keyboard.press('g');
        await page.waitForSelector('#grid-overlay:not([hidden])');
        await page.click(`#grid-body .tile[data-id="${id}"]`);
        await page.waitForSelector('#grid-overlay', { state: 'hidden' });
        await app.waitForSlide({ id });
      },
      async screenshot(name) {
        const file = path.join(OUT_DIR, `${safeName(name)}.png`);
        await page.screenshot({ path: file }).catch(() => {});
        return file;
      },
      async close() {
        apps.delete(app);
        await context.close().catch(() => {});
      },
    };
    apps.add(app);
    if (navigate) await page.goto(app.url);
    return app;
  }

  return {
    env,
    browser,
    byId,
    manifest: env.manifest,
    admin: env.admin,
    newApp,
    /** test body wrapper: screenshots of every open page on failure */
    wrap(name, fn) {
      return withScreenshots(name, fn, () => [...apps]);
    },
    async close() {
      for (const a of [...apps]) await a.close();
      await browser.close().catch(() => {});
      await env.close();
    },
  };
}

/**
 * Wrap a test body: on failure save a screenshot of every open page (tests/e2e/out/FAIL-<name>-N.png).
 * @param {string} name
 * @param {(t:import('node:test').TestContext)=>Promise<void>} fn
 * @param {()=>Array<{page:any}>} pagesFn returns the apps to capture
 */
export function withScreenshots(name, fn, pagesFn) {
  return async (t) => {
    try {
      await fn(t);
    } catch (e) {
      const apps = (pagesFn && pagesFn()) || [];
      let n = 0;
      for (const a of apps) {
        if (!a || !a.page || a.page.isClosed()) continue;
        const file = path.join(OUT_DIR, `FAIL-${safeName(name)}-${n++}.png`);
        await a.page.screenshot({ path: file }).catch(() => {});
      }
      throw e;
    }
  };
}

/** Filter the mock request log. */
export function mediaRequests(log, id) {
  return log.filter((e) => e.path === `/drive/v3/files/${id}` && e.query && e.query.alt === 'media' && e.method === 'GET');
}

export function listRequests(log) {
  return log.filter((e) => e.path === '/drive/v3/files' && e.method === 'GET');
}

/** Assert no uncaught page errors were seen. */
export function assertNoPageErrors(app) {
  assert.deepEqual(app.errors, [], `uncaught page errors:\n${app.errors.join('\n')}`);
}

/** Pretty diff of two id arrays for assertion messages. */
export function orderDiff(actual, expected) {
  const lines = [];
  const n = Math.max(actual.length, expected.length);
  for (let i = 0; i < n; i++) {
    const a = actual[i];
    const b = expected[i];
    lines.push(`${String(i).padStart(3)} ${a === b ? ' ' : '≠'} ${String(a).padEnd(26)} ${b}`);
  }
  return `\n    actual                     expected\n${lines.join('\n')}`;
}

export function assertOrder(actual, expected, msg = 'order') {
  assert.deepEqual(actual, expected, `${msg}:${orderDiff(actual, expected)}`);
}

/** Expected default order of folder_root without the optional ids the app did not list. */
export function expectedFor(manifest, variant, actualIds) {
  const exp = expectedOrder(manifest, variant);
  return exp.filter((id) => !manifest.optionalIds.includes(id) || actualIds.includes(id));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Take a screenshot and return the RGB colour at each [x, y] (CSS pixels of the viewport). */
export async function screenPixels(page, points) {
  const b64 = (await page.screenshot()).toString('base64');
  return page.evaluate(async ({ b64, points }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const k = img.naturalWidth / window.innerWidth;
    return points.map(([x, y]) => Array.from(g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data.slice(0, 3)));
  }, { b64, points });
}

/**
 * Tiny reverse proxy in front of the mock that removes response headers (e.g. to emulate a
 * googleapis.com CORS response whose Content-Range is not exposed to JavaScript).
 * @returns {Promise<{url:string, close:()=>Promise<void>, requests:number}>}
 */
export async function startStrippingProxy(targetUrl, { strip = ['access-control-expose-headers'] } = {}) {
  const target = new URL(targetUrl);
  const stats = { requests: 0 };
  const server = http.createServer((req, res) => {
    stats.requests++;
    const up = http.request({
      host: target.hostname, port: target.port, method: req.method, path: req.url,
      headers: { ...req.headers, host: target.host },
    }, (ur) => {
      const headers = { ...ur.headers };
      for (const h of strip) delete headers[h];
      res.writeHead(ur.statusCode, headers);
      ur.pipe(res);
    });
    up.on('error', () => { res.destroy(); });
    req.pipe(up);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stats,
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

/** "7月12日（土） 12:05" for an ISO instant in a time zone (the app's caption format) */
export function jaDateTime(iso, timeZone = 'Europe/Helsinki') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  const wd = { Sun: '日', Mon: '月', Tue: '火', Wed: '水', Thu: '木', Fri: '金', Sat: '土' }[parts.weekday];
  return `${parts.month}月${parts.day}日（${wd}） ${parts.hour}:${parts.minute}`;
}
