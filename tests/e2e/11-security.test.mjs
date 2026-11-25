// Regression tests of the security review of the public deployment: connection settings locked to config.js
// (crafted ?clientId= links), link-provided connection values not used silently, URL-only settings not saved as
// a side effect, no HTTP caching of Drive responses, ログアウト after expiry clearing the metadata cache,
// need-creds answered only for the app's own Service Worker, and the Content-Security-Policy being enforced.
import { test, before, after } from 'node:test';
import {
  openSuite, assert, assertNoPageErrors, assertNoCspViolations, cspViolations, sleep, SETTINGS_KEY, META_CACHE_KEY, TOKEN_KEY, TEST_KEY, TEST_TOKEN, TRIP_TZ,
} from './lib.mjs';

let suite;
before(async () => {
  suite = await openSuite({ maxPageSize: 100 });
});
after(async () => {
  await suite?.close();
});

const CONFIG_CLIENT = '111-config.apps.googleusercontent.com';
const EVIL_CLIENT = '666-attacker.apps.googleusercontent.com';
const storedSettings = (app) => app.page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), SETTINGS_KEY);

/** Serve a deployment config.js (window.SLIDESHOW_CONFIG) instead of the repository's empty one. */
async function withDeployConfig(app, config) {
  await app.context.route(/\/config\.js(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: `window.SLIDESHOW_CONFIG = ${JSON.stringify(config)};` }));
}

/** Read the link produced by 共有用リンクをコピー. */
async function copyShareLink(app) {
  await app.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: suite.env.appUrl });
  let prompted = null;
  app.page.on('dialog', (d) => {
    prompted = d.defaultValue();
    d.dismiss().catch(() => {});
  });
  const before = (await app.toasts()).length;
  await app.page.click('#btn-share');
  await app.page.waitForFunction((n) => window.__toasts.length > n, before, { timeout: 3000 }).catch(() => {});
  return prompted || app.page.evaluate(() => navigator.clipboard.readText());
}

