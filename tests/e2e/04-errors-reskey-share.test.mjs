// Scenario 7 (error handling), scenario 8 (resource keys) and scenario 15 (share link).
import { test, before, after } from 'node:test';
import {
  openSuite, assert, assertOrder, mediaRequests, listRequests, assertNoPageErrors, colorNear, TEST_KEY, DEVICE_TZ,
} from './lib.mjs';

let suite;
before(async () => {
  suite = await openSuite({ maxPageSize: 4 });
});
after(async () => {
  await suite?.close();
});

const ROOT_PARAMS = { folder: 'folder_root', key: TEST_KEY, mode: 'apikey', interval: 1, autostart: 1 };
const MSG = {
  keyInvalid: 'API キーが無効です。Google Cloud コンソールで作成した API キーを確認してください。',
  notFoundKey: 'ファイルまたはフォルダが見つかりません。フォルダの共有設定が「リンクを知っている全員」になっているか、URL が正しいかを確認してください。',
  notFolder: '指定された ID はフォルダではありません。フォルダの URL を指定してください。',
  noFolder: 'フォルダの URL または ID を入力してください。',
  badUrl: 'フォルダの URL の形式が正しくありません。ドライブでフォルダを開いたときの URL を貼り付けてください。',
  noKey: 'API キーを入力してください。',
  noClientId: 'OAuth クライアント ID を入力してください（「OAuth クライアント ID」の欄）。',
};

async function setupError(app, timeout = 20000) {
  await app.page.waitForSelector('#setup:not([hidden]) #setup-error:not([hidden])', { timeout });
  return (await app.page.textContent('#setup-error')).trim();
}

test('7a. start-up errors are shown in Japanese on the setup screen (bad key, private folder, file id, empty folder, unknown id)', { timeout: 120000 }, (t) => suite.wrap('07a-errors', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: { ...ROOT_PARAMS, key: 'WRONGKEY' } });
  assert.equal(await setupError(app), MSG.keyInvalid);
  assert.equal(await app.page.evaluate(() => window.__slideshow.screen), 'setup');

  await app.goto({ ...ROOT_PARAMS, folder: 'folder_private' });
  assert.equal(await setupError(app), MSG.notFoundKey, 'private folder with an API key');

  await app.goto({ ...ROOT_PARAMS, folder: 'img_lake' });
  assert.equal(await setupError(app), MSG.notFolder, 'file id instead of a folder');

  await app.goto({ ...ROOT_PARAMS, folder: 'no_such_folder_123' });
  assert.equal(await setupError(app), MSG.notFoundKey, 'unknown id');

  // a folder without any media
  await suite.admin.remove('img_extra_old_town');
  await app.goto({ ...ROOT_PARAMS, folder: 'folder_extra' });
  assert.match(await setupError(app), /^フォルダ「Extra \(shared\)」に写真・動画が見つかりませんでした。/);
  await suite.admin.reset();

  // the mock never saw a request without credentials
  const log = await suite.admin.log();
  assert.ok(!log.some((e) => e.method === 'GET' && e.auth === 'none' && !e.path.startsWith('/thumb/')), 'every API call carried credentials');
  assertNoPageErrors(app);
  await app.close();
})(t));

