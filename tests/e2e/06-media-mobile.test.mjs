// Scenario 11 (HEIC via heic-to), 12 (EXIF orientation), 13 (mobile viewport + swipe) and extra
// scenarios: Drive-thumbnail quality mode, loop=0 end card, cancel while loading, sound after a click.
import { test, before, after } from 'node:test';
import path from 'node:path';
import {
  openSuite, assert, assertNoPageErrors, assertNoCspViolations, colorNear, screenPixels, OUT_DIR, TEST_KEY, sleep,
} from './lib.mjs';

let suite;
before(async () => {
  suite = await openSuite({ maxPageSize: 4 });
});
after(async () => {
  await suite?.close();
});

const ROOT_PARAMS = { folder: 'folder_root', key: TEST_KEY, mode: 'apikey', interval: 1, autostart: 1 };

async function jumpTo(app, id, timeout) {
  await app.page.keyboard.press('g');
  await app.page.waitForSelector('#grid-overlay:not([hidden])');
  await app.page.click(`#grid-body .tile[data-id="${id}"]`);
  await app.waitForSlide({ id }, timeout);
  await app.page.waitForFunction((i) => window.__slideLog.find((e) => e.id === i)?.nw > 0, id, { timeout });
  return (await app.slideLog()).find((e) => e.id === id);
}

test('11. HEIC photo is converted in the browser (heic-to vendored in js/vendor/, no CDN) and displayed', { timeout: 150000 }, (t) => suite.wrap('11-heic', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS, navigate: false });
  // no third-party CDN may be contacted for the conversion
  const external = [];
  await app.context.route(/^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|cdnjs\.cloudflare\.com)\//, (route) => {
    external.push(route.request().url());
    return route.abort('internetdisconnected');
  });
  await app.goto();
  await app.waitForPlayer();
  const e = await jumpTo(app, 'img_viewpoint_heic', 90000);
  assert.match(e.src, /^blob:/, `converted image is a blob (not the Drive thumbnail): ${e.src}`);
  assert.equal(e.nw, 1280);
  assert.equal(e.nh, 853);
  assert.ok(colorNear(e.color, suite.byId.img_viewpoint_heic._test.bgColor, 32), `colour ${e.color} vs ${suite.byId.img_viewpoint_heic._test.bgColor}`);
  const loaded = await app.page.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((n) => n.includes('heic-to')));
  assert.ok(loaded.length > 0, 'heic-to was loaded');
  for (const u of loaded) assert.equal(new URL(u).pathname, '/js/vendor/heic-to.js', `heic-to comes from the app origin: ${u}`);
  assert.deepEqual(external, [], 'no CDN requests');
  // the original HEIC bytes were downloaded (not only the thumbnail)
  const reqs = (await suite.admin.log()).filter((x) => x.path === '/drive/v3/files/img_viewpoint_heic' && x.query.alt === 'media' && !x.range);
  assert.ok(reqs.some((x) => x.status === 200));
  await app.screenshot('heic-slide');
  assertNoPageErrors(app);
  await assertNoCspViolations(app);
  await app.close();
})(t));

test('11c. HEIC with the conversion library unreachable (js/vendor/heic-to.js blocked) falls back to the Drive thumbnail', { timeout: 120000 }, (t) => suite.wrap('11c-heic-no-lib', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS, navigate: false });
  let blocked = 0;
  await app.context.route('**/js/vendor/heic-to.js', (route) => {
    blocked++;
    return route.abort('internetdisconnected');
  });
  await app.goto();
  await app.waitForPlayer();
  const e = await jumpTo(app, 'img_viewpoint_heic', 30000);
  assert.ok(blocked > 0, 'the app tried to load heic-to');
  assert.ok(e.src.startsWith(`${suite.env.driveUrl}/thumb/img_viewpoint_heic=s`), `thumbnail fallback: ${e.src}`);
  assert.ok(e.nw > 0);
  // the show goes on
  await app.waitForSlide({ id: 'vid_hevc' }, 20000).catch(() => app.waitForSlide({ id: 'img_village_canon' }, 20000));
  assertNoPageErrors(app);
  await app.close();
})(t));

test('11b. imageQuality=fast uses Drive thumbnails (also for HEIC, without conversion)', { timeout: 120000 }, (t) => suite.wrap('11b-fast', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS, settings: { imageQuality: 'fast' } });
  await app.waitForPlayer();
  const first = await jumpTo(app, 'img_city_square', 20000);
  assert.ok(first.src.startsWith(`${suite.env.driveUrl}/thumb/img_city_square=s`), first.src);
  const heic = await jumpTo(app, 'img_viewpoint_heic', 20000);
  assert.ok(heic.src.startsWith(`${suite.env.driveUrl}/thumb/img_viewpoint_heic=s`), heic.src);
  assert.equal(heic.nw, 1024, 'large thumbnail variant');
  const loaded = await app.page.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.includes('heic-to')));
  assert.equal(loaded, false, 'no HEIC library needed');
  assertNoPageErrors(app);
  await assertNoCspViolations(app);
  await app.close();
})(t));

