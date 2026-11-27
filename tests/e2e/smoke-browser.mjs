#!/usr/bin/env node
// Browser smoke test: checks that the mock Drive behaves correctly for a real Chromium
// (CORS preflights, exposed headers, <img>/<video> loading, EXIF orientation, codecs)
// and that routeGoogleApis() works. Does not need the app.
//   node tests/e2e/smoke-browser.mjs      exits non-zero on failure
import assert from 'node:assert/strict';
import { startServers, loadPlaywright, routeGoogleApis, filesById, TEST_KEY, TEST_TOKEN } from './harness.mjs';

const { chromium } = loadPlaywright();
const env = await startServers({ maxPageSize: 4 });
const byId = filesById(env.manifest);
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e));
await page.goto(`${env.appUrl}/tests/e2e/blank.html`);

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  FAIL ${name}\n       ${String(e.stack || e).split('\n').slice(0, 6).join('\n       ')}`);
  }
}
const D = env.driveUrl;
const media = (id, extra = '') => `${D}/drive/v3/files/${id}?alt=media&supportsAllDrives=true&key=${TEST_KEY}${extra}`;
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

console.log(`chromium ${browser.version()}  app ${env.appUrl}  drive ${D}`);

await check('cors: bearer + Range from page (preflight), content-range readable', async () => {
  const r = await page.evaluate(async ({ D, TEST_TOKEN }) => {
    const res = await fetch(`${D}/drive/v3/files/vid_tram?alt=media`, { headers: { Authorization: `Bearer ${TEST_TOKEN}`, Range: 'bytes=0-1023' } });
    const buf = await res.arrayBuffer();
    return { status: res.status, cr: res.headers.get('content-range'), ct: res.headers.get('content-type'), len: buf.byteLength };
  }, { D, TEST_TOKEN });
  assert.equal(r.status, 206);
  assert.equal(r.cr, `bytes 0-1023/${byId.vid_tram.size}`);
  assert.equal(r.ct, 'video/mp4');
  assert.equal(r.len, 1024);
});
await check('cors: 401 www-authenticate and resource-key header readable/allowed', async () => {
  const r = await page.evaluate(async ({ D, TEST_KEY }) => {
    const a = await fetch(`${D}/drive/v3/files/img_lake`, { headers: { Authorization: 'Bearer expired' } });
    const b = await fetch(`${D}/drive/v3/files?q=${encodeURIComponent("'folder_reskey' in parents")}&fields=files(id,resourceKey)&key=${TEST_KEY}`,
      { headers: { 'X-Goog-Drive-Resource-Keys': 'folder_reskey/0-ABCdef' } });
    return { a: a.status, wa: a.headers.get('www-authenticate'), b: b.status, files: (await b.json()).files.length };
  }, { D, TEST_KEY });
  assert.equal(r.a, 401);
  assert.match(r.wa, /invalid_token/);
  assert.equal(r.b, 200);
  assert.equal(r.files, 2);
});
await check('img: JPEG via ?alt=media&key, EXIF orientation 6 auto-rotated, thumbnailLink', async () => {
  const r = await page.evaluate(async ({ a, b, t }) => {
    const load = (src) => new Promise((res) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => res({ ok: true, w: i.naturalWidth, h: i.naturalHeight });
      i.onerror = () => res({ ok: false });
      i.src = src;
    });
    return { normal: await load(a), rotated: await load(b), thumb: await load(t) };
  }, { a: media('img_city_square'), b: media('img_cathedral'), t: `${D}/thumb/img_cathedral=s220` });
  assert.deepEqual(r.normal, { ok: true, w: 1280, h: 853 });
  const exp = byId.img_cathedral._test.expected;
  assert.deepEqual(r.rotated, { ok: true, w: exp.displayWidth, h: exp.displayHeight });
  assert.equal(r.thumb.ok, true);
  assert.ok(r.thumb.h > r.thumb.w, 'thumbnail is upright (portrait)');
});
await check('img: HEIC is not decodable natively (app must fall back), its thumbnail is', async () => {
  const r = await page.evaluate(async ({ a, t }) => {
    const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(true); i.onerror = () => res(false); i.src = src; });
    return { heic: await load(a), thumb: await load(t) };
  }, { a: media('img_viewpoint_heic'), t: `${D}/thumb/img_viewpoint_heic=s220` });
  assert.equal(r.thumb, true);
  console.log(`       (native HEIC decode in this Chromium: ${r.heic})`);
});
await check('video: H.264 mp4 (moov at end), faststart mp4 and MOV play; HEVC reported', async () => {
  const r = await page.evaluate(async (srcs) => {
    const probe = (src) => new Promise((res) => {
      const v = document.createElement('video');
      v.muted = true;
      v.crossOrigin = 'anonymous';
      v.preload = 'auto';
      const done = (x) => { v.remove(); res(x); };
      v.onloadeddata = async () => {
        try { await v.play(); } catch { /* ignore */ }
        setTimeout(() => {
          const c = document.createElement('canvas');
          c.width = v.videoWidth; c.height = v.videoHeight;
          const g = c.getContext('2d');
          g.drawImage(v, 0, 0);
          const px = Array.from(g.getImageData(20, 20, 1, 1).data.slice(0, 3));
          done({ ok: true, w: v.videoWidth, h: v.videoHeight, d: Math.round(v.duration * 1000), t: v.currentTime, px });
        }, 400);
      };
      v.onerror = () => done({ ok: false, code: v.error && v.error.code });
      setTimeout(() => done({ ok: false, timeout: true }), 8000);
      document.body.appendChild(v);
      v.src = src;
    });
    const out = {};
    for (const [k, s] of Object.entries(srcs)) out[k] = await probe(s);
    return out;
  }, { tram: media('vid_tram'), ferry: media('vid_harbour_ferry'), mov: media('vid_deer_mov'), pxl: media('vid_pxl_bike'), hevc: media('vid_hevc') });
  for (const id of ['tram', 'ferry', 'mov', 'pxl']) {
    assert.equal(r[id].ok, true, `${id}: ${JSON.stringify(r[id])}`);
    assert.equal(r[id].w, 640);
    assert.ok(r[id].t > 0, `${id} did not advance`);
  }
  assert.ok(near(r.tram.px, hexToRgb(byId.vid_tram._test.bgColor), 24), `corner colour ${r.tram.px} vs ${byId.vid_tram._test.bgColor}`);
  assert.ok(near(r.mov.px, hexToRgb(byId.vid_deer_mov._test.bgColor), 24));
  // HEVC support depends on the Chromium build / platform decoders: informational only.
  // Playwright's Linux Chromium plays the AAC track but never decodes a frame
  // (videoWidth/videoHeight stay 0 and no 'error' event fires).
  const hevcVisible = r.hevc.ok && r.hevc.w > 0;
  console.log(`       (HEVC video visibly decodable in this Chromium: ${hevcVisible}; ${JSON.stringify(r.hevc)})`);
});
await check('image corner colour identifies the slide', async () => {
  const r = await page.evaluate(async (src) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.src = src;
    await i.decode();
    const c = document.createElement('canvas');
    c.width = i.naturalWidth; c.height = i.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(i, 0, 0);
    return Array.from(g.getImageData(10, 10, 1, 1).data.slice(0, 3));
  }, media('img_village_canon'));
  assert.ok(near(r, hexToRgb(byId.img_village_canon._test.bgColor), 12), `${r}`);
});
await check('routeGoogleApis(): https://www.googleapis.com/drive/** is served by the mock', async () => {
  const p2 = await context.newPage();
  await routeGoogleApis(p2, D);
  await p2.goto(`${env.appUrl}/tests/e2e/blank.html`);
  await env.admin.clearLog();
  const r = await p2.evaluate(async ({ TEST_TOKEN }) => {
    const a = await fetch('https://www.googleapis.com/drive/v3/files/img_lake?fields=id,name', { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
    const b = await fetch('https://www.googleapis.com/drive/v3/files/vid_tram?alt=media', { headers: { Authorization: `Bearer ${TEST_TOKEN}`, Range: 'bytes=0-15' } });
    const ok = await new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = 'https://www.googleapis.com/drive/v3/files/img_lake?alt=media&key=TESTKEY'; });
    return { a: a.status, body: await a.json(), b: b.status, cr: b.headers.get('content-range'), img: ok };
  }, { TEST_TOKEN });
  await p2.close();
  assert.equal(r.a, 200);
  assert.deepEqual(r.body, { id: 'img_lake', name: 'IMG_1410.JPG' });
  assert.equal(r.b, 206);
  assert.match(r.cr, /^bytes 0-15\//);
  assert.equal(r.img, 1280);
  const log = await env.admin.log();
  assert.ok(log.some((e) => e.path === '/drive/v3/files/img_lake' && e.auth === 'bearer'));
});
await check('no page errors', () => assert.deepEqual(pageErrors.map(String), []));

await browser.close();
await env.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
