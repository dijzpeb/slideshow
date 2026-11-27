// Scenario 2 (full playthrough: order, loop, video playback through the Service Worker with Range,
// HEVC fallback, max video duration) and scenario 10 (Service Worker blocked: direct URL / blob paths).
import { test, before, after } from 'node:test';
import {
  openSuite, assert, assertOrder, expectedFor, mediaRequests, assertNoPageErrors, assertNoCspViolations, colorNear, dedupeSlides, startStrippingProxy, jaDateTime, TEST_KEY,
} from './lib.mjs';

let suite;
before(async () => {
  suite = await openSuite({ maxPageSize: 4 });
});
after(async () => {
  await suite?.close();
});

const ROOT_PARAMS = { folder: 'folder_root', key: TEST_KEY, mode: 'apikey', interval: 1, autostart: 1 };
const PLAYABLE_VIDEOS = ['vid_harbour_ferry', 'vid_tram', 'vid_deer_mov', 'vid_pxl_bike', 'vid_long_walk'];
const slideKey = (e) => (e.kind === 'title' ? 'title' : e.kind === 'day' ? `day:${e.day}` : `${e.kind === 'end' ? 'end' : 'media'}:${e.id || e.kind}`);

test('2. full playthrough (interval=1, video max 2 s): every item shown in order, videos stream through the SW with Range, HEVC → Drive embed, loops to the title', { timeout: 240000 }, (t) => suite.wrap('02-playthrough', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS, settings: { videoMaxSeconds: 2 } });
  await app.waitForPlayer();
  const ids = await app.itemIds();
  const expected = expectedFor(suite.manifest, 'default', ids);
  assertOrder(ids, expected, 'items');
  const slideKeys = await app.page.evaluate(() => window.__slideshow.player.slides.map((s) => s.key));
  assert.equal(await app.page.evaluate(() => !!window.__slideshow.sw && !!navigator.serviceWorker.controller), true, 'page is controlled by the Service Worker');

  // play until the title card shows for the second time (loop=true)
  await app.page.waitForFunction(() => window.__slideLog.filter((e) => e.kind === 'title').length >= 2, null, { timeout: 200000, polling: 500 });
  const log = await app.slideLog();
  const firstLoopEnd = log.findIndex((e, i) => i > 0 && e.kind === 'title');
  const loop1 = dedupeSlides(log.slice(0, firstLoopEnd));
  assert.deepEqual(loop1.map(slideKey), slideKeys, 'visible slide sequence of the first loop');
  assert.equal(log[firstLoopEnd].kind, 'title', 'loops back to the title card');
  for (const e of loop1) assert.notEqual(e.kind, 'message', `error card shown: ${e.text}`);

  // captions: local capture time (trip zone), day number, 「日時推定」 only for Drive-date items
  const dayNo = {};
  for (const e of loop1) if (e.kind === 'day') dayNo.cur = (dayNo.cur || 0) + 1; else if (e.id) dayNo[e.id] = dayNo.cur;
  for (const e of loop1.filter((x) => x.id)) {
    const want = jaDateTime(suite.byId[e.id]._test.expected.appTimeUtcDefault);
    assert.ok(e.caption.includes(want), `${e.id}: caption 「${e.caption}」 should contain 「${want}」`);
    assert.ok(e.caption.includes(`${dayNo[e.id]}日目`), `${e.id}: caption 「${e.caption}」 day ${dayNo[e.id]}`);
    assert.equal(e.caption.includes('日時推定'), e.id === 'img_cabin', `${e.id}: 日時推定 badge`);
  }

  // photos: the right picture is on screen (corner colour = fixture background colour)
  const photos = loop1.filter((e) => e.kind === 'image');
  let sampled = 0;
  for (const e of photos) {
    assert.ok(e.nw > 0, `${e.id}: photo decoded (naturalWidth ${e.nw}, src ${e.src})`);
    if (e.color) {
      sampled++;
      assert.ok(colorNear(e.color, suite.byId[e.id]._test.bgColor), `${e.id}: corner colour ${e.color} vs ${suite.byId[e.id]._test.bgColor}`);
    }
    if (e.id !== 'img_viewpoint_heic') assert.match(e.src, /^blob:/, `${e.id}: original image (blob via SW), got ${e.src}`);
  }
  assert.ok(sampled >= photos.length - 2, `colour sampled for ${sampled}/${photos.length} photos`);

  // videos really played, from the Service Worker URL
  const vids = await app.videoInfo();
  for (const id of PLAYABLE_VIDEOS) {
    assert.ok(vids[id], `${id}: <video> element seen`);
    assert.ok(vids[id].maxTime > 0.3, `${id}: currentTime advanced (max ${vids[id].maxTime})`);
    assert.equal(vids[id].videoWidth, 640, `${id}: video track decoded`);
    assert.match(vids[id].src, new RegExp(`/__drive/media/${id}\\?`), `${id}: streamed through the Service Worker`);
    assert.ok(vids[id].maxTime < 3.5, `${id}: stopped at the 2 s maximum (reached ${vids[id].maxTime})`);
  }
  // vid_long_walk is 8 s long: it must give way after ~2 s
  const lw = loop1.findIndex((e) => e.id === 'vid_long_walk');
  const dt = loop1[lw + 1].t - loop1[lw].t;
  assert.ok(dt < 6000, `vid_long_walk shown for ${Math.round(dt)} ms (max 2 s + transition)`);

  // HEVC: not decodable in headless Chromium → Drive preview iframe (API-key mode)
  const hevc = log.filter((e) => e.id === 'vid_hevc');
  if (ids.includes('vid_hevc')) {
    const embed = hevc.find((e) => e.embed);
    assert.ok(embed, `vid_hevc shown as an embed: ${JSON.stringify(hevc)}`);
    assert.match(embed.embed, /^https:\/\/drive\.google\.com\/file\/d\/vid_hevc\/preview\?autoplay=1/);
    assert.ok(app.previewRequests.some((u) => u.includes('/file/d/vid_hevc/preview')), 'preview iframe requested');
    assert.equal(await app.page.evaluate(() => document.querySelectorAll('#player .slide-video-embed').length), 0, 'embed removed after it was shown');
  }

  // Service Worker → mock: Range requests for the videos, with the page origin (CORS fetch from the SW)
  const mlog = await suite.admin.log();
  for (const id of PLAYABLE_VIDEOS) {
    const reqs = mediaRequests(mlog, id).filter((e) => e.origin === suite.env.appUrl);
    const playback = reqs.filter((e) => e.range && !/^bytes=0-65535$/.test(e.range));
    assert.ok(playback.length > 0, `${id}: playback Range requests via the SW: ${JSON.stringify(reqs.map((e) => e.range))}`);
    assert.ok(reqs.every((e) => e.auth === 'key' && e.status >= 200 && e.status < 300), `${id}: ${JSON.stringify(reqs.map((e) => [e.range, e.status]))}`);
  }
  // vid_tram has its moov at the end (offset ~437 KB): the browser must request a range starting past 0
  const tramRanges = mediaRequests(mlog, 'vid_tram').map((e) => e.range).filter(Boolean);
  assert.ok(tramRanges.some((r) => /^bytes=0-$/.test(r)), `vid_tram open-ended range: ${tramRanges}`);
  const counter = await app.page.evaluate(() => document.querySelector('#player .counter').textContent);
  assert.match(counter, new RegExp(`^(\\d+ / ${expected.length})?$`));
  assertNoPageErrors(app);
  await assertNoCspViolations(app);
  await app.close();
})(t));

