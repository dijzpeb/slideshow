// Service Worker: <img>/<video> から Google ドライブの写真・動画を直接ストリーミングするためのプロキシ。
// ページ内の "__drive/media/<fileId>" へのリクエストを受け取り、認証ヘッダー（OAuth トークン）や
// リソースキーを付けて Drive API (files.get?alt=media) に転送する。Range リクエストもそのまま転送するので、
// 大きな動画でも全体をダウンロードせずに再生・シークできる。

const MEDIA_PATH = /\/__drive\/media\/([^/?#]+)$/;
const SCOPE_PATH = new URL(self.registration.scope).pathname;

/** 扱うのはページ内の fetch() と <img>/<video>/<audio> だけ（ページ遷移・iframe などは素通し） */
const MEDIA_DESTINATIONS = new Set(['', 'image', 'video', 'audio']);

/**
 * 再試行するのは <img>/<video>/<audio> の要求だけ。ページの fetch() は中止しても FetchEvent の
 * request.signal に伝わらない（Chromium）ので、ページ側（MediaLoader / DriveClient）で再試行する
 */
const RETRY_DESTINATIONS = new Set(['image', 'video', 'audio']);
/** 一時的なエラーとして再試行する上流のステータス */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
/** 再試行までの待ち時間（ミリ秒、これにゆらぎを加える） */
const RETRY_DELAYS = [500, 1000, 2000];

/** すべての応答に付ける: 内容の推測を禁止し、文書として開かれてもスクリプトを動かさない */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
};

/** タブ（クライアント）ごとの接続情報 clientId -> { apiBase, token?, apiKey? } */
const credsByClient = new Map();
/** 問い合わせ中の clientId -> Promise（同時に何度も問い合わせない） */
const asking = new Map();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'creds') {
    const id = event.source && event.source.id;
    if (id) {
      const c = sanitizeCreds(data.creds);
      if (c) credsByClient.set(id, c);
      else credsByClient.delete(id); // ログアウトなど: このタブの分だけ消す
    }
    const p = pruneClients();
    if (event.waitUntil) event.waitUntil(p);
  } else if (data.type === 'ping' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ type: 'pong' });
  }
});

/** 閉じられたタブの接続情報を捨てる */
async function pruneClients() {
  for (const id of [...credsByClient.keys()]) {
    try {
      if (!(await self.clients.get(id))) credsByClient.delete(id);
    } catch {
      /* 次の機会に */
    }
  }
}

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
  const request = event.request;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  // 別サイトから開かれたページ遷移などで、ドライブのファイルをこのサイトの文書として表示させない
  if (request.mode === 'navigate' || !MEDIA_DESTINATIONS.has(request.destination || '')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE_PATH)) return;
  const m = url.pathname.match(MEDIA_PATH);
  if (!m) return;
  const clientId = event.clientId || event.resultingClientId || '';
  event.respondWith(handleMedia(request, clientId, decodeURIComponent(m[1]), url.searchParams));
});

/** 要求元のタブに最新の接続情報を問い合わせる（ほかのタブには聞かない） */
async function askClient(clientId, force, failedToken) {
  const client = clientId ? await self.clients.get(clientId) : null;
  if (!client) return null;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => {
      ch.port1.close();
      resolve(null);
    }, 10000);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      ch.port1.close();
      resolve(sanitizeCreds(e.data && e.data.creds));
    };
    client.postMessage({ type: 'need-creds', force: !!force, failedToken: failedToken || null }, [ch.port2]);
  });
}

