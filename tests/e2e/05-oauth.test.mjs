// Scenario 9: OAuth mode with a stubbed Google Identity Services library — sign-in on 「開始」,
// Bearer tokens through the Service Worker, token expiry → re-login overlay → resume, folder search.
import { test, before, after } from 'node:test';
import {
  openSuite, assert, assertOrder, mediaRequests, assertNoPageErrors, colorNear, TEST_KEY,
} from './lib.mjs';

let suite;
before(async () => {
  suite = await openSuite({ maxPageSize: 4 });
});
after(async () => {
  await suite?.close();
});

const TOKEN_KEY = 'finland-slideshow.token.v1';

test('9a. OAuth: folder_private loads after clicking start (token requested via GIS), photos are downloaded with the Bearer token', { timeout: 120000 }, (t) => suite.wrap('09a-oauth', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false });
  const { page } = app;
  await app.goto({ mode: 'oauth', clientId: 'test-client', folder: 'folder_private', interval: 1 });
  await page.waitForSelector('#setup:not([hidden])');
  assert.equal(await page.isChecked('input[name="authMode"][value="oauth"]'), true);
  assert.match(await page.textContent('#login-status'), /「スライドショーを開始」を押すと Google のログイン画面が開きます。/);
  assert.equal(await page.evaluate(() => window.__gis?.requests.length ?? 0), 0, 'no token request before the click');
  await page.click('#btn-start');
  await app.waitForPlayer();
  const gis = await page.evaluate(() => ({ n: window.__gis.requests.length, prompt: window.__gis.requests[0]?.prompt, clientId: window.__gis.clientId, scope: window.__gis.scope }));
  assert.deepEqual(gis, { n: 1, prompt: '', clientId: 'test-client', scope: 'https://www.googleapis.com/auth/drive.readonly' });
  assert.ok(app.gisLoads.length >= 1, 'GIS library loaded from accounts.google.com');
  const ids = await app.itemIds();
  assertOrder(ids, suite.manifest.expectedOrderByFolder.folder_private, 'folder_private order');
  assert.ok(await page.evaluate(() => !!window.__slideshow.sw), 'Service Worker active');

  for (const id of ids) {
    await app.waitForSlide({ id }, 20000);
    await page.waitForFunction((i) => window.__slideLog.find((e) => e.id === i)?.nw > 0, id);
  }
  for (const e of (await app.slideLog()).filter((x) => x.kind === 'image')) {
    assert.match(e.src, /^blob:/);
    assert.ok(colorNear(e.color, suite.byId[e.id]._test.bgColor), `${e.id} colour ${e.color}`);
  }
  const log = await suite.admin.log();
  for (const id of ids) {
    const reqs = mediaRequests(log, id);
    assert.ok(reqs.length > 0, `${id} downloaded`);
    for (const e of reqs) {
      assert.equal(e.auth, 'bearer', `${id}: bearer auth`);
      assert.equal(e.authOk, true);
      assert.equal(e.query.key, undefined, 'no API key in OAuth mode');
    }
    // the app (origin = app) fetched the full photo
    assert.ok(reqs.some((e) => e.origin === suite.env.appUrl && !e.range && e.status === 200), `${id}: full download`);
  }
  assert.ok(log.filter((e) => e.method === 'GET' && !e.path.startsWith('/thumb/')).every((e) => e.auth === 'bearer'), 'every API call used the bearer token');
  // the token is kept for this tab only
  const stored = await page.evaluate((k) => JSON.parse(sessionStorage.getItem(k)), TOKEN_KEY);
  assert.equal(stored.accessToken, 'test-token');
  assert.equal(stored.clientId, 'test-client');
  assert.equal(await page.evaluate(() => localStorage.getItem('finland-slideshow.settings.v1').includes('test-token')), false, 'token not persisted in localStorage');

  // reload with autostart=1: the stored token is reused, no new login
  await app.goto({ mode: 'oauth', clientId: 'test-client', folder: 'folder_private', interval: 1, autostart: 1 });
  await app.waitForPlayer();
  assert.equal(await page.evaluate(() => window.__gis?.requests.length ?? 0), 0, 'no second login after reload');
  assertNoPageErrors(app);
  await app.close();
})(t));

