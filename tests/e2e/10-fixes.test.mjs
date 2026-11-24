// Regression tests for review findings: Service Worker hardening and retries, inaccessible folder
// shortcuts, refresh vs. folder switch, per-folder time corrections (+ share link), corrections vs.
// times with a recorded UTC offset, cancel during the Service Worker wait, grid keyboard handling.
import { test, before, after } from 'node:test';
import {
  openSuite, assert, assertNoPageErrors, assertOrder, expectedFor, mediaRequests, sleep, SETTINGS_KEY, TEST_KEY,
} from './lib.mjs';

let suite;
before(async () => {
  suite = await openSuite({ maxPageSize: 4 });
});
after(async () => {
  await suite?.close();
});

const ROOT_PARAMS = { folder: 'folder_root', key: TEST_KEY, mode: 'apikey', interval: 1, autostart: 1 };
const ZONED = '（タイムゾーン記録あり）';

const storedSettings = (app) => app.page.evaluate((k) => JSON.parse(localStorage.getItem(k)), SETTINGS_KEY);
const toastTexts = (app) => app.page.evaluate(() => window.__toasts.map((x) => x.text));

async function openGrid(app) {
  await app.page.keyboard.press('g');
  await app.page.waitForSelector('#grid-overlay:not([hidden])');
}

async function backToSetup(app) {
  const { page } = app;
  await page.mouse.move(500, 300);
  await page.mouse.move(510, 310);
  await page.click('#player .ctl-settings');
  await page.waitForSelector('#setup:not([hidden])');
}

/** wait until the background EXIF reads have reached img_lake (so later failures hit the photo download) */
async function waitForRefine(app) {
  await app.page.waitForFunction(() => window.__slideshow.items.find((i) => i.id === 'img_lake')?.timeSource === 'exif-offset', null, { timeout: 30000 });
}

test('F5. Service Worker: a navigation / iframe to __drive/media/<id> is not proxied; fetch() gets media with nosniff, CSP and a safe Content-Type', { timeout: 90000 }, (t) => suite.wrap('f5-sw-navigate', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS });
  await app.waitForPlayer();
  await app.page.waitForFunction(() => !!navigator.serviceWorker.controller && !!window.__slideshow.sw);
  const base = new URL('.', app.page.url()).toString();
  await suite.admin.clearLog();

  // top-level navigation (e.g. window.open from another site) → not answered by the SW
  const tab = await app.context.newPage();
  const resp = await tab.goto(`${base}__drive/media/txt_notes?mt=text%2Fhtml`);
  assert.equal(resp.fromServiceWorker(), false, 'navigation handled by the network, not the SW');
  assert.equal(resp.status(), 404, 'the static server has no such file');
  await tab.close();
  // iframe in the app page → not proxied either
  const frame = await app.page.evaluate(async () => {
    const f = document.createElement('iframe');
    f.src = '__drive/media/txt_notes?mt=text%2Fhtml';
    document.body.append(f);
    await new Promise((res) => (f.onload = res));
    let text = null;
    try {
      text = f.contentDocument && f.contentDocument.body.textContent;
    } catch { /* cross-origin */ }
    f.remove();
    return text;
  });
  assert.ok(!frame || !frame.includes('notes'), `iframe must not show the Drive file: ${frame}`);
  assert.equal(mediaRequests(await suite.admin.log(), 'txt_notes').length, 0, 'the SW did not fetch the file for the navigation / iframe');

  // fetch() from the app: media type passes through, with the security headers
  const photo = await app.page.evaluate(async () => {
    const r = await fetch('__drive/media/img_lake?mt=image%2Fjpeg');
    await r.arrayBuffer();
    return { status: r.status, ct: r.headers.get('content-type'), nosniff: r.headers.get('x-content-type-options'), csp: r.headers.get('content-security-policy') };
  });
  assert.deepEqual(photo, { status: 200, ct: 'image/jpeg', nosniff: 'nosniff', csp: "default-src 'none'; sandbox" });
  // a non-media file (text/plain upstream, text/html hint) is never served as a document type
  const other = await app.page.evaluate(async () => {
    const r = await fetch('__drive/media/txt_notes?mt=text%2Fhtml');
    await r.arrayBuffer();
    return { status: r.status, ct: r.headers.get('content-type'), nosniff: r.headers.get('x-content-type-options'), csp: r.headers.get('content-security-policy') };
  });
  assert.deepEqual(other, { status: 200, ct: 'application/octet-stream', nosniff: 'nosniff', csp: "default-src 'none'; sandbox" });
  // error responses carry the headers too
  const missing = await app.page.evaluate(async () => {
    const r = await fetch('__drive/media/no_such_file');
    return { status: r.status, nosniff: r.headers.get('x-content-type-options') };
  });
  assert.deepEqual(missing, { status: 404, nosniff: 'nosniff' });
  assertNoPageErrors(app);
  await app.close();
})(t));