test('S1. config.js with a client ID: a crafted ?clientId= / ?key= link and stored values cannot change the OAuth client; nothing of them is saved or shared', { timeout: 120000 }, (t) => suite.wrap('s1-locked-client', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false, settings: { clientId: 'stored-evil-client', apiKey: 'STOREDKEY', authMode: 'apikey' } });
  await withDeployConfig(app, { clientId: CONFIG_CLIENT, apiKey: '', folder: '', title: '', timeZone: '' });
  const { page } = app;
  await app.goto({ mode: 'apikey', key: 'EVILKEY', clientId: EVIL_CLIENT, folder: 'folder_private', interval: 1, autostart: 1 });
  await page.waitForSelector('#setup:not([hidden])');
  const s = await page.evaluate(() => ({ ...window.__slideshow.settings }));
  assert.deepEqual([s.authMode, s.clientId, s.apiKey], ['oauth', CONFIG_CLIENT, ''], 'the deployed client ID only');
  assert.equal(s.folder, 'folder_private', 'other link values still apply');
  // the API-key card and the client ID field are gone; only the OAuth card is offered
  assert.equal(await page.isHidden('input[name="authMode"][value="apikey"]'), true);
  assert.equal(await page.isDisabled('input[name="authMode"][value="apikey"]'), true);
  assert.equal(await page.isVisible('input[name="authMode"][value="oauth"]'), true);
  assert.equal(await page.isHidden('#oauth-advanced'), true);
  assert.equal(await page.evaluate(() => document.querySelector('#f-clientId').readOnly), true);
  assert.equal(await page.isHidden('#link-auth-warning'), true, 'locked: no conflict warning needed');
  // 「はじめての方へ」 does not ask for a client ID / API key the page does not offer
  const helpState = () => page.evaluate(() => ({ steps: [...document.querySelectorAll('[data-help="setup"]')].map((li) => li.hidden), locked: document.querySelector('#help-locked').hidden }));
  assert.deepEqual(await helpState(), { steps: [true, true], locked: false });
  assert.equal(await page.evaluate(() => window.__slideshow.screen), 'setup', 'no autostart (not signed in)');
  // the share link leaves the connection values out (the recipient uses the same deployment)
  const link = new URL(await copyShareLink(app));
  for (const k of ['mode', 'clientId', 'key', 'apiKey']) assert.equal(link.searchParams.get(k), null, `share link has no ${k}`);
  assert.equal(link.searchParams.get('folder'), 'folder_private');
  // even an altered (hidden) field does not reach Google Identity Services
  await page.evaluate((c) => {
    document.querySelector('#f-clientId').value = c;
    document.querySelector('#f-apiKey').value = 'EVILKEY';
  }, EVIL_CLIENT);
  await page.click('#btn-start');
  await app.waitForPlayer();
  const gis = await page.evaluate(() => ({ clientId: window.__gis.clientId, inits: window.__gis.inits }));
  assert.equal(gis.clientId, CONFIG_CLIENT, 'GIS initialised with the deployed client ID');
  const stored = JSON.stringify(await storedSettings(app));
  for (const bad of [EVIL_CLIENT, 'EVILKEY', 'stored-evil-client', 'STOREDKEY']) assert.ok(!stored.includes(bad), `"${bad}" is not stored: ${stored}`);
  const token = await page.evaluate((k) => JSON.parse(sessionStorage.getItem(k)), TOKEN_KEY);
  assert.equal(token.clientId, CONFIG_CLIENT);
  // every Drive request used the OAuth token, never a key from the link or storage
  const log = (await suite.admin.log()).filter((e) => e.path.startsWith('/drive/v3/') && e.method === 'GET');
  assert.ok(log.length > 0 && log.every((e) => e.auth === 'bearer' && !e.query.key), JSON.stringify(log.map((e) => [e.auth, e.query.key])));
  assertNoPageErrors(app);
  await assertNoCspViolations(app);
  await app.close();

  // config.js with only an API key: API-key mode with that key, no login offered, a link client ID is ignored
  const k = await suite.newApp({ navigate: false });
  await withDeployConfig(k, { apiKey: TEST_KEY });
  await k.goto({ mode: 'oauth', clientId: EVIL_CLIENT, key: 'EVILKEY', folder: 'folder_root', interval: 1, autostart: 1 });
  await k.waitForPlayer();
  const ks = await k.page.evaluate(() => ({ ...window.__slideshow.settings }));
  assert.deepEqual([ks.authMode, ks.apiKey, ks.clientId], ['apikey', TEST_KEY, '']);
  assert.deepEqual(k.gisLoads, [], 'Google Identity Services is never loaded');
  const klog = (await suite.admin.log()).filter((e) => e.path.startsWith('/drive/v3/') && e.query.key);
  assert.ok(klog.length > 0 && klog.every((e) => e.query.key === TEST_KEY));
  await k.page.mouse.move(400, 300);
  await k.page.click('#player .ctl-settings');
  await k.page.waitForSelector('#setup:not([hidden])');
  assert.equal(await k.page.isHidden('input[name="authMode"][value="oauth"]'), true);
  assert.equal(await k.page.isHidden('#apikey-field'), true);
  assert.equal(await k.page.isVisible('#apikey-locked'), true);
  assert.equal(await k.page.isHidden('#btn-folder-search'), true);
  assertNoPageErrors(k);
  await k.close();
})(t));

