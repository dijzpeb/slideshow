import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveClient, DriveError, FOLDER_MIME, SHORTCUT_MIME, mediaKind, safeMediaType, mimeEssence, normalizeMimeType, prefersThumbnail } from '../../js/drive.js';

const API = 'https://drive.test';

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function notFound(id) {
  return json(404, { error: { code: 404, message: `File not found: ${id}.`, errors: [{ reason: 'notFound' }] } });
}

/** Replace global fetch with a tiny fake Drive; returns the request log. */
function fakeDrive(t, { folders, files = {}, deny = {} }) {
  const log = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    log.push(u);
    const m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (deny[id]) return deny[id](id);
      return files[id] ? json(200, files[id]) : notFound(id);
    }
    if (u.pathname === '/drive/v3/files') {
      const parent = /'([^']+)' in parents/.exec(u.searchParams.get('q') || '')?.[1];
      if (deny[parent]) return deny[parent](parent);
      if (!(parent in folders)) return notFound(parent);
      return json(200, { files: folders[parent] });
    }
    return notFound(u.pathname);
  };
  t.after(() => {
    globalThis.fetch = orig;
  });
  return log;
}

const img = (id, parent) => ({ id, name: `${id}.jpg`, mimeType: 'image/jpeg', parents: [parent], modifiedTime: '2025-07-12T10:00:00Z' });
const folder = (id, parent) => ({ id, name: id, mimeType: FOLDER_MIME, parents: [parent] });
const folderShortcut = (id, target, parent) => ({
  id,
  name: id,
  mimeType: SHORTCUT_MIME,
  parents: [parent],
  shortcutDetails: { targetId: target, targetMimeType: FOLDER_MIME },
});

test('listMediaTree: an unreadable sub-folder / folder-shortcut target is skipped and counted', async (t) => {
  fakeDrive(t, {
    files: { root: { id: 'root', name: 'Trip', mimeType: FOLDER_MIME } },
    folders: {
      root: [img('a', 'root'), folder('day1', 'root'), folderShortcut('sc_gone', 'gone', 'root'), folderShortcut('sc_private', 'private', 'root')],
      day1: [img('b', 'day1')],
      // 'gone' is missing → 404
    },
    deny: {
      private: () => json(403, { error: { code: 403, message: 'denied', errors: [{ reason: 'insufficientFilePermissions' }] } }),
    },
  });
  const drive = new DriveClient({ apiBase: API, mode: 'apikey', apiKey: 'K' });
  const r = await drive.listMediaTree('root');
  assert.deepEqual(r.files.map((f) => f.id).sort(), ['a', 'b']);
  assert.equal(r.skippedFolders, 2);
});

test('listMediaTree: an error listing the root folder is still thrown', async (t) => {
  const log = fakeDrive(t, {
    files: { root: { id: 'root', name: 'Trip', mimeType: FOLDER_MIME } },
    folders: {}, // the root's metadata is readable, its listing is not
  });
  const drive = new DriveClient({ apiBase: API, mode: 'apikey', apiKey: 'K' });
  await assert.rejects(drive.listMediaTree('root'), (e) => e instanceof DriveError && e.status === 404);
  assert.ok(log.some((u) => u.pathname === '/drive/v3/files'), 'the listing was attempted');
});

test('listMediaTree: an aborted listing is not turned into a skipped folder', async (t) => {
  const ctrl = new AbortController();
  fakeDrive(t, {
    files: { root: { id: 'root', name: 'Trip', mimeType: FOLDER_MIME } },
    folders: { root: [folder('day1', 'root')] },
    deny: {
      day1: () => {
        ctrl.abort();
        return notFound('day1');
      },
    },
  });
  const drive = new DriveClient({ apiBase: API, mode: 'apikey', apiKey: 'K' });
  await assert.rejects(drive.listMediaTree('root', { signal: ctrl.signal }));
});

test('searchFolders follows nextPageToken up to maxPages / maxResults', async (t) => {
  const log = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    log.push(u);
    const page = Number(u.searchParams.get('pageToken') || 0);
    const files = Array.from({ length: 3 }, (_, i) => ({ id: `f${page * 3 + i}`, name: `F${page * 3 + i}`, mimeType: FOLDER_MIME }));
    return json(200, page < 9 ? { files, nextPageToken: String(page + 1) } : { files });
  };
  t.after(() => {
    globalThis.fetch = orig;
  });
  const drive = new DriveClient({ apiBase: API, mode: 'apikey', apiKey: 'K' });
  const all = await drive.searchFolders('');
  assert.equal(all.length, 15, '5 pages by default');
  assert.equal(log.length, 5);
  assert.match(log[0].searchParams.get('fields'), /^nextPageToken,files\(/);
  assert.equal(log[1].searchParams.get('pageToken'), '1');
  log.length = 0;
  const few = await drive.searchFolders('x', { maxResults: 4 });
  assert.deepEqual(few.map((f) => f.id), ['f0', 'f1', 'f2', 'f3']);
  assert.equal(log.length, 2);
  assert.equal(log[1].searchParams.get('pageSize'), '1', 'asks only for what is still needed');
});

