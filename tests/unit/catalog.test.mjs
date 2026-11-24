import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, buildSlides, resolveCaptureTime, needsExtraction, extractionPhase, cameraLabel, cameraGroup, summarizeGroups, tripSummary } from '../../js/catalog.js';
import { parseFolderInput, mediaKind, normalizeMimeType, escapeQueryValue } from '../../js/drive.js';
import { sanitize, settingsFromUrl, loadSettings, buildShareUrl, resolveApiBase, DEFAULTS } from '../../js/settings.js';

const TZ = 'Europe/Helsinki';
const iso = (t) => new Date(t).toISOString();

const files = [
  { id: 'a', name: 'IMG_0001.JPG', mimeType: 'image/jpeg', imageMediaMetadata: { time: '2025:07:12 14:00:00', cameraMake: 'Apple', cameraModel: 'iPhone 15' }, modifiedTime: '2025-08-01T00:00:00Z', createdTime: '2025-08-01T00:00:00Z' },
  { id: 'b', name: 'canon.jpg', mimeType: 'image/jpeg', imageMediaMetadata: { time: '2025:07:12 19:30:00', cameraMake: 'Canon', cameraModel: 'Canon EOS R6' }, modifiedTime: '2025-08-01T00:00:00Z', createdTime: '2025-08-01T00:00:00Z' },
  { id: 'c', name: 'VID_20250712_160000.mp4', mimeType: 'video/mp4', videoMediaMetadata: { durationMillis: '3000', width: 640, height: 360 }, modifiedTime: '2025-08-01T00:00:00Z', createdTime: '2025-08-01T00:00:00Z' },
  { id: 'd', name: 'PXL_20250713_063000123.mp4', mimeType: 'video/mp4', modifiedTime: '2025-08-01T00:00:00Z', createdTime: '2025-08-01T00:00:00Z' },
  { id: 'e', name: 'sauna.jpg', mimeType: 'image/jpeg', modifiedTime: '2025-07-13T17:00:00Z', createdTime: '2025-08-02T00:00:00Z' },
  { id: 'f', name: 'noexif.jpg', mimeType: 'image/jpeg', modifiedTime: '2025-08-01T00:00:00Z', createdTime: '2025-08-01T00:00:00Z' },
  { id: 'g', name: 'doc', mimeType: 'application/vnd.google-apps.document' },
];
const extracted = new Map([
  ['c', { kind: 'video', epoch: Date.UTC(2025, 6, 12, 13, 0), source: 'mp4-mvhd' }],
  ['f', { kind: 'image', wall: { y: 2025, mo: 7, d: 13, h: 10, mi: 0, s: 0, ms: 0 }, offsetMinutes: 180 }],
]);

test('resolveCaptureTime follows the priority rules', () => {
  assert.deepEqual(resolveCaptureTime(files[0], null, TZ), { epoch: Date.UTC(2025, 6, 12, 11, 0), source: 'exif' });
  assert.equal(resolveCaptureTime(files[2], extracted.get('c'), TZ).source, 'mp4-mvhd');
  // 動画の解析結果がなければファイル名（現地時刻）
  const vidNoMeta = resolveCaptureTime(files[2], null, TZ);
  assert.equal(vidNoMeta.source, 'filename');
  assert.equal(iso(vidNoMeta.epoch), '2025-07-12T13:00:00.000Z');
  // Pixel のファイル名は UTC
  const px = resolveCaptureTime(files[3], { kind: 'video', epoch: null, source: null }, TZ);
  assert.equal(px.source, 'filename');
  assert.equal(iso(px.epoch), '2025-07-13T06:30:00.123Z');
  // 何もなければ更新日時と作成日時の早い方
  assert.deepEqual(resolveCaptureTime(files[4], null, TZ), { epoch: Date.parse('2025-07-13T17:00:00Z'), source: 'drive-times' });
  // EXIF 直接読み取り（オフセット付き）
  const f = resolveCaptureTime(files[5], extracted.get('f'), TZ);
  assert.equal(f.source, 'exif-offset');
  assert.equal(iso(f.epoch), '2025-07-13T07:00:00.000Z');
  // オフセットなしの直接読み取りは撮影地タイムゾーン
  const f2 = resolveCaptureTime(files[5], { kind: 'image', wall: { y: 2025, mo: 7, d: 13, h: 10, mi: 0, s: 0 }, offsetMinutes: null }, TZ);
  assert.equal(iso(f2.epoch), '2025-07-13T07:00:00.000Z');
});

