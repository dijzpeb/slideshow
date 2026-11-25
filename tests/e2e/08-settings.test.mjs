// Extra: display settings entered in the setup form are applied and persisted; sub-folder switch;
// full-screen toggle (F key and HUD button).
import { test, before, after } from 'node:test';
import {
  openSuite, assert, assertNoPageErrors, SETTINGS_KEY, TEST_KEY, TRIP_TZ, DEVICE_TZ,
} from './lib.mjs';

let suite;
before(async () => {
  suite = await openSuite({ maxPageSize: 4 });
});
after(async () => {
  await suite?.close();
});

test('19. display settings from the form (no title/day cards, captions with file name, no fade, custom title) are applied and saved; sub-folders switch', { timeout: 120000 }, (t) => suite.wrap('19-settings', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: {}, settings: null });
  const { page } = app;
  await page.waitForSelector('#setup:not([hidden])');
  // defaults shown in the form
  assert.equal(await page.isChecked('input[name="authMode"][value="oauth"]'), true, 'OAuth is the default mode');
  await page.check('input[name="authMode"][value="apikey"]');
  await page.fill('#f-folder', 'https://drive.google.com/drive/folders/folder_root');
  await page.fill('#f-apiKey', TEST_KEY);
  await page.click('#display-settings summary');
  // the default trip zone is the device's (browser's) time zone; the context runs far from the trip zone
  const browserTz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(browserTz, DEVICE_TZ);
  assert.notEqual(browserTz, TRIP_TZ);
  assert.equal(await page.inputValue('input[name="timeZone"]'), browserTz);
  // the trip zone set in the form (not the device's zone) is used for captions and saved
  await page.fill('input[name="timeZone"]', TRIP_TZ);
  assert.equal(await page.inputValue('input[name="photoSeconds"]'), '6');
  await page.fill('input[name="photoSeconds"]', '1');
  await page.fill('input[name="videoMaxSeconds"]', '2');
  await page.selectOption('select[name="transition"]', 'none');
  await page.selectOption('select[name="captions"]', 'datetime-name');
  await page.fill('input[name="refreshMinutes"]', '0');
  await page.fill('input[name="title"]', 'Summer 2025');
  await page.uncheck('input[name="showTitleCard"]');
  await page.uncheck('input[name="showDayCards"]');
  await page.uncheck('input[name="kenBurns"]');
  await page.click('#btn-start');
  await app.waitForPlayer();
  const keys = await page.evaluate(() => window.__slideshow.player.slides.map((s) => s.key));
  assert.ok(keys.every((k) => k.startsWith('media:')), 'no title / day cards');
  const ids = await app.itemIds();
  await app.waitForSlide({ id: ids[0] });
  const cap = await page.textContent('#player .caption');
  assert.match(cap, /7月12日（土） 12:05/);
  assert.match(cap, /IMG_1203\.JPG/, 'caption includes the file name');
  const cls = await page.evaluate(() => document.querySelector('#player .slide.visible').className);
  assert.ok(!/\bfade\b/.test(cls), `no fade transition (${cls})`);
  assert.equal(await page.evaluate(() => !!document.querySelector('#player .slide.visible .kb')), false, 'no Ken Burns zoom');
  assert.equal(await page.evaluate(() => document.title), 'Summer 2025 - スライドショー');
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), SETTINGS_KEY);
  assert.deepEqual(
    { photoSeconds: stored.photoSeconds, videoMaxSeconds: stored.videoMaxSeconds, transition: stored.transition, captions: stored.captions, title: stored.title, showTitleCard: stored.showTitleCard, showDayCards: stored.showDayCards, kenBurns: stored.kenBurns, authMode: stored.authMode, apiKey: stored.apiKey, folder: stored.folder, timeZone: stored.timeZone },
    { photoSeconds: 1, videoMaxSeconds: 2, transition: 'none', captions: 'datetime-name', title: 'Summer 2025', showTitleCard: false, showDayCards: false, kenBurns: false, authMode: 'apikey', apiKey: TEST_KEY, folder: 'https://drive.google.com/drive/folders/folder_root', timeZone: TRIP_TZ },
  );
  // the photo really changes every ~1 s
  const n0 = (await app.slideLog()).length;
  await page.waitForFunction((n) => window.__slideLog.length >= n + 2, n0, { timeout: 8000 });

  // F / full-screen button
  await page.keyboard.press('f');
  await page.waitForFunction(() => !!document.fullscreenElement);
  assert.equal(await page.getAttribute('#player .ctl-fs', 'aria-label'), '全画面を終了 (F)');
  await page.keyboard.press('F');
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.mouse.move(300, 300);
  await page.mouse.move(310, 310);
  await page.click('#player .ctl-fs');
  await page.waitForFunction(() => !!document.fullscreenElement);
  // leaving to the settings screen exits full screen
  await page.mouse.move(320, 320);
  await page.click('#player .ctl-settings');
  await page.waitForSelector('#setup:not([hidden])');
  await page.waitForFunction(() => !document.fullscreenElement);

  // a fresh page load restores the saved settings into the form
  await page.reload();
  await page.waitForSelector('#setup:not([hidden])');
  assert.equal(await page.inputValue('#f-folder'), 'https://drive.google.com/drive/folders/folder_root');
  assert.equal(await page.isChecked('input[name="authMode"][value="apikey"]'), true);
  assert.equal(await page.isChecked('input[name="showTitleCard"]'), false);
  assert.equal(await page.inputValue('select[name="captions"]'), 'datetime-name');

  // without sub-folders only the root level is shown (a file shortcut in the root is still followed)
  await page.click('#display-settings summary');
  await page.uncheck('input[name="includeSubfolders"]');
  await suite.admin.clearLog();
  await page.click('#btn-start');
  await app.waitForPlayer();
  assert.deepEqual(await app.itemIds(), ['img_other_market']);
  const lists = (await suite.admin.log()).filter((e) => e.path === '/drive/v3/files' && e.query.q?.includes("'folder_day1' in parents"));
  assert.equal(lists.length, 0, 'sub-folders are not listed');
  assertNoPageErrors(app);
  await app.close();
})(t));