test('7b. setup form validation (empty / malformed folder URL, missing key / client id) and accepted URL forms', { timeout: 120000 }, (t) => suite.wrap('07b-validation', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: {} });
  const { page } = app;
  await page.waitForSelector('#setup:not([hidden])');
  await page.check('input[name="authMode"][value="apikey"]');
  await page.waitForSelector('#f-apiKey', { state: 'visible' });
  await page.fill('#f-folder', '');
  await page.fill('#f-apiKey', TEST_KEY);
  await page.click('#btn-start');
  assert.equal(await setupError(app), MSG.noFolder);
  await page.fill('#f-folder', 'https://example.com/some/page');
  await page.click('#btn-start');
  assert.equal(await setupError(app), MSG.badUrl);
  await page.fill('#f-folder', 'not a folder id!');
  await page.click('#btn-start');
  assert.equal(await setupError(app), MSG.badUrl);
  await page.fill('#f-folder', 'https://drive.google.com/drive/folders/folder_day4');
  await page.fill('#f-apiKey', '');
  await page.click('#btn-start');
  assert.equal(await setupError(app), MSG.noKey);
  await page.check('input[name="authMode"][value="oauth"]');
  await page.click('#btn-start');
  assert.equal(await setupError(app), MSG.noClientId);
  await page.check('input[name="authMode"][value="apikey"]');
  await page.fill('#f-apiKey', TEST_KEY);
  assert.equal((await app.page.evaluate(() => window.__slideshow.screen)), 'setup');
  // nothing was requested from Drive for invalid input
  assert.equal(listRequests(await suite.admin.log()).length, 0);

  // accepted URL forms
  for (const url of ['https://drive.google.com/drive/u/0/folders/folder_day4', 'https://drive.google.com/open?id=folder_day4', 'folder_day4']) {
    await page.fill('#f-folder', url);
    await page.click('#btn-start');
    await app.waitForPlayer();
    assert.deepEqual(await app.itemIds(), ['img_old_town', 'img_airport'], url);
    assert.equal(await page.evaluate(() => window.__slideshow.root.name), 'Day4 Old town');
    await page.mouse.move(500, 300);
    await page.click('#player .ctl-settings');
    await page.waitForSelector('#setup:not([hidden])');
    assert.equal(await page.inputValue('#f-folder'), url, 'the form keeps the input');
  }
  assertNoPageErrors(app);
  await app.close();
})(t));

test('7b2. an invalid trip time zone typed in the form is rejected with the validation message (not silently replaced)', { timeout: 60000 }, (t) => suite.wrap('07b2-timezone', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: {} });
  const { page } = app;
  await page.waitForSelector('#setup:not([hidden])');
  await page.check('input[name="authMode"][value="apikey"]');
  await page.fill('#f-folder', 'folder_day4');
  await page.fill('#f-apiKey', TEST_KEY);
  await page.click('#display-settings summary');
  await page.fill('input[name="timeZone"]', 'Asia/Tokio'); // typo of Asia/Tokyo
  await page.click('#btn-start');
  await page.waitForFunction(() => window.__slideshow.screen === 'player' || !document.querySelector('#setup-error').hidden, null, { timeout: 20000 });
  const st = await page.evaluate(() => ({ screen: window.__slideshow.screen, tz: window.__slideshow.settings.timeZone, err: document.querySelector('#setup-error').textContent }));
  assert.equal(st.screen, 'setup', `the show started anyway with timeZone=${st.tz} (the form input must be validated before sanitize() replaces it)`);
  assert.equal(st.err, 'タイムゾーン「Asia/Tokio」が正しくありません（例：Europe/Paris、America/New_York）。');
  // the share button does not produce a link without the time zone either
  await page.evaluate(() => {
    window.__copied = [];
    try {
      navigator.clipboard.writeText = async (x) => { window.__copied.push(x); };
    } catch { /* ignore */ }
    window.prompt = (msg, x) => { window.__copied.push(x); return null; };
    document.querySelector('#setup-error').hidden = true;
  });
  await page.click('#btn-share');
  const share = await page.evaluate(() => ({ copied: window.__copied, err: document.querySelector('#setup-error').hidden ? '' : document.querySelector('#setup-error').textContent }));
  assert.deepEqual(share, { copied: [], err: 'タイムゾーン「Asia/Tokio」が正しくありません（例：Europe/Paris、America/New_York）。' });
  await page.fill('input[name="timeZone"]', 'Asia/Tokyo');
  await page.click('#btn-share');
  const ok = await page.evaluate(() => window.__copied);
  assert.equal(ok.length, 1);
  assert.equal(new URL(ok[0]).searchParams.get('tz'), 'Asia/Tokyo');
  // a tz= typo in a link is shown in the form with the message; autostart does not start the show
  await app.goto({ folder: 'folder_day4', key: TEST_KEY, mode: 'apikey', tz: 'Asia/Tokio', autostart: 1 });
  await page.waitForSelector('#setup:not([hidden])');
  await page.waitForTimeout(1000);
  const fromUrl = await page.evaluate(() => ({ screen: window.__slideshow.screen, tz: document.querySelector('input[name="timeZone"]').value, err: document.querySelector('#setup-error').textContent }));
  assert.deepEqual(fromUrl, { screen: 'setup', tz: 'Asia/Tokio', err: 'タイムゾーン「Asia/Tokio」が正しくありません（例：Europe/Paris、America/New_York）。' });
  await app.close();
})(t));