test('mediaKind: MIME essence (case, spaces, parameters); images except SVG / +xml / icons, and video/*', () => {
  assert.equal(mimeEssence(' Image/JPEG ; charset=binary'), 'image/jpeg');
  for (const t of ['image/jpeg', 'IMAGE/JPEG', ' image/png ', 'image/heic', 'image/heif', 'image/avif', 'image/webp', 'image/gif', 'image/bmp', 'image/jpeg; foo=bar']) {
    assert.equal(mediaKind(t, 'x'), 'image', t);
  }
  // photos a browser may not decode are still part of the show (shown through Drive's thumbnail)
  for (const t of ['image/tiff', 'image/x-adobe-dng', 'image/x-canon-cr2', 'image/x-canon-cr3', 'image/x-sony-arw', 'image/x-nikon-nef', 'image/x-png', 'image/jxl']) {
    assert.equal(mediaKind(t, 'x'), 'image', t);
  }
  for (const t of ['video/mp4', 'video/quicktime', 'Video/MP4; codecs="avc1"', 'video/webm']) assert.equal(mediaKind(t, 'x'), 'video', t);
  for (const t of [
    'image/svg+xml',
    'image/svg+xml; charset=utf-8',
    'Image/SVG+XML',
    ' image/svg+xml ;x=1',
    'image/x-test+xml',
    'video/x-test+xml',
    'image/svg',
    'image/x-svg',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'text/html',
    'application/xhtml+xml',
    'image/',
  ]) {
    assert.equal(mediaKind(t, 'photo.jpg'), null, t);
  }
  // Drive's octet-stream: the extension decides (as before)
  assert.equal(mediaKind('application/octet-stream', 'IMG_1.HEIC'), 'image');
  assert.equal(mediaKind('', 'clip.mov'), 'video');
  assert.equal(mediaKind('application/octet-stream', 'logo.svg'), null);
  assert.equal(normalizeMimeType('Image/JPEG; x=1', 'a.jpg'), 'image/jpeg');
});

test('prefersThumbnail: camera RAW and other types no browser decodes use the thumbnail first (no big download)', () => {
  for (const t of ['image/x-adobe-dng', 'image/x-canon-cr2', 'image/x-sony-arw', 'Image/X-Nikon-NEF; x=1', 'image/x-fuji-raf']) assert.equal(prefersThumbnail(t), true, t);
  // the original first: browsers (or the bundled HEIC converter) may show it; TIFF / JPEG XL in Safari
  for (const t of ['image/jpeg', 'image/png', 'image/x-png', 'image/heic', 'image/heif', 'image/avif', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff', 'image/jxl']) {
    assert.equal(prefersThumbnail(t), false, t);
  }
  assert.equal(prefersThumbnail('video/mp4'), false);
});

test('safeMediaType: essence only, image/video/audio, never SVG / +xml; falls back to the hint, then octet-stream', () => {
  assert.equal(safeMediaType('image/jpeg; charset=binary'), 'image/jpeg');
  assert.equal(safeMediaType('Image/HEIC'), 'image/heic');
  assert.equal(safeMediaType('video/quicktime'), 'video/quicktime');
  assert.equal(safeMediaType('audio/mpeg'), 'audio/mpeg');
  for (const t of ['image/svg+xml', 'image/svg+xml; charset=utf-8', 'image/svg', 'image/x-svg', 'image/x-test+xml', 'text/html', 'application/xhtml+xml', 'application/octet-stream', '', null, 'image/<script>']) {
    assert.equal(safeMediaType(t), 'application/octet-stream', String(t));
  }
  assert.equal(safeMediaType('text/html', 'image/png'), 'image/png');
  assert.equal(safeMediaType('image/svg+xml', 'image/svg+xml'), 'application/octet-stream');
  assert.equal(safeMediaType(null, 'video/mp4'), 'video/mp4');
  assert.equal(safeMediaType('image/x-adobe-dng'), 'image/x-adobe-dng');
});

test('DriveClient: every API request is made with cache: "no-store" and without cookies', async (t) => {
  const inits = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    inits.push(init);
    const u = new URL(url);
    if (u.searchParams.get('alt') === 'media') return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (u.pathname === '/drive/v3/files') return json(200, { files: [] });
    return json(200, { id: 'root', name: 'root', mimeType: FOLDER_MIME });
  };
  t.after(() => {
    globalThis.fetch = orig;
  });
  const drive = new DriveClient({ apiBase: API, mode: 'oauth', getToken: async () => 'tok' });
  await drive.listMediaTree('root');
  await drive.searchFolders('x');
  await drive.fetchRange('img', 0, 10);
  await (await drive.fetchMedia('img')).arrayBuffer();
  assert.ok(inits.length >= 5);
  for (const init of inits) {
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'omit');
  }
});