test('F10. a transient 503 on a photo download is retried and the original photo is shown (not the thumbnail)', { timeout: 120000 }, (t) => suite.wrap('f10-sw-retry', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS });
  await app.waitForPlayer();
  await waitForRefine(app);
  await suite.admin.fail('img_lake', 503, 1);
  await app.jumpViaGrid('img_breakfast');
  await app.waitForSlide({ id: 'img_lake' }, 30000);
  await app.page.waitForFunction(() => window.__slideLog.find((e) => e.id === 'img_lake')?.nw > 0);
  const e = (await app.slideLog()).find((x) => x.id === 'img_lake');
  assert.match(e.src, /^blob:/, `original photo after the retry: ${e.src}`);
  const reqs = mediaRequests(await suite.admin.log(), 'img_lake');
  assert.equal(reqs.filter((x) => x.status === 503).length, 1);
  assert.ok(reqs.some((x) => x.status === 200), `statuses: ${reqs.map((x) => x.status)}`);
  assert.ok(!(await toastTexts(app)).some((x) => x.includes('IMG_1410')), 'no warning toast');
  assertNoPageErrors(app);
  await app.close();
})(t));

test('F10b/F24. an aborted photo download is not retried or continued upstream (page fetch, not the SW)', { timeout: 120000 }, (t) => suite.wrap('f10b-abort-no-retry', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: { ...ROOT_PARAMS, interval: 30 } });
  const { page } = app;
  await app.waitForPlayer();
  await waitForRefine(app);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller && !!window.__slideshow.sw);
  await suite.admin.clearLog();
  await suite.admin.fail('img_lake', 503, 10);
  // the player's photo load is aborted 300 ms in (the user moved on): no further upstream attempts
  const res = await page.evaluate(async () => {
    const st = window.__slideshow;
    const item = st.items.find((i) => i.id === 'img_lake');
    st.loader.cache.delete('img_lake');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    try {
      await st.loader.loadImage(item, { signal: ac.signal });
      return 'loaded';
    } catch (e) {
      return e.name;
    }
  });
  assert.equal(res, 'AbortError');
  await sleep(4000);
  let reqs = mediaRequests(await suite.admin.log(), 'img_lake');
  assert.equal(reqs.length, 1, `upstream requests after the abort: ${reqs.map((r) => r.status)}`);
  // a page fetch() through the Service Worker is not retried there either (its abort never reaches the SW)
  await suite.admin.clearLog();
  const st = await page.evaluate(async () => (await fetch('__drive/media/img_lake?mt=image%2Fjpeg')).status);
  assert.equal(st, 503);
  await sleep(1500);
  reqs = mediaRequests(await suite.admin.log(), 'img_lake');
  assert.equal(reqs.length, 1, `SW fetch() attempts: ${reqs.map((r) => r.status)}`);
  await suite.admin.fail('img_lake', 503, 0);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('F6. a folder shortcut whose target cannot be listed is skipped with a warning; the show still plays', { timeout: 120000 }, (t) => suite.wrap('f6-folder-shortcut', async () => {
  await suite.admin.reset();
  // sc_folder_extra in folder_root points at folder_extra; make the target inaccessible (files.list → 404)
  await suite.admin.hide('folder_extra');
  const app = await suite.newApp({ params: ROOT_PARAMS });
  await app.waitForPlayer();
  const ids = await app.itemIds();
  assert.ok(!ids.includes('img_extra_porvoo'), 'items of the unreadable folder are left out');
  assertOrder(ids, expectedFor(suite.manifest, 'default', ids).filter((id) => id !== 'img_extra_porvoo'), 'the rest of the folder');
  await app.page.waitForFunction(() => window.__toasts.some((x) => x.text.startsWith('アクセスできないフォルダを')), null, { timeout: 10000 });
  assert.ok((await toastTexts(app)).includes('アクセスできないフォルダを 1 件スキップしました'));
  const lists = (await suite.admin.log()).filter((e) => e.path === '/drive/v3/files' && (e.query.q || '').includes("'folder_extra' in parents"));
  assert.ok(lists.some((e) => e.status === 404), 'the target folder was tried');
  // the show plays
  await app.waitForSlide({ id: 'img_senate_square' }, 20000);
  await app.waitForSlide({ id: 'img_helsinki_cathedral' }, 20000);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('F7/F14. a refresh that is still running when another folder is started does not overwrite the new show', { timeout: 120000 }, (t) => suite.wrap('f7-refresh-race', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS });
  const { page } = app;
  await app.waitForPlayer();
  // hold the refresh's listing of folder_root until the new folder is playing
  let hold = false;
  const held = [];
  const driveFiles = `${suite.env.driveUrl}/drive/v3/files`;
  await page.route((url) => url.href.startsWith(driveFiles) && url.pathname === '/drive/v3/files', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') || '';
    if (hold && q.includes("'folder_root' in parents")) {
      held.push(route);
      return undefined;
    }
    return route.continue();
  });
  hold = true;
  await openGrid(app);
  await page.click('#btn-refresh');
  for (let i = 0; i < 100 && !held.length; i++) await sleep(100);
  assert.ok(held.length > 0, 'the refresh is waiting for the folder listing');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#grid-overlay', { state: 'hidden' });
  await backToSetup(app);
  await page.fill('#f-folder', 'folder_extra');
  await page.click('#btn-start');
  await app.waitForPlayer();
  await page.waitForFunction(() => window.__slideshow.root?.id === 'folder_extra');
  // let the old refresh continue
  hold = false;
  for (const r of held.splice(0)) await r.continue().catch(() => {});
  const overwritten = await page
    .waitForFunction(() => window.__slideshow.root?.id !== 'folder_extra' || window.__toasts.some((x) => x.text.startsWith('フォルダが更新されました')), null, { timeout: 6000 })
    .then(() => true, () => false);
  const st = await page.evaluate(() => ({
    root: window.__slideshow.root.id,
    items: window.__slideshow.items.map((i) => i.id),
    player: window.__slideshow.player.items.map((i) => i.id),
    folder: window.__slideshow.settings.folder,
    refreshing: window.__slideshow.refreshing,
  }));
  assert.equal(overwritten, false, `the old refresh changed the new show: ${JSON.stringify(st)} toasts=${await toastTexts(app)}`);
  assert.deepEqual(st, { root: 'folder_extra', items: ['img_extra_porvoo'], player: ['img_extra_porvoo'], folder: 'folder_extra', refreshing: false });
  // refreshing the new folder still works
  await openGrid(app);
  await page.click('#btn-refresh');
  await page.waitForFunction(() => window.__toasts.some((x) => x.text === '新しい写真・動画はありませんでした'), null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__slideshow.root.id), 'folder_extra');
  assertNoPageErrors(app);
  await app.close();
})(t));

