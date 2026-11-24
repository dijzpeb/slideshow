// Service Worker: <img>/<video> から Google ドライブの写真・動画を直接ストリーミングするためのプロキシ。
// ページ内の "__drive/media/<fileId>" へのリクエストを受け取り、認証ヘッダー（OAuth トークン）や
// リソースキーを付けて Drive API (files.get?alt=media) に転送する。Range リクエストもそのまま転送するので、
// 大きな動画でも全体をダウンロードせずに再生・シークできる。

const MEDIA_PATH = /\/__drive\/media\/([^/?#]+)$/;
const SCOPE_PATH = new URL(self.registration.scope).pathname;

/** ページから受け取った接続情報 { apiBase, token?, apiKey? } */
let creds = null;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'creds') {
    creds = sanitizeCreds(data.creds);
  } else if (data.type === 'ping' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ type: 'pong' });
  }
});

function sanitizeCreds(c) {
  if (!c || typeof c.apiBase !== 'string') return null;
  try {
    const u = new URL(c.apiBase);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
  } catch {
    return null;
  }
  return { apiBase: c.apiBase.replace(/\/+$/, ''), token: c.token || null, apiKey: c.apiKey || null };
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE_PATH)) return;
  const m = url.pathname.match(MEDIA_PATH);
  if (!m) return;
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;
  event.respondWith(handleMedia(event, decodeURIComponent(m[1]), url.searchParams));
});

/** ページに最新の接続情報を問い合わせる */
async function askClient(clientId, force, failedToken) {
  let client = clientId ? await self.clients.get(clientId) : null;
  if (!client) {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
    client = all.find((c) => c.visibilityState === 'visible') || all[0] || null;
  }
  if (!client) return null;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 10000);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(sanitizeCreds(e.data && e.data.creds));
    };
    client.postMessage({ type: 'need-creds', force: !!force, failedToken: failedToken || null }, [ch.port2]);
  });
}

function upstreamRequest(c, id, params, request) {
  const u = new URL(`${c.apiBase}/drive/v3/files/${encodeURIComponent(id)}`);
  u.searchParams.set('alt', 'media');
  u.searchParams.set('supportsAllDrives', 'true');
  if (c.apiKey && !c.token) u.searchParams.set('key', c.apiKey);
  const headers = new Headers();
  if (c.token) headers.set('Authorization', `Bearer ${c.token}`);
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);
  const rk = params.get('rk');
  if (rk && /^[-\w]+$/.test(rk)) headers.set('X-Goog-Drive-Resource-Keys', `${id}/${rk}`);
  return fetch(u.toString(), {
    method: request.method,
    headers,
    mode: 'cors',
    credentials: 'omit',
    cache: 'no-store',
    signal: request.signal,
  });
}

const PASS_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

/** "bytes=a-b" / "bytes=a-" / "bytes=-n" を解析（単一範囲のみ）。size が分かれば終端を補う */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    if (!size) return null;
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? (size ? size - 1 : null) : Number(m[2]);
    if (size && end != null) end = Math.min(end, size - 1);
  }
  return { start, end };
}

/**
 * Content-Type を補正しつつ、ストリームのまま応答を作り直す。
 * Drive の CORS 応答では Content-Range が JavaScript から見えないことがあるため、
 * その場合はリクエストの Range とファイルサイズから組み立てる（<video> のシークに必須）。
 */
function rewrap(res, { mimeHint, size, rangeHeader }) {
  const headers = new Headers();
  for (const h of PASS_HEADERS) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (res.status === 206 && !headers.has('content-range') && size) {
    const r = parseRange(rangeHeader, size);
    if (r && r.end != null) {
      let end = r.end;
      const len = Number(headers.get('content-length'));
      if (len > 0) end = Math.min(end, r.start + len - 1);
      headers.set('content-range', `bytes ${r.start}-${end}/${size}`);
      if (!headers.has('content-length')) headers.set('content-length', String(end - r.start + 1));
    }
  } else if (res.status === 200 && size && !headers.has('content-length')) {
    headers.set('content-length', String(size));
  }
  let ct = res.headers.get('content-type') || mimeHint || 'application/octet-stream';
  // QuickTime (.mov) の H.264 動画は MP4 として扱えば Chrome / Firefox でも再生できることが多い
  if (/^video\/quicktime/i.test(ct)) ct = 'video/mp4';
  headers.set('content-type', ct);
  if (res.status === 206 && !headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function handleMedia(event, id, params) {
  const mimeHint = params.get('mt') || '';
  const size = Number(params.get('sz')) || 0;
  try {
    let c = creds || (await askClient(event.clientId, false));
    if (!c) return new Response('No credentials', { status: 401 });
    if (!creds) creds = c;
    let res = await upstreamRequest(c, id, params, event.request);
    if (res.status === 401 && c.token) {
      // トークン切れ: ページに新しいトークンを問い合わせて一度だけ再試行
      const fresh = await askClient(event.clientId, true, c.token);
      if (fresh && fresh.token && fresh.token !== c.token) {
        creds = fresh;
        res = await upstreamRequest(fresh, id, params, event.request);
      }
    }
    if (!res.ok && res.status !== 206) {
      const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
      if (res.status === 416 && size) headers['content-range'] = `bytes */${size}`;
      return new Response(`Upstream error ${res.status}`, { status: res.status, headers });
    }
    return rewrap(res, { mimeHint, size, rangeHeader: event.request.headers.get('Range') });
  } catch (e) {
    if (e && e.name === 'AbortError') return new Response(null, { status: 499 });
    return new Response(`Proxy error: ${e && e.message}`, { status: 502 });
  }
}
