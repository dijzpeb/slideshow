// Extra: private files whose thumbnailLink is not usable from <img> (thumbnails need auth, as for
// real private Drive files without cookies): the show is unaffected, the grid degrades gracefully.
import { test, before, after } from 'node:test';
import { openSuite, assert, assertOrder, expectedFor, assertNoPageErrors, assertNoCspViolations } from './lib.mjs';

let suite;
before(async () => {
  suite = await openSuite({ maxPageSize: 100, driveOptions: { thumbAuth: 'required' } });
});
after(async () => {
  await suite?.close();
});

test('20. OAuth with thumbnails that need auth: photos/videos still play, grid shows fallback tiles, thumbnails are given up after a few failures', { timeout: 120000 }, (t) => suite.wrap('20-private-thumbs', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false });
  const { page } = app;
  await app.startOAuth('folder_root');
  const ids = await app.itemIds();
  assertOrder(ids, expectedFor(suite.manifest, 'default', ids), 'order');
  // the first photo and a video display normally (through the SW with the token)
  await app.waitForSlide({ id: ids[0] }, 20000);
  await page.waitForFunction((id) => window.__slideLog.find((e) => e.id === id)?.nw > 0, ids[0]);
  await app.jumpViaGrid('vid_tram');
  await page.waitForFunction(() => window.__video.vid_tram?.maxTime > 0.3, null, { timeout: 20000 });
  // grid
  await page.keyboard.press('g');
  await page.waitForSelector('#grid-overlay:not([hidden])');
  await page.waitForFunction((n) => document.querySelectorAll('#grid-body .tile').length === n, ids.length);
  await page.waitForFunction(() => window.__slideshow.loader.thumbFailed === true, null, { timeout: 20000 });
  const tiles = await page.$$eval('#grid-body .tile', (els) => els.map((el) => ({
    id: el.dataset.id, noThumb: el.classList.contains('no-thumb'), name: el.querySelector('.tile-name')?.textContent,
    imgVisible: !!el.querySelector('img') && !el.querySelector('img').hidden && el.querySelector('img').naturalWidth > 0,
  })));
  for (const tile of tiles) {
    assert.ok(tile.noThumb || tile.imgVisible, `${tile.id}: either a fallback tile or a working image`);
    if (tile.noThumb) assert.equal(tile.name, suite.byId[tile.id].name, `${tile.id}: fallback tile shows the file name`);
  }
  const thumbReqs = (await suite.admin.log()).filter((e) => e.path.startsWith('/thumb/'));
  assert.ok(thumbReqs.length > 0 && thumbReqs.every((e) => e.status >= 400), 'thumbnail requests were rejected by the mock');
  // re-opening the grid does not retry the broken thumbnails
  await page.keyboard.press('Escape');
  await suite.admin.clearLog();
  await page.keyboard.press('g');
  await page.waitForSelector('#grid-overlay:not([hidden])');
  await page.waitForTimeout(1000);
  assert.equal((await suite.admin.log()).filter((e) => e.path.startsWith('/thumb/')).length, 0, 'thumbnails not requested again');
  assertNoPageErrors(app);
  await assertNoCspViolations(app);
  await app.close();
})(t));