test('F1. time corrections are saved per folder and travel in the share link', { timeout: 150000 }, (t) => suite.wrap('f1-per-folder-share', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS });
  const { page } = app;
  await app.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: suite.env.appUrl });
  let prompted = null;
  page.on('dialog', (d) => {
    prompted = d.defaultValue();
    d.dismiss().catch(() => {});
  });
  await app.waitForPlayer();
  // Canon EOS R6 −6 h for folder_root
  await openGrid(app);
  await page.click('#time-fix summary');
  await page.waitForSelector('#time-fix[open] #time-fix-table .fix-row');
  await page.locator('#time-fix-table .fix-row[data-group="Canon EOS R6"] input').nth(0).fill('-6');
  await page.click('#btn-time-fix-apply');
  await page.waitForFunction(() => window.__toasts.some((x) => x.text === '時刻の補正を適用しました'));
  assert.deepEqual((await storedSettings(app)).cameraOffsets, { folder_root: { 'Canon EOS R6': -360 } });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#grid-overlay', { state: 'hidden' });

  // share link from the setup screen carries the correction
  await backToSetup(app);
  prompted = null;
  const before = (await app.toasts()).length;
  await page.click('#btn-share');
  await page.waitForFunction((n) => window.__toasts.length > n, before, { timeout: 3000 }).catch(() => {});
  const shareUrl = prompted || (await page.evaluate(() => navigator.clipboard.readText()));
  const u = new URL(shareUrl);
  assert.equal(u.searchParams.get('folder'), 'folder_root');
  assert.deepEqual(u.searchParams.getAll('fix'), ['-360:Canon EOS R6']);

  // another folder with the same camera is not corrected
  await page.fill('#f-folder', 'folder_aurora');
  await page.click('#btn-start');
  await app.waitForPlayer();
  await page.waitForFunction(() => window.__slideshow.root?.id === 'folder_aurora');
  const aurora = await app.items();
  assert.deepEqual(aurora.map((i) => i.id), ['img_aurora_1', 'img_aurora_2', 'img_aurora_canon'], 'uncorrected order in folder_aurora');
  const canon = aurora.find((i) => i.id === 'img_aurora_canon');
  assert.equal(canon.offsetMinutes, 0);
  assert.equal(canon.iso, suite.byId.img_aurora_canon._test.expected.appTimeUtcDefault);
  await openGrid(app);
  await page.click('#time-fix summary');
  const vals = await page.locator('#time-fix-table .fix-row[data-group="Canon EOS R6"] input').evaluateAll((els) => els.map((e) => e.value));
  assert.deepEqual(vals, ['0', '0'], 'the form shows no correction for this folder');
  assert.deepEqual((await storedSettings(app)).cameraOffsets, { folder_root: { 'Canon EOS R6': -360 } }, 'folder_root keeps its correction');
  assertNoPageErrors(app);

  // the share link in a fresh browser profile plays the corrected order
  const viewer = await suite.newApp({ params: {}, settings: null, navigate: false });
  const runUrl = new URL(shareUrl);
  runUrl.searchParams.set('apiBase', suite.env.driveUrl);
  await viewer.page.goto(runUrl.toString());
  await viewer.page.waitForSelector('#setup:not([hidden])');
  await viewer.page.click('#btn-start');
  await viewer.waitForPlayer();
  const items = await viewer.items();
  const ids = items.map((i) => i.id);
  assertOrder(ids, expectedFor(suite.manifest, 'canonFix', ids), 'order from the share link');
  for (const it of items) assert.equal(it.offsetMinutes, it.group === 'Canon EOS R6' ? -360 : 0, `${it.id} correction`);
  assert.deepEqual((await storedSettings(viewer)).cameraOffsets, { folder_root: { 'Canon EOS R6': -360 } }, 'saved for that folder');
  assertNoPageErrors(viewer);
  await viewer.close();
  await app.close();
})(t));

