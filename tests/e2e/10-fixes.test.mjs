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
  assert.deepEqual(u.searchParams.getAll('fix'), ['-360:Canon EOS R6', '*'], 'fix=*: the complete set of corrections of the folder');

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

  // the share link plays the corrected order; corrections the recipient had for that folder (from an older link) are
  // replaced, not merged (R5)
  const viewer = await suite.newApp({ params: {}, settings: { cameraOffsets: { folder_root: { 'Canon EOS R6': -300, 'SONY ILCE-7M4': 30 } } }, navigate: false });
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

test('R3. 適用 keeps the saved corrections of groups that are not listed yet (EXIF of that photo not read yet)', { timeout: 120000 }, (t) => suite.wrap('r3-apply-keeps-unlisted', async () => {
  await suite.admin.reset();
  // trip zone Asia/Tokyo: the iPhone 14 photo's OffsetTimeOriginal (+03:00) differs, so once its EXIF is read it
  // moves to the （タイムゾーン記録あり） group (e.g. a share link brought that correction in)
  const IPHONE_ZONED = `Apple iPhone 14${ZONED}`;
  const app = await suite.newApp({
    params: { ...ROOT_PARAMS, tz: 'Asia/Tokyo' },
    settings: { cameraOffsets: { folder_root: { [IPHONE_ZONED]: 30, 'Canon EOS R6': -60 } } },
    navigate: false,
  });
  const { page } = app;
  // the background EXIF read of that photo is slow: it is still in the plain camera group
  let release;
  let held = 0;
  const gate = new Promise((r) => (release = r));
  await app.context.route(/\/drive\/v3\/files\/img_other_kauppatori\?/, async (route) => {
    if (route.request().headers().range) {
      held++;
      await gate;
    }
    await route.continue().catch(() => {});
  });
  await app.goto();
  await app.waitForPlayer();
  for (let i = 0; i < 200 && !held; i++) await sleep(100);
  assert.ok(held, 'the EXIF read of img_other_kauppatori is waiting');
  const it0 = (await app.items()).find((i) => i.id === 'img_other_kauppatori');
  assert.deepEqual([it0.group, it0.offsetMinutes], ['Apple iPhone 14', 0], 'not refined yet');
  await openGrid(app);
  await page.click('#time-fix summary');
  await page.waitForSelector('#time-fix[open] #time-fix-table .fix-row');
  // the saved correction is listed (it can be checked and removed) although no item is in that group yet
  const zonedRow = page.locator(`#time-fix-table .fix-row[data-group="${IPHONE_ZONED}"]`);
  assert.deepEqual(await zonedRow.locator('input').evaluateAll((els) => els.map((e) => e.value)), ['0', '30']);
  assert.match(await zonedRow.textContent(), /写真 0・動画 0今は該当する写真・動画がありません/);
  // change only Canon
  await page.locator('#time-fix-table .fix-row[data-group="Canon EOS R6"] input').nth(1).fill('-50');
  await page.locator('#time-fix-table .fix-row[data-group="Canon EOS R6"] input').nth(0).fill('0');
  await page.click('#btn-time-fix-apply');
  await page.waitForFunction(() => window.__toasts.some((x) => x.text === '時刻の補正を適用しました'));
  assert.deepEqual((await storedSettings(app)).cameraOffsets, { folder_root: { [IPHONE_ZONED]: 30, 'Canon EOS R6': -50 } });
  // once the EXIF is read, the photo gets its correction
  release();
  await page.waitForFunction(() => window.__slideshow.items.find((i) => i.id === 'img_other_kauppatori')?.timeSource === 'exif-offset', null, { timeout: 30000 });
  const it1 = (await app.items()).find((i) => i.id === 'img_other_kauppatori');
  assert.deepEqual([it1.group, it1.offsetMinutes], [IPHONE_ZONED, 30]);
  // a row set to 0 removes that correction
  await page.waitForSelector(`#time-fix-table .fix-row[data-group="${IPHONE_ZONED}"]`);
  await page.locator(`#time-fix-table .fix-row[data-group="${IPHONE_ZONED}"] input`).nth(1).fill('0');
  await page.click('#btn-time-fix-apply');
  await page.waitForFunction(() => window.__toasts.filter((x) => x.text === '時刻の補正を適用しました').length >= 2);
  assert.deepEqual((await storedSettings(app)).cameraOffsets, { folder_root: { 'Canon EOS R6': -50 } });
  assertNoPageErrors(app);
  await app.close();
})(t));