test('file EXIF (DateTimeOriginal + offset) beats Drive time; DateTime-only does not', () => {
  // Drive は「EXIF DateTime」（編集日時のことがある）を返すかもしれない
  const edited = { id: 'x', name: 'x.jpg', mimeType: 'image/jpeg', imageMediaMetadata: { time: '2025:08:01 10:00:00' } };
  const r1 = resolveCaptureTime(edited, { wall: { y: 2025, mo: 7, d: 12, h: 20, mi: 0, s: 0 }, offsetMinutes: 540, tag: 'original' }, TZ);
  assert.equal(r1.source, 'exif-offset');
  assert.equal(iso(r1.epoch), '2025-07-12T11:00:00.000Z');
  const r2 = resolveCaptureTime(edited, { wall: { y: 2025, mo: 7, d: 12, h: 14, mi: 0, s: 0 }, offsetMinutes: null, tag: 'original' }, TZ);
  assert.equal(r2.source, 'exif');
  assert.equal(iso(r2.epoch), '2025-07-12T11:00:00.000Z');
  const r3 = resolveCaptureTime(edited, { wall: { y: 2025, mo: 9, d: 1, h: 0, mi: 0, s: 0 }, offsetMinutes: null, tag: 'datetime' }, TZ);
  assert.equal(iso(r3.epoch), '2025-08-01T07:00:00.000Z');
});

test('extractionPhase', () => {
  assert.equal(extractionPhase(files[0]), 'refine');
  assert.equal(extractionPhase(files[2]), 'required');
  assert.equal(extractionPhase(files[5]), 'required');
  assert.equal(extractionPhase({ name: 'a.png', mimeType: 'image/png' }), null);
  assert.equal(extractionPhase({ name: 'a.heic', mimeType: 'image/heic', imageMediaMetadata: { time: '2025:07:12 10:00:00' } }), 'refine');
});

test('needsExtraction', () => {
  assert.equal(needsExtraction(files[0]), false);
  assert.equal(needsExtraction(files[2]), true);
  assert.equal(needsExtraction(files[5]), true);
  assert.equal(needsExtraction({ name: 'x.png', mimeType: 'image/png' }), false);
  assert.equal(needsExtraction({ name: 'x.webm', mimeType: 'video/webm' }), false);
  assert.equal(needsExtraction({ name: 'x.mov', mimeType: 'video/quicktime' }), true);
});

test('buildCatalog sorts chronologically, ignores non-media, applies camera offsets', () => {
  const items = buildCatalog(files, extracted, { timeZone: TZ });
  assert.deepEqual(items.map((i) => i.id), ['a', 'c', 'b', 'd', 'f', 'e']);
  assert.equal(items.find((i) => i.id === 'b').group, 'Canon EOS R6');
  assert.equal(items.find((i) => i.id === 'a').group, 'Apple iPhone 15');
  const fixed = buildCatalog(files, extracted, { timeZone: TZ, cameraOffsets: { 'Canon EOS R6': -360 } });
  // Canon: 19:30 → 13:30 Helsinki = 10:30Z、iPhone 11:00Z より前
  assert.deepEqual(fixed.map((i) => i.id), ['b', 'a', 'c', 'd', 'f', 'e']);
  assert.equal(fixed[0].offsetMinutes, -360);
  assert.equal(fixed[0].day, '2025-07-12');
});

test('buildCatalog tie-breaks by name (numeric)', () => {
  const t = '2025:07:12 10:00:00';
  const fs = ['IMG_10.jpg', 'IMG_2.jpg', 'IMG_1.jpg'].map((name, i) => ({ id: `t${i}`, name, mimeType: 'image/jpeg', imageMediaMetadata: { time: t } }));
  assert.deepEqual(buildCatalog(fs, null, { timeZone: TZ }).map((i) => i.name), ['IMG_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg']);
});

test('buildSlides inserts title and day cards with calendar day numbers', () => {
  const items = buildCatalog(files, extracted, { timeZone: TZ });
  const slides = buildSlides(items, { showTitleCard: true, showDayCards: true });
  assert.deepEqual(slides.map((s) => (s.type === 'media' ? s.item.id : s.type === 'day' ? `day${s.dayNumber}` : s.type)), ['title', 'day1', 'a', 'c', 'b', 'day2', 'd', 'f', 'e']);
  assert.equal(buildSlides(items, { showTitleCard: false, showDayCards: false }).length, items.length);
  assert.deepEqual(buildSlides([], {}), []);
  const sum = tripSummary(items);
  assert.equal(sum.dayCount, 2);
  assert.equal(sum.videos, 2);
  assert.equal(sum.photos, 4);
});

