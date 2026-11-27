#!/usr/bin/env node
// 開発用の簡易静的ファイルサーバー（依存パッケージなし）。
// 使い方: node scripts/serve.mjs [--port 8080] [--host 127.0.0.1] [--root .]
// ページを ?apiBase=http://127.0.0.1:<port>（Drive API のモック）で開いたときは、index.html の CSP にその接続先を足して配信する。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addLocalOriginsToCsp, apiBaseOrigin } from './dev-csp.mjs';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(opt('root', path.join(here, '..')));
const port = Number(opt('port', process.env.PORT || 8080));
const host = opt('host', '127.0.0.1');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }
  let file = path.normalize(path.join(root, pathname));
  if (!file.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      file = path.join(file, 'index.html');
    }
    fs.readFile(file, (err2, data) => {
      if (err2) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const mock = ext === '.html' ? apiBaseOrigin(req.url) : null;
      const body = mock ? Buffer.from(addLocalOriginsToCsp(data.toString('utf8'), [mock])) : data;
      res.writeHead(200, {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  });
});

server.listen(port, host, () => {
  // Google の「承認済みの JavaScript 生成元」や API キーのウェブサイト制限には localhost で登録するので
  // （127.0.0.1 は別のオリジン）、ループバックで待ち受けるときは localhost の URL を表示する
  const shown = ['127.0.0.1', '::1', 'localhost'].includes(host) ? 'localhost' : host;
  console.log(`Serving ${root} at http://${shown}:${server.address().port}/`);
});
