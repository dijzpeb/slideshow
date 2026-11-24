#!/usr/bin/env node
// Smoke test for the mock Drive API + static server + fixture manifest (no browser).
//   node tests/e2e/smoke-mock.mjs        exits non-zero on failure
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { startServers, FIXTURES_DIR, TEST_KEY, TEST_TOKEN, filesById } from './harness.mjs';

const PAGE = 4;
const env = await startServers({ maxPageSize: PAGE });
const { driveUrl, admin, manifest } = env;
const byId = filesById(manifest);
const ORIGIN = 'http://127.0.0.1:5555';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (e) {
    results.push({ name, ok: false, e });
    console.log(`  FAIL ${name}\n       ${String(e.stack || e).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

function url(p, params = {}) {
  const u = new URL(driveUrl + p);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}
const KEY = { key: TEST_KEY };
const BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
async function api(p, params = {}, { headers = {}, method = 'GET' } = {}) {
  const r = await fetch(url(p, params), { method, headers: { origin: ORIGIN, ...headers } });
  const text = method === 'HEAD' ? '' : await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { r, status: r.status, json, text, headers: r.headers };
}
async function listAll(params, opts) {
  const files = [];
  let pageToken;
  let pages = 0;
  do {
    const { status, json } = await api('/drive/v3/files', { ...params, pageToken }, opts);
    assert.equal(status, 200, JSON.stringify(json));
    assert.ok(json.files.length <= PAGE, `page larger than ${PAGE}`);
    files.push(...json.files);
    pageToken = json.nextPageToken;
    pages++;
    assert.ok(pages < 200, 'runaway pagination');
  } while (pageToken);
  return { files, pages };
}
const childrenOf = (fid, { includeTrashed = true, includeHidden = false } = {}) => manifest.files
  .filter((f) => f.parents.includes(fid))
  .filter((f) => includeTrashed || !f.trashed)
  .filter((f) => includeHidden || !f._test.hiddenUntilRevealed)
  .map((f) => f.id).sort();
const ids = (files) => files.map((f) => f.id).sort();
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const qParents = (id, extra = '') => `'${id}' in parents${extra}`;

console.log(`mock drive: ${driveUrl}  app: ${env.appUrl}  maxPageSize=${PAGE}`);

// ---------------------------------------------------------------- manifest
await check('manifest: files exist on disk with matching size/md5', () => {
  for (const f of manifest.files) {
    if (!f._test.path) continue;
    const buf = fs.readFileSync(path.join(FIXTURES_DIR, f._test.path));
    assert.equal(String(buf.length), f.size, f.id);
    assert.equal(md5(buf), f.md5Checksum, f.id);
    for (const t of Object.values(f._test.thumbs || {})) assert.ok(fs.existsSync(path.join(FIXTURES_DIR, t)), t);
  }
});
await check('manifest: oracle orders are consistent', () => {
  assert.equal(manifest.expectedOrderDefault.length, 25);
  assert.equal(manifest.expectedOrderWithReveal.length, 27);
  assert.deepEqual(manifest.expectedOrderCanonFix, manifest.expectedOrderTrue);
  assert.notDeepEqual(manifest.expectedOrderDefault, manifest.expectedOrderTrue);
  for (const id of manifest.expectedOrderWithReveal) assert.equal(byId[id]._test.expected.include, true, id);
  const times = manifest.expectedOrderDefault.map((id) => byId[id]._test.expected.appTimeUtcDefault);
  assert.deepEqual([...times].sort(), times);
  assert.deepEqual(manifest.hiddenIds.sort(), ['img_hidden_lapland', 'img_hidden_rovaniemi']);
});

// ---------------------------------------------------------------- auth
await check('auth: no credentials → 403 dailyLimitExceededUnreg', async () => {
  const { status, json } = await api('/drive/v3/files', { q: qParents('folder_root') });
  assert.equal(status, 403);
  assert.equal(json.error.code, 403);
  assert.equal(json.error.status, 'PERMISSION_DENIED');
  assert.equal(json.error.errors[0].reason, 'dailyLimitExceededUnreg');
});
await check('auth: invalid bearer → 401 + www-authenticate (exposed)', async () => {
  const { status, json, headers } = await api('/drive/v3/files/img_senate_square', {}, { headers: { authorization: 'Bearer nope' } });
  assert.equal(status, 401);
  assert.match(headers.get('www-authenticate'), /^Bearer /);
  assert.equal(json.error.status, 'UNAUTHENTICATED');
  assert.deepEqual(json.error.errors[0], { message: 'Invalid Credentials', domain: 'global', reason: 'authError', location: 'Authorization', locationType: 'header' });
  assert.match(json.error.message, /^Request had invalid authentication credentials/);
  assert.ok(headers.get('access-control-expose-headers').split(',').includes('www-authenticate'));
});
await check('auth: invalid API key → 400 API_KEY_INVALID', async () => {
  const { status, json } = await api('/drive/v3/files/img_senate_square', { key: 'WRONG' });
  assert.equal(status, 400);
  assert.equal(json.error.details[0].reason, 'API_KEY_INVALID');
});
await check('auth: bearer wins over key; access_token query param accepted', async () => {
  assert.equal((await api('/drive/v3/files/img_private_1', { key: TEST_KEY }, { headers: BEARER })).status, 200);
  assert.equal((await api('/drive/v3/files/img_private_1', { access_token: TEST_TOKEN })).status, 200);
});

// ---------------------------------------------------------------- files.list
await check('list: folder_root via API key, paginated, all children (incl. trashed rules)', async () => {
  const { files, pages } = await listAll({ q: qParents('folder_root', ' and trashed = false'), fields: 'nextPageToken,files(id,name,mimeType)', pageSize: '100', ...KEY });
  assert.deepEqual(ids(files), childrenOf('folder_root', { includeTrashed: false }));
  assert.ok(pages >= 2, 'expected pagination');
  for (const f of files) assert.deepEqual(Object.keys(f).sort(), ['id', 'mimeType', 'name']);
});
await check('list: stable order = name ascending (not chronological)', async () => {
  const { files } = await listAll({ q: qParents('folder_day1'), fields: 'nextPageToken,files(name)', ...KEY });
  const names = files.map((f) => f.name);
  assert.deepEqual(names, [...names].sort());
});
await check('list: trashed items returned unless trashed = false', async () => {
  const all = await listAll({ q: qParents('folder_day1'), fields: 'nextPageToken,files(id,trashed)', ...KEY });
  assert.ok(all.files.some((f) => f.id === 'img_trashed' && f.trashed === true));
  const nt = await listAll({ q: `${qParents('folder_day1')} and trashed=false`, fields: 'nextPageToken,files(id)', ...KEY });
  assert.ok(!nt.files.some((f) => f.id === 'img_trashed'));
  const only = await listAll({ q: `${qParents('folder_day1')} and trashed = true`, fields: 'nextPageToken,files(id)', ...KEY });
  assert.deepEqual(ids(only.files), ['img_trashed']);
});
await check('list: nextPageToken omitted when not in fields', async () => {
  const { json } = await api('/drive/v3/files', { q: qParents('folder_root'), fields: 'files(id)', ...KEY });
  assert.equal(json.files.length, PAGE);
  assert.ok(!('nextPageToken' in json));
  assert.deepEqual(Object.keys(json), ['files']);
});
await check('list: default fields = kind,incompleteSearch,nextPageToken,files(kind,id,name,mimeType)', async () => {
  const { json } = await api('/drive/v3/files', { q: qParents('folder_root'), ...KEY });
  assert.deepEqual(Object.keys(json).sort(), ['files', 'incompleteSearch', 'kind', 'nextPageToken']);
  assert.equal(json.kind, 'drive#fileList');
  assert.equal(json.incompleteSearch, false);
  for (const f of json.files) assert.deepEqual(Object.keys(f).sort(), ['id', 'kind', 'mimeType', 'name']);
});
await check('list: mimeType =, !=, contains; name contains (case-insensitive); and/or/not/()', async () => {
  const folders = await listAll({ q: `${qParents('folder_day3')} and mimeType = 'application/vnd.google-apps.folder'`, fields: 'nextPageToken,files(id)', ...KEY });
  assert.deepEqual(ids(folders.files), ['folder_aurora']);
  const nonFolders = await listAll({ q: `${qParents('folder_day3')} and mimeType != 'application/vnd.google-apps.folder'`, fields: 'nextPageToken,files(id)', ...KEY });
  assert.deepEqual(ids(nonFolders.files), childrenOf('folder_day3').filter((i) => i !== 'folder_aurora'));
  const vids = await listAll({ q: `${qParents('folder_day2')} and mimeType contains 'video/'`, fields: 'nextPageToken,files(id)', ...KEY });
  assert.deepEqual(ids(vids.files), ['vid_hevc', 'vid_reindeer_mov']);
  const named = await listAll({ q: `${qParents('folder_day1')} and name contains 'img_12'`, fields: 'nextPageToken,files(name)', ...KEY });
  assert.deepEqual(named.files.map((f) => f.name).sort(), ['IMG_1203.JPG', 'IMG_1207.JPG', 'IMG_1240.JPG', 'IMG_1250.JPG']);
  const media = await listAll({ q: `${qParents('folder_day1')} and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/')`, fields: 'nextPageToken,files(id)', ...KEY });
  assert.equal(media.files.length, 7);
  const notImg = await listAll({ q: `${qParents('folder_day1')} and not mimeType contains 'image/'`, fields: 'nextPageToken,files(id)', ...KEY });
  assert.deepEqual(ids(notImg.files), ['vid_harbour_ferry', 'vid_tram']);
  const multi = await listAll({ q: `('folder_day4' in parents or 'folder_aurora' in parents) and trashed = false`, fields: 'nextPageToken,files(id)', ...KEY });
  assert.equal(multi.files.length, 5);
  const esc = await api('/drive/v3/files', { q: `name contains 'Friend\\'s'`, fields: 'files(id)' }, { headers: BEARER });
  assert.deepEqual(ids(esc.json.files), ['folder_other']);
});
await check('list: unsupported q → 400 Invalid Value (location q)', async () => {
  for (const q of [`fullText contains 'x'`, `'me' in owners`, `'folder_root' in parents and`, `sharedWithMe`, `name = folder_root`, `foo = 'x'`]) {
    const { status, json } = await api('/drive/v3/files', { q, ...KEY });
    assert.equal(status, 400, q);
    assert.equal(json.error.message, 'Invalid Value');
    assert.equal(json.error.errors[0].location, 'q');
  }
});
await check('list: pageSize validation and invalid pageToken', async () => {
  for (const ps of ['0', '1001', 'abc']) assert.equal((await api('/drive/v3/files', { q: qParents('folder_root'), pageSize: ps, ...KEY })).status, 400, ps);
  assert.equal((await api('/drive/v3/files', { q: qParents('folder_root'), pageSize: '1000', ...KEY })).status, 200);
  const bad = await api('/drive/v3/files', { q: qParents('folder_root'), pageToken: 'garbage', ...KEY });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.errors[0].location, 'pageToken');
  const first = await api('/drive/v3/files', { q: qParents('folder_root'), ...KEY });
  const other = await api('/drive/v3/files', { q: qParents('folder_day1'), pageToken: first.json.nextPageToken, ...KEY });
  assert.equal(other.status, 400, 'page token must be bound to the query');
});
await check('list: pageSize below cap is honoured', async () => {
  const { json } = await api('/drive/v3/files', { q: qParents('folder_root'), pageSize: '2', fields: 'nextPageToken,files(id)', ...KEY });
  assert.equal(json.files.length, 2);
  assert.ok(json.nextPageToken);
});
await check('list: orderBy (name desc, createdTime, folder) and invalid orderBy', async () => {
  const d = await listAll({ q: qParents('folder_day1'), orderBy: 'name desc', fields: 'nextPageToken,files(name)', ...KEY });
  const names = d.files.map((f) => f.name);
  assert.deepEqual(names, [...names].sort().reverse());
  const c = await listAll({ q: qParents('folder_day1'), orderBy: 'createdTime', fields: 'nextPageToken,files(createdTime)', ...KEY });
  const ct = c.files.map((f) => f.createdTime);
  assert.deepEqual(ct, [...ct].sort());
  const f = await listAll({ q: qParents('folder_root'), orderBy: 'folder,name', fields: 'nextPageToken,files(mimeType)', ...KEY });
  const firstNonFolder = f.files.findIndex((x) => x.mimeType !== 'application/vnd.google-apps.folder');
  assert.ok(f.files.slice(firstNonFolder).every((x) => x.mimeType !== 'application/vnd.google-apps.folder'));
  assert.equal((await api('/drive/v3/files', { q: qParents('folder_root'), orderBy: 'bogus', ...KEY })).status, 400);
});
await check('list: folder_big paginates through 120 items', async () => {
  const { files, pages } = await listAll({ q: `${qParents('folder_big')} and trashed = false`, pageSize: '1000', fields: 'nextPageToken,files(id)', ...KEY });
  assert.equal(files.length, 120);
  assert.equal(pages, 30);
  assert.equal(new Set(files.map((f) => f.id)).size, 120);
});

