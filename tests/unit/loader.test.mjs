// Unit tests of MediaLoader's photo cache: skipped photos stop downloading (AbortController per entry).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaLoader } from '../../js/loader.js';
import { DriveClient } from '../../js/drive.js';

// Minimal browser stand-ins: <img> that "loads" any URL, fetch() of the Drive API with a controllable delay.
class FakeImage {
  constructor() {
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.onload = null;
    this.onerror = null;
  }
  set src(v) {
    this._src = v;
    if (!v) return;
    setTimeout(() => {
      this.naturalWidth = 640;
      this.naturalHeight = 480;
      this.onload?.();
    }, 1);
  }
  get src() {
    return this._src;
  }
  decode() {
    return Promise.resolve();
  }
}
globalThis.Image = FakeImage;

function setup({ status = () => 200 } = {}) {
  const requests = [];
  const pending = new Map(); // id -> resolve()
  globalThis.fetch = (url, init = {}) => {
    const u = new URL(url);
    const id = decodeURIComponent(u.pathname.split('/').pop());
    const req = { id, url: u, headers: init.headers || {}, signal: init.signal, aborted: false };
    requests.push(req);
    const st = status(id, requests.filter((r) => r.id === id).length);
    if (st !== 200) return Promise.resolve(new Response('{"error":{"code":503,"message":"busy"}}', { status: st }));
    return new Promise((resolve, reject) => {
      const done = () => resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
      pending.set(id, done);
      init.signal?.addEventListener('abort', () => {
        req.aborted = true;
        reject(init.signal.reason || new DOMException('Aborted', 'AbortError'));
      });
    });
  };
  const loader = new MediaLoader({
    drive: new DriveClient({ apiBase: 'https://drive.test', mode: 'apikey', apiKey: 'K' }),
    sw: { scope: 'https://app.test/trip/' },
    getSettings: () => ({ imageQuality: 'original' }),
  });
  const item = (id) => ({ id, name: `${id}.jpg`, mimeType: 'image/jpeg', modifiedTime: '2025-01-01T00:00:00Z' });
  const finish = (id) => pending.get(id)?.();
  return { loader, requests, item, finish };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const isAbort = (e) => e instanceof DOMException && e.name === 'AbortError';

test('loader: loadImage(item, {keep}) aborts in-flight downloads of photos outside item + keep', async () => {
  const { loader, requests, item, finish } = setup();
  const a = loader.loadImage(item('A'), { keep: ['A', 'B'] });
  const b = loader.loadImage(item('B'), { keep: ['A', 'B'] });
  await tick();
  const c = loader.loadImage(item('C'), { keep: ['B', 'D'] }); // the user jumped ahead: A is no longer needed
  await assert.rejects(a, isAbort);
  await tick();
  assert.equal(requests.find((r) => r.id === 'A').aborted, true, 'A download aborted');
  assert.equal(requests.find((r) => r.id === 'B').aborted, false, 'B kept');
  assert.equal(loader.cache.has('A'), false, 'aborted entry removed from the cache');
  finish('B');
  finish('C');
  assert.equal((await b).via, 'original');
  assert.equal((await c).via, 'original');
  // A requested again starts a fresh download
  const a2 = loader.loadImage(item('A'), { keep: ['A', 'B', 'C'] });
  await tick();
  assert.equal(requests.filter((r) => r.id === 'A').length, 2);
  finish('A');
  assert.equal((await a2).width, 640);
});

test('loader: calls in the same task (show + preload) protect each other; retain(keep) aborts the rest', async () => {
  const { loader, requests, item, finish } = setup();
  const x = loader.loadImage(item('X'), { keep: [] });
  await tick();
  // one task: target + preloads beyond the neighbour window, then retain()
  const p = [loader.loadImage(item('T'), { keep: ['T', 'N1'] }), loader.loadImage(item('N1'), { keep: ['T', 'N1'] }), loader.loadImage(item('N2'), { keep: ['T', 'N1'] })];
  loader.retain(['T', 'N1']);
  await assert.rejects(x, isAbort);
  await tick();
  assert.deepEqual(requests.filter((r) => r.aborted).map((r) => r.id), ['X']);
  for (const id of ['T', 'N1', 'N2']) finish(id);
  for (const r of await Promise.all(p)) assert.equal(r.via, 'original');
  // later retain() aborts an in-flight preload that is no longer wanted
  const late = loader.loadImage(item('L'));
  await tick();
  loader.retain(['T']);
  await assert.rejects(late, isAbort);
  assert.equal(loader.cache.has('T'), true, 'finished photos are not affected');
});

test('loader: loadImage without keep does not abort other downloads', async () => {
  const { loader, requests, item, finish } = setup();
  const a = loader.loadImage(item('A'));
  await tick();
  const b = loader.loadImage(item('B'));
  await tick();
  assert.equal(requests.some((r) => r.aborted), false);
  finish('A');
  finish('B');
  await Promise.all([a, b]);
});

test('loader: {signal} rejects that call; the download stops only when no other caller still waits', async () => {
  const { loader, requests, item, finish } = setup();
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  const p1 = loader.loadImage(item('S'), { signal: ac1.signal });
  const p2 = loader.loadImage(item('S'), { signal: ac2.signal });
  await tick();
  ac1.abort();
  await assert.rejects(p1, isAbort);
  await tick();
  assert.equal(requests[0].aborted, false, 'second caller still waits');
  ac2.abort();
  await assert.rejects(p2, isAbort);
  await tick();
  assert.equal(requests[0].aborted, true);
  assert.equal(loader.cache.has('S'), false);

  // a caller without a signal keeps the download alive
  const ac3 = new AbortController();
  const q1 = loader.loadImage(item('U'), { signal: ac3.signal });
  const q2 = loader.loadImage(item('U'));
  await tick();
  ac3.abort();
  await assert.rejects(q1, isAbort);
  finish('U');
  assert.equal((await q2).via, 'original');
  await assert.rejects(loader.loadImage(item('V'), { signal: AbortSignal.abort() }), isAbort);
});

test('loader: clear() aborts in-flight downloads', async () => {
  const { loader, requests, item } = setup();
  const a = loader.loadImage(item('A'));
  await tick();
  loader.clear();
  await assert.rejects(a, isAbort);
  await tick();
  assert.equal(requests[0].aborted, true);
  assert.equal(loader.cache.size, 0);
});

test('loader: photo originals are fetched from the page (not through the SW), with the resource key and a real abort', async () => {
  const { loader, requests, item, finish } = setup();
  const p = loader.loadImage({ ...item('R'), resourceKey: '0-rk' });
  await tick();
  const r = requests[0];
  assert.equal(r.url.origin, 'https://drive.test', 'Drive API, not the Service Worker URL');
  assert.equal(r.url.searchParams.get('alt'), 'media');
  assert.equal(r.url.searchParams.get('key'), 'K');
  assert.equal(r.headers['X-Goog-Drive-Resource-Keys'], 'R/0-rk');
  finish('R');
  assert.equal((await p).via, 'original');
});

test('loader: a transient 503 is retried in the page; aborting during the backoff stops the retries', async () => {
  // one 503, then OK
  const ok = setup({ status: (id, n) => (n === 1 ? 503 : 200) });
  const p = ok.loader.loadImage(ok.item('A'));
  while (ok.requests.length < 2) await new Promise((r) => setTimeout(r, 50));
  ok.finish('A');
  assert.equal((await p).via, 'original');
  // always 503: the user moves on during the backoff → no more requests
  const busy = setup({ status: () => 503 });
  const ac = new AbortController();
  const q = busy.loader.loadImage(busy.item('B'), { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(busy.requests.length, 1);
  ac.abort();
  await assert.rejects(q, isAbort);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(busy.requests.length, 1, 'no upstream request after the abort');
});

test('loader: a photo whose modifiedTime changed replaces the old entry: its download is aborted and its Blob URL revoked', async () => {
  const { loader, requests, item, finish } = setup();
  const revoked = [];
  const origRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (u) => {
    revoked.push(u);
    origRevoke.call(URL, u);
  };
  try {
    // in flight when the file changes in Drive → the old download stops
    const v1 = item('A');
    const v2 = { ...v1, modifiedTime: '2025-02-01T00:00:00Z' };
    const p1 = loader.loadImage(v1);
    await tick();
    const p2 = loader.loadImage(v2);
    await assert.rejects(p1, isAbort);
    await tick();
    assert.equal(requests[0].aborted, true, 'old version download aborted');
    assert.equal(loader.cache.get('A').sig, v2.modifiedTime);
    finish('A');
    const r2 = await p2;
    // already loaded when the file changes → the old Blob URL is released
    const v3 = { ...v1, modifiedTime: '2025-03-01T00:00:00Z' };
    const p3 = loader.loadImage(v3);
    await tick();
    await tick();
    assert.ok(revoked.includes(r2.url), 'old Blob URL revoked');
    assert.equal(loader.cache.size, 1);
    finish('A');
    const r3 = await p3;
    loader.clear();
    await tick();
    assert.ok(revoked.includes(r3.url), 'clear() releases the current version');
  } finally {
    URL.revokeObjectURL = origRevoke;
  }
});
