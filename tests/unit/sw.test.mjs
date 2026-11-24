// Unit tests of the Service Worker media proxy (sw.js), run against fake SW globals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://app.test/trip/';
const API = 'https://drive.test';

/**
 * Loads sw.js with fake globals. `upstream(call)` answers the proxied Drive requests
 * (call: {url, method, headers, signal}); clients answer need-creds with `answer`.
 */
function loadSw({ upstream }) {
  const listeners = {};
  const clients = new Map();
  const calls = [];
  const delays = [];
  const fakeSelf = {
    registration: { scope: SCOPE },
    location: { origin: new URL(SCOPE).origin },
    skipWaiting() {},
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    clients: {
      async get(id) {
        return clients.get(id);
      },
      async claim() {},
      async matchAll() {
        return [...clients.values()];
      },
    },
  };
  const fakeFetch = async (url, init) => {
    const call = { url: new URL(url), method: init.method, headers: init.headers, signal: init.signal };
    calls.push(call);
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return upstream(call, calls.length);
  };
  // backoff and timeouts run 100x faster; the requested delays are recorded
  const fastTimeout = (fn, ms) => {
    delays.push(ms);
    return setTimeout(fn, Math.ceil(ms / 100));
  };
  new Function('self', 'fetch', 'setTimeout', SRC)(fakeSelf, fakeFetch, fastTimeout);

  function addClient(id, answer = null) {
    const c = {
      id,
      asked: [],
      answer,
      postMessage(msg, transfer) {
        c.asked.push(msg);
        if (c.answer !== undefined && transfer && transfer[0]) transfer[0].postMessage({ type: 'creds', creds: c.answer });
      },
    };
    clients.set(id, c);
    return c;
  }

  async function message(fromId, data) {
    const waits = [];
    listeners.message({ data, source: fromId ? { id: fromId } : null, ports: [], waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  }

  /** Dispatches a fetch event; returns null when the SW does not respond (request goes to the network). */
  function fetchEvent(path, { clientId = 'c1', mode = 'cors', destination = '', method = 'GET', headers = {}, signal } = {}) {
    const ac = new AbortController();
    const request = {
      url: new URL(path, SCOPE).toString(),
      method,
      mode,
      destination,
      headers: new Headers(headers),
      signal: signal || ac.signal,
    };
    let responded = null;
    listeners.fetch({
      request,
      clientId,
      resultingClientId: '',
      respondWith(p) {
        responded = Promise.resolve(p);
      },
    });
    return responded;
  }

  return { listeners, clients, calls, delays, addClient, message, fetchEvent };
}

const jpeg = (init = {}) => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'content-type': 'image/jpeg', ...init } });
const authOf = (call) => call.headers.get('Authorization');

function assertSecurityHeaders(res) {
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
}

test('sw: each tab uses its own credentials (OAuth tab and API-key tab)', async () => {
  const sw = loadSw({ upstream: () => jpeg() });
  sw.addClient('tabB');
  sw.addClient('tabA');
  await sw.message('tabB', { type: 'creds', creds: { apiBase: API, token: 'TOKEN_B' } });
  await sw.message('tabA', { type: 'creds', creds: { apiBase: API, apiKey: 'KEY_A' } });

  const rb = await sw.fetchEvent('__drive/media/img_private_1?mt=image%2Fjpeg', { clientId: 'tabB', destination: 'image' });
  const ra = await sw.fetchEvent('__drive/media/img_public?mt=image%2Fjpeg', { clientId: 'tabA', destination: 'image' });
  assert.equal(rb.status, 200);
  assert.equal(ra.status, 200);
  const [cb, ca] = sw.calls;
  assert.equal(cb.url.pathname, '/drive/v3/files/img_private_1');
  assert.equal(authOf(cb), 'Bearer TOKEN_B');
  assert.equal(cb.url.searchParams.get('key'), null);
  assert.equal(authOf(ca), null);
  assert.equal(ca.url.searchParams.get('key'), 'KEY_A');
});

