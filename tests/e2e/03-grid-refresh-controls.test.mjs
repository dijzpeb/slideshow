// Scenario 4 (per-camera time correction via the grid UI, persisted), scenario 5 (manual + automatic
// refresh) and scenario 6 (keyboard shortcuts and HUD controls).
import { test, before, after } from 'node:test';
import {
  openSuite, assert, assertOrder, expectedFor, assertNoPageErrors, assertNoCspViolations, colorNear, SETTINGS_KEY, TEST_KEY, sleep,
} from './lib.mjs';

let suite;
before(async () => {
  suite = await openSuite({ maxPageSize: 4 });
});
after(async () => {
  await suite?.close();
});

const ROOT_PARAMS = { folder: 'folder_root', key: TEST_KEY, mode: 'apikey', interval: 1, autostart: 1 };

async function openGrid(app, how = 'key') {
  if (how === 'key') await app.page.keyboard.press('g');
  else {
    await app.page.mouse.move(640, 360);
    await app.page.mouse.move(650, 370);
    await app.page.click('#player .ctl-grid');
  }
  await app.page.waitForSelector('#grid-overlay:not([hidden])');
}
const gridTileIds = (app) => app.page.evaluate(() => [...document.querySelectorAll('#grid-body .tile')].map((t) => t.dataset.id));
const toastTexts = async (app) => (await app.toasts()).map((x) => x.text);

test('4. per-camera time correction in the grid: Canon EOS R6 −6 h → expectedOrderCanonFix, persisted across reloads', { timeout: 120000 }, (t) => suite.wrap('04-timefix', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS });
  await app.waitForPlayer();
  const ids0 = await app.itemIds();
  assertOrder(ids0, expectedFor(suite.manifest, 'default', ids0), 'default order');

  await openGrid(app, 'key');
  await app.page.waitForFunction((n) => document.querySelectorAll('#grid-body .tile').length === n, ids0.length);
  assertOrder(await gridTileIds(app), ids0, 'grid tiles follow the slideshow order');
  // per-day sections
  const sections = await app.page.$$eval('#grid-body .grid-day h3 .day-num', (els) => els.map((e) => e.textContent));
  assert.deepEqual(sections, ['1日目', '2日目', '3日目', '4日目']);

  await app.page.click('#time-fix summary');
  await app.page.waitForSelector('#time-fix[open] #time-fix-table .fix-row');
  const groups = await app.page.$$eval('#time-fix-table .fix-row', (rows) => rows.map((r) => r.dataset.group));
  assert.ok(groups.includes('Canon EOS R6'), `camera groups: ${groups}`);
  const tzNote = await app.page.textContent('#time-fix-table p');
  assert.match(tzNote, /Europe\/Athens（UTC\+3）/);
  const canonRow = app.page.locator('#time-fix-table .fix-row[data-group="Canon EOS R6"]');
  assert.match(await canonRow.textContent(), /写真 3/);
  await canonRow.locator('input').nth(0).fill('-6');
  await app.page.click('#btn-time-fix-apply');
  await app.page.waitForFunction(() => window.__toasts.some((x) => x.text === '時刻の補正を適用しました'));

  const items = await app.items();
  const ids1 = items.map((i) => i.id);
  assertOrder(ids1, expectedFor(suite.manifest, 'canonFix', ids1), 'order after the Canon correction');
  for (const it of items) {
    assert.equal(it.iso, suite.byId[it.id]._test.expected.appTimeUtcCanonFix, `time of ${it.id} after the correction`);
    assert.equal(it.offsetMinutes, it.group === 'Canon EOS R6' ? -360 : 0);
  }
  assertOrder(await gridTileIds(app), ids1, 'grid re-rendered in the corrected order');
  assertOrder(await app.page.evaluate(() => window.__slideshow.player.items.map((i) => i.id)), ids1, 'player re-sorted');
  const tileTitle = await app.page.getAttribute('#grid-body .tile[data-id="img_market_square_canon"]', 'title');
  assert.match(tileTitle, /補正 -360分/);
  // stored
  const stored = await app.page.evaluate((k) => JSON.parse(localStorage.getItem(k)), SETTINGS_KEY);
  assert.deepEqual(stored.cameraOffsets, { folder_root: { 'Canon EOS R6': -360 } }, 'corrections are stored per folder');

  // close the grid and check the corrected Canon photo is shown at its new position
  await app.page.keyboard.press('Escape');
  await app.page.waitForSelector('#grid-overlay', { state: 'hidden' });

  // reload: the correction is applied again from localStorage
  await app.page.reload();
  await app.waitForPlayer();
  const ids2 = await app.itemIds();
  assertOrder(ids2, expectedFor(suite.manifest, 'canonFix', ids2), 'order after reload');
  await openGrid(app, 'button');
  await app.page.click('#time-fix summary');
  const vals = await app.page.locator('#time-fix-table .fix-row[data-group="Canon EOS R6"] input').evaluateAll((els) => els.map((e) => e.value));
  assert.deepEqual(vals, ['-6', '0'], 'the form shows the stored correction');

  // reset to 0 → back to the default order
  await app.page.locator('#time-fix-table .fix-row[data-group="Canon EOS R6"] input').nth(0).fill('0');
  await app.page.click('#btn-time-fix-apply');
  await app.page.waitForFunction(() => window.__slideshow.items.find((i) => i.id === 'img_market_square_canon').offsetMinutes === 0);
  const ids3 = await app.itemIds();
  assertOrder(ids3, expectedFor(suite.manifest, 'default', ids3), 'order after removing the correction');
  const stored2 = await app.page.evaluate((k) => JSON.parse(localStorage.getItem(k)), SETTINGS_KEY);
  assert.deepEqual(stored2.cameraOffsets, {});
  assertNoPageErrors(app);
  await assertNoCspViolations(app);
  await app.close();
})(t));