test('9b. OAuth token expiry: 401 on the next media load → re-login overlay, show paused; 「ログインして続ける」 resumes with the new token', { timeout: 150000 }, (t) => suite.wrap('09b-oauth-expiry', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false });
  const { page } = app;
  await app.startOAuth('folder_root');
  await app.waitForSlide({ id: 'img_senate_square' }, 20000);
  // let the background EXIF reads finish so that the next request is a media load
  await page.waitForFunction(() => window.__slideshow.items.find((i) => i.id === 'img_airport')?.timeSource === 'exif-offset', null, { timeout: 30000 });
  await suite.admin.clearLog();
  await suite.admin.setTokens([]);
  await page.waitForSelector('#auth-overlay:not([hidden])', { timeout: 30000 });
  assert.equal(await page.textContent('#auth-title'), 'ログインの有効期限が切れました');
  const st = await app.current();
  assert.equal(st.playing, false, 'show paused while logged out');
  assert.ok(await page.evaluate(() => document.querySelector('#player').classList.contains('paused')));
  const log1 = await suite.admin.log();
  assert.ok(log1.some((e) => e.status === 401 && e.auth === 'bearer'), 'the mock rejected the old token');
  assert.equal(await page.evaluate((k) => sessionStorage.getItem(k), TOKEN_KEY), null, 'rejected token discarded');
  // stays paused while the overlay is open
  const nSlides = (await app.slideLog()).length;
  await page.waitForTimeout(2500);
  assert.equal((await app.slideLog()).length, nSlides, 'no slide changes behind the overlay');

  // re-login
  await suite.admin.clearLog();
  await suite.admin.setTokens(['test-token-2']);
  await page.evaluate(() => { window.__nextToken = 'test-token-2'; });
  await page.click('#btn-reauth');
  await page.waitForSelector('#auth-overlay', { state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__gis.requests.length), 2, 'second token request on the button click');
  await page.waitForFunction(() => window.__slideshow.player.playing === true);
  await page.waitForFunction((n) => window.__slideLog.filter((e) => e.kind === 'image' && e.nw > 0).length >= 2 && window.__slideLog.length >= n + 2, nSlides, { timeout: 30000 });
  const log2 = await suite.admin.log();
  const media2 = log2.filter((e) => e.query && e.query.alt === 'media');
  assert.ok(media2.length > 0, 'media requested after re-login');
  assert.ok(media2.some((e) => e.auth === 'bearer' && e.authOk && (e.status === 200 || e.status === 206)), 'new token accepted');
  assert.equal((await page.evaluate((k) => JSON.parse(sessionStorage.getItem(k)), TOKEN_KEY)).accessToken, 'test-token-2');
  assert.ok(!log2.some((e) => e.status === 401 && e.query?.alt === 'media' && Date.parse(e.ts) > Date.now() - 3000), 'no further 401s');

  // expire again and choose 「設定に戻る」
  await suite.admin.setTokens([]);
  await page.waitForSelector('#auth-overlay:not([hidden])', { timeout: 30000 });
  await page.click('#btn-auth-cancel');
  await page.waitForSelector('#setup:not([hidden])');
  assert.equal(await page.isHidden('#auth-overlay'), true);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('9c. OAuth folder search (フォルダを検索) fills the folder URL (with resource key) and the login status UI', { timeout: 120000 }, (t) => suite.wrap('09c-oauth-search', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false });
  const { page } = app;
  await app.goto({ mode: 'oauth', clientId: 'test-client', interval: 1 });
  await page.waitForSelector('#setup:not([hidden])');
  // login button in the status area
  await page.click('#login-status button');
  await page.waitForFunction(() => /ログイン中（あと約 \d+ 分有効）/.test(document.querySelector('#login-status').textContent));
  assert.match(await page.textContent('#login-status'), /あと約 60 分有効/);

  await page.click('#btn-folder-search');
  await page.waitForSelector('#folder-overlay:not([hidden])');
  await page.waitForSelector('#folder-results .folder-item');
  const all = await page.$$eval('#folder-results .folder-item strong', (els) => els.map((e) => e.textContent));
  // (only the first result page is shown; the mock caps pages at 4 here)
  assert.ok(all.length >= 1, `folders: ${all}`);
  await page.fill('#folder-query', 'フィンランド');
  await page.press('#folder-query', 'Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#folder-results .folder-item strong')].map((e) => e.textContent).join() === 'フィンランド旅行 2025');
  await page.fill('#folder-query', 'old shared');
  await page.press('#folder-query', 'Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#folder-results .folder-item strong')].map((e) => e.textContent).join() === 'Old shared folder');
  await page.click('#folder-results .folder-item');
  await page.waitForSelector('#folder-overlay', { state: 'hidden' });
  assert.equal(await page.inputValue('#f-folder'), 'https://drive.google.com/drive/folders/folder_reskey?resourcekey=0-ABCdef');
  assert.equal(await page.getAttribute('input[name="title"]', 'placeholder'), 'Old shared folder');
  // search with a quote in it must not break the query
  await page.click('#btn-folder-search');
  await page.fill('#folder-query', "Friend's");
  await page.press('#folder-query', 'Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#folder-results .folder-item strong')].map((e) => e.textContent).join() === "Friend's photos", null, { timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#folder-overlay', { state: 'hidden' });

  await page.click('#btn-start');
  await app.waitForPlayer();
  assertOrder(await app.itemIds(), suite.manifest.expectedOrderByFolder.folder_reskey, 'folder found by search plays');
  const log = await suite.admin.log();
  const search = log.filter((e) => e.path === '/drive/v3/files' && /mimeType\s*=\s*'application\/vnd.google-apps.folder'/.test(e.query.q || ''));
  assert.ok(search.length >= 3 && search.every((e) => e.status === 200 && e.auth === 'bearer'), JSON.stringify(search.map((e) => [e.query.q, e.status])));
  // logout
  await page.mouse.move(400, 300);
  await page.click('#player .ctl-settings');
  await page.waitForSelector('#setup:not([hidden])');
  await page.click('#login-status button:has-text("ログアウト")');
  await page.waitForFunction(() => /「スライドショーを開始」を押すと/.test(document.querySelector('#login-status').textContent));
  assert.equal(await page.evaluate((k) => sessionStorage.getItem(k), TOKEN_KEY), null);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('9d. OAuth: an unplayable (HEVC) video shows its poster and a 「Google ドライブのプレーヤーで再生」 button that opens the Drive player', { timeout: 120000 }, (t) => suite.wrap('09d-oauth-hevc', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false });
  const { page } = app;
  await app.startOAuth('folder_root');
  // go to the item after vid_hevc, pause, then step back onto it (so the 1 s timer cannot move on)
  await app.jumpViaGrid('vid_reindeer_mov');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__slideshow.player.playing === false);
  await page.keyboard.press('ArrowLeft');
  await page.waitForSelector('#player .slide-video-fallback.visible[data-id="vid_hevc"]', { timeout: 20000 });
  const fb = await page.evaluate(() => {
    const el = document.querySelector('#player .slide-video-fallback.visible');
    return { poster: el.querySelector('img.photo')?.src, button: el.querySelector('button')?.textContent, video: !!el.querySelector('video'), note: el.querySelector('.fallback-note p')?.textContent };
  });
  assert.ok(fb.poster && fb.poster.startsWith(`${suite.env.driveUrl}/thumb/vid_hevc=s`), `poster ${fb.poster}`);
  assert.match(fb.button, /Google ドライブのプレーヤーで再生/);
  assert.equal(fb.video, false);
  assert.match(fb.note, /直接再生できません/);
  await page.click('#player .slide-video-fallback.visible button');
  await page.waitForSelector('#player .drive-player iframe');
  const dp = await page.evaluate(() => ({
    src: document.querySelector('#player .drive-player iframe').src,
    link: document.querySelector('#player .drive-player a').href,
  }));
  assert.equal(dp.src, 'https://drive.google.com/file/d/vid_hevc/preview?autoplay=1');
  assert.match(dp.link, /^https:\/\/drive\.google\.com\/file\/d\/vid_hevc\/view/);
  assert.ok(app.previewRequests.some((u) => u.includes('/file/d/vid_hevc/preview')));
  assert.equal((await app.current()).playing, false, 'show paused while the Drive player is open');
  // keys do not reach the slideshow while the Drive player is open; Escape closes it
  const idx = (await app.current()).index;
  await page.keyboard.press('ArrowRight');
  assert.equal((await app.current()).index, idx);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#player .drive-player', { state: 'detached' });
  await page.keyboard.press('ArrowRight');
  await app.waitForSlide({ id: 'vid_reindeer_mov' });
  assertNoPageErrors(app);
  await app.close();
})(t));