test('7c. a photo that cannot be downloaded (HTTP 500, no thumbnail) is skipped with a warning; the show does not stall', { timeout: 120000 }, (t) => suite.wrap('07c-skip-broken', async () => {
  await suite.admin.reset();
  await suite.admin.fail('img_breakfast', 500, 1000);
  const app = await suite.newApp({ params: ROOT_PARAMS, navigate: false });
  let thumbBlocked = 0;
  await app.context.route(/\/thumb\/img_breakfast=/, (route) => {
    thumbBlocked++;
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' });
  });
  await app.goto();
  await app.waitForPlayer();
  const ids = await app.itemIds();
  assert.ok(ids.includes('img_breakfast'), 'listed (metadata is fine)');
  await app.jumpViaGrid('img_village_canon');
  // village → day 3 card → (img_breakfast skipped) → vid_pxl_bike → img_lake
  await app.waitForSlide({ id: 'img_lake' }, 30000);
  const log = await app.slideLog();
  const from = log.findIndex((e) => e.id === 'img_village_canon');
  const seq = log.slice(from).map((e) => e.id || `${e.kind}:${e.day || ''}`);
  assert.deepEqual(seq.slice(0, 4), ['img_village_canon', 'day:2025-07-14', 'vid_pxl_bike', 'img_lake'], `sequence ${seq}`);
  assert.ok(!log.some((e) => e.id === 'img_breakfast'), 'broken photo never shown');
  assert.ok(!log.some((e) => e.kind === 'message'), 'no error card');
  const toasts = await app.toasts();
  assert.ok(toasts.some((x) => x.text === '写真を表示できませんでした: IMG_1401.JPG' && x.cls.includes('toast-warn')), `toasts: ${JSON.stringify(toasts.map((x) => x.text))}`);
  assert.ok(thumbBlocked > 0, 'thumbnail fallback was attempted');
  const reqs = mediaRequests(await suite.admin.log(), 'img_breakfast');
  assert.ok(reqs.some((e) => e.status === 500), 'mock returned 500');
  assert.equal((await app.current()).playing, true, 'still playing');
  // the next photos keep coming
  await app.waitForSlide({ id: ids[ids.indexOf('img_lake') + 1] }, 15000);
  assertNoPageErrors(app);
  await suite.admin.fail('img_breakfast', 500, 0);
  await app.close();
})(t));

test('7d. a download error that outlasts the retries falls back to the Drive thumbnail (no gap)', { timeout: 120000 }, (t) => suite.wrap('07d-thumb-fallback', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: ROOT_PARAMS });
  await app.waitForPlayer();
  // wait until the background EXIF reads are done, so that the failure hits the photo download
  await app.page.waitForFunction(() => window.__slideshow.items.find((i) => i.id === 'img_lake')?.timeSource === 'exif-offset', null, { timeout: 30000 });
  // photo downloads retry 429/5xx three times (1 + 3 attempts); a single 503 is covered in 10-fixes
  await suite.admin.fail('img_lake', 503, 4);
  await app.jumpViaGrid('img_breakfast');
  await app.waitForSlide({ id: 'img_lake' }, 30000);
  await app.page.waitForFunction(() => window.__slideLog.find((e) => e.id === 'img_lake')?.nw > 0);
  const e = (await app.slideLog()).find((x) => x.id === 'img_lake');
  assert.ok(e.src.startsWith(`${suite.env.driveUrl}/thumb/img_lake=s`), `thumbnail used: ${e.src}`);
  assert.equal(mediaRequests(await suite.admin.log(), 'img_lake').filter((x) => x.status === 503).length, 4, 'retried three times');
  assertNoPageErrors(app);
  await app.close();
})(t));