test('19b. the default trip time zone is the device time zone (another browser zone), and the share link carries it', { timeout: 60000 }, (t) => suite.wrap('19b-device-tz', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: {}, settings: null, contextOptions: { timezoneId: 'America/New_York' } });
  const { page } = app;
  await page.waitForSelector('#setup:not([hidden])');
  assert.equal(await page.evaluate(() => window.__slideshow.settings.timeZone), 'America/New_York');
  assert.equal(await page.inputValue('input[name="timeZone"]'), 'America/New_York');
  await page.evaluate(() => {
    window.__copied = [];
    try {
      navigator.clipboard.writeText = async (x) => { window.__copied.push(x); };
    } catch { /* ignore */ }
    window.prompt = (msg, x) => { window.__copied.push(x); return null; };
  });
  await page.check('input[name="authMode"][value="apikey"]');
  await page.fill('#f-folder', 'folder_day4');
  await page.fill('#f-apiKey', TEST_KEY);
  await page.click('#btn-share');
  const links = await page.evaluate(() => window.__copied);
  assert.equal(links.length, 1);
  assert.equal(new URL(links[0]).searchParams.get('tz'), 'America/New_York', 'the default zone is shared (the recipient may be elsewhere)');
  // tz= in a link wins over the device zone
  await app.goto({ folder: 'folder_day4', key: TEST_KEY, mode: 'apikey', tz: TRIP_TZ });
  await page.waitForSelector('#setup:not([hidden])');
  assert.equal(await page.inputValue('input[name="timeZone"]'), TRIP_TZ);
  assert.equal(await page.evaluate(() => window.__slideshow.settings.timeZone), TRIP_TZ);
  assertNoPageErrors(app);
  await app.close();
})(t));
