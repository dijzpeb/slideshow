// 開発・テスト用: index.html の Content-Security-Policy（meta）に、ローカルの接続先（Drive API のモックなど）を足す。
// 公開サイト（GitHub Pages）では使わない。公開する index.html の CSP には localhost を入れない。
// 使うのは scripts/serve.mjs（npm start）と tests/e2e/harness.mjs（E2E テストの静的サーバー）。

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** ローカルの接続先を足すディレクティブ（Drive API・サムネイル・動画） */
const DIRECTIVES = ['connect-src', 'img-src', 'media-src'];
const CSP_META_RE = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/i;

/** ループバック（localhost / 127.0.0.1 / [::1]）の http(s) URL ならそのオリジン、そうでなければ null */
export function loopbackOrigin(value) {
  try {
    const u = new URL(String(value));
    if (!['http:', 'https:'].includes(u.protocol) || !LOOPBACK_HOSTS.has(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** ページの URL の ?apiBase=（アプリが localhost で開かれたときだけ受け付ける接続先）のオリジン */
export function apiBaseOrigin(requestUrl) {
  try {
    const v = new URL(String(requestUrl), 'http://localhost').searchParams.get('apiBase');
    return v ? loopbackOrigin(v) : null;
  } catch {
    return null;
  }
}

/** CSP の文字列の connect-src / img-src / media-src に origins を足す */
export function extendCsp(policy, origins) {
  const list = [...new Set(origins.map(loopbackOrigin).filter(Boolean))];
  if (!list.length) return policy;
  return policy
    .split(';')
    .map((d) => (DIRECTIVES.includes(d.trim().split(/\s+/)[0]) ? `${d.trimEnd()} ${list.join(' ')}` : d))
    .join(';');
}

/** HTML の CSP の meta に origins（ループバックのものだけ）を足す。meta がなければそのまま */
export function addLocalOriginsToCsp(html, origins) {
  return String(html).replace(CSP_META_RE, (m, head, policy, tail) => head + extendCsp(policy, origins) + tail);
}