test('8. resource keys: folder URL with ?resourcekey= (API key) → both photos load; X-Goog-Drive-Resource-Keys sent for list and media', { timeout: 120000 }, (t) => suite.wrap('08-resourcekey', async () => {
  await suite.admin.reset();
  const folderUrl = 'https://drive.google.com/drive/folders/folder_reskey?resourcekey=0-ABCdef';
  const app = await suite.newApp({ params: { ...ROOT_PARAMS, folder: folderUrl } });
  await app.waitForPlayer();
  const ids = await app.itemIds();
  assertOrder(ids, suite.manifest.expectedOrderByFolder.folder_reskey, 'folder_reskey order');
  await app.waitForSlide({ kind: 'title' });
  assert.equal(await app.page.textContent('#player .slide-title .card-title'), 'Old shared folder');
  for (const id of ids) {
    await app.waitForSlide({ id }, 20000);
    await app.page.waitForFunction((i) => window.__slideLog.find((e) => e.id === i)?.nw > 0, id);
  }
  const shown = (await app.slideLog()).filter((e) => e.kind === 'image');
  for (const e of shown) {
    assert.match(e.src, /^blob:/, `${e.id}: original file`);
    assert.ok(colorNear(e.color, suite.byId[e.id]._test.bgColor), `${e.id} colour ${e.color}`);
  }
  const log = await suite.admin.log();
  const meta = log.find((e) => e.path === '/drive/v3/files/folder_reskey' && !e.query.alt);
  assert.ok(meta, 'folder metadata requested');
  assert.equal(meta.resourceKeys, 'folder_reskey/0-ABCdef');
  assert.equal(meta.status, 200);
  const lists = listRequests(log).filter((e) => e.query.q.includes("'folder_reskey' in parents"));
  assert.ok(lists.length > 0);
  for (const e of lists) {
    assert.ok((e.resourceKeys || '').includes('folder_reskey/0-ABCdef'), `list request resource keys: ${e.resourceKeys}`);
    assert.equal(e.status, 200);
  }
  for (const [id, key] of [['img_reskey_1', '0-imgAkey1'], ['img_reskey_2', '0-imgBkey2']]) {
    const reqs = mediaRequests(log, id);
    assert.ok(reqs.length > 0, `${id} downloaded`);
    for (const e of reqs) {
      assert.ok((e.resourceKeys || '').includes(`${id}/${key}`), `${id}: resource key header ${e.resourceKeys}`);
      assert.ok(e.status === 200 || e.status === 206, `${id}: status ${e.status}`);
    }
  }
  assert.ok(!log.some((e) => e.status === 404), 'no 404 (missing key) responses');

  // without the resource key the folder is not accessible
  await app.goto({ ...ROOT_PARAMS, folder: 'folder_reskey' });
  assert.equal(await setupError(app), MSG.notFoundKey);
  assertNoPageErrors(app);
  await app.close();
})(t));