test('sw: without cached credentials only the requesting tab is asked, and its answer is cached', async () => {
  const sw = loadSw({ upstream: () => jpeg() });
  const c1 = sw.addClient('c1', { apiBase: API, token: 'T1' });
  const other = sw.addClient('other', { apiBase: API, apiKey: 'OTHER' });
  const [r1, r2] = await Promise.all([sw.fetchEvent('__drive/media/a'), sw.fetchEvent('__drive/media/b')]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(c1.asked.length, 1, 'concurrent requests share one question');
  assert.equal(c1.asked[0].type, 'need-creds');
  assert.equal(c1.asked[0].force, false);
  await sw.fetchEvent('__drive/media/c');
  assert.equal(c1.asked.length, 1, 'answer cached');
  assert.ok(sw.calls.every((c) => authOf(c) === 'Bearer T1'));
  assert.equal(other.asked.length, 0, 'other tabs are never asked');

  // a request whose client is unknown gets 401, no other tab's credentials
  const r = await sw.fetchEvent('__drive/media/x', { clientId: 'gone' });
  assert.equal(r.status, 401);
  assertSecurityHeaders(r);
  assert.equal(other.asked.length, 0);
  assert.equal(sw.calls.length, 3);
});

test('sw: sign-out (creds null) clears only that tab; closed tabs are pruned', async () => {
  const sw = loadSw({ upstream: () => jpeg() });
  const c1 = sw.addClient('c1', null);
  sw.addClient('c2');
  const c3 = sw.addClient('c3', { apiBase: API, apiKey: 'FRESH3' });
  await sw.message('c1', { type: 'creds', creds: { apiBase: API, token: 'T1' } });
  await sw.message('c2', { type: 'creds', creds: { apiBase: API, apiKey: 'K2' } });
  await sw.message('c3', { type: 'creds', creds: { apiBase: API, apiKey: 'OLD3' } });

  await sw.message('c1', { type: 'creds', creds: null });
  const r1 = await sw.fetchEvent('__drive/media/a', { clientId: 'c1' });
  assert.equal(r1.status, 401, 'signed-out tab has no credentials');
  assert.equal(c1.asked.length, 1, 'it was asked (and answered null)');
  const r2 = await sw.fetchEvent('__drive/media/b', { clientId: 'c2' });
  assert.equal(r2.status, 200);
  assert.equal(sw.calls.at(-1).url.searchParams.get('key'), 'K2');

  // c3 closes: the next creds message prunes its entry
  sw.clients.delete('c3');
  await sw.message('c2', { type: 'creds', creds: { apiBase: API, apiKey: 'K2' } });
  sw.clients.set('c3', c3); // same id seen again: must ask instead of using the pruned entry
  await sw.fetchEvent('__drive/media/c', { clientId: 'c3' });
  assert.equal(c3.asked.length, 1);
  assert.equal(sw.calls.at(-1).url.searchParams.get('key'), 'FRESH3');
});

test('sw: 401 asks the same tab for a fresh token and retries once', async () => {
  const sw = loadSw({ upstream: (call) => (authOf(call) === 'Bearer OLD' ? new Response('', { status: 401 }) : jpeg()) });
  const c1 = sw.addClient('c1', { apiBase: API, token: 'NEW' });
  sw.addClient('c2', { apiBase: API, token: 'OTHER' });
  await sw.message('c1', { type: 'creds', creds: { apiBase: API, token: 'OLD' } });
  const r = await sw.fetchEvent('__drive/media/a');
  assert.equal(r.status, 200);
  assert.deepEqual(c1.asked, [{ type: 'need-creds', force: true, failedToken: 'OLD' }]);
  await sw.fetchEvent('__drive/media/b');
  assert.deepEqual(sw.calls.map(authOf), ['Bearer OLD', 'Bearer NEW', 'Bearer NEW']);
});

test('sw: a rejected token is forgotten when the tab has no new one; the next request asks the tab again', async () => {
  const sw = loadSw({ upstream: (call) => (authOf(call) === 'Bearer OLD' ? new Response('', { status: 401 }) : jpeg()) });
  const c1 = sw.addClient('c1', null); // logged out: no token to give
  await sw.message('c1', { type: 'creds', creds: { apiBase: API, token: 'OLD' } });
  assert.equal((await sw.fetchEvent('__drive/media/a')).status, 401);
  c1.answer = { apiBase: API, token: 'NEW' }; // re-login (before the tab pushes its new creds)
  assert.equal((await sw.fetchEvent('__drive/media/b')).status, 200);
  assert.deepEqual(sw.calls.map(authOf), ['Bearer OLD', 'Bearer NEW'], 'the old token is not tried again');
  assert.deepEqual(c1.asked.map((m) => m.force), [true, false]);
});

test('sw: navigations and non-media destinations are not proxied', async () => {
  const sw = loadSw({ upstream: () => jpeg() });
  sw.addClient('c1', { apiBase: API, apiKey: 'K' });
  assert.equal(sw.fetchEvent('__drive/media/evil', { mode: 'navigate', destination: 'document' }), null);
  assert.equal(sw.fetchEvent('__drive/media/evil', { mode: 'navigate', destination: '' }), null);
  for (const destination of ['document', 'iframe', 'frame', 'object', 'embed', 'script', 'style', 'worker', 'sharedworker', 'font', 'manifest']) {
    assert.equal(sw.fetchEvent('__drive/media/evil', { mode: 'no-cors', destination }), null, destination);
  }
  assert.equal(sw.fetchEvent('__drive/media/x', { method: 'POST' }), null);
  assert.equal(sw.fetchEvent('elsewhere/x'), null);
  for (const destination of ['', 'image', 'video', 'audio']) {
    const r = await sw.fetchEvent('__drive/media/ok', { mode: 'no-cors', destination });
    assert.equal(r.status, 200, destination);
  }
});

test('sw: only image/video/audio content types pass (no SVG/HTML); nosniff + CSP sandbox on every response', async () => {
  const types = {
    html: 'text/html; charset=utf-8',
    svg: 'image/svg+xml',
    svg2: 'Image/SVG+XML; charset=utf-8',
    xml: 'application/xhtml+xml',
    mov: 'video/quicktime',
    jpg: 'image/jpeg',
    heic: 'image/heic',
    mp3: 'audio/mpeg',
    none: null,
  };
  const sw = loadSw({
    upstream: (call) => {
      const id = call.url.pathname.split('/').pop();
      if (id === 'missing') return new Response('{"error":{}}', { status: 404, headers: { 'content-type': 'application/json' } });
      const ct = types[id];
      return new Response('<script>alert(1)</script>', { status: 200, headers: ct ? { 'content-type': ct } : {} });
    },
  });
  sw.addClient('c1', { apiBase: API, apiKey: 'K' });
  const ct = async (path) => {
    const r = await sw.fetchEvent(path);
    assertSecurityHeaders(r);
    return r.headers.get('content-type');
  };
  assert.equal(await ct('__drive/media/html'), 'application/octet-stream');
  assert.equal(await ct('__drive/media/html?mt=text%2Fhtml'), 'application/octet-stream');
  assert.equal(await ct('__drive/media/svg'), 'application/octet-stream');
  assert.equal(await ct('__drive/media/svg2?mt=image%2Fsvg%2Bxml'), 'application/octet-stream');
  assert.equal(await ct('__drive/media/xml'), 'application/octet-stream');
  assert.equal(await ct('__drive/media/mov'), 'video/mp4');
  assert.equal(await ct('__drive/media/jpg'), 'image/jpeg');
  assert.equal(await ct('__drive/media/heic'), 'image/heic');
  assert.equal(await ct('__drive/media/mp3'), 'audio/mpeg');
  assert.equal(await ct('__drive/media/none?mt=video%2Fquicktime'), 'video/mp4');
  assert.equal(await ct('__drive/media/none?mt=image%2Fpng'), 'image/png');
  assert.equal(await ct('__drive/media/none'), 'application/octet-stream');
  // the HTML hint does not win over a missing type, and an HTML body labelled as image stays an image
  assert.equal(await ct('__drive/media/html?mt=image%2Fjpeg'), 'image/jpeg');
  const miss = await sw.fetchEvent('__drive/media/missing');
  assert.equal(miss.status, 404);
  assertSecurityHeaders(miss);
  assert.match(miss.headers.get('content-type'), /^text\/plain/);
});

test('sw: Range is forwarded and Content-Range is synthesized when hidden by CORS', async () => {
  const sw = loadSw({
    upstream: (call) => {
      assert.equal(call.headers.get('Range'), 'bytes=100-199');
      return new Response(new Uint8Array(100), { status: 206, headers: { 'content-type': 'video/mp4' } });
    },
  });
  sw.addClient('c1', { apiBase: API, apiKey: 'K' });
  const r = await sw.fetchEvent('__drive/media/v?mt=video%2Fmp4&sz=1000', { destination: 'video', headers: { Range: 'bytes=100-199' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 100-199/1000');
  assert.equal(r.headers.get('content-length'), '100');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assertSecurityHeaders(r);
});

test('sw: transient upstream errors (429/5xx/403 rate limit) are retried with backoff', async () => {
  const plan = {
    a: [429, 200],
    b: [500, 502, 503, 200],
    c: [504, 504, 504, 504, 200],
    d: ['rate', 200],
    e: ['forbidden', 200],
    f: [404, 200],
  };
  const sw = loadSw({
    upstream: (call) => {
      const id = call.url.pathname.split('/').pop();
      const step = plan[id].shift();
      if (step === 'rate') {
        return new Response(JSON.stringify({ error: { code: 403, errors: [{ domain: 'usageLimits', reason: 'userRateLimitExceeded' }] } }), { status: 403 });
      }
      if (step === 'forbidden') {
        return new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: 'insufficientFilePermissions' }] } }), { status: 403 });
      }
      return step === 200 ? jpeg() : new Response('busy', { status: step });
    },
  });
  sw.addClient('c1', { apiBase: API, apiKey: 'K' });
  const count = (id) => sw.calls.filter((c) => c.url.pathname.endsWith(`/${id}`)).length;
  const media = (id, destination = 'image') => sw.fetchEvent(`__drive/media/${id}`, { destination, mode: 'no-cors' });

  assert.equal((await media('a')).status, 200);
  assert.equal(count('a'), 2);
  assert.equal((await media('b', 'video')).status, 200);
  assert.equal(count('b'), 4);
  const c = await media('c');
  assert.equal(c.status, 504, 'gives up after 3 retries');
  assert.equal(count('c'), 4);
  assert.equal((await media('d')).status, 200);
  assert.equal(count('d'), 2);
  assert.equal((await media('e')).status, 403, 'permission errors are not retried');
  assert.equal(count('e'), 1);
  assert.equal((await media('f')).status, 404);
  assert.equal(count('f'), 1);
  // exponential backoff with jitter: ~0.5 s, ~1 s, ~2 s
  const backoffs = sw.delays.filter((ms) => ms < 5000);
  assert.equal(backoffs.length, 1 + 3 + 3 + 1, `${backoffs}`);
  for (const ms of backoffs) assert.ok(ms >= 375 && ms <= 2500, `${ms}`);
  assert.ok(backoffs.some((ms) => ms >= 1500), 'third attempt waits ~2 s');
});