test('cameraLabel / cameraGroup / summarizeGroups', () => {
  assert.equal(cameraLabel('Canon', 'Canon EOS R6'), 'Canon EOS R6');
  assert.equal(cameraLabel('Apple', 'iPhone 15'), 'Apple iPhone 15');
  assert.equal(cameraLabel('', 'X100V'), 'X100V');
  assert.equal(cameraLabel('FUJIFILM', ''), 'FUJIFILM');
  assert.equal(cameraLabel(null, undefined), '');
  assert.equal(cameraGroup({}, null, 'video'), '動画（機種不明）');
  assert.equal(cameraGroup({}, { model: 'iPhone 15', make: 'Apple' }, 'video'), 'Apple iPhone 15');
  const g = summarizeGroups(buildCatalog(files, extracted, { timeZone: TZ }));
  assert.ok(g.find((x) => x.group === 'Canon EOS R6'));
});

test('parseFolderInput', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  assert.deepEqual(parseFolderInput(`https://drive.google.com/drive/folders/${id}`), { id, resourceKey: null });
  assert.deepEqual(parseFolderInput(`https://drive.google.com/drive/folders/${id}?usp=sharing`), { id, resourceKey: null });
  assert.deepEqual(parseFolderInput(`https://drive.google.com/drive/u/1/folders/${id}?resourcekey=0-abcDEF`), { id, resourceKey: '0-abcDEF' });
  assert.deepEqual(parseFolderInput(`https://drive.google.com/open?id=${id}`), { id, resourceKey: null });
  assert.deepEqual(parseFolderInput(`  ${id}  `), { id, resourceKey: null });
  assert.deepEqual(parseFolderInput(`${id}?resourcekey=0-x`), { id, resourceKey: '0-x' });
  assert.equal(parseFolderInput('https://example.com/foo'), null);
  assert.equal(parseFolderInput('not an id!'), null);
  assert.equal(parseFolderInput(''), null);
});

test('mediaKind / normalizeMimeType / escapeQueryValue', () => {
  assert.equal(mediaKind('image/heic'), 'image');
  assert.equal(mediaKind('video/quicktime'), 'video');
  assert.equal(mediaKind('image/svg+xml'), null);
  assert.equal(mediaKind('application/octet-stream', 'IMG_1.HEIC'), 'image');
  assert.equal(mediaKind('application/pdf', 'x.pdf'), null);
  assert.equal(normalizeMimeType('application/octet-stream', 'a.MOV'), 'video/quicktime');
  assert.equal(normalizeMimeType('image/JPEG', 'a.jpg'), 'image/jpeg');
  assert.equal(escapeQueryValue("Tom's \\ trip"), "Tom\\'s \\\\ trip");
});

test('settings: sanitize, URL params, share URL', () => {
  const s = sanitize({ photoSeconds: '9999', timeZone: 'Bad/Zone', captions: 'x', cameraOffsets: { a: '30', b: 0, c: 'x' } });
  assert.equal(s.photoSeconds, 120);
  assert.equal(s.timeZone, DEFAULTS.timeZone);
  assert.equal(s.captions, 'datetime');
  assert.deepEqual(s.cameraOffsets, { a: 30 });
  const u = settingsFromUrl('?folder=abc&key=KEY1&interval=3');
  assert.deepEqual(u, { folder: 'abc', apiKey: 'KEY1', photoSeconds: '3', authMode: 'apikey' });
  global.localStorage = { getItem: () => JSON.stringify({ folder: 'stored', photoSeconds: 4 }), setItem() {}, removeItem() {} };
  const loaded = loadSettings({ clientId: 'cid', folder: 'deploy' }, '?interval=7');
  assert.equal(loaded.folder, 'stored');
  assert.equal(loaded.photoSeconds, 7);
  assert.equal(loaded.clientId, 'cid');
  delete global.localStorage;
  const share = new URL(buildShareUrl('https://x.github.io/slideshow/?old=1#h', { ...DEFAULTS, folder: 'F', authMode: 'apikey', apiKey: 'K' }));
  assert.equal(share.searchParams.get('folder'), 'F');
  assert.equal(share.searchParams.get('key'), 'K');
  assert.equal(share.searchParams.get('old'), null);
});

test('resolveApiBase only allows overrides on localhost', () => {
  assert.equal(resolveApiBase({ hostname: 'x.github.io', search: '?apiBase=http://127.0.0.1:9' }), 'https://www.googleapis.com');
  assert.equal(resolveApiBase({ hostname: '127.0.0.1', search: '?apiBase=http://127.0.0.1:8787/' }), 'http://127.0.0.1:8787');
  assert.equal(resolveApiBase({ hostname: 'localhost', search: '?apiBase=https://evil.example.com' }), 'https://www.googleapis.com');
  assert.equal(resolveApiBase({ hostname: 'localhost', search: '' }), 'https://www.googleapis.com');
});