test('12. EXIF orientation 6: img_cathedral is displayed upright (portrait)', { timeout: 120000 }, (t) => suite.wrap('12-orientation', async () => {
  await suite.admin.reset();
  // no blurred backdrop / zoom, so that the area beside a portrait photo is plain black
  const app = await suite.newApp({ params: ROOT_PARAMS, settings: { blurBackground: false, kenBurns: false } });
  await app.waitForPlayer();
  const check = async (id) => {
    await app.waitForSlide({ id }, 30000);
    if (await app.page.evaluate(() => window.__slideshow.player.playing)) await app.page.keyboard.press('Space'); // pause on it
    await app.waitForSlide({ id }, 5000);
    await app.page.waitForFunction((i) => window.__slideLog.find((e) => e.id === i)?.color, id);
    await app.page.waitForFunction(() => !document.querySelector('#player .slide.leaving')); // cross-fade finished
    await app.page.mouse.move(1, 1);
    return (await app.slideLog()).find((x) => x.id === id);
  };
  const e = await check('img_cathedral');
  const exp = suite.byId.img_cathedral._test.expected;
  assert.equal(e.nw, exp.displayWidth);
  assert.equal(e.nh, exp.displayHeight);
  assert.ok(e.nw < e.nh, 'portrait');
  assert.ok(colorNear(e.color, suite.byId.img_cathedral._test.bgColor), `colour ${e.color}`);
  // 853×1280 in a 1280×720 viewport → ~480 px wide in the middle; x=200 is outside the picture
  const bg = suite.byId.img_cathedral._test.bgColor;
  const [top, side] = await screenPixels(app.page, [[640, 15], [200, 15]]);
  assert.ok(colorNear(top, bg), `top centre is the photo: ${top} vs ${bg}`);
  assert.ok(side.every((v) => v < 30), `left of a portrait photo is black: ${side}`);
  await app.screenshot('orientation-cathedral');
  // control: a landscape photo covers x=200
  await app.page.keyboard.press('ArrowLeft');
  await check('img_city_square');
  const [side2] = await screenPixels(app.page, [[200, 15]]);
  assert.ok(colorNear(side2, suite.byId.img_city_square._test.bgColor), `landscape photo covers x=200: ${side2}`);
  assertNoPageErrors(app);
  await app.close();
})(t));