// ---------------------------------------------------------------- fields
await check('fields: nested selection imageMediaMetadata(time,cameraModel)', async () => {
  const { files } = await listAll({ q: qParents('folder_day1'), fields: 'nextPageToken,files(id,name,mimeType,imageMediaMetadata(time,cameraModel))', ...KEY });
  const m = Object.fromEntries(files.map((f) => [f.id, f]));
  assert.deepEqual(m.img_helsinki_cathedral.imageMediaMetadata, { time: '2025:07:12 12:20:00', cameraModel: 'iPhone 15' });
  assert.deepEqual(m.img_market_square_canon.imageMediaMetadata, { time: '2025:07:12 20:10:00', cameraModel: 'Canon EOS R6' });
  assert.ok(!('imageMediaMetadata' in m.img_sauna), 'empty nested object must be omitted');
  assert.ok(!('imageMediaMetadata' in m.vid_tram));
  const exifRange = (await api('/drive/v3/files/img_exif_range', { fields: 'id,imageMediaMetadata(time,width)', ...KEY })).json;
  assert.deepEqual(exifRange, { id: 'img_exif_range', imageMediaMetadata: { width: 1280 } });
});
await check('fields: slash syntax, location sub-fields, *, files(*)', async () => {
  const s = await api('/drive/v3/files/img_suomenlinna_gps', { fields: 'id,imageMediaMetadata/location/latitude,imageMediaMetadata(location(longitude))', ...KEY });
  assert.deepEqual(s.json, { id: 'img_suomenlinna_gps', imageMediaMetadata: { location: { latitude: 60.1454, longitude: 24.9881 } } });
  const all = await api('/drive/v3/files/vid_tram', { fields: '*', ...KEY });
  const rec = byId.vid_tram;
  for (const k of ['kind', 'id', 'name', 'mimeType', 'parents', 'size', 'md5Checksum', 'createdTime', 'modifiedTime', 'videoMediaMetadata', 'thumbnailLink', 'hasThumbnail', 'webViewLink']) {
    assert.ok(k in all.json, k);
  }
  assert.ok(!('_test' in all.json));
  assert.equal(all.json.size, rec.size);
  assert.equal(all.json.thumbnailLink, `${driveUrl}/thumb/vid_tram=s220`);
  assert.equal(typeof all.json.videoMediaMetadata.durationMillis, 'string');
  const l = await api('/drive/v3/files', { q: qParents('folder_day4'), fields: 'files(*)', ...KEY });
  assert.deepEqual(Object.keys(l.json), ['files']);
  assert.ok(l.json.files.every((f) => f.md5Checksum && f.imageMediaMetadata && !f._test));
});
await check('fields: invalid selection → 400 invalidParameter', async () => {
  for (const fields of ['files(id,bogus)', 'bogusTop', 'id,imageMediaMetadata(nope)', 'files(id']) {
    const p = fields.startsWith('files') || fields === 'bogusTop' ? '/drive/v3/files' : '/drive/v3/files/img_lake';
    const { status, json } = await api(p, { q: p.endsWith('files') ? qParents('folder_root') : undefined, fields, ...KEY });
    assert.equal(status, 400, fields);
    assert.equal(json.error.errors[0].reason, 'invalidParameter');
    assert.equal(json.error.errors[0].location, 'fields');
  }
});