test('S2. unlocked deployment: a link whose key / client ID differs from the saved one shows a warning, does not autostart or save, and can be reverted', { timeout: 120000 }, (t) => suite.wrap('s2-link-warning', async () => {
  await suite.admin.reset();
  await suite.admin.setKeys([TEST_KEY, 'OTHERKEY']);
  try {
    const app = await suite.newApp({ navigate: false, settings: { authMode: 'apikey', apiKey: TEST_KEY } });
    const { page } = app;
    const params = { folder: 'folder_root', key: 'OTHERKEY', interval: 1, autostart: 1 };
    await app.goto(params);
    await page.waitForSelector('#link-auth-warning:not([hidden])');
    assert.match(await page.textContent('#link-auth-warning'), /リンクで指定された接続設定です。信頼できるリンクでなければ使わないでください。/);
    // unlocked: 「はじめての方へ」 explains how to create a client ID / API key
    assert.deepEqual(await page.evaluate(() => ({ steps: [...document.querySelectorAll('[data-help="setup"]')].map((li) => li.hidden), locked: document.querySelector('#help-locked').hidden })), { steps: [false, false], locked: true });
    await sleep(1500);
    assert.equal(await page.evaluate(() => window.__slideshow.screen), 'setup', 'no autostart with the link key');
    assert.equal((await suite.admin.log()).filter((e) => e.query && e.query.key === 'OTHERKEY').length, 0, 'the link key was not used');
    assert.equal(await page.inputValue('#f-apiKey'), 'OTHERKEY', 'the link value is shown in the form');
    assert.equal((await storedSettings(app)).apiKey, TEST_KEY, 'not saved');
    // 保存済みの接続設定に戻す
    await page.click('#btn-link-auth-revert');
    assert.equal(await page.isHidden('#link-auth-warning'), true);
    assert.equal(await page.inputValue('#f-apiKey'), TEST_KEY);
    await page.click('#btn-start');
    await app.waitForPlayer();
    assert.ok((await suite.admin.log()).filter((e) => e.path.startsWith('/drive/v3/') && e.query.key).every((e) => e.query.key === TEST_KEY));
    assert.equal((await storedSettings(app)).apiKey, TEST_KEY);
    // the same link again; this time the user starts with the warning in view → the link key is used and saved
    await suite.admin.clearLog();
    await app.goto(params);
    await page.waitForSelector('#link-auth-warning:not([hidden])');
    await page.click('#btn-start');
    await app.waitForPlayer();
    assert.equal((await storedSettings(app)).apiKey, 'OTHERKEY');
    assert.ok((await suite.admin.log()).some((e) => e.query && e.query.key === 'OTHERKEY'));
    // a different client ID in a link: warning, the client ID field is opened
    await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ authMode: 'oauth', clientId: 'my-client' })), SETTINGS_KEY);
    await app.goto({ folder: 'folder_private', mode: 'oauth', clientId: EVIL_CLIENT });
    await page.waitForSelector('#link-auth-warning:not([hidden])');
    assert.equal(await page.evaluate(() => document.querySelector('#oauth-advanced').open), true);
    assert.equal(await page.inputValue('#f-clientId'), EVIL_CLIENT);
    await page.click('#btn-link-auth-revert');
    assert.equal(await page.inputValue('#f-clientId'), 'my-client');
    assert.equal((await storedSettings(app)).clientId, 'my-client');
    // only an OAuth client saved; a link brings an API key (→ API-key mode) with autostart: still a warning
    await suite.admin.clearLog();
    await app.goto({ folder: 'folder_root', key: 'OTHERKEY', interval: 1, autostart: 1 });
    await page.waitForSelector('#link-auth-warning:not([hidden])');
    await sleep(1500);
    assert.equal(await page.evaluate(() => window.__slideshow.screen), 'setup', 'no autostart with a key from the link');
    assert.equal((await suite.admin.log()).filter((e) => e.query && e.query.key === 'OTHERKEY').length, 0, 'the link key was not used');
    await page.click('#btn-link-auth-revert');
    assert.equal(await page.isChecked('input[name="authMode"][value="oauth"]'), true);
    assert.equal(await page.inputValue('#f-apiKey'), '');
    assert.equal(await page.inputValue('#f-clientId'), 'my-client');
    // only an API key saved; a link switches to OAuth with another client: warning, the client ID field is opened
    await page.evaluate(({ k, key }) => localStorage.setItem(k, JSON.stringify({ authMode: 'apikey', apiKey: key })), { k: SETTINGS_KEY, key: TEST_KEY });
    await app.goto({ folder: 'folder_private', mode: 'oauth', clientId: EVIL_CLIENT });
    await page.waitForSelector('#link-auth-warning:not([hidden])');
    assert.equal(await page.evaluate(() => document.querySelector('#oauth-advanced').open), true);
    assert.equal(await page.inputValue('#f-clientId'), EVIL_CLIENT);
    await page.click('#btn-link-auth-revert');
    assert.equal(await page.isChecked('input[name="authMode"][value="apikey"]'), true);
    assert.equal(await page.inputValue('#f-clientId'), '');
    assert.equal(await page.inputValue('#f-apiKey'), TEST_KEY);
    assert.deepEqual(await storedSettings(app), { authMode: 'apikey', apiKey: TEST_KEY }, 'nothing from the link saved');
    assertNoPageErrors(app);
    await app.close();
  } finally {
    await suite.admin.reset();
  }
})(t));