async function swipe(page, cdp, { from, to, steps = 6, ms = 120 }) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] });
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps;
    const y = from[1] + ((to[1] - from[1]) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await sleep(ms / steps);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('13. mobile viewport (390×844, touch): no horizontal scroll on the setup screen, swipe left/right navigates', { timeout: 120000 }, (t) => suite.wrap('13-mobile', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({
    params: {},
    contextOptions: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  });
  const { page } = app;
  await page.waitForSelector('#setup:not([hidden])');
  const overflow = () => page.evaluate(() => ({
    doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth,
    wide: [...document.querySelectorAll('#setup *')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1);
    }).slice(0, 5).map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${el.className}`),
  }));
  let o = await overflow();
  assert.ok(o.doc <= o.vw && o.body <= o.vw, `horizontal overflow on the setup screen: ${JSON.stringify(o)}`);
  await page.screenshot({ path: path.join(OUT_DIR, 'mobile-setup.png'), fullPage: true });
  // open every collapsible section and check again
  await page.check('input[name="authMode"][value="apikey"]');
  await page.click('#display-settings summary');
  await page.click('details.help summary');
  o = await overflow();
  assert.ok(o.doc <= o.vw && o.body <= o.vw, `horizontal overflow with all sections open: ${JSON.stringify(o)}`);
  assert.deepEqual(o.wide, [], 'no element sticks out of the viewport');
  await page.screenshot({ path: path.join(OUT_DIR, 'mobile-setup-expanded.png'), fullPage: true });

  // start the show by tapping the start button
  await page.fill('#f-folder', 'folder_root');
  await page.fill('#f-apiKey', TEST_KEY);
  await page.fill('input[name="photoSeconds"]', '1');
  await page.tap('#btn-start');
  await app.waitForPlayer();
  const ids = await app.itemIds();
  await app.waitForSlide({ id: ids[0] }, 20000);
  // pause with the play/pause button (tap the stage first to reveal the HUD)
  await page.tap('#player .stage', { position: { x: 195, y: 300 } }).catch(() => {});
  await page.tap('#player .ctl-play');
  await page.waitForFunction(() => window.__slideshow.player.playing === false);
  const start = await app.current();
  const cdp = await app.context.newCDPSession(page);
  await swipe(page, cdp, { from: [320, 420], to: [60, 430] });
  await page.waitForFunction((i) => window.__slideshow.player.index === i + 1, start.index, { timeout: 5000 });
  await app.waitForSlide({ id: ids[ids.indexOf(start.id) + 1] });
  await swipe(page, cdp, { from: [60, 420], to: [330, 410] });
  await page.waitForFunction((i) => window.__slideshow.player.index === i, start.index, { timeout: 5000 });
  // a vertical drag is not a swipe
  await swipe(page, cdp, { from: [200, 200], to: [210, 600] });
  await sleep(300);
  assert.equal((await app.current()).index, start.index, 'vertical drag ignored');
  o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
  assert.ok(o.doc <= o.vw, `player overflow ${JSON.stringify(o)}`);
  await page.screenshot({ path: path.join(OUT_DIR, 'mobile-player.png') });
  assertNoPageErrors(app);
  await app.close();
})(t));

test('16. loop=0: after the last item the end card 「おわり」 appears; 「もう一度見る」 restarts', { timeout: 120000 }, (t) => suite.wrap('16-noloop', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: { folder: 'https://drive.google.com/drive/folders/folder_reskey?resourcekey=0-ABCdef', key: TEST_KEY, mode: 'apikey', interval: 1, loop: 0, autostart: 1 } });
  await app.waitForPlayer();
  await app.waitForSlide({ kind: 'end' }, 40000);
  const seq = (await app.slideLog()).map((e) => e.id || e.kind);
  assert.deepEqual(seq, ['title', 'day', ...suite.manifest.expectedOrderByFolder.folder_reskey, 'end']);
  assert.equal(await app.page.textContent('#player .slide-end .card-title'), 'おわり');
  assert.equal((await app.current()).playing, false);
  await sleep(1500);
  assert.equal((await app.slideLog()).length, seq.length, 'stays on the end card');
  await app.page.click('#player .slide-end button:has-text("もう一度見る")');
  await app.waitForSlide({ kind: 'title' });
  assert.equal((await app.current()).playing, true);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('17. 「キャンセル」 while loading returns to the setup screen and the show does not start later', { timeout: 120000 }, (t) => suite.wrap('17-cancel', async () => {
  await suite.admin.reset();
  await suite.admin.setLatency(400);
  try {
    const app = await suite.newApp({ params: ROOT_PARAMS });
    await app.page.waitForSelector('#loading:not([hidden])');
    await app.page.click('#btn-cancel-load');
    await app.page.waitForSelector('#setup:not([hidden])');
    await suite.admin.setLatency(0);
    await sleep(4000);
    assert.equal(await app.page.evaluate(() => window.__slideshow.screen), 'setup', 'the cancelled load did not start the player');
    assert.equal(await app.page.isHidden('#setup-error'), true, 'no error shown for a cancel');
    // starting again works
    await app.page.click('#btn-start');
    await app.waitForPlayer();
    assertNoPageErrors(app);
    await app.close();
  } finally {
    await suite.admin.setLatency(0);
  }
})(t));

test('18. started by a click (user gesture): videos play with sound; autostart (no gesture) plays them muted', { timeout: 120000 }, (t) => suite.wrap('18-sound', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: { folder: 'folder_root', key: TEST_KEY, mode: 'apikey', interval: 1 }, settings: { videoMuted: false } });
  await app.page.click('#btn-start');
  await app.waitForPlayer();
  await jumpTo(app, 'img_city_square', 20000).catch(() => {});
  await app.page.keyboard.press('g');
  await app.page.waitForSelector('#grid-overlay:not([hidden])');
  await app.page.click('#grid-body .tile[data-id="vid_harbour_ferry"]');
  await app.page.waitForFunction(() => window.__video.vid_harbour_ferry?.maxTime > 0.3, null, { timeout: 20000 });
  const v = (await app.videoInfo()).vid_harbour_ferry;
  assert.equal(v.muted, false, 'video plays with sound after the start click');
  assert.equal(await app.page.getAttribute('#player .ctl-mute', 'aria-label'), 'ミュート (M)');
  await app.close();

  const auto = await suite.newApp({ params: ROOT_PARAMS, settings: { videoMuted: false } });
  await auto.waitForPlayer();
  assert.equal(await auto.page.evaluate(() => window.__slideshow.settings.videoMuted), true, 'autostart without ?muted forces mute');
  await auto.page.evaluate(() => window.__slideshow.player.goToItem('vid_harbour_ferry'));
  await auto.page.waitForFunction(() => window.__video.vid_harbour_ferry?.maxTime > 0.3, null, { timeout: 20000 });
  assert.equal((await auto.videoInfo()).vid_harbour_ferry.muted, true);
  assertNoPageErrors(auto);
  await auto.close();
})(t));
