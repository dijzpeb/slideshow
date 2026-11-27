// Scenario 1 (catalog order, exclusions, shortcuts, pagination, title/day cards) and
// scenario 3 (background EXIF refinement).
import { test, before, after } from 'node:test';
import {
  openSuite, assert, assertOrder, expectedFor, mediaRequests, listRequests, assertNoPageErrors, TEST_KEY, TRIP_TZ, META_CACHE_KEY,
} from './lib.mjs';

let suite;
before(async () => {
  suite = await openSuite({ maxPageSize: 4 });
});
after(async () => {
  await suite?.close();
});

const ROOT_PARAMS = { folder: 'folder_root', key: TEST_KEY, mode: 'apikey', interval: 1, autostart: 1 };
const dayKeyTrip = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TRIP_TZ }).format(new Date(iso));

test('1. API-key mode, folder_root: chronological order, exclusions, shortcuts, pagination, title & day cards', { timeout: 90000 }, (t) => suite.wrap('01-catalog-order', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS });
  await app.waitForPlayer();

  // --- order and times ------------------------------------------------------------------
  const items = await app.items();
  const ids = items.map((i) => i.id);
  const expected = expectedFor(suite.manifest, 'default', ids);
  assertOrder(ids, expected, 'window.__slideshow.items order vs expectedOrderDefault');
  for (const it of items) {
    const want = suite.byId[it.id]._test.expected.appTimeUtcDefault;
    assert.equal(it.iso, want, `capture time of ${it.id} (source ${it.timeSource})`);
  }
  // videos: the time source must come from the file, not from Drive dates
  const src = Object.fromEntries(items.map((i) => [i.id, i.timeSource]));
  assert.equal(src.vid_tram, 'mp4-mvhd', 'vid_tram (moov at end) read from mvhd');
  assert.equal(src.vid_harbour_ferry, 'mp4-mvhd');
  assert.equal(src.vid_deer_mov, 'mp4-apple', 'MOV uses com.apple.quicktime.creationdate');
  assert.equal(src.vid_pxl_bike, 'filename', 'Pixel filename (UTC)');
  assert.equal(src.img_screenshot, 'filename');
  assert.equal(src.img_cabin, 'drive-times');
  assert.match(src.img_sony_offset, /^exif(-offset)?$/);

  // --- exclusions and shortcut resolution ---------------------------------------------------
  for (const id of ['img_trashed', 'txt_notes', 'doc_itinerary', 'sc_img_other', 'sc_folder_extra', 'img_hidden_lunch', 'img_hidden_berries',
    'folder_day1', 'folder_night_sky', 'img_private_1', 'img_reskey_1', 'big_001']) {
    assert.ok(!ids.includes(id), `${id} must not be in the slideshow`);
  }
  assert.ok(ids.includes('img_other_market'), 'file shortcut target (in a non-public folder) resolved');
  assert.ok(ids.includes('img_extra_old_town'), 'folder shortcut followed');
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');

  // --- pagination (maxPageSize 4) -----------------------------------------------------------
  const log = await suite.admin.log();
  const lists = listRequests(log);
  const paged = lists.filter((e) => e.query.pageToken);
  assert.ok(paged.length >= 3, `expected follow-up page requests with pageToken, got ${paged.length}`);
  for (const e of lists) assert.equal(e.status, 200, `list request failed: ${JSON.stringify(e.query)}`);
  for (const folder of ['folder_root', 'folder_day1', 'folder_day2', 'folder_day3', 'folder_night_sky', 'folder_day4', 'folder_extra']) {
    assert.ok(lists.some((e) => e.query.q && e.query.q.includes(`'${folder}' in parents`)), `${folder} was listed`);
  }
  assert.ok(lists.every((e) => /trashed\s*=\s*false/.test(e.query.q)), 'list queries exclude trash');
  // every list request is in API-key mode
  assert.ok(log.filter((e) => e.method === 'GET').every((e) => e.auth === 'key' || e.path.startsWith('/thumb/')), 'API-key auth on every Drive call');

  // --- title card -------------------------------------------------------------------------------
  await app.waitForSlide({ kind: 'title' });
  const title = await app.page.evaluate(() => {
    const el = document.querySelector('#player .slide-title');
    return {
      title: el.querySelector('.card-title')?.textContent,
      sub: el.querySelector('.card-sub')?.textContent,
      meta: el.querySelector('.card-meta')?.textContent,
      doc: document.title,
    };
  });
  const rootName = suite.byId.folder_root.name;
  assert.equal(title.title, rootName, 'title card shows the folder name');
  assert.equal(title.sub, '2025年7月12日（土） – 7月15日', 'title card shows the date range');
  const nVideos = items.filter((i) => i.kind === 'video').length;
  assert.equal(title.meta, `写真 ${items.length - nVideos}枚・動画 ${nVideos}本・4日間`);
  assert.equal(title.doc, `${rootName} - スライドショー`);

  // --- day cards ------------------------------------------------------------------------------
  const daySlides = await app.page.evaluate(() => window.__slideshow.player.slides.filter((s) => s.type === 'day').map((s) => ({ day: s.day, n: s.dayNumber, count: s.count })));
  const expDays = new Map();
  for (const id of expected) {
    const k = dayKeyTrip(suite.byId[id]._test.expected.appTimeUtcDefault);
    expDays.set(k, (expDays.get(k) || 0) + 1);
  }
  assert.deepEqual(daySlides, [...expDays.entries()].map(([day, count], i) => ({ day, n: i + 1, count })), 'day cards 1日目..4日目 with item counts');
  // slide list = title, then each day card directly before the first item of that day
  const slideKeys = await app.page.evaluate(() => window.__slideshow.player.slides.map((s) => s.key));
  const expKeys = ['title'];
  let lastDay = null;
  for (const id of expected) {
    const d = dayKeyTrip(suite.byId[id]._test.expected.appTimeUtcDefault);
    if (d !== lastDay) expKeys.push(`day:${d}`);
    lastDay = d;
    expKeys.push(`media:${id}`);
  }
  assert.deepEqual(slideKeys, expKeys);

  // the first day card is actually displayed after the title
  await app.waitForSlide({ kind: 'day', day: '2025-07-12' }, 15000);
  const day1 = await app.page.evaluate(() => {
    const el = document.querySelector('#player .slide-day.visible');
    return { kicker: el.querySelector('.card-kicker').textContent, title: el.querySelector('.card-title').textContent, meta: el.querySelector('.card-meta').textContent };
  });
  assert.deepEqual(day1, { kicker: '1日目', title: '2025年7月12日（土）', meta: `${expDays.get('2025-07-12')}件` });

  // first photo + caption + counter
  await app.waitForSlide({ id: expected[0] }, 15000);
  const hud = await app.page.evaluate(() => ({
    caption: document.querySelector('#player .caption').textContent,
    counter: document.querySelector('#player .counter').textContent,
  }));
  assert.match(hud.caption, /7月12日（土） 12:05/, 'caption shows the trip-zone wall-clock time');
  assert.match(hud.caption, /1日目/);
  assert.equal(hud.counter, `1 / ${expected.length}`);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('1b. metadata cache: a reload reuses the parsed capture times (no Range reads before the show starts)', { timeout: 90000 }, (t) => suite.wrap('01b-meta-cache', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS });
  await app.waitForPlayer();
  // wait for the background refinement to finish (its results are cached too)
  await app.page.waitForFunction(() => window.__slideshow.items.find((i) => i.id === 'img_airport')?.timeSource === 'exif-offset', null, { timeout: 30000 });
  const cached = await app.page.evaluate((k) => Object.keys(JSON.parse(localStorage.getItem(k) || '{}')), META_CACHE_KEY);
  for (const id of ['vid_tram', 'vid_deer_mov', 'img_sony_offset', 'img_city_square']) assert.ok(cached.includes(id), `${id} cached`);
  const ids1 = await app.itemIds();
  await suite.admin.clearLog();
  await app.page.reload();
  await app.waitForPlayer();
  const ids2 = await app.itemIds();
  assert.deepEqual(ids2, ids1);
  const items = await app.items();
  assert.equal(items.find((i) => i.id === 'img_city_square').timeSource, 'exif-offset', 'refined result applied immediately from the cache');
  const ranged = (await suite.admin.log()).filter((e) => e.range && /^bytes=0-/.test(e.range) && e.origin && !e.path.includes('vid_'));
  assert.deepEqual(ranged.map((e) => e.path), [], 'no EXIF Range reads on the second load');
  assertNoPageErrors(app);
  await app.close();
})(t));