test('15. share link: 共有用リンクをコピー produces a URL that pre-fills folder / key / mode (and title / tz)', { timeout: 120000 }, (t) => suite.wrap('15-share', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: {}, settings: null });
  const { page } = app;
  await app.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: suite.env.appUrl });
  let prompted = null;
  page.on('dialog', (d) => {
    prompted = d.defaultValue();
    d.dismiss().catch(() => {});
  });
  const copied = async () => {
    prompted = null;
    const before = (await app.toasts()).length;
    await page.click('#btn-share');
    await page.waitForFunction((n) => window.__toasts.length > n, before, { timeout: 3000 }).catch(() => {});
    if (prompted) return prompted;
    return page.evaluate(() => navigator.clipboard.readText());
  };
  await page.waitForSelector('#setup:not([hidden])');
  // no folder yet → error
  await page.click('#btn-share');
  assert.equal(await setupError(app), '先にフォルダの URL を入力してください。');

  const folderUrl = 'https://drive.google.com/drive/folders/folder_root';
  await page.fill('#f-folder', folderUrl);
  await page.check('input[name="authMode"][value="apikey"]');
  await page.fill('#f-apiKey', TEST_KEY);
  await page.click('#display-settings summary');
  await page.fill('input[name="title"]', 'テスト旅行');
  // the default trip zone is this browser's zone; the link carries it anyway (the recipient's device may be elsewhere)
  assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), DEVICE_TZ);
  assert.equal(await page.inputValue('input[name="timeZone"]'), DEVICE_TZ, 'default trip zone = the browser time zone');
  assert.equal(new URL(await copied()).searchParams.get('tz'), DEVICE_TZ, 'tz is in the link even when it is the default');
  await page.fill('input[name="timeZone"]', 'Asia/Tokyo');
  const shareUrl = await copied();
  assert.ok((await app.toasts()).some((x) => x.text === '共有用リンクをコピーしました') || prompted, 'copied (toast) or shown in a prompt');
  const u = new URL(shareUrl);
  assert.equal(`${u.origin}${u.pathname}`, `${suite.env.appUrl}/`);
  assert.equal(u.searchParams.get('folder'), folderUrl);
  assert.equal(u.searchParams.get('mode'), 'apikey');
  assert.equal(u.searchParams.get('key'), TEST_KEY);
  assert.equal(u.searchParams.get('title'), 'テスト旅行');
  assert.equal(u.searchParams.get('tz'), 'Asia/Tokyo');
  assert.equal(u.searchParams.get('apiBase'), null, 'test-only parameters are not shared');
  assert.equal(u.searchParams.get('clientId'), null);

  // open the link in a fresh browser profile
  const viewer = await suite.newApp({ params: {}, settings: null, navigate: false });
  await viewer.page.goto(shareUrl);
  await viewer.page.waitForSelector('#setup:not([hidden])');
  assert.equal(await viewer.page.inputValue('#f-folder'), folderUrl);
  assert.equal(await viewer.page.isChecked('input[name="authMode"][value="apikey"]'), true);
  assert.equal(await viewer.page.inputValue('#f-apiKey'), TEST_KEY);
  assert.equal(await viewer.page.inputValue('input[name="title"]'), 'テスト旅行');
  assert.equal(await viewer.page.inputValue('input[name="timeZone"]'), 'Asia/Tokyo');
  assert.equal(await viewer.page.isVisible('#f-apiKey'), true, 'API-key panel shown');
  // the same link (pointed at the mock) starts the show with the shared settings
  const runUrl = new URL(shareUrl);
  runUrl.searchParams.set('apiBase', suite.env.driveUrl);
  await viewer.page.goto(runUrl.toString());
  await viewer.page.click('#btn-start');
  await viewer.waitForPlayer();
  await viewer.waitForSlide({ kind: 'title' });
  assert.equal(await viewer.page.textContent('#player .slide-title .card-title'), 'テスト旅行');
  assert.equal(await viewer.page.evaluate(() => window.__slideshow.settings.timeZone), 'Asia/Tokyo');
  assertNoPageErrors(viewer);
  await viewer.close();

  // OAuth: the link carries the client id, never an API key or a token
  await page.check('input[name="authMode"][value="oauth"]');
  if (!(await page.isVisible('#f-clientId'))) await page.click('#oauth-advanced summary');
  await page.fill('#f-clientId', 'test-client.apps.googleusercontent.com');
  const oauthUrl = new URL(await copied());
  assert.equal(oauthUrl.searchParams.get('mode'), 'oauth');
  assert.equal(oauthUrl.searchParams.get('clientId'), 'test-client.apps.googleusercontent.com');
  assert.equal(oauthUrl.searchParams.get('key'), null);
  assert.equal(oauthUrl.searchParams.get('tz'), 'Asia/Tokyo');
  assert.ok(!/token/i.test(oauthUrl.search));
  assertNoPageErrors(app);
  await app.close();
})(t));