test('F0. a correction for a camera does not apply to its times recorded with another UTC offset (separate （タイムゾーン記録あり） group)', { timeout: 120000 }, (t) => suite.wrap('f0-zoned-groups', async () => {
  await suite.admin.reset();
  // corrections saved for the plain camera groups (e.g. before the EXIF offsets were read)
  const app = await suite.newApp({
    params: ROOT_PARAMS,
    settings: { cameraOffsets: { folder_root: { 'SONY ILCE-7M4': -360, 'Apple iPhone 15': 60 } } },
  });
  const { page } = app;
  await app.waitForPlayer();
  await waitForRefine(app);
  const byId = Object.fromEntries((await app.items()).map((i) => [i.id, i]));
  // the Sony's EXIF has OffsetTimeOriginal +09:00 (not the trip zone): its time is already right and must not move
  const sony = byId.img_sony_offset;
  assert.equal(sony.timeSource, 'exif-offset');
  assert.equal(sony.group, `SONY ILCE-7M4${ZONED}`);
  assert.equal(sony.offsetMinutes, 0, 'img_sony_offset is not corrected');
  assert.equal(sony.iso, suite.byId.img_sony_offset._test.trueCaptureUtc);
  // the iPhone's offset +03:00 equals the trip zone: both readings give the same time, so the iPhone group
  // (and its saved correction, e.g. for clock drift) stays the same before and after the EXIF is read
  for (const id of ['img_exif_range', 'img_lake']) {
    const it = byId[id];
    assert.equal(it.timeSource, 'exif-offset', `${id} source`);
    assert.equal(it.group, 'Apple iPhone 15', `${id} group`);
    assert.equal(it.offsetMinutes, 60, `${id} keeps the iPhone correction`);
    assert.equal(it.iso, new Date(Date.parse(suite.byId[id]._test.trueCaptureUtc) + 3600000).toISOString(), `${id} time`);
  }
  // the time-fix table lists the zoned groups with the hint
  await openGrid(app);
  await page.click('#time-fix summary');
  await page.waitForSelector('#time-fix[open] #time-fix-table .fix-row');
  const groups = await page.$$eval('#time-fix-table .fix-row', (rows) => rows.map((r) => r.dataset.group));
  assert.ok(groups.includes(`SONY ILCE-7M4${ZONED}`), `groups: ${groups}`);
  const notes = await page.$$eval('#time-fix-table p', (els) => els.map((e) => e.textContent));
  assert.match(notes[0], /^撮影地のタイムゾーン: Europe\/Helsinki/);
  assert.ok(notes.some((n) => n.includes(`「${ZONED}」のグループは`)), `notes: ${notes}`);
  const sonyVals = await page.locator(`#time-fix-table .fix-row[data-group="SONY ILCE-7M4${ZONED}"] input`).evaluateAll((els) => els.map((e) => e.value));
  assert.deepEqual(sonyVals, ['0', '0']);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('F17. キャンセル while waiting for the Service Worker keeps the setup screen', { timeout: 90000 }, (t) => suite.wrap('f17-cancel-sw-wait', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false });
  await app.context.addInitScript(() => {
    const c = navigator.serviceWorker;
    if (!c) return;
    const orig = c.register.bind(c);
    c.register = (...a) => new Promise((r) => setTimeout(() => r(orig(...a)), 3000));
  });
  await app.goto({ ...ROOT_PARAMS, folder: 'folder_extra' });
  // listing done, the app now waits for the (delayed) Service Worker
  await app.page.waitForFunction(() => window.__slideshow.screen === 'loading' && window.__slideshow.files.length === 1);
  await sleep(200);
  await app.page.click('#btn-cancel-load');
  await app.page.waitForSelector('#setup:not([hidden])');
  // the Service Worker becomes ready afterwards; start() must not continue
  await app.page.waitForFunction(() => !!window.__slideshow.sw, null, { timeout: 20000 });
  await sleep(1000);
  const st = await app.page.evaluate(() => ({ screen: window.__slideshow.screen, active: !!window.__slideshow.player?.active }));
  assert.deepEqual(st, { screen: 'setup', active: false });
  assertNoPageErrors(app);
  await app.close();
})(t));