test('3. background EXIF refinement: offsets honoured, Canon (no offset) keeps the Drive time, order unchanged', { timeout: 90000 }, (t) => suite.wrap('03-refine', async () => {
  await suite.admin.reset();
  await suite.admin.clearLog();
  const app = await suite.newApp({ params: ROOT_PARAMS });
  await app.waitForPlayer();
  const ids0 = await app.itemIds();
  const expected = expectedFor(suite.manifest, 'default', ids0);
  assertOrder(ids0, expected, 'initial order');

  // photos without a Drive time are parsed before the show starts (required phase)
  let items = await app.items();
  const byIdNow = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byIdNow.img_exif_range.iso, '2025-07-13T08:30:00.000Z');
  assert.equal(byIdNow.img_sony_offset.iso, '2025-07-13T10:05:00.000Z', 'Sony DTO 19:05 +09:00 → 10:05Z');
  assert.equal(byIdNow.img_exif_range.timeSource, 'exif-offset');
  assert.equal(byIdNow.img_sony_offset.timeSource, 'exif-offset');

  // refine phase: every photo with a readable EXIF is re-read in the background
  const refineIds = items.filter((i) => i.kind === 'image' && suite.byId[i.id]._test.exif && suite.byId[i.id].imageMediaMetadata?.time).map((i) => i.id);
  assert.ok(refineIds.length >= 15, `refine candidates: ${refineIds.length}`);
  const expectSource = (id) => (suite.byId[id]._test.exif.offsetTimeOriginal ? 'exif-offset' : 'exif');
  try {
    await app.page.waitForFunction((want) => {
      const m = Object.fromEntries(window.__slideshow.items.map((i) => [i.id, i.timeSource]));
      return Object.entries(want).every(([id, s]) => m[id] === s);
    }, Object.fromEntries(refineIds.map((id) => [id, expectSource(id)])), { timeout: 45000 });
  } catch {
    items = await app.items();
    const diff = refineIds.map((id) => [id, items.find((i) => i.id === id)?.timeSource, expectSource(id)]).filter(([, a, b]) => a !== b);
    assert.fail(`refinement did not finish with the expected time sources: ${JSON.stringify(diff)}`);
  }
  items = await app.items();
  for (const it of items) assert.equal(it.iso, suite.byId[it.id]._test.expected.appTimeUtcDefault, `time of ${it.id} after refinement (${it.timeSource})`);
  assertOrder(items.map((i) => i.id), expected, 'order after refinement');
  for (const id of suite.manifest.canonIds) {
    assert.equal(items.find((i) => i.id === id).timeSource, 'exif', `${id}: Canon without OffsetTimeOriginal stays on the trip-zone wall clock`);
  }

  // the refinement used small Range reads, not full downloads
  const log = await suite.admin.log();
  for (const id of refineIds) {
    const reqs = mediaRequests(log, id);
    assert.ok(reqs.some((e) => /^bytes=0-\d+$/.test(e.range || '') && Number(e.range.split('-')[1]) < 256 * 1024), `${id}: EXIF read with a Range request`);
  }
  // the player received the refined list (current slide kept)
  const playerIds = await app.page.evaluate(() => window.__slideshow.player.items.map((i) => i.id));
  assertOrder(playerIds, expected, 'player.items after refinement');
  assertNoPageErrors(app);
  await app.close();
})(t));