test('R4. corrections saved by the previous version keep applying to the videos whose group name changed', { timeout: 120000 }, (t) => suite.wrap('r4-legacy-offsets', async () => {
  await suite.admin.reset();
  // previous format: flat { group: minutes } next to the folder it was made for
  const app = await suite.newApp({ params: ROOT_PARAMS, settings: { folder: 'folder_root', cameraOffsets: { '動画（機種不明）': -180 } } });
  const { page } = app;
  await app.waitForPlayer();
  const byId = Object.fromEntries((await app.items()).map((i) => [i.id, i]));
  // VID_… used to be 動画（機種不明）; now it is grouped by its file name and still gets −3 h
  assert.equal(byId.vid_tram.group, 'スマートフォン動画（ファイル名から推定）');
  assert.equal(byId.vid_tram.offsetMinutes, -180);
  assert.equal(byId.vid_harbour_ferry.group, '動画（機種不明）');
  assert.equal(byId.vid_harbour_ferry.offsetMinutes, -180);
  // the iPhone video was in its camera group before too; the Pixel file name is UTC (its own zoned group)
  assert.equal(byId.vid_reindeer_mov.offsetMinutes, 0);
  assert.equal(byId.vid_pxl_husky.offsetMinutes, 0);
  const st = await page.evaluate(() => ({ co: window.__slideshow.settings.cameraOffsets, legacy: window.__slideshow.settings.legacyCameraOffsets }));
  assert.deepEqual(st, { co: { folder_root: { '動画（機種不明）': -180, 'スマートフォン動画（ファイル名から推定）': -180 } }, legacy: {} });
  // the time-fix table shows it, and 適用 saves it in the new format
  await openGrid(app);
  await page.click('#time-fix summary');
  await page.waitForSelector('#time-fix[open] #time-fix-table .fix-row');
  const vals = await page.locator('#time-fix-table .fix-row[data-group="スマートフォン動画（ファイル名から推定）"] input').evaluateAll((els) => els.map((e) => e.value));
  assert.deepEqual(vals, ['-3', '0']);
  await page.click('#btn-time-fix-apply');
  await page.waitForFunction(() => window.__toasts.some((x) => x.text === '時刻の補正を適用しました'));
  const saved = await storedSettings(app);
  assert.deepEqual(saved.cameraOffsets, { folder_root: { '動画（機種不明）': -180, 'スマートフォン動画（ファイル名から推定）': -180 } });
  assert.deepEqual(saved.legacyCameraOffsets, {});
  assertNoPageErrors(app);
  await app.close();
})(t));

// ---------------------------------------------------------------------------
// player: a slide that is still loading owns the show (R6–R11)

const PLAYER_PARAMS = { folder: 'folder_root', key: TEST_KEY, mode: 'apikey', autostart: 1 };
const PLAYER_SETTINGS = { photoSeconds: 30, videoMaxSeconds: 0, transition: 'none', loop: false, kenBurns: false };
const slideKey = (e) => (e.kind === 'day' ? `day:${e.day}` : e.kind === 'title' ? 'title' : `media:${e.id}`);
const longWalk = (page) => page.evaluate(() => {
  const v = document.querySelector('#player .slide-video[data-id="vid_long_walk"] video');
  const p = window.__slideshow.player;
  return { playing: p.playing, key: p.slides[p.index]?.key, paused: v ? v.paused : null, t: v ? v.currentTime : null };
});