test('S3. an autostart link\'s folder / title / key / tz are not saved when M is pressed or a time correction is applied', { timeout: 120000 }, (t) => suite.wrap('s3-no-side-effect-save', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false, settings: { folder: 'folder_private', title: 'My own title' } });
  const { page } = app;
  await app.goto({ folder: 'folder_root', key: TEST_KEY, mode: 'apikey', title: 'Title from a link', tz: 'Asia/Tokyo', interval: 1, autostart: 1 });
  await app.waitForPlayer();
  const before = await storedSettings(app);
  assert.equal(await page.evaluate(() => window.__slideshow.settings.videoMuted), true, 'autostart mutes');
  await page.keyboard.press('m');
  await page.waitForFunction(() => window.__slideshow.settings.videoMuted === false);
  let stored = await storedSettings(app);
  assert.deepEqual(stored, { ...before, videoMuted: false }, 'only videoMuted was saved');
  for (const k of ['apiKey', 'authMode']) assert.equal(stored[k], undefined, `${k} not saved`);
  assert.equal(stored.timeZone, TRIP_TZ, 'the link\'s tz (Asia/Tokyo) not saved; the seeded trip zone is kept');
  assert.equal(stored.folder, 'folder_private');
  assert.equal(stored.title, 'My own title');
  // a camera correction in the grid saves only that folder's corrections
  await page.keyboard.press('g');
  await page.waitForSelector('#grid-overlay:not([hidden])');
  await page.click('#time-fix summary');
  await page.waitForSelector('#time-fix[open] #time-fix-table .fix-row[data-group="Canon EOS R6"]');
  await page.locator('#time-fix-table .fix-row[data-group="Canon EOS R6"] input').nth(0).fill('-6');
  await page.click('#btn-time-fix-apply');
  await page.waitForFunction(() => window.__toasts.some((x) => x.text === '時刻の補正を適用しました'));
  stored = await storedSettings(app);
  assert.deepEqual(stored, { ...before, videoMuted: false, cameraOffsets: { folder_root: { 'Canon EOS R6': -360 } } });
  assertNoPageErrors(app);
  await app.close();
})(t));

test('S4. Drive API requests bypass the HTTP cache (no-store); ログアウト is offered after expiry and clears the token and the metadata cache, not the settings', { timeout: 120000 }, (t) => suite.wrap('s4-no-store-logout', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false });
  const { page } = app;
  // record the cache mode of every fetch() the page makes (Playwright's routing disables the browser's HTTP
  // cache, so the request headers cannot tell; the Service Worker's own fetches are covered by its unit tests)
  await app.context.addInitScript(() => {
    window.__fetches = [];
    const orig = window.fetch;
    window.fetch = function (input, init) {
      const req = input instanceof Request ? input : null;
      window.__fetches.push({ url: String(req ? req.url : input), cache: (init && init.cache) || (req ? req.cache : 'default') });
      return orig.apply(this, arguments);
    };
  });
  await app.startOAuth('folder_private');
  await page.waitForFunction(() => window.__slideLog.some((e) => e.kind === 'image' && e.nw > 0), null, { timeout: 20000 });
  const fetches = await page.evaluate(() => window.__fetches);
  const api = fetches.filter((f) => f.url.startsWith(`${suite.env.driveUrl}/drive/v3/`));
  assert.ok(api.some((f) => f.url.includes('alt=media')) && api.some((f) => new URL(f.url).pathname === '/drive/v3/files'), `listing + downloads seen: ${JSON.stringify(fetches)}`);
  assert.deepEqual(api.filter((f) => f.cache !== 'no-store'), [], 'every Drive API fetch() of the page is no-store');
  // something to clear: the metadata cache of this browser
  await page.waitForFunction((k) => !!localStorage.getItem(k), META_CACHE_KEY, { timeout: 20000 }).catch(() => {});
  await page.evaluate((k) => {
    const c = JSON.parse(localStorage.getItem(k) || '{}');
    c.marker = { sig: 'x', v: 0, data: null, at: Date.now() };
    localStorage.setItem(k, JSON.stringify(c));
  }, META_CACHE_KEY);
  await page.mouse.move(400, 300);
  await page.click('#player .ctl-settings');
  await page.waitForSelector('#setup:not([hidden])');
  assert.match(await page.textContent('#login-status'), /ログイン中/);
  // the token expires while the page stays open
  await page.evaluate(() => {
    const s = window.__slideshow.session;
    s.tokenData.expiresAt = Date.now() - 1000;
    s.dispatchEvent(new Event('expired'));
  });
  await page.waitForFunction(() => /ログインの有効期限が切れました/.test(document.querySelector('#login-status').textContent));
  assert.equal(await page.isVisible('#login-status button:has-text("ログアウト")'), true, 'ログアウト offered for an expired token');
  assert.equal(await page.isVisible('#login-status button:has-text("ログイン")'), true);
  await page.click('#login-status button:has-text("ログアウト")');
  await page.waitForFunction(() => /「スライドショーを開始」を押すと/.test(document.querySelector('#login-status').textContent));
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), META_CACHE_KEY), null, 'metadata cache cleared');
  assert.equal(await page.evaluate((k) => sessionStorage.getItem(k), TOKEN_KEY), null, 'token cleared');
  assert.deepEqual(await page.evaluate(() => window.__gis.revoked), [TEST_TOKEN], 'token revoked');
  const stored = await storedSettings(app);
  assert.equal(stored.folder, 'folder_private', 'saved settings kept');
  assert.ok((await app.toasts()).some((x) => x.text === 'ログアウトしました'));
  assertNoPageErrors(app);
  await assertNoCspViolations(app);
  await app.close();
})(t));

