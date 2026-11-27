// Unit tests of the Content-Security-Policy of index.html and of the dev/test-only CSP extension (scripts/dev-csp.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addLocalOriginsToCsp, apiBaseOrigin, extendCsp, loopbackOrigin } from '../../scripts/dev-csp.mjs';

const HTML = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const META_RE = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i;

function directives(policy) {
  return Object.fromEntries(
    policy
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...values]) => [name, values]),
  );
}

test('index.html: the CSP meta comes before anything that loads (scripts, styles, icons)', () => {
  const head = HTML.slice(0, HTML.indexOf('</head>'));
  const csp = head.search(META_RE);
  assert.ok(csp > 0, 'CSP meta present in <head>');
  for (const tag of ['<script', '<link', '<style']) {
    const i = head.indexOf(tag);
    if (i >= 0) assert.ok(csp < i, `CSP before the first ${tag}`);
  }
  assert.ok(head.indexOf('<meta charset="utf-8"') < csp, 'charset stays first');
});

test('index.html: the production CSP allows only the app itself and the Google endpoints it uses (no localhost)', () => {
  const policy = HTML.match(META_RE)[1];
  assert.doesNotMatch(policy, /localhost|127\.0\.0\.1|\[::1\]|http:|\*\s|'unsafe-inline'|'unsafe-eval'/);
  const d = directives(policy);
  assert.deepEqual(d['default-src'], ["'none'"]);
  assert.deepEqual(d['script-src'], ["'self'", 'https://accounts.google.com/gsi/client']);
  assert.deepEqual(d['connect-src'], ["'self'", 'https://www.googleapis.com', 'https://accounts.google.com/gsi/', 'https://oauth2.googleapis.com']);
  assert.deepEqual(d['img-src'], ["'self'", 'blob:', 'data:', 'https://*.googleusercontent.com', 'https://drive.google.com']);
  // <video src> of the Drive API directly (API key, no Service Worker); everything else is same-origin (SW) or blob:
  assert.deepEqual(d['media-src'], ["'self'", 'blob:', 'https://www.googleapis.com']);
  assert.deepEqual(d['frame-src'], ['https://drive.google.com', 'https://accounts.google.com/gsi/']);
  assert.deepEqual(d['worker-src'], ["'self'", 'blob:']);
  for (const k of ['base-uri', 'form-action', 'object-src']) assert.deepEqual(d[k], ["'none'"], k);
  // the API base the app uses by default is allowed
  assert.ok(d['connect-src'].includes('https://www.googleapis.com'));
});

test('dev-csp: only loopback origins are added, and only to connect-src / img-src / media-src', () => {
  assert.equal(loopbackOrigin('http://127.0.0.1:8787/drive/v3'), 'http://127.0.0.1:8787');
  assert.equal(loopbackOrigin('http://localhost:1'), 'http://localhost:1');
  assert.equal(loopbackOrigin('http://[::1]:5'), 'http://[::1]:5');
  for (const v of ['https://evil.example', 'http://127.0.0.1.evil.example', 'javascript:alert(1)', 'file:///etc/passwd', '', null, 'not a url']) {
    assert.equal(loopbackOrigin(v), null, String(v));
  }
  assert.equal(apiBaseOrigin('/?apiBase=http%3A%2F%2F127.0.0.1%3A9000&folder=x'), 'http://127.0.0.1:9000');
  assert.equal(apiBaseOrigin('/?apiBase=https%3A%2F%2Fevil.example'), null);
  assert.equal(apiBaseOrigin('/?folder=x'), null);

  const out = addLocalOriginsToCsp(HTML, ['http://127.0.0.1:9000', 'https://evil.example', 'http://127.0.0.1:9000/x']);
  const before = directives(HTML.match(META_RE)[1]);
  const after = directives(out.match(META_RE)[1]);
  for (const [name, values] of Object.entries(before)) {
    const extra = ['connect-src', 'img-src', 'media-src'].includes(name) ? ['http://127.0.0.1:9000'] : [];
    assert.deepEqual(after[name], [...values, ...extra], name);
  }
  assert.equal(out.replace(META_RE, ''), HTML.replace(META_RE, ''), 'nothing else in the page changes');
  // nothing to add / no CSP meta → unchanged
  assert.equal(addLocalOriginsToCsp(HTML, []), HTML);
  assert.equal(addLocalOriginsToCsp(HTML, ['https://evil.example']), HTML);
  assert.equal(addLocalOriginsToCsp('<!doctype html><title>x</title>', ['http://127.0.0.1:1']), '<!doctype html><title>x</title>');
  assert.equal(extendCsp("default-src 'none'; img-src 'self'", ['http://localhost:2']), "default-src 'none'; img-src 'self' http://localhost:2");
});
