// Unit tests of OAuthSession.request() against a Google Identity Services stand-in that behaves like the
// real library: every requestAccessToken() call reuses (navigates and focuses) the same named popup, results
// of superseded requests are dropped, and closing the popup is reported once (one close-poll timer).
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };

/** GIS token client stand-in. `popup.close()` = the user closes the popup; `popup.grant()` = the user allows */
function installGis() {
  const popup = { open: false, navigations: 0, closedEvents: 0 };
  let cfg = null;
  let poll = null;
  globalThis.window = {
    google: {
      accounts: {
        oauth2: {
          initTokenClient(c) {
            cfg = c;
            return {
              requestAccessToken() {
                popup.open = true; // window.open(url, 'g_auth_token_window_…'): same window, navigated + focused
                popup.navigations++;
                if (!poll) {
                  poll = setInterval(() => {
                    if (popup.open) return;
                    clearInterval(poll);
                    poll = null;
                    popup.closedEvents++;
                    cfg.error_callback({ type: 'popup_closed' });
                  }, 10);
                }
              },
            };
          },
          hasGrantedAllScopes: () => true,
        },
      },
    },
  };
  popup.close = () => {
    popup.open = false;
  };
  popup.grant = (token = 'tok') => {
    clearInterval(poll);
    poll = null;
    popup.open = false;
    cfg.callback({ access_token: token, expires_in: 3599 });
  };
  return popup;
}

const settleState = (p) => {
  const st = { state: 'pending', value: null };
  p.then(
    (v) => Object.assign(st, { state: 'resolved', value: v }),
    (e) => Object.assign(st, { state: 'rejected', value: e }),
  );
  return st;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('auth: a second request() while the popup is open shares the request; closing the popup once cancels both callers at once', async () => {
  const popup = installGis();
  const { OAuthSession } = await import('../../js/auth.js');
  const s = new OAuthSession('cid');
  await s.init();
  const a = settleState(s.request()); // 「ログイン」
  const b = settleState(s.request()); // then 「スライドショーを開始」 while the popup is behind the window
  assert.equal(popup.navigations, 2, 'the popup is brought to the front again');
  await sleep(30);
  popup.close();
  await sleep(60);
  assert.equal(popup.closedEvents, 1, 'GIS reports the closed popup once');
  for (const st of [a, b]) {
    assert.equal(st.state, 'rejected');
    assert.equal(st.value.type, 'popup_closed');
    assert.equal(st.value.message, 'ログインがキャンセルされました。');
  }
  assert.equal(s.pending, null);
  // a later request works normally
  const c = settleState(s.request());
  await sleep(10);
  popup.grant('tok2');
  await sleep(0);
  assert.deepEqual([c.state, c.value], ['resolved', 'tok2']);
  assert.equal(s.accessToken, 'tok2');
  s.dispose();
});

test('auth: a token after a re-request resolves every caller; a token for each call (simple stubs) is harmless', async () => {
  const popup = installGis();
  const { OAuthSession } = await import('../../js/auth.js');
  const s = new OAuthSession('cid2');
  await s.init();
  const a = settleState(s.request());
  const b = settleState(s.request());
  await sleep(10);
  popup.grant('tok');
  popup.grant('tok-again'); // a stub that answers both calls separately
  await sleep(0);
  assert.deepEqual([a.state, a.value, b.state, b.value], ['resolved', 'tok', 'resolved', 'tok']);
  assert.equal(s.accessToken, 'tok-again', 'the newest token is kept');
  assert.equal(s.pending, null);
  s.dispose();
});

test('auth: an expired token still counts as held (hasToken, so ログアウト is offered); signOut revokes and forgets it', async () => {
  const popup = installGis();
  const revoked = [];
  window.google.accounts.oauth2.revoke = (t, cb) => {
    revoked.push(t);
    cb?.({});
  };
  const { OAuthSession } = await import('../../js/auth.js');
  const s = new OAuthSession('cid3');
  await s.init();
  assert.equal(s.hasToken, false);
  const p = s.request();
  await sleep(10);
  popup.grant('tok3');
  await p;
  assert.deepEqual([s.signedIn, s.hasToken], [true, true]);
  s.tokenData.expiresAt = Date.now() - 1000; // expired while the page stayed open
  assert.deepEqual([s.signedIn, s.hasToken], [false, true]);
  let changes = 0;
  s.addEventListener('change', () => changes++);
  s.signOut();
  assert.deepEqual([s.signedIn, s.hasToken, changes], [false, false, 1]);
  assert.deepEqual(revoked, ['tok3']);
  s.dispose();
});

test('auth: a token of this tab restored after it expired is still held (ログアウト can remove it); no expired event', async () => {
  installGis();
  const revoked = [];
  window.google.accounts.oauth2.revoke = (t, cb) => {
    revoked.push(t);
    cb?.({});
  };
  const store = new Map();
  const prev = globalThis.sessionStorage;
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    const { OAuthSession } = await import('../../js/auth.js');
    const key = 'photo-slideshow.token.v1';
    // expired (the tab was reopened / reloaded after an hour)
    store.set(key, JSON.stringify({ accessToken: 'old-tok', expiresAt: Date.now() - 60000, clientId: 'cid4' }));
    const s = new OAuthSession('cid4');
    let expired = 0;
    s.addEventListener('expired', () => expired++);
    assert.deepEqual([s.signedIn, s.hasToken, s.accessToken], [false, true, null]);
    assert.equal(await s.getToken(), null, 'an expired token is never handed out');
    await sleep(20);
    assert.equal(expired, 0, 'no expired event for a token that was already expired when restored');
    s.signOut();
    assert.deepEqual([s.hasToken, store.has(key)], [false, false], 'signOut removes it from sessionStorage');
    assert.deepEqual(revoked, ['old-tok']);
    s.dispose();
    // a token of another client stays unused
    store.set(key, JSON.stringify({ accessToken: 'other', expiresAt: Date.now() + 3600000, clientId: 'cid-other' }));
    const o = new OAuthSession('cid4');
    assert.deepEqual([o.signedIn, o.hasToken], [false, false]);
    o.dispose();
    // a valid token is restored as before
    store.set(key, JSON.stringify({ accessToken: 'good', expiresAt: Date.now() + 3600000, clientId: 'cid4' }));
    const g = new OAuthSession('cid4');
    assert.deepEqual([g.signedIn, g.accessToken], [true, 'good']);
    g.dispose();
  } finally {
    globalThis.sessionStorage = prev;
  }
});