test('2b. Service Worker proxy contract: Range, QuickTime → video/mp4, suffix ranges, 416, 404, resource keys', { timeout: 60000 }, (t) => suite.wrap('02b-sw-contract', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS });
  await app.waitForPlayer();
  const sizes = Object.fromEntries(['vid_deer_mov', 'vid_tram', 'img_reskey_1'].map((id) => [id, Number(suite.byId[id].size)]));
  const r = await app.page.evaluate(async (sizes) => {
    const get = async (path, range) => {
      const res = await fetch(path, { headers: range ? { Range: range } : {} });
      const body = await res.arrayBuffer();
      return { status: res.status, ct: res.headers.get('content-type'), cr: res.headers.get('content-range'), len: body.byteLength, ar: res.headers.get('accept-ranges') };
    };
    const mov = `__drive/media/vid_deer_mov?mt=video%2Fquicktime&sz=${sizes.vid_deer_mov}`;
    return {
      head: await get(mov, 'bytes=0-99'),
      suffix: await get(mov, 'bytes=-100'),
      open: await get(`__drive/media/vid_tram?mt=video%2Fmp4&sz=${sizes.vid_tram}`, `bytes=${sizes.vid_tram - 10}-`),
      tooFar: await get(`__drive/media/vid_tram?mt=video%2Fmp4&sz=${sizes.vid_tram}`, `bytes=${sizes.vid_tram + 10}-`),
      missing: await get('__drive/media/no_such_file?mt=image%2Fjpeg'),
      rkOk: await get(`__drive/media/img_reskey_1?rk=0-imgAkey1&mt=image%2Fjpeg&sz=${sizes.img_reskey_1}`),
      rkMissing: await get(`__drive/media/img_reskey_1?mt=image%2Fjpeg&sz=${sizes.img_reskey_1}`),
      controlled: !!navigator.serviceWorker.controller,
    };
  }, sizes);
  const M = sizes.vid_deer_mov;
  assert.equal(r.controlled, true);
  assert.deepEqual(r.head, { status: 206, ct: 'video/mp4', cr: `bytes 0-99/${M}`, len: 100, ar: 'bytes' }, 'QuickTime served as video/mp4');
  assert.deepEqual(r.suffix, { status: 206, ct: 'video/mp4', cr: `bytes ${M - 100}-${M - 1}/${M}`, len: 100, ar: 'bytes' });
  const T = sizes.vid_tram;
  assert.equal(r.open.status, 206);
  assert.equal(r.open.cr, `bytes ${T - 10}-${T - 1}/${T}`);
  assert.equal(r.open.len, 10);
  assert.equal(r.tooFar.status, 416);
  assert.equal(r.tooFar.cr, `bytes */${T}`);
  assert.equal(r.missing.status, 404);
  assert.equal(r.rkOk.status, 200);
  assert.equal(r.rkOk.len, sizes.img_reskey_1);
  assert.equal(r.rkMissing.status, 404, 'resource key is required for img_reskey_1');
  const log = await suite.admin.log();
  assert.ok(mediaRequests(log, 'img_reskey_1').some((e) => e.resourceKeys === 'img_reskey_1/0-imgAkey1' && e.status === 200));
  assertNoPageErrors(app);
  await app.close();
})(t));