test('5. manual refresh (今すぐ更新): newly revealed photos are inserted chronologically, toast shown, current slide kept', { timeout: 120000 }, (t) => suite.wrap('05-refresh', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS });
  await app.waitForPlayer();
  await app.waitForSlide({ id: 'img_cathedral' }, 20000);
  await suite.admin.revealAll();
  await openGrid(app, 'key');
  const before = await app.current();
  assert.equal(before.playing, false, 'opening the grid pauses the show');
  await app.page.click('#btn-refresh');
  await app.page.waitForFunction(() => window.__toasts.some((x) => x.text.startsWith('フォルダが更新されました')), null, { timeout: 20000 });
  assert.ok((await toastTexts(app)).includes('フォルダが更新されました（2 件追加）'), `toasts: ${await toastTexts(app)}`);
  const ids = await app.itemIds();
  assertOrder(ids, expectedFor(suite.manifest, 'reveal', ids), 'order after refresh');
  const items = await app.items();
  for (const it of items) assert.equal(it.iso, suite.byId[it.id]._test.expected.appTimeUtcDefault, `time of ${it.id}`);
  await app.page.waitForFunction((n) => document.querySelectorAll('#grid-body .tile').length === n, ids.length);
  assert.match(await app.page.textContent('#grid-title'), new RegExp(`（${ids.length}件）$`));
  const afterRefresh = await app.current();
  assert.equal(afterRefresh.slideKey, before.slideKey, 'current slide preserved');
  assert.equal(afterRefresh.id, before.id, 'visible slide unchanged');

  // nothing new → info toast
  await app.page.click('#btn-refresh');
  await app.page.waitForFunction(() => window.__toasts.some((x) => x.text === '新しい写真・動画はありませんでした'), null, { timeout: 20000 });

  // removal is reported too
  await suite.admin.remove('img_lake');
  await app.page.click('#btn-refresh');
  await app.page.waitForFunction(() => window.__toasts.some((x) => x.text === 'フォルダが更新されました（1 件削除）'), null, { timeout: 20000 });
  assert.ok(!(await app.itemIds()).includes('img_lake'));

  // a revealed photo really displays (click its tile)
  await app.page.click('#grid-body .tile[data-id="img_hidden_lunch"]');
  await app.waitForSlide({ id: 'img_hidden_lunch' });
  await app.page.waitForFunction(() => window.__slideLog.find((e) => e.id === 'img_hidden_lunch')?.color);
  const e = (await app.slideLog()).find((x) => x.id === 'img_hidden_lunch');
  assert.ok(colorNear(e.color, suite.byId.img_hidden_lunch._test.bgColor), `colour ${e.color}`);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('5c. when the photo on screen is deleted from Drive and the folder is refreshed, the next item is not skipped', { timeout: 120000 }, (t) => suite.wrap('05c-remove-current', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS });
  await app.waitForPlayer();
  const ids = await app.itemIds();
  await app.jumpViaGrid('img_breakfast');
  if ((await app.current()).playing) await app.page.keyboard.press('Space');
  await app.page.waitForFunction(() => window.__slideshow.player.playing === false);
  const cur = await app.current();
  const k = ids.indexOf(cur.id);
  const following = ids[k + 1];
  // the photo on screen disappears from Drive; refresh
  await suite.admin.remove(cur.id);
  await openGrid(app, 'key');
  await app.page.click('#btn-refresh');
  await app.page.waitForFunction(() => window.__toasts.some((x) => x.text === 'フォルダが更新されました（1 件削除）'), null, { timeout: 20000 });
  await app.page.keyboard.press('Escape');
  await app.page.waitForSelector('#grid-overlay', { state: 'hidden' });
  const n = (await app.slideLog()).length;
  await app.page.keyboard.press('Space'); // resume
  await app.page.waitForFunction((m) => window.__slideLog.length > m, n, { timeout: 15000 });
  const next = (await app.slideLog())[n];
  assert.equal(next.id, following, `after the removed ${cur.id} the show must continue with ${following}, but showed ${next.id} `
    + '(Player.setItems(): when the current slide is gone, next() must show the slide that moved into its place)');
  assertNoPageErrors(app);
  await app.close();
})(t));