async function playLongWalk(app, minTime = 1) {
  const { page } = app;
  await page.evaluate(() => window.__slideshow.player.goToItem('vid_long_walk', { play: true }));
  await app.waitForSlide({ id: 'vid_long_walk' });
  // fully buffered, so that only the next slide waits for the (slowed) network
  await page.waitForFunction(() => {
    const v = document.querySelector('#player .slide-video[data-id="vid_long_walk"] video');
    return v && v.buffered.length && v.buffered.end(v.buffered.length - 1) >= v.duration - 0.05;
  }, null, { timeout: 20000 });
  await page.waitForFunction((t) => (document.querySelector('#player .slide-video[data-id="vid_long_walk"] video')?.currentTime || 0) > t, minTime, { timeout: 20000 });
}

test('R6. a tile picked while a video is paused under the grid: the old video is not resumed during a slow load, the picked photo is shown', { timeout: 120000 }, (t) => suite.wrap('r6-goto-item-old-video', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: PLAYER_PARAMS, settings: PLAYER_SETTINGS });
  const { page } = app;
  await app.waitForPlayer();
  await playLongWalk(app, 1);
  await openGrid(app);
  const t0 = (await longWalk(app.page)).t;
  await page.evaluate(() => window.__slideshow.loader.clear());
  await suite.admin.setLatency(7000);
  try {
    await page.click('#grid-body .tile[data-id="img_porvoo"]');
    await page.waitForSelector('#grid-overlay', { state: 'hidden' });
    await sleep(5500); // longer than the paused-video watchdog (3 s + 1 s tick)
    const st = await longWalk(page);
    assert.equal(st.playing, true, 'the show plays from the picked tile');
    assert.equal(st.key, 'media:img_porvoo');
    assert.equal(st.paused, true, `the old video stays paused: ${JSON.stringify(st)}`);
    assert.ok(Math.abs(st.t - t0) < 0.2, `old video did not advance (${t0} → ${st.t})`);
  } finally {
    await suite.admin.setLatency(0);
  }
  await app.waitForSlide({ id: 'img_porvoo' }, 30000);
  const log = (await app.slideLog()).map(slideKey);
  assert.equal(log[log.indexOf('media:vid_long_walk') + 1], 'media:img_porvoo', `slides: ${log.slice(-4)}`);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('R7. → near the end of a video while the next slide loads slowly: the video stops and the next slide is not skipped', { timeout: 120000 }, (t) => suite.wrap('r7-next-near-video-end', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: PLAYER_PARAMS, settings: PLAYER_SETTINGS });
  const { page } = app;
  await app.waitForPlayer();
  await playLongWalk(app, 5.5); // 8 s video
  const next = await page.evaluate(() => {
    const p = window.__slideshow.player;
    return p.slides[p.index + 1].key;
  });
  await page.evaluate(() => window.__slideshow.loader.clear());
  await suite.admin.setLatency(4000);
  try {
    await page.keyboard.press('ArrowRight');
    await sleep(300);
    assert.equal((await longWalk(page)).paused, true, 'the outgoing video stops at once');
    await sleep(3000); // the video would have ended by now
    const st = await longWalk(page);
    assert.equal(st.key, next, 'still on the slide the user went to');
  } finally {
    await suite.admin.setLatency(0);
  }
  await app.waitForLog("(e) => e.t > 0 && (e.kind !== 'video' || e.id !== 'vid_long_walk') && window.__slideLog.indexOf(e) > window.__slideLog.findIndex((x) => x.id === 'vid_long_walk')", 30000);
  const log = (await app.slideLog()).map(slideKey);
  assert.equal(log[log.lastIndexOf('media:vid_long_walk') + 1], next, `slides: ${log.slice(-4)}`);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('R8. a refresh that removes the slide being loaded: when its load fails, the slide that moved into its place is shown', { timeout: 120000 }, (t) => suite.wrap('r8-stale-index-skip', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: PLAYER_PARAMS, settings: PLAYER_SETTINGS });
  const { page } = app;
  await app.waitForPlayer();
  await page.evaluate(() => window.__slideshow.player.goToItem('img_aurora_2', { play: true }));
  await app.waitForSlide({ id: 'img_aurora_2' });
  const keys = await page.evaluate(() => window.__slideshow.player.slides.map((s) => s.key));
  const at = keys.indexOf('media:img_porvoo');
  assert.equal(keys[at + 1], 'media:img_extra_porvoo', 'fixture order');
  // img_porvoo was deleted in Drive but is still listed; the player goes to it
  await page.evaluate(() => window.__slideshow.loader.clear());
  await suite.admin.remove('img_porvoo');
  await suite.admin.setLatency(1500);
  try {
    await page.evaluate((i) => {
      window.__slideshow.player.goTo(i, 1); // not awaited: the load is still running
    }, at);
    await sleep(300);
    // the refresh lands while the deleted photo is still loading
    const mid = await page.evaluate(() => {
      const s = window.__slideshow;
      s.player.setItems(s.items.filter((it) => it.id !== 'img_porvoo'));
      const p = s.player;
      return { key: p.slides[p.index]?.key, detached: p.detached };
    });
    assert.deepEqual(mid, { key: 'media:img_extra_porvoo', detached: true });
  } finally {
    await suite.admin.setLatency(0);
  }
  await page.waitForFunction(() => window.__slideLog.some((e) => e.id === 'img_extra_porvoo' || e.id === 'img_airport'), null, { timeout: 60000 });
  const log = (await app.slideLog()).map(slideKey);
  assert.equal(log[log.length - 1], 'media:img_extra_porvoo', `slides: ${log.slice(-3)}`);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('R9. the controls hide again after 「もう一度見る」 on the end card and after the list comes back from empty', { timeout: 120000 }, (t) => suite.wrap('r9-hud-after-end', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: PLAYER_PARAMS, settings: { ...PLAYER_SETTINGS, photoSeconds: 2 } });
  const { page } = app;
  await app.waitForPlayer();
  const hud = () => page.evaluate(() => ({ hidden: document.querySelector('#player').classList.contains('hud-hidden'), playing: window.__slideshow.player.playing }));
  await page.evaluate(() => window.__slideshow.player.goTo(window.__slideshow.player.slides.length - 1));
  await page.waitForSelector('#player .slide-end', { timeout: 60000 });
  const box = await (await page.$('#player .slide-end .btn-light')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up(); // the mouse stays still afterwards
  await page.waitForFunction(() => window.__slideshow.player.playing === true);
  await page.waitForFunction(() => document.querySelector('#player').classList.contains('hud-hidden'), null, { timeout: 6000 });
  assert.deepEqual(await hud(), { hidden: true, playing: true });
  // the list becomes empty and comes back while playing
  await page.evaluate(() => window.__slideshow.player.setItems([]));
  await page.waitForFunction(() => !document.querySelector('#player').classList.contains('hud-hidden'));
  await sleep(500);
  await page.evaluate(() => window.__slideshow.player.setItems(window.__slideshow.items));
  await page.waitForFunction(() => document.querySelector('#player').classList.contains('hud-hidden'), null, { timeout: 6000 });
  assert.deepEqual(await hud(), { hidden: true, playing: true });
  assertNoPageErrors(app);
  await app.close();
})(t));