test('2c. Content-Range hidden by CORS (no Access-Control-Expose-Headers): the SW synthesizes it and a moov-at-end video still plays', { timeout: 90000 }, (t) => suite.wrap('02c-hidden-content-range', async () => {
  await suite.admin.reset();
  const proxy = await startStrippingProxy(suite.env.driveUrl);
  try {
    const app = await suite.newApp({ params: { ...ROOT_PARAMS, apiBase: proxy.url } });
    await app.waitForPlayer();
    const T = Number(suite.byId.vid_tram.size);
    const r = await app.page.evaluate(async ({ proxyUrl, T }) => {
      const direct = await fetch(`${proxyUrl}/drive/v3/files/vid_tram?alt=media&key=TESTKEY`, { headers: { Range: 'bytes=0-9' } });
      const viaSw = await fetch(`__drive/media/vid_tram?mt=video%2Fmp4&sz=${T}`, { headers: { Range: 'bytes=100-199' } });
      return { directStatus: direct.status, directCr: direct.headers.get('content-range'), swStatus: viaSw.status, swCr: viaSw.headers.get('content-range'), swLen: (await viaSw.arrayBuffer()).byteLength };
    }, { proxyUrl: proxy.url, T });
    assert.equal(r.directStatus, 206);
    assert.equal(r.directCr, null, 'Content-Range is not readable from JavaScript through this proxy');
    assert.deepEqual([r.swStatus, r.swCr, r.swLen], [206, `bytes 100-199/${T}`, 100], 'SW rebuilt Content-Range from the size');
    await app.jumpViaGrid('vid_tram');
    await app.page.waitForFunction(() => window.__video.vid_tram && window.__video.vid_tram.maxTime > 0.5, null, { timeout: 20000 });
    assert.equal((await app.videoInfo()).vid_tram.videoWidth, 640);
    assert.ok(proxy.stats.requests > 0);
    assertNoPageErrors(app);
    await assertNoCspViolations(app);
    await app.close();
  } finally {
    await proxy.close();
  }
})(t));

// Browsers without a usable Service Worker API (e.g. some in-app web views / private modes).
// Playwright's serviceWorkers:'block' alone makes register() resolve without ever activating a worker,
// (the app gives up after a timeout, test 10 below); here the API is removed entirely so the fallback paths can be exercised.
const NO_SW_API = () => { try { delete Navigator.prototype.serviceWorker; } catch { /* ignore */ } };

