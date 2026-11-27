// Scenario 14: a large folder (120 photos, names shuffled against capture time) with paginated listing.
import { test, before, after } from 'node:test';
import {
  openSuite, assert, assertOrder, listRequests, assertNoPageErrors, colorNear, TEST_KEY,
} from './lib.mjs';

let suite;
before(async () => {
  suite = await openSuite({ maxPageSize: 50 });
});
after(async () => {
  await suite?.close();
});

test('14. folder_big (120 photos, pages of 50): loads, sorted by capture time, grid renders 120 tiles', { timeout: 150000 }, (t) => suite.wrap('14-big-folder', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: { folder: 'folder_big', key: TEST_KEY, mode: 'apikey', interval: 1, autostart: 1 } });
  await app.waitForPlayer(60000);
  const expected = suite.manifest.expectedOrderByFolder.folder_big;
  assert.equal(expected.length, 120);
  const items = await app.items();
  assertOrder(items.map((i) => i.id), expected, 'folder_big order');
  for (let i = 1; i < items.length; i++) assert.ok(items[i].epoch > items[i - 1].epoch, 'strictly increasing times');
  for (const it of items) assert.equal(it.iso, suite.byId[it.id]._test.trueCaptureUtc, `time of ${it.id}`);
  // names are shuffled relative to time: the order is not the name order
  assert.notDeepEqual(items.map((i) => i.id), [...expected].sort());

  // listing used 3 pages of at most 50
  const lists = listRequests(await suite.admin.log()).filter((e) => e.query.q.includes("'folder_big' in parents"));
  assert.equal(lists.length, 3, `pages: ${lists.length}`);
  assert.equal(lists.filter((e) => e.query.pageToken).length, 2);
  assert.ok(lists.every((e) => e.status === 200));

  // title: one day, 120 photos
  await app.waitForSlide({ kind: 'title' });
  const meta = await app.page.evaluate(() => ({
    title: document.querySelector('#player .slide-title .card-title').textContent,
    sub: document.querySelector('#player .slide-title .card-sub').textContent,
    meta: document.querySelector('#player .slide-title .card-meta').textContent,
  }));
  assert.deepEqual(meta, { title: 'Big folder (pagination)', sub: '2025年7月20日（日）', meta: '写真 120枚' });

  // grid
  await app.page.keyboard.press('g');
  await app.page.waitForSelector('#grid-overlay:not([hidden])');
  await app.page.waitForFunction(() => document.querySelectorAll('#grid-body .tile').length === 120);
  const tiles = await app.page.$$eval('#grid-body .tile', (els) => els.map((e) => e.dataset.id));
  assertOrder(tiles, expected, 'grid tile order');
  assert.match(await app.page.textContent('#grid-title'), /（120件）$/);
  assert.equal(await app.page.$$eval('#grid-body .grid-day', (els) => els.length), 1);
  // thumbnails of the visible tiles load
  await app.page.waitForFunction(() => [...document.querySelectorAll('#grid-body .tile')].slice(0, 8).every((t) => !t.classList.contains('no-thumb')), null, { timeout: 20000 });
  // scroll to the end and pick the last tile
  await app.page.locator('#grid-body .tile').last().scrollIntoViewIfNeeded();
  await app.page.locator('#grid-body .tile').last().click();
  await app.waitForSlide({ id: expected[119] });
  await app.page.waitForFunction((id) => window.__slideLog.find((e) => e.id === id)?.color, expected[119]);
  const e = (await app.slideLog()).find((x) => x.id === expected[119]);
  assert.ok(colorNear(e.color, suite.byId[expected[119]]._test.bgColor, 40), `colour ${e.color}`);
  assert.equal(await app.page.textContent('#player .counter'), '120 / 120');
  assertNoPageErrors(app);
  await app.close();
})(t));
