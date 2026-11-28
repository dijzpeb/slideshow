// Video preloading: while the slide before a video is shown, the next video is already loading in a detached
// <video>, and that same element is shown when the slideshow gets there (no wait for the first Drive round trips).
import { test, before, after } from 'node:test';
import { openSuite, assert, assertNoPageErrors } from './lib.mjs';

let suite;
before(async () => {
  suite = await openSuite();
});
after(async () => {
  await suite?.close();
});

/** wait until the player preloads `id`, and keep a reference to that <video> in the page as window[name] */
async function waitForPreload(app, id, name, timeout = 10000) {
  await app.page.waitForFunction((id) => window.__slideshow.player.videoPreload?.id === id, id, { timeout });
  await app.page.evaluate((name) => {
    window[name] = window.__slideshow.player.videoPreload.video;
  }, name);
}

/** the <video> shown for `id` is the element kept as window[name] */
const showsPreloaded = (app, id, name) =>
  app.page.evaluate(({ id, name }) => {
    const v = document.querySelector(`#player .slide-video[data-id="${id}"] video`);
    return !!v && v === window[name];
  }, { id, name });

test('V1. photo → video (OAuth, 600 ms per Drive request): the video loads while the photo is shown and appears as soon as the photo\'s time is up', { timeout: 180000 }, (t) => suite.wrap('v1-preload-photo-video', async () => {
  await suite.admin.reset();
  await suite.admin.setLatency(600);
  const app = await suite.newApp({ navigate: false, settings: { transition: 'none', videoMaxSeconds: 2 } });
  try {
    await app.startOAuth('folder_root', { interval: 3 });
    await app.waitForSlide({ id: 'img_cathedral' }, 60000);
    await waitForPreload(app, 'vid_harbour_ferry', '__pre');
    assert.equal((await app.current()).id, 'img_cathedral', 'preloading while the photo is still shown');

    await app.waitForSlide({ id: 'vid_harbour_ferry' }, 20000);
    assert.ok(await showsPreloaded(app, 'vid_harbour_ferry', '__pre'), 'the preloaded <video> is the one shown');
    const log = await app.slideLog();
    const i = log.findIndex((e) => e.id === 'vid_harbour_ferry');
    assert.equal(log[i - 1].id, 'img_cathedral');
    const wait = log[i].t - log[i - 1].t - 3000;
    // without the preload the first frame needs at least one more Drive round trip (600 ms) after the photo's 3 s
    assert.ok(wait < 300, `video shown ${Math.round(wait)} ms after the photo's 3 s were up`);

    await app.page.waitForFunction(() => window.__video.vid_harbour_ferry?.maxTime > 0.3, null, { timeout: 20000 });
    const v = (await app.videoInfo()).vid_harbour_ferry;
    assert.match(v.src, /\/__drive\/media\/vid_harbour_ferry\?/, 'streamed through the Service Worker');
    assert.equal(v.videoWidth, 640);
    assertNoPageErrors(app);
  } finally {
    await suite.admin.setLatency(0);
    await app.close();
  }
}));

test('V2. the preload is kept across a day card, and while a video plays the video after it is preloaded too', { timeout: 150000 }, (t) => suite.wrap('v2-preload-day-card-video-video', async () => {
  await suite.admin.reset();
  // → img_village_canon, [day 2025-07-14], vid_pxl_bike (2 s), vid_long_walk
  await suite.admin.trash('img_breakfast');
  await suite.admin.trash('img_lake');
  const app = await suite.newApp({ navigate: false, settings: { transition: 'none', videoMaxSeconds: 0 } });
  try {
    await app.startOAuth('folder_root', { interval: 2 });
    await app.jumpViaGrid('img_village_canon');
    await waitForPreload(app, 'vid_pxl_bike', '__pre1');

    await app.waitForSlide({ kind: 'day', day: '2025-07-14' });
    assert.ok(await app.page.evaluate(() => window.__slideshow.player.videoPreload?.video === window.__pre1), 'same preload during the day card');

    await app.waitForSlide({ id: 'vid_pxl_bike' });
    assert.ok(await showsPreloaded(app, 'vid_pxl_bike', '__pre1'), 'vid_pxl_bike: the preloaded <video> is shown');
    // a 2 s video is within the lead time of its end from the start: the next video is preloaded while it plays
    await waitForPreload(app, 'vid_long_walk', '__pre2', 5000);
    assert.equal((await app.current()).id, 'vid_pxl_bike', 'preloading while the first video is still shown');

    await app.waitForSlide({ id: 'vid_long_walk' });
    assert.ok(await showsPreloaded(app, 'vid_long_walk', '__pre2'), 'vid_long_walk: the preloaded <video> is shown');
    await app.page.waitForFunction(() => window.__video.vid_long_walk?.maxTime > 0.5, null, { timeout: 20000 });
    assert.equal((await app.videoInfo()).vid_pxl_bike.videoWidth, 640);
    assertNoPageErrors(app);
  } finally {
    await app.close();
  }
}));

test('V3. after a video this browser cannot play (HEVC → button), the next video is preloaded and used; jumping elsewhere stops a preload', { timeout: 150000 }, (t) => suite.wrap('v3-preload-fallback-drop', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false, settings: { transition: 'none', videoMaxSeconds: 2 } });
  try {
    await app.startOAuth('folder_root', { interval: 2 });
    await app.jumpViaGrid('vid_hevc');
    // Playwright's Chromium does not decode HEVC (if it did, the 3 s video would preload the next one at once too)
    await waitForPreload(app, 'vid_deer_mov', '__pre');
    await app.waitForSlide({ id: 'vid_deer_mov' });
    assert.ok(await showsPreloaded(app, 'vid_deer_mov', '__pre'), 'vid_deer_mov: the preloaded <video> is shown');
    await app.page.waitForFunction(() => window.__video.vid_deer_mov?.maxTime > 0.3, null, { timeout: 20000 });

    // a preload that is no longer next is stopped and its <video> released
    await app.jumpViaGrid('img_cathedral');
    await waitForPreload(app, 'vid_harbour_ferry', '__dropped');
    await app.page.keyboard.press('End');
    await app.waitForSlide({ id: 'img_airport' });
    const st = await app.page.evaluate(() => ({ preload: window.__slideshow.player.videoPreload?.id || null, src: window.__dropped.hasAttribute('src') }));
    assert.deepEqual(st, { preload: null, src: false });
    assertNoPageErrors(app);
  } finally {
    await app.close();
  }
}));
