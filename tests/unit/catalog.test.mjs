import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCatalog,
  buildSlides,
  resolveCaptureTime,
  needsExtraction,
  extractionPhase,
  cameraLabel,
  cameraGroup,
  correctionGroup,
  hasExplicitOffset,
  summarizeGroups,
  tripSummary,
  mainDayRange,
  ZONED_GROUP_SUFFIX,
  MVHD_VIDEO_GROUP_SUFFIX,
  offsetMatchesZone,
  UNKNOWN_PHOTO_GROUP,
  UNKNOWN_VIDEO_GROUP,
  legacyCameraGroup,
  migrateLegacyOffsets,
} from '../../js/catalog.js';
import { parseFolderInput, mediaKind, normalizeMimeType, escapeQueryValue } from '../../js/drive.js';
import { sanitize, settingsFromUrl, loadSettings, buildShareUrl, resolveApiBase, DEFAULTS, offsetsForFolder, legacyOffsetsForFolder } from '../../js/settings.js';

// 撮影地: UTC+2、夏時間は UTC+3
const TZ = 'Europe/Athens';
const iso = (t) => new Date(t).toISOString();

const files = [
  { id: 'a', name: 'IMG_0001.JPG', mimeType: 'image/jpeg', imageMediaMetadata: { time: '2025:07:12 14:00:00', cameraMake: 'Apple', cameraModel: 'iPhone 15' }, modifiedTime: '2025-08-01T00:00:00Z', createdTime: '2025-08-01T00:00:00Z' },
  { id: 'b', name: 'canon.jpg', mimeType: 'image/jpeg', imageMediaMetadata: { time: '2025:07:12 19:30:00', cameraMake: 'Canon', cameraModel: 'Canon EOS R6' }, modifiedTime: '2025-08-01T00:00:00Z', createdTime: '2025-08-01T00:00:00Z' },
  { id: 'c', name: 'VID_20250712_160000.mp4', mimeType: 'video/mp4', videoMediaMetadata: { durationMillis: '3000', width: 640, height: 360 }, modifiedTime: '2025-08-01T00:00:00Z', createdTime: '2025-08-01T00:00:00Z' },
  { id: 'd', name: 'PXL_20250713_063000123.mp4', mimeType: 'video/mp4', modifiedTime: '2025-08-01T00:00:00Z', createdTime: '2025-08-01T00:00:00Z' },
  { id: 'e', name: 'cabin.jpg', mimeType: 'image/jpeg', modifiedTime: '2025-07-13T17:00:00Z', createdTime: '2025-08-02T00:00:00Z' },
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
  // Canon: 19:30 → 現地 13:30（UTC+3）= 10:30Z、iPhone 11:00Z より前
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

test('correctionGroup: times with an explicit UTC offset get their own group', () => {
  const sony = { id: 's', name: 'DSC01234.JPG', mimeType: 'image/jpeg', imageMediaMetadata: { time: '2025:07:13 19:05:00', cameraMake: 'SONY', cameraModel: 'ILCE-7M4' } };
  assert.equal(ZONED_GROUP_SUFFIX, '（タイムゾーン記録あり）');
  // Drive の時刻（現地時刻として解釈）→ カメラ名のまま
  assert.equal(correctionGroup(sony, null, 'image', 'exif'), 'SONY ILCE-7M4');
  // EXIF のオフセット付き → 別グループ
  assert.equal(correctionGroup(sony, null, 'image', 'exif-offset'), 'SONY ILCE-7M4（タイムゾーン記録あり）');
  // カメラ不明の写真・動画は「機種不明」が基本
  assert.equal(correctionGroup({ name: 'x.jpg' }, null, 'image', 'exif-offset'), `${UNKNOWN_PHOTO_GROUP}${ZONED_GROUP_SUFFIX}`);
  // 動画: 時差付きの Apple / ©day は別、mvhd は同じグループ
  const mov = { name: 'clip.mov' };
  assert.equal(correctionGroup(mov, { make: 'Apple', model: 'iPhone 15', offsetMinutes: 180 }, 'video', 'mp4-apple'), 'Apple iPhone 15（タイムゾーン記録あり）');
  assert.equal(correctionGroup(mov, { offsetMinutes: -300 }, 'video', 'mp4-day'), `${UNKNOWN_VIDEO_GROUP}${ZONED_GROUP_SUFFIX}`);
  assert.equal(correctionGroup(mov, { offsetMinutes: null }, 'video', 'mp4-day'), UNKNOWN_VIDEO_GROUP);
  assert.equal(correctionGroup(mov, { offsetMinutes: null }, 'video', 'mp4-mvhd'), UNKNOWN_VIDEO_GROUP);
  // ファイル名: PXL_ は UTC → 別グループ、それ以外（現地時刻）はそのまま
  assert.equal(hasExplicitOffset({ name: 'PXL_20250714_063000123.jpg' }, null, 'filename'), true);
  assert.equal(hasExplicitOffset({ name: 'IMG_20250714_093000.jpg' }, null, 'filename'), false);
  assert.equal(hasExplicitOffset({ name: 'x.jpg' }, null, 'drive-times'), false);
});

test('buildCatalog: a correction for the local-clock group does not apply after the EXIF offset is read (F0)', () => {
  // Sony の時計が日本時間のまま: Drive の時刻 19:05（撮影地の時刻として読むと 16:05Z、6 時間遅い）
  const sony = { id: 's', name: 'DSC01234.JPG', mimeType: 'image/jpeg', imageMediaMetadata: { time: '2025:07:13 19:05:00', cameraMake: 'SONY', cameraModel: 'ILCE-7M4' } };
  const cameraOffsets = { 'SONY ILCE-7M4': -360 };
  const before = buildCatalog([sony], null, { timeZone: TZ, cameraOffsets });
  assert.equal(before[0].group, 'SONY ILCE-7M4');
  assert.equal(iso(before[0].epoch), '2025-07-13T10:05:00.000Z');
  assert.equal(before[0].offsetMinutes, -360);
  // 精度向上で EXIF（+09:00）を読んだ後も同じ正しい時刻（補正は二重にかからない）
  const ex = new Map([['s', { kind: 'image', wall: { y: 2025, mo: 7, d: 13, h: 19, mi: 5, s: 0, ms: 0 }, offsetMinutes: 540, tag: 'original', make: 'SONY', model: 'ILCE-7M4' }]]);
  const after = buildCatalog([sony], ex, { timeZone: TZ, cameraOffsets });
  assert.equal(after[0].timeSource, 'exif-offset');
  assert.equal(after[0].group, 'SONY ILCE-7M4（タイムゾーン記録あり）');
  assert.equal(after[0].offsetMinutes, 0);
  assert.equal(iso(after[0].epoch), '2025-07-13T10:05:00.000Z');
  // オフセット付きのグループにも個別に補正できる
  const both = buildCatalog([sony], ex, { timeZone: TZ, cameraOffsets: { 'SONY ILCE-7M4（タイムゾーン記録あり）': 30 } });
  assert.equal(iso(both[0].epoch), '2025-07-13T10:35:00.000Z');
  // DateTime だけ（Drive の時刻なし）でもオフセットがあれば exif-offset
  const noDrive = { id: 'n', name: 'n.jpg', mimeType: 'image/jpeg' };
  const r = resolveCaptureTime(noDrive, { wall: { y: 2025, mo: 7, d: 13, h: 19, mi: 5, s: 0 }, offsetMinutes: 540, tag: 'datetime' }, TZ);
  assert.equal(r.source, 'exif-offset');
  assert.equal(iso(r.epoch), '2025-07-13T10:05:00.000Z');
  // cameraOffsets が null / 継承プロパティ名のグループでも落ちない
  assert.equal(buildCatalog([sony], null, { timeZone: TZ, cameraOffsets: null })[0].offsetMinutes, 0);
  const proto = { ...sony, imageMediaMetadata: { time: '2025:07:13 19:05:00', cameraModel: 'constructor' } };
  assert.equal(buildCatalog([proto], null, { timeZone: TZ, cameraOffsets: {} })[0].offsetMinutes, 0);
});

test('cameraGroup: videos without a camera label are grouped by file name (F2)', () => {
  const g = (name) => cameraGroup({ name }, null, 'video');
  assert.equal(g('GX010123.MP4'), 'GoPro（ファイル名から推定）');
  assert.equal(g('GH011234.MP4'), 'GoPro（ファイル名から推定）');
  assert.equal(g('GOPR0042.MP4'), 'GoPro（ファイル名から推定）');
  assert.equal(g('MVI_0042.MP4'), 'Canon（ファイル名から推定）');
  assert.equal(g('DJI_0001.MP4'), 'DJI（ファイル名から推定）');
  assert.equal(g('DJI_20250713123456_0001_D.MP4'), 'DJI（ファイル名から推定）');
  assert.equal(g('PXL_20250714_063000123.mp4'), 'スマートフォン動画（ファイル名から推定）');
  assert.equal(g('VID_20250712_183000.mp4'), 'スマートフォン動画（ファイル名から推定）');
  assert.equal(g('IMG_4321.MOV'), 'スマートフォン動画（ファイル名から推定）');
  assert.equal(g('harbour_ferry.mp4'), UNKNOWN_VIDEO_GROUP);
  assert.equal(g('GX01.mp4'), UNKNOWN_VIDEO_GROUP);
  // 機種名が読めればそちらが優先、写真はファイル名で分けない
  assert.equal(cameraGroup({ name: 'PXL_20250714_063000123.mp4' }, { make: 'Google', model: 'Pixel 8' }, 'video'), 'Google Pixel 8');
  assert.equal(cameraGroup({ name: 'MVI_0042.MP4' }, { model: 'Canon EOS R6' }, 'video'), 'Canon EOS R6');
  assert.equal(cameraGroup({ name: 'GOPR0042.JPG' }, null, 'image'), UNKNOWN_PHOTO_GROUP);
  // Pixel の動画（ファイル名 = UTC）は、メタデータがなければ別グループ
  const items = buildCatalog(
    [
      { id: 'p', name: 'PXL_20250714_063000123.mp4', mimeType: 'video/mp4' },
      { id: 'g', name: 'GX010123.MP4', mimeType: 'video/mp4' },
      { id: 'c', name: 'MVI_0042.MP4', mimeType: 'video/mp4' },
    ],
    new Map([
      ['g', { kind: 'video', epoch: Date.UTC(2025, 6, 14, 12), source: 'mp4-mvhd', offsetMinutes: null }],
      ['c', { kind: 'video', epoch: Date.UTC(2025, 6, 14, 20), source: 'mp4-mvhd', offsetMinutes: null, model: 'Canon EOS R6' }],
    ]),
    { timeZone: TZ },
  );
  assert.deepEqual(
    Object.fromEntries(items.map((i) => [i.id, i.group])),
    { p: 'スマートフォン動画（ファイル名から推定）（タイムゾーン記録あり）', g: 'GoPro（ファイル名から推定）', c: 'Canon EOS R6（動画）' },
  );
});

test('correctionGroup: a labelled video timed by mvhd gets its own （動画） group, corrected apart from the photos (F2)', () => {
  // Canon の時計は正しい（撮影地の時刻）。写真は現地時刻、動画の mvhd にも現地時刻（UTC として読むと 3 時間遅い）
  const fs = [
    { id: 'photo', name: 'IMG_0001.JPG', mimeType: 'image/jpeg', imageMediaMetadata: { time: '2025:07:13 15:00:00', cameraMake: 'Canon', cameraModel: 'Canon EOS R6' } },
    { id: 'video', name: 'MVI_0002.MP4', mimeType: 'video/mp4' },
  ];
  const ex = new Map([['video', { kind: 'video', epoch: Date.UTC(2025, 6, 13, 15, 1), source: 'mp4-mvhd', offsetMinutes: null, make: 'Canon', model: 'Canon EOS R6' }]]);
  assert.equal(MVHD_VIDEO_GROUP_SUFFIX, '（動画）');
  const at = (offs) => Object.fromEntries(buildCatalog(fs, ex, { timeZone: TZ, cameraOffsets: offs }).map((i) => [i.id, `${i.group} ${iso(i.epoch)}`]));
  assert.deepEqual(at({}), { photo: 'Canon EOS R6 2025-07-13T12:00:00.000Z', video: 'Canon EOS R6（動画） 2025-07-13T15:01:00.000Z' });
  // 動画だけを -3 時間: 写真はそのまま
  assert.deepEqual(at({ 'Canon EOS R6（動画）': -180 }), { photo: 'Canon EOS R6 2025-07-13T12:00:00.000Z', video: 'Canon EOS R6（動画） 2025-07-13T12:01:00.000Z' });
  // 写真の補正は動画に影響しない
  assert.equal(at({ 'Canon EOS R6': -60 }).video, 'Canon EOS R6（動画） 2025-07-13T15:01:00.000Z');
  // Apple の creationdate（時差付き）や機種不明の mvhd には付けない
  assert.equal(correctionGroup({ name: 'x.mov' }, { make: 'Apple', model: 'iPhone 15', offsetMinutes: 540 }, 'video', 'mp4-apple', { epoch: Date.UTC(2025, 6, 13), timeZone: TZ }), 'Apple iPhone 15（タイムゾーン記録あり）');
  assert.equal(correctionGroup({ name: 'clip.mp4' }, { offsetMinutes: null }, 'video', 'mp4-mvhd'), UNKNOWN_VIDEO_GROUP);
});

test('correctionGroup: a recorded offset equal to the trip zone keeps the plain group, so clock-drift corrections survive refine', () => {
  // Sony のタイムゾーン設定は正しい（+03:00）が時計が 7 分進んでいる。Drive の時刻 15:07（本当は 12:00Z）
  const sony = { id: 's', name: 'DSC00042.JPG', mimeType: 'image/jpeg', imageMediaMetadata: { time: '2025:07:13 15:07:00', cameraMake: 'SONY', cameraModel: 'ILCE-7M4' } };
  const cameraOffsets = { 'SONY ILCE-7M4': -7 };
  const before = buildCatalog([sony], null, { timeZone: TZ, cameraOffsets })[0];
  assert.equal(before.group, 'SONY ILCE-7M4');
  assert.equal(iso(before.epoch), '2025-07-13T12:00:00.000Z');
  // 精度向上（または preciseTimes をオンにした後）で EXIF の +03:00 を読んでも、同じグループ・同じ補正のまま
  const ex = new Map([['s', { kind: 'image', wall: { y: 2025, mo: 7, d: 13, h: 15, mi: 7, s: 0, ms: 0 }, offsetMinutes: 180, tag: 'original', make: 'SONY', model: 'ILCE-7M4' }]]);
  const after = buildCatalog([sony], ex, { timeZone: TZ, cameraOffsets })[0];
  assert.equal(after.timeSource, 'exif-offset');
  assert.equal(after.group, 'SONY ILCE-7M4');
  assert.equal(after.offsetMinutes, -7);
  assert.equal(iso(after.epoch), '2025-07-13T12:00:00.000Z');
  // 冬時間（+02:00）の日付でも、その時点のオフセットと比べる
  assert.equal(offsetMatchesZone({ offsetMinutes: 120 }, Date.UTC(2025, 0, 10, 12), TZ), true);
  assert.equal(offsetMatchesZone({ offsetMinutes: 180 }, Date.UTC(2025, 0, 10, 12), TZ), false);
  assert.equal(offsetMatchesZone({ offsetMinutes: null }, Date.UTC(2025, 0, 10, 12), TZ), false);
  assert.equal(offsetMatchesZone({ offsetMinutes: 180 }, Date.UTC(2025, 6, 10, 12), 'Not/AZone'), false);
  // 撮影地と同じオフセットの Apple 動画は機種のグループ、UTC のファイル名（PXL_）は別グループのまま
  const at = { epoch: Date.UTC(2025, 6, 13, 9), timeZone: TZ };
  assert.equal(correctionGroup({ name: 'x.mov' }, { make: 'Apple', model: 'iPhone 15', offsetMinutes: 180 }, 'video', 'mp4-apple', at), 'Apple iPhone 15');
  assert.equal(correctionGroup({ name: 'PXL_20250713_090000000.mp4' }, null, 'video', 'filename', at), `スマートフォン動画（ファイル名から推定）${ZONED_GROUP_SUFFIX}`);
});

test('buildSlides / tripSummary: an outlying date does not set day 1 (F4)', () => {
  const at = (id, isoTime, kind = 'image') => ({ id, name: `${id}.jpg`, mimeType: kind === 'image' ? 'image/jpeg' : 'video/mp4', modifiedTime: isoTime, createdTime: isoTime });
  const fs = [
    at('reset', '2000-01-01T10:00:00Z'), // 時計未設定のカメラ
    at('d1a', '2025-07-12T09:00:00Z'),
    at('d1b', '2025-07-12T12:00:00Z'),
    at('d2', '2025-07-13T09:00:00Z'),
    at('d4', '2025-07-15T09:00:00Z', 'video'),
  ];
  const items = buildCatalog(fs, null, { timeZone: TZ });
  assert.deepEqual(items.map((i) => i.id), ['reset', 'd1a', 'd1b', 'd2', 'd4']);
  const range = mainDayRange(items);
  assert.deepEqual(range, { firstDay: '2025-07-12', lastDay: '2025-07-15', count: 4 });
  const slides = buildSlides(items, { showTitleCard: true, showDayCards: true });
  assert.deepEqual(
    slides.map((s) => (s.type === 'media' ? s.item.id : s.type === 'day' ? `day:${s.day}:${s.dayNumber}` : s.type)),
    ['title', 'day:2000-01-01:null', 'reset', 'day:2025-07-12:1', 'd1a', 'd1b', 'day:2025-07-13:2', 'd2', 'day:2025-07-15:4', 'd4'],
  );
  // 日付カードの形は変わらない（dayIndex は全体での順番）
  const day1 = slides.find((s) => s.type === 'day' && s.day === '2025-07-12');
  assert.deepEqual(day1, { key: 'day:2025-07-12', type: 'day', day: '2025-07-12', dayIndex: 1, dayNumber: 1, count: 2 });
  const sum = tripSummary(items);
  assert.equal(sum.firstDay, '2025-07-12');
  assert.equal(sum.lastDay, '2025-07-15');
  assert.equal(iso(sum.first), '2025-07-12T09:00:00.000Z');
  assert.equal(iso(sum.last), '2025-07-15T09:00:00.000Z');
  assert.equal(sum.dayCount, 3);
  assert.deepEqual(sum.main, { first: sum.first, last: sum.last, firstDay: sum.firstDay, lastDay: sum.lastDay, dayCount: 3 });
  assert.equal(sum.all.firstDay, '2000-01-01');
  assert.equal(sum.all.dayCount, 4);
  assert.equal(sum.outliers, 1);
  assert.equal(sum.photos, 4);
  assert.equal(sum.videos, 1);
  // 後ろに離れた日（何年も後にアップロードした日時推定のファイル）も期間外
  const late = buildCatalog([...fs.slice(1), at('late', '2027-03-01T09:00:00Z')], null, { timeZone: TZ });
  const lateSlides = buildSlides(late, {});
  assert.equal(lateSlides.find((s) => s.type === 'day' && s.day === '2027-03-01').dayNumber, null);
  assert.equal(tripSummary(late).lastDay, '2025-07-15');
  // 30 日以内の空きは同じまとまり（暦日で数える）
  const near = buildCatalog([at('a', '2025-07-01T09:00:00Z'), at('b', '2025-07-31T09:00:00Z')], null, { timeZone: TZ });
  assert.deepEqual(buildSlides(near, {}).filter((s) => s.type === 'day').map((s) => s.dayNumber), [1, 31]);
  // 件数が同じなら早い方が主な期間
  const two = buildCatalog([at('x', '2024-01-01T09:00:00Z'), at('y', '2025-01-01T09:00:00Z')], null, { timeZone: TZ });
  assert.deepEqual(buildSlides(two, {}).filter((s) => s.type === 'day').map((s) => s.dayNumber), [1, null]);
  assert.equal(tripSummary([]), null);
  assert.equal(mainDayRange([]), null);
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
  const s = sanitize({ photoSeconds: '9999', timeZone: 'Bad/Zone', captions: 'x', cameraOffsets: { F1: { a: '30', b: 0, c: 'x' } } });
  assert.equal(s.photoSeconds, 120);
  assert.equal(s.timeZone, DEFAULTS.timeZone);
  assert.equal(s.captions, 'datetime');
  assert.deepEqual(s.cameraOffsets, { F1: { a: 30 } });
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
  // 既定のタイムゾーン（この端末のもの）でも必ず付ける。開く人の端末のタイムゾーンは違うかもしれない
  assert.equal(share.searchParams.get('tz'), DEFAULTS.timeZone);
  assert.equal(new URL(buildShareUrl('https://x.github.io/slideshow/', { ...DEFAULTS, folder: 'F', timeZone: 'Asia/Tokyo' })).searchParams.get('tz'), 'Asia/Tokyo');
});

test('resolveApiBase only allows overrides on localhost', () => {
  assert.equal(resolveApiBase({ hostname: 'x.github.io', search: '?apiBase=http://127.0.0.1:9' }), 'https://www.googleapis.com');
  assert.equal(resolveApiBase({ hostname: '127.0.0.1', search: '?apiBase=http://127.0.0.1:8787/' }), 'http://127.0.0.1:8787');
  assert.equal(resolveApiBase({ hostname: 'localhost', search: '?apiBase=https://evil.example.com' }), 'https://www.googleapis.com');
  assert.equal(resolveApiBase({ hostname: 'localhost', search: '' }), 'https://www.googleapis.com');
});

test('legacy corrections (saved by the previous version) keep applying to the same files after the groups changed', () => {
  const F = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  // the previous version saved { group: minutes } with the folder; its video groups were the label read from the
  // Apple mdta / ©mak / ©mod keys, else 動画（機種不明） (Canon CMT1 / Android keys and file names were not used)
  global.localStorage = {
    getItem: () => JSON.stringify({ folder: F, cameraOffsets: { '動画（機種不明）': -180, 'Canon EOS R6': -60, 'Apple iPhone 15': 30 } }),
    setItem() {},
    removeItem() {},
  };
  let s;
  try {
    s = loadSettings({}, '');
  } finally {
    delete global.localStorage;
  }
  const files = [
    { id: 'canon', name: 'MVI_0042.MP4', mimeType: 'video/mp4' },
    { id: 'gopro', name: 'GX010123.MP4', mimeType: 'video/mp4' },
    { id: 'pixel', name: 'clip.mp4', mimeType: 'video/mp4' },
    { id: 'plain', name: 'clip2.mp4', mimeType: 'video/mp4' },
    { id: 'iphone', name: 'IMG_0001.MOV', mimeType: 'video/quicktime' },
    { id: 'iphone_z', name: 'IMG_0002.MOV', mimeType: 'video/quicktime' },
    { id: 'photo', name: 'IMG_0003.JPG', mimeType: 'image/jpeg', imageMediaMetadata: { time: '2025:07:13 15:00:00', cameraMake: 'Canon', cameraModel: 'Canon EOS R6' } },
  ];
  const t = Date.UTC(2025, 6, 13, 15);
  const ex = new Map([
    ['canon', { kind: 'video', epoch: t, source: 'mp4-mvhd', offsetMinutes: null, make: 'Canon', model: 'Canon EOS R6', legacyLabel: false }],
    ['gopro', { kind: 'video', epoch: t, source: 'mp4-mvhd', offsetMinutes: null }],
    ['pixel', { kind: 'video', epoch: t, source: 'mp4-mvhd', offsetMinutes: null, make: 'Google', model: 'Pixel 8', legacyLabel: false }],
    ['plain', { kind: 'video', epoch: t, source: 'mp4-mvhd', offsetMinutes: null }],
    // mvhd only (no creationdate): read with the Apple keys before too
    ['iphone', { kind: 'video', epoch: t, source: 'mp4-mvhd', offsetMinutes: null, make: 'Apple', model: 'iPhone 15', legacyLabel: true }],
    // recorded with another UTC offset: never gets a local-time correction
    ['iphone_z', { kind: 'video', epoch: t, source: 'mp4-apple', offsetMinutes: 540, make: 'Apple', model: 'iPhone 15', legacyLabel: true }],
  ]);
  assert.equal(legacyCameraGroup(files[0], ex.get('canon'), 'video'), UNKNOWN_VIDEO_GROUP);
  assert.equal(legacyCameraGroup(files[4], ex.get('iphone'), 'video'), 'Apple iPhone 15');
  assert.equal(legacyCameraGroup(files[6], null, 'image'), 'Canon EOS R6');
  // results cached before legacyLabel existed: only Apple labels count as read before
  assert.equal(legacyCameraGroup(files[0], { make: 'Canon', model: 'Canon EOS R6' }, 'video'), UNKNOWN_VIDEO_GROUP);
  assert.equal(legacyCameraGroup(files[4], { make: 'Apple', model: 'iPhone 15' }, 'video'), 'Apple iPhone 15');

  const own = offsetsForFolder(s, F);
  const legacy = legacyOffsetsForFolder(s, F);
  assert.deepEqual(legacy, { '動画（機種不明）': -180, 'Canon EOS R6': -60, 'Apple iPhone 15': 30 });
  const add = migrateLegacyOffsets(files, ex, { timeZone: TZ, cameraOffsets: own, legacyOffsets: legacy });
  assert.deepEqual(add, {
    'Canon EOS R6（動画）': -180,
    'GoPro（ファイル名から推定）': -180,
    'Google Pixel 8（動画）': -180,
    'Apple iPhone 15（動画）': 30,
  });
  const items = buildCatalog(files, ex, { timeZone: TZ, cameraOffsets: { ...add, ...own } });
  const off = Object.fromEntries(items.map((i) => [i.id, i.offsetMinutes]));
  assert.deepEqual(off, { canon: -180, gopro: -180, pixel: -180, plain: -180, iphone: 30, iphone_z: 0, photo: -60 }, 'the same offsets as the previous version');
  // nothing to move when every group already has its own correction
  assert.deepEqual(migrateLegacyOffsets(files, ex, { timeZone: TZ, cameraOffsets: { ...add, ...own }, legacyOffsets: legacy }), {});
  assert.deepEqual(migrateLegacyOffsets(files, ex, { timeZone: TZ, cameraOffsets: own, legacyOffsets: {} }), {});
});