// ---------------------------------------------------------------- files.get
await check('get: default fields kind,id,name,mimeType; HEAD works', async () => {
  const { json } = await api('/drive/v3/files/img_senate_square', { supportsAllDrives: 'true', ...KEY });
  assert.deepEqual(json, { kind: 'drive#file', id: 'img_senate_square', name: 'IMG_1203.JPG', mimeType: 'image/jpeg' });
  const h = await api('/drive/v3/files/img_senate_square', KEY, { method: 'HEAD' });
  assert.equal(h.status, 200);
  assert.match(h.headers.get('content-type'), /application\/json/);
});
await check('get: shortcut details + target resolvable with API key', async () => {
  const { json } = await api('/drive/v3/files/sc_img_other', { fields: 'id,mimeType,shortcutDetails', ...KEY });
  assert.deepEqual(json.shortcutDetails, { targetId: 'img_other_kauppatori', targetMimeType: 'image/jpeg' });
  assert.equal((await api('/drive/v3/files/img_other_kauppatori', KEY)).status, 200);
  const fsc = (await api('/drive/v3/files/sc_folder_extra', { fields: 'shortcutDetails', ...KEY })).json;
  assert.equal(fsc.shortcutDetails.targetMimeType, 'application/vnd.google-apps.folder');
  const extra = await listAll({ q: qParents('folder_extra'), fields: 'nextPageToken,files(id)', ...KEY });
  assert.deepEqual(ids(extra.files), ['img_extra_porvoo']);
  // the friend's folder itself is private
  assert.equal((await api('/drive/v3/files', { q: qParents('folder_other'), ...KEY })).status, 404);
});
await check('get: unknown id → Google-style 404', async () => {
  const { status, json } = await api('/drive/v3/files/nope', KEY);
  assert.equal(status, 404);
  assert.deepEqual(json, { error: { code: 404, message: 'File not found: nope.', errors: [{ message: 'File not found: nope.', domain: 'global', reason: 'notFound', location: 'fileId', locationType: 'parameter' }] } });
});