test('R10. media keys (Media Session) do not play or change slides behind the grid', { timeout: 120000 }, (t) => suite.wrap('r10-media-session-modal', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: PLAYER_PARAMS, settings: PLAYER_SETTINGS, navigate: false });
  await app.context.addInitScript(() => {
    window.__msHandlers = {};
    const orig = MediaSession.prototype.setActionHandler;
    MediaSession.prototype.setActionHandler = function (a, fn) {
      window.__msHandlers[a] = fn;
      return orig.call(this, a, fn);
    };
  });
  await app.goto();
  const { page } = app;
  await app.waitForPlayer();
  await playLongWalk(app, 0.5);
  await openGrid(app);
  const t0 = (await longWalk(page)).t;
  await page.evaluate(() => window.__msHandlers.play());
  await page.evaluate(() => window.__msHandlers.nexttrack());
  await sleep(1500);
  const st = await longWalk(page);
  assert.deepEqual({ playing: st.playing, key: st.key, paused: st.paused }, { playing: false, key: 'media:vid_long_walk', paused: true });
  assert.ok(Math.abs(st.t - t0) < 0.1);
  assert.equal(await page.isVisible('#grid-overlay'), true);
  // closed: the keys work again
  await page.click('#btn-grid-close');
  await page.waitForSelector('#grid-overlay', { state: 'hidden' });
  await page.evaluate(() => window.__msHandlers.pause());
  await page.evaluate(() => window.__msHandlers.play());
  await page.waitForFunction(() => window.__slideshow.player.playing === true);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('R11. pausing while the muted autoplay retry is pending (Safari policy) keeps the video (no fallback, no skip)', { timeout: 120000 }, (t) => suite.wrap('r11-pause-muted-retry', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: { ...PLAYER_PARAMS, muted: 0 }, settings: PLAYER_SETTINGS });
  const { page } = app;
  await app.waitForPlayer();
  await page.evaluate(() => {
    // Safari: an unmuted play() outside a user gesture is rejected
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!this.muted) return Promise.reject(new DOMException('not allowed', 'NotAllowedError'));
      return orig.call(this);
    };
  });
  await page.evaluate(() => window.__slideshow.loader.clear());
  await suite.admin.setLatency(9000); // no frame within the ready wait (like iOS, which loads only when playing)
  try {
    await page.evaluate(() => {
      const p = window.__slideshow.player;
      p.audioUnlocked = true;
      p.goToItem('vid_tram', { play: true });
    });
    await page.waitForFunction(() => window.__slideshow.player.current?.item?.id === 'vid_tram', null, { timeout: 20000 });
    await sleep(300); // the muted play() is still pending
    await page.evaluate(() => window.__slideshow.player.pause());
    await sleep(1500);
  } finally {
    await suite.admin.setLatency(0);
  }
  const st = await page.evaluate(() => {
    const p = window.__slideshow.player;
    return { id: p.current?.item?.id, kind: p.current?.kind, failed: !!p.current?.videoFailed, playing: p.playing, key: p.slides[p.index].key };
  });
  assert.deepEqual(st, { id: 'vid_tram', kind: 'video', failed: false, playing: false, key: 'media:vid_tram' });
  assert.equal(app.previewRequests.length, 0, 'no Drive embed fallback');
  assertNoPageErrors(app);
  await app.close();
})(t));

