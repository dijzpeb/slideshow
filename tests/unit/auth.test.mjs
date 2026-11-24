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