// ---------------------------------------------------------------- access control
await check('access: private folder/files → 404 with API key, 200 with bearer', async () => {
  assert.equal((await api('/drive/v3/files/folder_private', KEY)).status, 404);
  assert.equal((await api('/drive/v3/files/img_private_1', KEY)).status, 404);
  assert.equal((await api('/drive/v3/files/img_private_1', { alt: 'media', ...KEY })).status, 404);
  const l = await api('/drive/v3/files', { q: qParents('folder_private'), ...KEY });
  assert.equal(l.status, 404);
  assert.equal(l.json.error.message, 'File not found: folder_private.');
  const b = await listAll({ q: qParents('folder_private'), fields: 'nextPageToken,files(id)' }, { headers: BEARER });
  assert.deepEqual(ids(b.files), ['img_private_1', 'img_private_2']);
  const media = await api('/drive/v3/files/img_private_2', { alt: 'media' }, { headers: BEARER });
  assert.equal(media.status, 200);
});
await check('access: resource keys required in API-key mode', async () => {
  const H = (v) => ({ headers: { 'X-Goog-Drive-Resource-Keys': v } });
  assert.equal((await api('/drive/v3/files', { q: qParents('folder_reskey'), ...KEY })).status, 404);
  assert.equal((await api('/drive/v3/files', { q: qParents('folder_reskey'), ...KEY }, H('folder_reskey/WRONG'))).status, 404);
  const l = await api('/drive/v3/files', { q: qParents('folder_reskey'), fields: 'files(id,resourceKey)', ...KEY }, H('folder_reskey/0-ABCdef'));
  assert.equal(l.status, 200);
  assert.deepEqual(l.json.files.sort((a, b) => a.id.localeCompare(b.id)), [{ id: 'img_reskey_1', resourceKey: '0-imgAkey1' }, { id: 'img_reskey_2', resourceKey: '0-imgBkey2' }]);
  assert.equal((await api('/drive/v3/files/folder_reskey', KEY, H('folder_reskey/0-ABCdef'))).status, 200);
  assert.equal((await api('/drive/v3/files/img_reskey_1', { alt: 'media', ...KEY })).status, 404);
  assert.equal((await api('/drive/v3/files/img_reskey_1', { alt: 'media', ...KEY }, H('folder_reskey/0-ABCdef'))).status, 404);
  const ok = await api('/drive/v3/files/img_reskey_1', { alt: 'media', ...KEY }, H('folder_reskey/0-ABCdef, img_reskey_1/0-imgAkey1'));
  assert.equal(ok.status, 200);
  assert.equal((await api('/drive/v3/files/img_reskey_2', { alt: 'media' }, { headers: BEARER })).status, 200);
});
await check('access: "root" alias needs OAuth', async () => {
  assert.equal((await api('/drive/v3/files', { q: `'root' in parents`, ...KEY })).status, 404);
  const b = await listAll({ q: `'root' in parents and trashed = false`, fields: 'nextPageToken,files(id)' }, { headers: BEARER });
  assert.ok(b.files.some((f) => f.id === 'folder_root'));
});