test('sw: a page fetch() (destination "") is not retried in the SW (Chromium does not pass its abort on)', async () => {
  const sw = loadSw({ upstream: () => new Response('busy', { status: 503 }) });
  sw.addClient('c1', { apiBase: API, apiKey: 'K' });
  const r = await sw.fetchEvent('__drive/media/a');
  assert.equal(r.status, 503);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(sw.calls.length, 1);
});

test('sw: retries stop when the requesting tab is gone', async () => {
  let sw = null;
  sw = loadSw({
    upstream: () => {
      sw.clients.delete('c1'); // the tab closes while the first attempt is answered
      return new Response('busy', { status: 503 });
    },
  });
  sw.addClient('c1', { apiBase: API, apiKey: 'K' });
  await sw.message('c1', { type: 'creds', creds: { apiBase: API, apiKey: 'K' } });
  const r = await sw.fetchEvent('__drive/media/a', { destination: 'video', mode: 'no-cors' });
  assert.equal(r.status, 499);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(sw.calls.length, 1);
});

test('sw: an aborted request stops retrying', async () => {
  const ac = new AbortController();
  const sw = loadSw({
    upstream: () => {
      setTimeout(() => ac.abort(), 1);
      return new Response('busy', { status: 503 });
    },
  });
  sw.addClient('c1', { apiBase: API, apiKey: 'K' });
  const r = await sw.fetchEvent('__drive/media/a', { signal: ac.signal, destination: 'image', mode: 'no-cors' });
  assert.equal(r.status, 499);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(sw.calls.length, 1);
});