test('9e. OAuth: 5 minutes before expiry a banner offers 「延長する」, which refreshes the token', { timeout: 120000 }, (t) => suite.wrap('09e-oauth-expiring', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false });
  const { page } = app;
  await app.goto({ mode: 'oauth', clientId: 'test-client', folder: 'folder_private', interval: 1 });
  await page.waitForSelector('#setup:not([hidden])');
  await page.evaluate(() => { window.__nextExpiresIn = 302; }); // warning fires ~2 s after login
  await page.click('#btn-start');
  await app.waitForPlayer();
  await page.waitForSelector('#player .expiring-banner', { timeout: 15000 });
  assert.match(await page.textContent('#player .expiring-banner'), /まもなくログインの有効期限が切れます。/);
  const exp1 = await page.evaluate(() => window.__slideshow.session.expiresAt);
  await page.evaluate(() => { window.__nextExpiresIn = 3599; window.__nextToken = 'test-token'; });
  await page.click('#player .expiring-banner button:has-text("延長する")');
  await page.waitForFunction(() => window.__toasts.some((x) => x.text === 'ログインを延長しました'));
  await page.waitForSelector('#player .expiring-banner', { state: 'detached' });
  const exp2 = await page.evaluate(() => window.__slideshow.session.expiresAt);
  assert.ok(exp2 - exp1 > 3000 * 1000, `expiry extended (${exp1} → ${exp2})`);
  assert.equal(await page.evaluate(() => window.__gis.requests.length), 2);
  assert.equal((await app.current()).playing, true, 'the show kept playing');
  assertNoPageErrors(app);
  await app.close();
})(t));