// ---------------------------------------------------------------------------
// OAuth: expiry warning, re-login, the re-login dialog, folder search vs. start (R12–R16)

/** make the stubbed GIS popup answer only after `ms` (the user is still in the popup) */
const slowPopup = (page, ms) => page.evaluate((delay) => {
  const c = window.__slideshow.session.client;
  const orig = c.requestAccessToken.bind(c);
  c.requestAccessToken = (o) => setTimeout(() => orig(o), delay);
}, ms);

test('R12. the expiry warning is shown when the show starts after the warning time has passed (token accepted with < 5 min left)', { timeout: 120000 }, (t) => suite.wrap('r12-expiring-at-start', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false });
  const { page } = app;
  await app.goto({ mode: 'oauth', clientId: 'test-client', folder: 'folder_private', interval: 1 });
  await page.waitForSelector('#setup:not([hidden])');
  // the 'expiring' moment has passed by the time the player starts (it fired during loading, or here before it)
  await page.evaluate(() => { window.__nextExpiresIn = 290; });
  await page.click('#btn-start');
  await app.waitForPlayer();
  await page.waitForSelector('#player .expiring-banner', { timeout: 5000 });
  assert.match(await page.textContent('#player .expiring-banner'), /まもなくログインの有効期限が切れます。/);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('R13. 「延長する」 completing after the token expired closes the re-login dialog and continues the show', { timeout: 120000 }, (t) => suite.wrap('r13-extend-after-expiry', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false });
  const { page } = app;
  await app.goto({ mode: 'oauth', clientId: 'test-client', folder: 'folder_private', interval: 1 });
  await page.waitForSelector('#setup:not([hidden])');
  await page.evaluate(() => { window.__nextExpiresIn = 302; });
  await page.click('#btn-start');
  await app.waitForPlayer();
  await page.waitForSelector('#player .expiring-banner', { timeout: 15000 });
  await slowPopup(page, 2000);
  await page.evaluate(() => { window.__nextExpiresIn = 3599; });
  await page.click('#player .expiring-banner button:has-text("延長する")');
  // the token runs out while the popup is still open
  await page.evaluate(() => window.__slideshow.session.dispatchEvent(new Event('expired')));
  await page.waitForSelector('#auth-overlay:not([hidden])');
  assert.equal(await page.evaluate(() => window.__slideshow.player.playing), false);
  await page.waitForFunction(() => window.__toasts.some((x) => x.text === 'ログインを延長しました'), null, { timeout: 10000 });
  await page.waitForSelector('#auth-overlay', { state: 'hidden', timeout: 3000 });
  const st = await page.evaluate(() => ({
    playing: window.__slideshow.player.playing,
    valid: window.__slideshow.session.isValidFor(5 * 60000),
    inert: document.querySelector('#player').inert,
    banner: !!document.querySelector('#player .expiring-banner'),
  }));
  assert.deepEqual(st, { playing: true, valid: true, inert: false, banner: false });
  assert.equal(await page.evaluate(() => window.__gis.requests.length), 2, 'no second login needed');
  assertNoPageErrors(app);
  await app.close();
})(t));