test('3b. refinement fixes Drive times when the trip time zone setting is wrong (tz=UTC) and re-sorts the running show', { timeout: 90000 }, (t) => suite.wrap('03b-refine-tz', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: { ...ROOT_PARAMS, tz: 'UTC' }, navigate: false });
  // hold the background EXIF reads of photos that have a Drive time, to observe the state before refinement
  const refineIds = new Set(suite.manifest.files.filter((f) => f._test?.exif && f.imageMediaMetadata?.time).map((f) => f.id));
  let release;
  const gate = new Promise((r) => { release = r; });
  let held = 0;
  await app.context.route(/\/drive\/v3\/files\/[^/?]+\?alt=media/, async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
    if (refineIds.has(id) && route.request().headers().range) {
      held++;
      await gate;
    }
    await route.continue().catch(() => {});
  });
  await app.goto();
  await app.waitForPlayer();
  await app.page.waitForFunction(() => window.__slideshow.player && window.__slideshow.player.slides.length > 0);
  let items = Object.fromEntries((await app.items()).map((i) => [i.id, i]));
  // before refinement: Drive wall clock "12:05" read as UTC
  assert.equal(items.img_city_square.iso, '2025-07-12T12:05:00.000Z', 'pre-refinement: Drive time interpreted in the (wrong) trip zone');
  assert.equal(items.img_city_square.timeSource, 'exif');
  assert.equal(items.img_market_square_canon.iso, '2025-07-12T20:10:00.000Z');
  // video times are absolute and unaffected by the trip zone
  assert.equal(items.vid_tram.iso, '2025-07-12T15:30:00.000Z');
  assert.ok(held > 0, 'refinement requests were issued');
  release();
  await app.page.waitForFunction(() => window.__slideshow.items.find((i) => i.id === 'img_city_square').timeSource === 'exif-offset', null, { timeout: 45000 });
  const withOffset = Object.keys(items).filter((id) => suite.byId[id]._test.exif?.offsetTimeOriginal);
  assert.ok(withOffset.length >= 10, `photos with OffsetTimeOriginal: ${withOffset.length}`);
  await app.page.waitForFunction((ids) => ids.every((id) => window.__slideshow.items.find((i) => i.id === id)?.timeSource === 'exif-offset'), withOffset, { timeout: 45000 });
  items = Object.fromEntries((await app.items()).map((i) => [i.id, i]));
  for (const [id, f] of Object.entries(suite.byId)) {
    if (!items[id] || !f._test.exif?.offsetTimeOriginal) continue;
    assert.equal(items[id].iso, f._test.trueCaptureUtc, `${id}: refined with OffsetTimeOriginal → true instant`);
  }
  // Canon has no offset: stays on the wall clock interpreted in the configured zone
  assert.equal(items.img_market_square_canon.iso, '2025-07-12T20:10:00.000Z');
  // the running player was re-sorted
  const playerIds = await app.page.evaluate(() => window.__slideshow.player.items.map((i) => i.id));
  const stateIds = await app.itemIds();
  assert.deepEqual(playerIds, stateIds);
  const sorted = [...Object.values(items)].sort((a, b) => a.epoch - b.epoch || 0).map((i) => i.id);
  assert.deepEqual(stateIds.filter((id) => items[id]).map((id) => items[id].epoch), sorted.map((id) => items[id].epoch), 'items sorted by time');
  assertNoPageErrors(app);
  await app.close();
})(t));