test('S4b. ログアウト is also offered after a reload with an expired token and after the API rejected the token (401), and clears what is left', { timeout: 150000 }, (t) => suite.wrap('s4b-logout-stale', async () => {
  await suite.admin.reset();
  try {
    const app = await suite.newApp({ navigate: false });
    const { page } = app;
    const logoutBtn = '#login-status button:has-text("ログアウト")';
    const statusText = () => page.textContent('#login-status');
    /** the metadata cache of this browser exists (written by the background EXIF reads) */
    const waitForMetaCache = () => page.waitForFunction((k) => (localStorage.getItem(k) || '{}') !== '{}', META_CACHE_KEY, { timeout: 30000 });

    // (1) the token expired, then the tab was reloaded: the restored token is held as expired
    await app.startOAuth('folder_root');
    await waitForMetaCache();
    await page.evaluate((k) => {
      const tok = JSON.parse(sessionStorage.getItem(k));
      tok.expiresAt = Date.now() - 1000;
      sessionStorage.setItem(k, JSON.stringify(tok));
    }, TOKEN_KEY);
    await app.goto({ mode: 'oauth', clientId: 'test-client', folder: 'folder_root', interval: 1 });
    await page.waitForSelector('#setup:not([hidden])');
    await page.waitForFunction(() => /ログインの有効期限が切れました/.test(document.querySelector('#login-status').textContent));
    assert.equal(await page.isVisible(logoutBtn), true, `ログアウト offered after the reload: ${await statusText()}`);
    await page.click(logoutBtn);
    await page.waitForFunction(() => /「スライドショーを開始」を押すと/.test(document.querySelector('#login-status').textContent));
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), META_CACHE_KEY), null, 'metadata cache cleared');
    assert.equal(await page.evaluate((k) => sessionStorage.getItem(k), TOKEN_KEY), null, 'the expired token removed');
    assert.deepEqual(await page.evaluate(() => window.__gis.revoked), [TEST_TOKEN], 'the expired token revoked as well');
    assert.equal(await page.isVisible(logoutBtn), false, 'nothing left to clear: only ログイン');

    // (2) the API rejects the token (401): the token is dropped, the metadata cache is still offered for clearing
    await page.click('#btn-start');
    await app.waitForPlayer();
    await waitForMetaCache();
    await suite.admin.setTokens([]);
    // a refresh (今すぐ更新) makes sure there is a request, even if the next slides are loaded already
    await page.evaluate(() => document.querySelector('#btn-refresh').click());
    await page.waitForSelector('#auth-overlay:not([hidden])', { timeout: 30000 });
    assert.ok((await suite.admin.log()).some((e) => e.status === 401 && e.auth === 'bearer'), 'the mock rejected the token');
    await page.click('#btn-auth-cancel');
    await page.waitForSelector('#setup:not([hidden])');
    assert.equal(await page.evaluate((k) => sessionStorage.getItem(k), TOKEN_KEY), null, 'rejected token discarded');
    assert.equal(await page.isVisible(logoutBtn), true, `ログアウト offered while the metadata cache is left: ${await statusText()}`);
    assert.equal(await page.isVisible('#login-status button:has-text("ログイン")'), true);
    await page.click(logoutBtn);
    await page.waitForFunction((k) => localStorage.getItem(k) === null, META_CACHE_KEY);
    assert.equal(await page.isVisible(logoutBtn), false);
    assert.equal((await storedSettings(app)).folder, 'folder_root', 'saved settings kept');
    assertNoPageErrors(app);
    await assertNoCspViolations(app);
    await app.close();
  } finally {
    await suite.admin.reset();
  }
})(t));