test('R14. the re-login dialog over the grid is modal for the keyboard; after re-login the grid is usable again', { timeout: 120000 }, (t) => suite.wrap('r14-auth-modal', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false });
  const { page } = app;
  await app.startOAuth('folder_private');
  await sleep(1000);
  await openGrid(app);
  // the token is rejected while the grid is open
  await suite.admin.setTokens([]);
  await page.evaluate(() => window.__slideshow.session.getToken(true));
  await page.waitForSelector('#auth-overlay:not([hidden])');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'btn-reauth');
  for (const key of ['Shift+Tab', 'Shift+Tab', 'Tab', 'Tab', 'Tab', 'Tab']) {
    await page.keyboard.press(key);
    const where = await page.evaluate(() => ({ id: document.activeElement?.id || document.activeElement?.tagName, inGrid: !!document.activeElement?.closest('#grid-overlay'), inPlayer: !!document.activeElement?.closest('#player') }));
    assert.equal(where.inGrid || where.inPlayer, false, `${key} moved the focus behind the dialog: ${JSON.stringify(where)}`);
  }
  assert.deepEqual(await page.evaluate(() => ({
    grid: !document.querySelector('#grid-overlay').hidden,
    playing: window.__slideshow.player.playing,
    inert: [document.querySelector('#player').inert, document.querySelector('#grid-overlay').inert],
  })), { grid: true, playing: false, inert: [true, true] });
  // re-login: the dialog closes, the grid is back in use (focus inside it), still paused
  await suite.admin.setTokens(['test-token-2']);
  await page.evaluate(() => { window.__nextToken = 'test-token-2'; });
  await page.focus('#btn-reauth');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#auth-overlay', { state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => ({
    grid: !document.querySelector('#grid-overlay').hidden,
    playing: window.__slideshow.player.playing,
    inert: [document.querySelector('#player').inert, document.querySelector('#grid-overlay').inert],
    focusInGrid: !!document.activeElement?.closest('#grid-overlay'),
  })), { grid: true, playing: false, inert: [true, false], focusInGrid: true });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#grid-overlay', { state: 'hidden' });
  await page.waitForFunction(() => window.__slideshow.player.playing === true, null, { timeout: 3000 });
  assertNoPageErrors(app);
  await app.close();
})(t));