test('5b. automatic refresh (refresh interval from the URL) picks up revealed photos while playing', { timeout: 120000 }, (t) => suite.wrap('05b-autorefresh', async () => {
  await suite.admin.reset();
  // refresh=0.05 minutes = every 3 s
  const app = await suite.newApp({ params: { ...ROOT_PARAMS, refresh: 0.05 } });
  await app.waitForPlayer();
  await suite.admin.revealAll();
  await app.page.waitForFunction(() => window.__slideshow.items.some((i) => i.id === 'img_hidden_berries'), null, { timeout: 20000 });
  const ids = await app.itemIds();
  assertOrder(ids, expectedFor(suite.manifest, 'reveal', ids), 'order after the automatic refresh');
  await app.page.waitForFunction(() => window.__toasts.some((x) => x.text === 'フォルダが更新されました（2 件追加）'), null, { timeout: 5000 });
  // the show was not restarted (only one title card so far) and keeps playing
  const st = await app.current();
  assert.equal(st.playing, true);
  const titles = (await app.slideLog()).filter((e) => e.kind === 'title').length;
  assert.equal(titles, 1, 'no restart');
  const n = (await app.slideLog()).length;
  await app.page.waitForFunction((k) => window.__slideLog.length > k, n, { timeout: 15000 });
  // silent refreshes without changes do not toast
  await sleep(3500);
  assert.ok(!(await toastTexts(app)).includes('新しい写真・動画はありませんでした'), 'silent auto refresh');
  const listCount = (await suite.admin.log()).filter((e) => e.path === '/drive/v3/files' && e.query.q?.includes("'folder_root' in parents")).length;
  assert.ok(listCount >= 3, `folder_root listed repeatedly by the timer (${listCount})`);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('6. keyboard and HUD controls: Space/K, ←/→, Home/End, M, G/Escape, tile click, settings button', { timeout: 120000 }, (t) => suite.wrap('06-controls', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS });
  const { page } = app;
  await app.waitForPlayer();
  const ids = await app.itemIds();
  await app.waitForSlide({ id: ids[0] }, 20000);

  // Space pauses
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#player').classList.contains('paused'));
  let st = await app.current();
  assert.equal(st.playing, false);
  assert.equal(await page.getAttribute('#player .ctl-play', 'aria-label'), '再生 (Space)');
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#player .pause-badge')).opacity) > 0.5);
  const pausedOn = st.id;
  await sleep(2500); // photo interval is 1 s: a running show would have moved on
  assert.equal((await app.current()).id, pausedOn, 'stays on the same photo while paused');

  // arrows navigate (and stay paused); ids[0..3] are all on day 1, so no day card in between
  const k = ids.indexOf(pausedOn);
  assert.ok(k >= 0 && k <= 1, `paused on ${pausedOn}`);
  await page.keyboard.press('ArrowRight');
  await app.waitForSlide({ id: ids[k + 1] });
  await page.keyboard.press('ArrowRight');
  await app.waitForSlide({ id: ids[k + 2] });
  await page.keyboard.press('ArrowLeft');
  await app.waitForSlide({ id: ids[k + 1] });
  assert.equal((await app.current()).playing, false);
  assert.equal(await page.textContent('#player .counter'), `${k + 2} / ${ids.length}`);

  // End / Home
  await page.keyboard.press('End');
  await app.waitForSlide({ id: ids[ids.length - 1] });
  assert.equal(await page.textContent('#player .counter'), `${ids.length} / ${ids.length}`);
  await page.keyboard.press('Home');
  await app.waitForSlide({ kind: 'title' });
  assert.equal((await app.current()).index, 0);

  // M toggles mute (autostart without ?muted starts muted) and is saved
  const muted0 = await page.evaluate(() => window.__slideshow.settings.videoMuted);
  assert.equal(muted0, true, 'autostart mutes videos');
  await page.keyboard.press('m');
  assert.equal(await page.evaluate(() => window.__slideshow.settings.videoMuted), false);
  assert.equal(await page.getAttribute('#player .ctl-mute', 'aria-label'), 'ミュート (M)');
  assert.equal(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).videoMuted, SETTINGS_KEY), false);
  await page.keyboard.press('M');
  assert.equal(await page.evaluate(() => window.__slideshow.settings.videoMuted), true);
  assert.equal(await page.getAttribute('#player .ctl-mute', 'aria-label'), 'ミュート解除 (M)');

  // K resumes, Space pauses again
  await page.keyboard.press('k');
  await page.waitForFunction(() => !document.querySelector('#player').classList.contains('paused'));
  assert.equal((await app.current()).playing, true);
  await page.keyboard.press('Space');
  assert.equal((await app.current()).playing, false);
  await page.keyboard.press('Space');
  assert.equal((await app.current()).playing, true);

  // G opens the grid (pauses), Escape closes it (resumes)
  await page.keyboard.press('g');
  await page.waitForSelector('#grid-overlay:not([hidden])');
  assert.equal((await app.current()).playing, false, 'grid pauses');
  // keys are ignored by the player while the grid is open
  const idxGrid = (await app.current()).index;
  await page.keyboard.press('ArrowRight');
  assert.equal((await app.current()).index, idxGrid, 'arrow keys do not navigate behind the grid');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#grid-overlay', { state: 'hidden' });
  assert.equal((await app.current()).playing, true, 'closing the grid resumes');

  // clicking a tile jumps to that item
  await page.keyboard.press('g');
  await page.waitForSelector('#grid-overlay:not([hidden])');
  await page.click('#grid-body .tile[data-id="img_lake"]');
  await page.waitForSelector('#grid-overlay', { state: 'hidden' });
  await app.waitForSlide({ id: 'img_lake' });
  // the tile of the current item is highlighted next time
  await page.keyboard.press('g');
  await page.waitForSelector('#grid-overlay:not([hidden])');
  const curTile = await page.$eval('#grid-body .tile.current', (e) => e.dataset.id);
  assert.ok(['img_lake', ids[ids.indexOf('img_lake') + 1]].includes(curTile), `current tile ${curTile}`);
  await page.click('#btn-grid-close');
  await page.waitForSelector('#grid-overlay', { state: 'hidden' });

  // HUD buttons (show the HUD with a mouse move first)
  await page.keyboard.press('Space');
  await page.mouse.move(600, 300);
  await page.mouse.move(610, 310);
  const c0 = await app.current();
  await page.click('#player .ctl-next');
  await page.waitForFunction((i) => window.__slideshow.player.index === i + 1, c0.index);
  await page.mouse.move(620, 320);
  await page.click('#player .ctl-prev');
  await page.waitForFunction((i) => window.__slideshow.player.index === i, c0.index);
  await page.click('#player .ctl-play');
  assert.equal((await app.current()).playing, true);
  await page.mouse.move(600, 300);
  await page.click('#player .ctl-play');
  assert.equal((await app.current()).playing, false);
  await page.click('#player .ctl-mute');
  assert.equal(await page.evaluate(() => window.__slideshow.settings.videoMuted), false);

  // settings button → back to the setup screen with the form filled, and the show can be restarted
  await page.click('#player .ctl-settings');
  await page.waitForSelector('#setup:not([hidden])');
  assert.equal(await page.inputValue('#f-folder'), 'folder_root');
  assert.equal(await page.inputValue('#f-apiKey'), TEST_KEY);
  assert.equal(await page.isChecked('input[name="authMode"][value="apikey"]'), true);
  await page.click('#btn-start');
  await app.waitForPlayer();
  await page.waitForFunction(() => window.__slideLog.filter((e) => e.kind === 'title').length >= 2, null, { timeout: 15000 });
  await app.waitForSlide({ id: ids[0] }, 20000);
  assertNoPageErrors(app);
  await app.close();
})(t));