test('F19. Escape / G close the grid even after focus left it; focus stays on the tile across a re-render', { timeout: 90000 }, (t) => suite.wrap('f19-grid-keys', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS });
  const { page } = app;
  await app.waitForPlayer();
  await openGrid(app);
  assert.equal(await page.evaluate(() => document.querySelector('#player').inert), true, 'player inert behind the grid');
  await page.click('#grid-title'); // focus → body
  await page.keyboard.press('Escape');
  await page.waitForSelector('#grid-overlay', { state: 'hidden' });
  assert.equal(await page.evaluate(() => document.querySelector('#player').inert), false);
  assert.equal(await page.evaluate(() => window.__slideshow.player.playing), true, 'resumed');
  await openGrid(app);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('g');
  await page.waitForSelector('#grid-overlay', { state: 'hidden' });
  // a refresh re-renders the tiles; the focused tile keeps the focus (and Escape still works)
  await openGrid(app);
  await page.focus('#grid-body .tile[data-id="img_lake"]');
  const tileBefore = await page.$('#grid-body .tile[data-id="img_lake"]');
  await page.evaluate(() => document.querySelector('#btn-refresh').click()); // keeps the focus on the tile
  await page.waitForFunction(() => window.__toasts.some((x) => x.text === '新しい写真・動画はありませんでした'), null, { timeout: 20000 });
  assert.equal(await tileBefore.evaluate((el) => el.isConnected), false, 'tiles were re-rendered');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.id), 'img_lake');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#grid-overlay', { state: 'hidden' });
  assertNoPageErrors(app);
  await app.close();
})(t));