test('R15. フォルダを検索 and スライドショーを開始 both waiting for one login: no folder dialog over the show; the show keeps its Drive client', { timeout: 120000 }, (t) => suite.wrap('r15-folder-search-race', async () => {
  await suite.admin.reset();
  // folder search first, then start
  const a = await suite.newApp({ navigate: false });
  await a.goto({ mode: 'oauth', clientId: 'test-client', folder: 'folder_private', interval: 1 });
  await a.page.waitForSelector('#setup:not([hidden])');
  await a.page.waitForFunction(() => !!window.__slideshow.session?.client);
  await slowPopup(a.page, 1500);
  await a.page.click('#btn-folder-search');
  await a.page.click('#btn-start');
  await a.waitForPlayer();
  await sleep(1000);
  assert.equal(await a.page.isHidden('#folder-overlay'), true, 'folder dialog closed when the show started');
  assert.equal(await a.page.evaluate(() => window.__gis.requests.length), 2, 'the popup was brought up again (one login)');
  assertNoPageErrors(a);
  await a.close();

  // start first, then folder search: the show keeps the Drive client that learned the resource keys
  const b = await suite.newApp({ navigate: false });
  const folderUrl = 'https://drive.google.com/drive/folders/folder_reskey?resourcekey=0-ABCdef';
  await b.goto({ mode: 'oauth', clientId: 'test-client', folder: folderUrl, interval: 1 });
  await b.page.waitForSelector('#setup:not([hidden])');
  await b.page.waitForFunction(() => !!window.__slideshow.session?.client);
  await slowPopup(b.page, 1500);
  await suite.admin.setLatency(300);
  try {
    await b.page.click('#btn-start');
    await b.page.click('#btn-folder-search');
    await b.waitForPlayer(60000);
  } finally {
    await suite.admin.setLatency(0);
  }
  await sleep(1000);
  const st = await b.page.evaluate(() => ({
    folderOverlay: !document.querySelector('#folder-overlay').hidden,
    sameDrive: window.__slideshow.loader.drive === window.__slideshow.drive,
    rootKey: window.__slideshow.drive.resourceKeys.get('folder_reskey') || null,
  }));
  assert.deepEqual(st, { folderOverlay: false, sameDrive: true, rootKey: '0-ABCdef' });
  assertNoPageErrors(b);
  await b.close();
})(t));

test('R16. the background EXIF refinement stopped by an expired login starts again after re-login', { timeout: 150000 }, (t) => suite.wrap('r16-refine-after-relogin', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false });
  const { page } = app;
  // photos with a Drive capture time are only read in the background (refine phase): hold those reads
  const refineIds = new Set(suite.manifest.files.filter((f) => /^image\/(jpeg|heic)/.test(f.mimeType) && f.imageMediaMetadata?.time).map((f) => f.id));
  let hold = true;
  const held = [];
  await app.context.route(/\/drive\/v3\/files\/[^/?]+\?/, async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
    if (hold && refineIds.has(id) && route.request().headers().range) {
      held.push(route);
      return;
    }
    await route.continue().catch(() => {});
  });
  await app.startOAuth('folder_root');
  for (let i = 0; i < 200 && !held.length; i++) await sleep(100);
  assert.ok(held.length > 0, 'the refinement is running');
  // the token is rejected: the refinement stops
  await suite.admin.setTokens([]);
  await page.evaluate(() => window.__slideshow.session.getToken(true));
  await page.waitForSelector('#auth-overlay:not([hidden])');
  hold = false;
  for (const r of held.splice(0)) await r.continue().catch(() => {});
  await page.waitForFunction(() => window.__slideshow.refineInterrupted === true, null, { timeout: 20000 });
  assert.equal((await app.items()).find((i) => i.id === 'img_lake').timeSource, 'exif', 'not refined yet');
  // re-login → the refinement runs again
  await suite.admin.setTokens(['test-token-2']);
  await page.evaluate(() => { window.__nextToken = 'test-token-2'; });
  await page.click('#btn-reauth');
  await page.waitForSelector('#auth-overlay', { state: 'hidden' });
  await page.waitForFunction(() => window.__slideshow.items.find((i) => i.id === 'img_lake')?.timeSource === 'exif-offset', null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__slideshow.refineInterrupted), false);
  assertNoPageErrors(app);
  await app.close();
})(t));