/** Register tests/e2e/foreign-sw.js (scope /tests/e2e/) from the page and let it send need-creds to every window. */
async function probeFromForeignWorker(page, { force = false } = {}) {
  return page.evaluate(async ({ force }) => {
    const reg = await navigator.serviceWorker.register('tests/e2e/foreign-sw.js', { scope: 'tests/e2e/' });
    const worker = reg.active || reg.waiting || reg.installing;
    if (worker.state !== 'activated') {
      await new Promise((resolve) => worker.addEventListener('statechange', () => worker.state === 'activated' && resolve()));
    }
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(e.data);
      reg.active.postMessage({ type: 'probe', force, waitMs: 1500 }, [ch.port2]);
    });
  }, { force });
}

test('S5. need-creds from another same-origin Service Worker is ignored (no credentials leak, a forced request does not drop the token)', { timeout: 120000 }, (t) => suite.wrap('s5-foreign-sw', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ navigate: false });
  const { page } = app;
  await app.startOAuth('folder_private');
  await page.waitForFunction(() => window.__slideLog.some((e) => e.kind === 'image' && e.nw > 0), null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL), `${suite.env.appUrl}/sw.js`, 'the app\'s own worker controls the page');
  const answers = await probeFromForeignWorker(page);
  const mine = answers.filter((a) => a.url.startsWith(`${suite.env.appUrl}/?`));
  assert.equal(mine.length, 1, `the foreign worker reached the app window: ${JSON.stringify(answers)}`);
  assert.deepEqual(mine[0], { url: mine[0].url, answered: false }, 'no credentials for a foreign worker');
  const forced = await probeFromForeignWorker(page, { force: true });
  assert.equal(forced.find((a) => a.url === mine[0].url).answered, false);
  await sleep(300);
  assert.equal(await page.evaluate(() => window.__slideshow.session.signedIn), true, 'the token was not dropped');
  assert.equal(await page.isHidden('#auth-overlay'), true, 'no re-login prompt');
  // the app's own worker still gets the credentials it asks for (an <img> through the SW, credentials forgotten first)
  await page.evaluate(() => window.__slideshow.sw.pushCreds(null));
  const viaSw = await page.evaluate(() => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth);
    img.onerror = () => resolve(0);
    img.src = `__drive/media/img_private_1?mt=image%2Fjpeg&t=${Date.now()}`;
  }));
  assert.ok(viaSw > 0, 'own Service Worker answered');
  assertNoPageErrors(app);
  await app.close();
})(t));

test('S6. the Content-Security-Policy is enforced in the tests too (only the mock origin is added): foreign hosts and inline scripts are blocked', { timeout: 60000 }, (t) => suite.wrap('s6-csp-enforced', async () => {
  await suite.admin.reset();
  const app = await suite.newApp({ params: { folder: 'folder_root', key: TEST_KEY } });
  const { page } = app;
  await page.waitForSelector('#setup:not([hidden])');
  const policy = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content);
  assert.match(policy, /^default-src 'none';/);
  assert.ok(policy.includes(`connect-src 'self' https://www.googleapis.com https://accounts.google.com/gsi/ https://oauth2.googleapis.com ${suite.env.driveUrl}`), policy);
  const r = await page.evaluate(async () => {
    const out = {};
    // an injected inline script does not run (code evaluated by the test itself is exempt, so no eval check here)
    const inline = document.createElement('script');
    inline.textContent = 'window.__inlineRan = true;';
    document.head.append(inline);
    out.inline = window.__inlineRan ? 'ran' : 'blocked';
    try {
      await fetch('https://example.invalid/x');
      out.fetch = 'ok';
    } catch (e) {
      out.fetch = e.name;
    }
    out.img = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve('loaded');
      img.onerror = () => resolve('blocked');
      img.src = 'https://example.invalid/x.png';
    });
    const s = document.createElement('script');
    s.src = 'https://example.invalid/x.js';
    out.script = await new Promise((resolve) => {
      s.onload = () => resolve('loaded');
      s.onerror = () => resolve('blocked');
      document.head.append(s);
    });
    return out;
  });
  assert.deepEqual(r, { inline: 'blocked', fetch: 'TypeError', img: 'blocked', script: 'blocked' });
  await sleep(200);
  const v = await cspViolations(app);
  const directives = new Set(v.map((x) => x.directive).filter(Boolean));
  for (const d of ['connect-src', 'img-src', 'script-src-elem']) assert.ok(directives.has(d), `${d} violation reported: ${JSON.stringify(v)}`);
  await app.close();
})(t));