test('F13b. a pause from outside the app (media key, headset) pauses the show: sound stays on, the video is not skipped', { timeout: 120000 }, (t) => suite.wrap('f13b-external-pause', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: { folder: 'folder_root', key: TEST_KEY, mode: 'apikey' }, settings: { refreshMinutes: 0, photoSeconds: 1, videoMaxSeconds: 0, videoMuted: false } });
  const { page } = app;
  await page.waitForSelector('#setup:not([hidden])');
  await page.click('#btn-start');
  await app.waitForPlayer();
  await app.jumpViaGrid('vid_long_walk');
  await page.waitForFunction(() => window.__video.vid_long_walk?.maxTime > 0.5, null, { timeout: 20000 });
  const state = () => page.evaluate(() => {
    const v = document.querySelector('#player .slide-video[data-id="vid_long_walk"] video');
    const p = window.__slideshow.player;
    return { playing: p.playing, paused: v.paused, muted: v.muted, audioUnlocked: p.audioUnlocked, playBtn: document.querySelector('#player .ctl-play').getAttribute('aria-label') };
  });
  assert.equal((await state()).muted, false, 'plays with sound after the start click');
  assert.equal(await page.evaluate(() => navigator.mediaSession?.playbackState), 'playing');
  // the browser pauses the <video> itself (what a media key does without Media Session handlers)
  await page.evaluate(() => document.querySelector('#player .slide-video[data-id="vid_long_walk"] video').pause());
  await page.waitForFunction(() => window.__slideshow.player.playing === false, null, { timeout: 3000 });
  await sleep(5000); // longer than the paused-video watchdog
  assert.deepEqual(await state(), { playing: false, paused: true, muted: false, audioUnlocked: true, playBtn: '再生 (Space)' });
  assert.equal((await app.current()).id, 'vid_long_walk', 'not skipped');
  // played again from outside: the show follows
  await page.evaluate(() => document.querySelector('#player .slide-video[data-id="vid_long_walk"] video').play());
  await page.waitForFunction(() => window.__slideshow.player.playing === true, null, { timeout: 3000 });
  const st = await state();
  assert.equal(st.muted, false);
  assert.equal(st.playBtn, '一時停止 (Space)');
  assert.ok(!(await toastTexts(app)).some((x) => x.includes('次へ進みます')), 'no skip toast');
  assertNoPageErrors(app);
  await app.close();
})(t));

test('F18b. while audio is locked, 「次へ」 does not unmute the video being skipped', { timeout: 120000 }, (t) => suite.wrap('f18b-next-keeps-muted', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: { folder: 'folder_root', key: TEST_KEY, mode: 'apikey', autostart: 1, muted: 0, interval: 30 }, settings: { refreshMinutes: 0, videoMaxSeconds: 0 }, navigate: false });
  // user activation as the browser tracks it: none at load; a pointer press or key makes it sticky and briefly transient
  await app.context.addInitScript(() => {
    let sticky = false;
    let transientUntil = 0;
    Object.defineProperty(Navigator.prototype, 'userActivation', {
      configurable: true,
      get() {
        return { get hasBeenActive() { return sticky; }, get isActive() { return performance.now() < transientUntil; } };
      },
    });
    const act = () => {
      sticky = true;
      transientUntil = performance.now() + 5000;
    };
    addEventListener('pointerdown', act, true);
    addEventListener('keydown', act, true);
  });
  await app.goto();
  const { page } = app;
  await app.waitForPlayer();
  await page.evaluate(() => window.__slideshow.player.goToItem('vid_harbour_ferry'));
  await app.waitForSlide({ id: 'vid_harbour_ferry' });
  await page.waitForFunction(() => window.__video.vid_harbour_ferry?.maxTime > 0.3, null, { timeout: 20000 });
  const v = () => page.evaluate(() => {
    const el = document.querySelector('#player .slide-video[data-id="vid_harbour_ferry"] video');
    return el ? { muted: el.muted, paused: el.paused } : null;
  });
  assert.equal(await page.evaluate(() => window.__slideshow.player.audioUnlocked), false, 'no user activation yet');
  assert.equal((await v()).muted, true);
  // the next photo is slow to arrive
  await page.evaluate(() => window.__slideshow.loader.clear());
  await suite.admin.setLatency(2500);
  try {
    await page.mouse.move(640, 650);
    await page.mouse.move(650, 655);
    await page.click('#player .ctl-next');
    const samples = [];
    for (let i = 0; i < 5; i++) {
      await sleep(300);
      samples.push(await v());
    }
    for (const s of samples.filter(Boolean)) assert.equal(s.muted, true, `outgoing video unmuted: ${JSON.stringify(samples)}`);
    assert.equal(await page.evaluate(() => window.__slideshow.player.audioUnlocked), true, 'sound is enabled for the next videos');
    assert.equal(await page.getAttribute('#player .ctl-mute', 'aria-label'), 'ミュート (M)');
  } finally {
    await suite.admin.setLatency(0);
  }
  assertNoPageErrors(app);
  await app.close();
})(t));