test('9f. OAuth: login popup closed / access denied → Japanese error on the setup screen, no show', { timeout: 60000 }, (t) => suite.wrap('09f-oauth-denied', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false });
  const { page } = app;
  await app.goto({ mode: 'oauth', clientId: 'test-client', folder: 'folder_private', interval: 1 });
  await page.waitForSelector('#setup:not([hidden])');
  await page.evaluate(() => { window.__nextTokenError = { error: 'access_denied' }; });
  await page.click('#btn-start');
  await page.waitForSelector('#setup-error:not([hidden])');
  assert.equal(await page.textContent('#setup-error'), 'Google ドライブへのアクセスが許可されませんでした。');
  await page.evaluate(() => { window.__nextTokenError = { type: 'popup_closed' }; });
  await page.click('#btn-start');
  await page.waitForFunction(() => document.querySelector('#setup-error').textContent === 'ログインがキャンセルされました。');
  assert.equal(await page.evaluate(() => window.__slideshow.screen), 'setup');
  // and a normal login still works afterwards
  await page.click('#btn-start');
  await app.waitForPlayer();
  assertNoPageErrors(app);
  await app.close();
})(t));

test('9g. two tabs with different credentials (OAuth tab + API-key tab): the Service Worker must use each tab\'s own credentials', { timeout: 120000 }, (t) => suite.wrap('09g-two-tabs', async () => {
  await suite.admin.reset();
  // tab B: OAuth, private folder (photos need the bearer token)
  const B = await suite.newApp({ navigate: false });
  await B.startOAuth('folder_private', { interval: 30 });
  await B.page.waitForFunction(() => window.__slideLog.some((e) => e.kind === 'image' && e.nw > 0), null, { timeout: 20000 });
  // tab A in the same browser profile: API key, public folder → pushes its credentials into the shared SW
  const A = await B.context.newPage();
  await A.goto(suite.env.appUrlFor({ folder: 'folder_root', key: TEST_KEY, mode: 'apikey', interval: 1, autostart: 1 }));
  await A.waitForFunction(() => window.__slideshow && window.__slideshow.screen === 'player', null, { timeout: 20000 });
  await A.waitForTimeout(1000);
  // tab B needs its photos again (its in-memory cache only keeps a few photos; drop it to force new downloads)
  await suite.admin.clearLog();
  const n0 = (await B.slideLog()).length;
  await B.page.evaluate(() => {
    window.__slideshow.loader.clear();
    window.__slideshow.player.goToItem('img_private_1');
  });
  await B.page.waitForFunction((n) => window.__slideLog.slice(n).some((x) => x.id === 'img_private_1' && x.nw > 0), n0, { timeout: 30000 });
  const e = (await B.slideLog()).slice(n0).find((x) => x.id === 'img_private_1');
  const reqs = mediaRequests(await suite.admin.log(), 'img_private_1');
  const summary = reqs.map((r) => `${r.auth}→${r.status}`).join(', ');
  assert.ok(reqs.every((r) => r.auth === 'bearer'), `tab B's photo was requested with another tab's credentials: ${summary} `
    + '(sw.js must keep credentials per client)');
  assert.match(e.src, /^blob:/, `tab B shows the original photo, not a thumbnail fallback (${e.src})`);
  // media elements of tab B go through the Service Worker: it must use tab B's credentials, not tab A's
  await suite.admin.clearLog();
  const viaSw = await B.page.evaluate(() => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ ok: true, w: img.naturalWidth });
    img.onerror = () => resolve({ ok: false });
    img.src = `__drive/media/img_private_1?mt=image%2Fjpeg&t=${Date.now()}`;
  }));
  const swReqs = mediaRequests(await suite.admin.log(), 'img_private_1');
  assert.ok(swReqs.length > 0 && swReqs.every((r) => r.auth === 'bearer'), `SW request credentials: ${swReqs.map((r) => `${r.auth}→${r.status}`)}`);
  assert.ok(viaSw.ok && viaSw.w > 0, 'tab B <img> through the SW loads');
  await A.close();
  await B.close();
})(t));