// ---------------------------------------------------------------- media
await check('media: full download (200) with correct bytes and Content-Type', async () => {
  for (const id of ['img_senate_square', 'vid_reindeer_mov', 'img_arctic_circle_heic', 'img_screenshot', 'txt_notes']) {
    const r = await fetch(url(`/drive/v3/files/${id}`, { alt: 'media', supportsAllDrives: 'true', ...KEY }));
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(r.status, 200, id);
    assert.equal(r.headers.get('content-type'), byId[id].mimeType);
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('content-length'), byId[id].size);
    assert.equal(md5(buf), byId[id].md5Checksum);
  }
});
await check('media: Range a-b / a- / -n → 206; unsatisfiable → 416; HEAD', async () => {
  const rec = byId.vid_tram;
  const size = Number(rec.size);
  const whole = fs.readFileSync(path.join(FIXTURES_DIR, rec._test.path));
  const get = (range, method = 'GET') => fetch(url('/drive/v3/files/vid_tram', { alt: 'media', ...KEY }), { method, headers: { range, origin: ORIGIN } });
  let r = await get('bytes=0-99');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 0-99/${size}`);
  assert.equal(r.headers.get('content-length'), '100');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(whole.subarray(0, 100)));
  const expose = r.headers.get('access-control-expose-headers').split(',');
  for (const h of ['content-range', 'content-length', 'content-type', 'date', 'accept-ranges']) assert.ok(expose.includes(h), h);
  r = await get(`bytes=${size - 10}-`);
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes ${size - 10}-${size - 1}/${size}`);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(whole.subarray(size - 10)));
  r = await get('bytes=-50');
  assert.equal(r.status, 206);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(whole.subarray(size - 50)));
  r = await get(`bytes=100-${size + 1000}`);
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 100-${size - 1}/${size}`);
  await r.arrayBuffer();
  r = await get(`bytes=${size}-`);
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), `bytes */${size}`);
  await r.text();
  r = await get('bytes=0-9', 'HEAD');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-length'), '10');
  r = await fetch(url('/drive/v3/files/vid_tram', { alt: 'media', ...KEY }), { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-length'), String(size));
});
await check('media: EXIF of img_exif_range is inside the first 64 KiB', async () => {
  const r = await fetch(url('/drive/v3/files/img_exif_range', { alt: 'media', ...KEY }), { headers: { range: 'bytes=0-65535' } });
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 206);
  assert.ok(buf.includes(Buffer.from('2025:07:13 11:30:00')));
  assert.ok(buf.includes(Buffer.from('+03:00')));
});
await check('media: folders / Google Docs / shortcuts → 403 fileNotDownloadable', async () => {
  for (const id of ['folder_day1', 'doc_itinerary', 'sc_img_other']) {
    const { status, json } = await api(`/drive/v3/files/${id}`, { alt: 'media', ...KEY });
    assert.equal(status, 403, id);
    assert.equal(json.error.errors[0].reason, 'fileNotDownloadable');
  }
});

// ---------------------------------------------------------------- CORS
await check('cors: preflight echoes origin / request headers, max-age 3600', async () => {
  const r = await fetch(url('/drive/v3/files', { q: qParents('folder_root') }), {
    method: 'OPTIONS',
    headers: { origin: ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,range,x-goog-drive-resource-keys' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(r.headers.get('access-control-allow-headers'), 'authorization,range,x-goog-drive-resource-keys');
  for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.ok(r.headers.get('access-control-allow-methods').includes(m));
  assert.equal(r.headers.get('access-control-max-age'), '3600');
});
await check('cors: every response header name is exposed', async () => {
  const r = await fetch(url('/drive/v3/files/img_lake', KEY), { headers: { origin: ORIGIN } });
  await r.text();
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  const exposed = new Set(r.headers.get('access-control-expose-headers').split(','));
  const hop = new Set(['connection', 'keep-alive', 'transfer-encoding', 'access-control-expose-headers']);
  for (const [k] of r.headers) if (!hop.has(k)) assert.ok(exposed.has(k), `not exposed: ${k}`);
});

// ---------------------------------------------------------------- thumbnails
await check('thumbs: thumbnailLink serves JPEG (s220 / w-h / unknown)', async () => {
  const meta = (await api('/drive/v3/files/img_helsinki_cathedral', { fields: 'thumbnailLink,hasThumbnail', ...KEY })).json;
  assert.equal(meta.hasThumbnail, true);
  let r = await fetch(meta.thumbnailLink, { headers: { origin: ORIGIN } });
  let buf = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(buf.subarray(0, 3).toString('hex'), 'ffd8ff');
  const small = buf.length;
  r = await fetch(`${driveUrl}/thumb/img_helsinki_cathedral=w800-h600`);
  buf = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200);
  assert.ok(buf.length > small, 'large thumbnail expected');
  for (const id of ['vid_hevc', 'img_arctic_circle_heic', 'img_screenshot']) {
    r = await fetch(`${driveUrl}/thumb/${id}=s220`);
    await r.arrayBuffer();
    assert.equal(r.status, 200, id);
  }
  r = await fetch(`${driveUrl}/thumb/nope=s220`);
  await r.text();
  assert.equal(r.status, 404);
  r = await fetch(`${driveUrl}/thumb/img_hidden_lapland=s220`);
  await r.text();
  assert.equal(r.status, 404, 'hidden items have no thumbnail yet');
});

// ---------------------------------------------------------------- admin
await check('admin: reveal / reveal-all / reset', async () => {
  const list = async () => ids((await listAll({ q: qParents('folder_day2', ' and trashed = false'), fields: 'nextPageToken,files(id)', ...KEY })).files);
  assert.ok(!(await list()).includes('img_hidden_rovaniemi'));
  assert.equal((await api('/drive/v3/files/img_hidden_rovaniemi', KEY)).status, 404);
  assert.equal((await api('/drive/v3/files/img_hidden_rovaniemi', { alt: 'media' }, { headers: BEARER })).status, 404);
  await admin.reveal('img_hidden_rovaniemi');
  assert.ok((await list()).includes('img_hidden_rovaniemi'));
  assert.equal((await api('/drive/v3/files/img_hidden_rovaniemi', { alt: 'media', ...KEY })).status, 200);
  assert.equal((await api('/drive/v3/files/img_hidden_lapland', KEY)).status, 404);
  const all = await admin.revealAll();
  assert.deepEqual(all.ids, ['img_hidden_lapland']);
  assert.equal((await api('/drive/v3/files/img_hidden_lapland', KEY)).status, 200);
  await admin.reset();
  assert.ok(!(await list()).includes('img_hidden_rovaniemi'));
  const raw = await fetch(`${driveUrl}/__admin/reveal?id=nope`, { method: 'POST' });
  assert.equal(raw.status, 404);
  await raw.text();
});
await check('admin: tokens / keys replacement (expiry simulation)', async () => {
  await admin.setTokens(['t2']);
  assert.equal((await api('/drive/v3/files/img_lake', {}, { headers: BEARER })).status, 401);
  assert.equal((await api('/drive/v3/files/img_lake', {}, { headers: { authorization: 'Bearer t2' } })).status, 200);
  await admin.setKeys(['K2']);
  assert.equal((await api('/drive/v3/files/img_lake', KEY)).status, 400);
  assert.equal((await api('/drive/v3/files/img_lake', { key: 'K2' })).status, 200);
  await admin.reset();
  assert.equal((await api('/drive/v3/files/img_lake', {}, { headers: BEARER })).status, 200);
  assert.equal((await api('/drive/v3/files/img_lake', KEY)).status, 200);
});
await check('admin: latency', async () => {
  await admin.setLatency(250);
  const t0 = Date.now();
  await api('/drive/v3/files/img_lake', KEY);
  assert.ok(Date.now() - t0 >= 240, 'latency not applied');
  await admin.setLatency(0);
});
await check('admin: fail injection for media', async () => {
  await admin.fail('img_senate_square', 500, 2);
  const m = () => api('/drive/v3/files/img_senate_square', { alt: 'media', ...KEY });
  const a = await m();
  assert.equal(a.status, 500);
  assert.equal(a.json.error.errors[0].reason, 'backendError');
  assert.equal((await api('/drive/v3/files/img_senate_square', KEY)).status, 200, 'metadata unaffected');
  assert.equal((await m()).status, 500);
  assert.equal((await m()).status, 200);
  await admin.fail('img_lake', 429, 1);
  assert.equal((await api('/drive/v3/files/img_lake', { alt: 'media', ...KEY })).status, 429);
  assert.equal((await api('/drive/v3/files/img_lake', { alt: 'media', ...KEY })).status, 200);
});
await check('admin: trash / delete simulation', async () => {
  await admin.trash('img_lake');
  const l = await listAll({ q: qParents('folder_day3', ' and trashed = false'), fields: 'nextPageToken,files(id)', ...KEY });
  assert.ok(!ids(l.files).includes('img_lake'));
  await admin.remove('vid_long_walk');
  assert.equal((await api('/drive/v3/files/vid_long_walk', KEY)).status, 404);
  await admin.reset();
  assert.equal((await api('/drive/v3/files/vid_long_walk', KEY)).status, 200);
});
await check('admin: request log', async () => {
  await admin.clearLog();
  await api('/drive/v3/files/img_lake', KEY);
  await fetch(url('/drive/v3/files/vid_tram', { alt: 'media', ...KEY }), { headers: { range: 'bytes=0-9' } }).then((r) => r.arrayBuffer());
  await api('/drive/v3/files', { q: qParents('folder_private') }, { headers: BEARER });
  await api('/drive/v3/files/img_lake');
  const log = await admin.log();
  assert.equal(log.length, 4);
  assert.deepEqual(log.map((e) => [e.method, e.path, e.auth, e.status]), [
    ['GET', '/drive/v3/files/img_lake', 'key', 200],
    ['GET', '/drive/v3/files/vid_tram', 'key', 206],
    ['GET', '/drive/v3/files', 'bearer', 200],
    ['GET', '/drive/v3/files/img_lake', 'none', 403],
  ]);
  assert.equal(log[1].range, 'bytes=0-9');
  assert.equal(log[1].query.alt, 'media');
  assert.ok(!Number.isNaN(Date.parse(log[0].ts)));
  const st = await admin.state();
  assert.equal(st.maxPageSize, PAGE);
});

// ---------------------------------------------------------------- static server
await check('static: MIME types, no-store, index.html for directories, traversal', async () => {
  let r = await fetch(`${env.appUrl}/tests/e2e/harness.mjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/javascript/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  await r.text();
  r = await fetch(`${env.appUrl}/tests/e2e/blank.html`);
  assert.match(r.headers.get('content-type'), /^text\/html/);
  await r.text();
  r = await fetch(`${env.appUrl}/%2e%2e/%2e%2e/etc/passwd`);
  assert.ok([403, 404].includes(r.status));
  await r.text();
  r = await fetch(`${env.appUrl}/does-not-exist.js`);
  assert.equal(r.status, 404);
  await r.text();
  const { startStaticServer } = await import('./harness.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>root</title>');
  fs.writeFileSync(path.join(dir, 'sub', 'index.html'), '<!doctype html><title>sub</title>');
  fs.writeFileSync(path.join(dir, 'a.wasm'), Buffer.from([0, 97, 115, 109]));
  const s = await startStaticServer({ root: dir });
  try {
    r = await fetch(`${s.url}/`);
    assert.match(await r.text(), /root/);
    r = await fetch(`${s.url}/sub/?x=1`);
    assert.match(await r.text(), /sub/);
    r = await fetch(`${s.url}/sub`, { redirect: 'manual' });
    assert.equal(r.status, 301);
    r = await fetch(`${s.url}/a.wasm`);
    assert.equal(r.headers.get('content-type'), 'application/wasm');
    await r.arrayBuffer();
  } finally {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await env.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