/** このタブの接続情報（なければ問い合わせて覚えておく） */
async function credsFor(clientId) {
  if (!clientId) return null;
  const known = credsByClient.get(clientId);
  if (known) return known;
  let p = asking.get(clientId);
  if (!p) {
    p = askClient(clientId, false).then((c) => {
      // 問い合わせ中に届いた新しい情報は上書きしない
      if (c && !credsByClient.has(clientId)) credsByClient.set(clientId, c);
      return credsByClient.get(clientId) || null;
    });
    p.finally(() => asking.delete(clientId)).catch(() => {});
    asking.set(clientId, p);
  }
  return p;
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

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function backoff(attempt) {
  const base = RETRY_DELAYS[attempt];
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** 429 / 5xx、または 403 のうちレート制限（本文の reason で判断）なら一時的なエラー */
async function isTransient(res, request) {
  if (RETRY_STATUS.has(res.status)) return true;
  if (res.status !== 403 || request.method !== 'GET') return false;
  try {
    const text = await res.clone().text();
    return /"reason"\s*:\s*"(rateLimitExceeded|userRateLimitExceeded)"/.test(text);
  } catch {
    return false;
  }
}

/** 待ったあと、要求元のタブがまだあるか確かめる（閉じられていれば中止） */
async function waitBeforeRetry(attempt, request, clientId) {
  await sleep(backoff(attempt), request.signal);
  if (request.signal && request.signal.aborted) throw abortError();
  if (clientId && !(await self.clients.get(clientId))) throw abortError();
}

/**
 * 上流への GET / HEAD（冪等）。<img>/<video>/<audio> の要求だけ、一時的なエラーを指数バックオフで数回再試行する
 */
async function fetchUpstream(c, id, params, request, clientId) {
  const retries = RETRY_DESTINATIONS.has(request.destination || '') ? RETRY_DELAYS.length : 0;
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= retries;
    let res;
    try {
      res = await upstreamRequest(c, id, params, request);
    } catch (e) {
      if (last || (request.signal && request.signal.aborted)) throw e;
      await waitBeforeRetry(attempt, request, clientId);
      continue;
    }
    if (last || !(await isTransient(res, request))) return res;
    if (res.body) res.body.cancel().catch(() => {});
    await waitBeforeRetry(attempt, request, clientId);
  }
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

/** 写真・動画・音声の Content-Type だけを通す（SVG と XML 系（+xml）は不可）。それ以外は null */
function mediaType(ct) {
  const t = String(ct || '').split(';')[0].trim().toLowerCase();
  // QuickTime (.mov) の H.264 動画は MP4 として扱えば Chrome / Firefox でも再生できることが多い
  if (t === 'video/quicktime') return 'video/mp4';
  if (!/^(image|video|audio)\/[a-z0-9][a-z0-9.+-]*$/.test(t) || t.endsWith('+xml') || t.includes('svg')) return null;
  return t;
}

/**
 * Content-Type を補正しつつ、ストリームのまま応答を作り直す。
 * Drive の CORS 応答では Content-Range が JavaScript から見えないことがあるため、
 * その場合はリクエストの Range とファイルサイズから組み立てる（<video> のシークに必須）。
 */
function rewrap(res, { mimeHint, size, rangeHeader }) {
  const headers = new Headers(SECURITY_HEADERS);
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
  headers.set('content-type', mediaType(res.headers.get('content-type')) || mediaType(mimeHint) || 'application/octet-stream');
  if (res.status === 206 && !headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function textResponse(text, status, extra = {}) {
  return new Response(text, {
    status,
    headers: { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

async function handleMedia(request, clientId, id, params) {
  const mimeHint = params.get('mt') || '';
  const size = Number(params.get('sz')) || 0;
  try {
    const c = await credsFor(clientId);
    if (!c) return textResponse('No credentials', 401);
    let res = await fetchUpstream(c, id, params, request, clientId);
    if (res.status === 401 && c.token) {
      // トークン切れ: このタブに新しいトークンを問い合わせて一度だけ再試行
      const fresh = await askClient(clientId, true, c.token);
      if (fresh && fresh.token && fresh.token !== c.token) {
        credsByClient.set(clientId, fresh);
        res = await fetchUpstream(fresh, id, params, request, clientId);
      } else if (credsByClient.get(clientId) === c) {
        // 拒否されたトークンは覚えておかない（再ログイン後の最初の要求はタブに問い合わせる）
        credsByClient.delete(clientId);
      }
    }
    if (!res.ok && res.status !== 206) {
      if (res.body) res.body.cancel().catch(() => {});
      return textResponse(`Upstream error ${res.status}`, res.status, res.status === 416 && size ? { 'content-range': `bytes */${size}` } : {});
    }
    return rewrap(res, { mimeHint, size, rangeHeader: request.headers.get('Range') });
  } catch (e) {
    if (e && e.name === 'AbortError') return new Response(null, { status: 499, headers: SECURITY_HEADERS });
    return textResponse(`Proxy error: ${e && e.message}`, 502);
  }
}