test('10. Service Workers blocked by the browser (newContext serviceWorkers:"block"): API-key slideshow must still start and play', { timeout: 120000 }, (t) => suite.wrap('10-sw-blocked', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS, contextOptions: { serviceWorkers: 'block' } });
  try {
    await app.waitForPlayer(25000);
  } catch {
    const st = await app.page.evaluate(() => ({ screen: window.__slideshow.screen, loading: document.querySelector('#loading-title').textContent, sw: window.__slideshow.sw }));
    assert.fail(`slideshow never started with Service Workers blocked: stuck on screen=${st.screen} 「${st.loading}」 `
      + '(setupServiceWorker() must give up on register()/ready after its timeout and return null)');
  }
  await app.waitForSlide({ id: 'img_city_square' }, 20000);
  await app.jumpViaGrid('vid_tram');
  await app.page.waitForFunction(() => window.__video.vid_tram && window.__video.vid_tram.maxTime > 0.3, null, { timeout: 15000 });
  await app.waitForSlide({ id: 'img_market_square_canon' }, 15000);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('10a. no Service Worker API, API-key mode: photos via fetch→blob, videos via the direct API URL', { timeout: 120000 }, (t) => suite.wrap('10a-no-sw-apikey', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS, contextOptions: { serviceWorkers: 'block' }, navigate: false });
  await app.context.addInitScript(NO_SW_API);
  await app.goto();
  await app.waitForPlayer();
  assert.equal(await app.page.evaluate(() => window.__slideshow.sw), null, 'no Service Worker');
  await app.waitForSlide({ id: 'img_city_square' }, 20000);
  await app.jumpViaGrid('vid_tram');
  await app.page.waitForFunction(() => window.__video.vid_tram && window.__video.vid_tram.maxTime > 0.3, null, { timeout: 15000 });
  const v = (await app.videoInfo()).vid_tram;
  assert.ok(v.src.startsWith(`${suite.env.driveUrl}/drive/v3/files/vid_tram?`), `direct API URL: ${v.src}`);
  assert.match(v.src, /[?&]key=TESTKEY/);
  assert.match(v.src, /[?&]alt=media/);
  assert.equal(v.videoWidth, 640);
  await app.waitForSlide({ id: 'img_market_square_canon' }, 15000);
  const log = await app.slideLog();
  const photo = log.find((e) => e.id === 'img_market_square_canon');
  await app.page.waitForFunction(() => window.__slideLog.find((e) => e.id === 'img_market_square_canon')?.nw > 0);
  const photo2 = (await app.slideLog()).find((e) => e.id === 'img_market_square_canon');
  assert.ok(photo, 'photo after the video shown');
  assert.match(photo2.src, /^blob:/);
  assert.ok(colorNear(photo2.color, suite.byId.img_market_square_canon._test.bgColor), `colour ${photo2.color}`);
  // the media request came from the page (CORS fetch), with the API key
  const reqs = mediaRequests(await suite.admin.log(), 'img_market_square_canon');
  assert.ok(reqs.some((e) => !e.range && e.auth === 'key' && e.status === 200), 'full download with key');
  assertNoPageErrors(app);
  await assertNoCspViolations(app);
  await app.close();
})(t));

test('10b. no Service Worker API, OAuth mode: videos are downloaded as blobs and play', { timeout: 120000 }, (t) => suite.wrap('10b-no-sw-oauth', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ contextOptions: { serviceWorkers: 'block' }, navigate: false });
  await app.context.addInitScript(NO_SW_API);
  await app.startOAuth('folder_root');
  assert.equal(await app.page.evaluate(() => window.__slideshow.sw), null, 'no Service Worker');
  await app.jumpViaGrid('vid_harbour_ferry');
  await app.page.waitForFunction(() => window.__video.vid_harbour_ferry && window.__video.vid_harbour_ferry.maxTime > 0.3, null, { timeout: 20000 });
  const v = (await app.videoInfo()).vid_harbour_ferry;
  assert.match(v.src, /^blob:/, `blob URL: ${v.src}`);
  assert.equal(v.videoWidth, 640);
  const reqs = mediaRequests(await suite.admin.log(), 'vid_harbour_ferry');
  assert.ok(reqs.some((e) => !e.range && e.auth === 'bearer' && e.authOk && e.status === 200), 'full download with the bearer token');
  // next photo also loads without the SW (fetch with Authorization → blob)
  await app.waitForSlide({ id: 'img_fortress_gps' }, 15000);
  await app.page.waitForFunction(() => window.__slideLog.find((e) => e.id === 'img_fortress_gps')?.nw > 0);
  assertNoPageErrors(app);
  await assertNoCspViolations(app);
  await app.close();
})(t));
