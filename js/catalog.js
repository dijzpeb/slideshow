// Drive のファイル情報と解析結果から、撮影日時順のスライド項目を作る（DOM 非依存）

import {
  tzOffsetMs,
  wallClockToEpoch,
  wallClockWithOffsetToEpoch,
  parseExifDateTime,
  parseFilenameTime,
  parseRfc3339,
  dayKey,
  daysBetween,
} from './timeutil.js';
import { mediaKind, normalizeMimeType } from './drive.js';

/** 撮影日時の取得元（表示用ラベル） */
export const TIME_SOURCE_LABELS = {
  exif: '写真の撮影日時（EXIF）',
  'exif-offset': '写真の撮影日時（EXIF・時差情報あり）',
  'mp4-apple': '動画の撮影日時（Apple メタデータ）',
  'mp4-day': '動画の撮影日時（メタデータ）',
  'mp4-mvhd': '動画の作成日時（MP4）',
  filename: 'ファイル名の日時',
  'drive-times': 'ドライブ上の日時（推定）',
};

/** 動画のメタデータ解析が可能な MIME タイプ（ISO BMFF 系） */
export function isIsoBmffVideo(mimeType) {
  return /^video\/(mp4|quicktime|x-m4v|3gpp|3gpp2|mp4v-es|x-mp4)$/i.test(mimeType || '');
}

/** EXIF を自前で読める画像 */
export function canReadExif(mimeType) {
  return /^image\/(jpeg|jpg|pjpeg|heic|heif|avif)$/i.test(mimeType || '');
}

/**
 * このファイルのバイナリ解析が必要か。
 *  - 'required': 解析しないと撮影日時が分からない（動画、Drive に撮影日時がない写真）
 *  - 'refine'  : Drive の撮影日時はあるが、ファイルの EXIF（撮影時刻のタイムゾーン情報など）でより正確にできる
 *  - null      : 解析できない／不要
 */
export function extractionPhase(file) {
  const mt = normalizeMimeType(file.mimeType, file.name);
  const kind = mediaKind(mt, file.name);
  if (kind === 'video') return isIsoBmffVideo(mt) ? 'required' : null;
  if (kind === 'image') {
    if (!canReadExif(mt)) return null;
    const t = file.imageMediaMetadata && parseExifDateTime(file.imageMediaMetadata.time);
    return t ? 'refine' : 'required';
  }
  return null;
}

/** 撮影日時を決めるのにバイナリ解析が必須か */
export function needsExtraction(file) {
  return extractionPhase(file) === 'required';
}

/** 解析結果キャッシュ用の署名（内容が変われば変わる値） */
export function fileSignature(file) {
  return file.md5Checksum || `${file.size || ''}:${file.modifiedTime || ''}`;
}

function cleanStr(s) {
  return typeof s === 'string' ? s.replace(/\u0000/g, '').trim() : '';
}

/** "Canon" + "Canon EOS R6" → "Canon EOS R6"、"Apple" + "iPhone 15" → "Apple iPhone 15" */
export function cameraLabel(make, model) {
  const mk = cleanStr(make);
  const md = cleanStr(model);
  if (!mk && !md) return '';
  if (!mk) return md;
  if (!md) return mk;
  const firstWord = mk.split(/\s+/)[0].toLowerCase();
  if (md.toLowerCase().startsWith(firstWord)) return md;
  return `${mk} ${md}`;
}

export const UNKNOWN_PHOTO_GROUP = '写真（機種不明）';
export const UNKNOWN_VIDEO_GROUP = '動画（機種不明）';
/** 撮影日時が（撮影地のタイムゾーンと違う）UTC オフセット付きで記録されていたファイルのグループ名に付ける接尾辞 */
export const ZONED_GROUP_SUFFIX = '（タイムゾーン記録あり）';
/**
 * 機種名の分かる動画のうち、日時を MP4 の作成日時（mvhd、UTC として読む）から取ったもののグループ名に付ける接尾辞。
 * 多くのカメラは mvhd に現地時刻を書くため、現地時刻として読む写真とは必要な補正が違う
 */
export const MVHD_VIDEO_GROUP_SUFFIX = '（動画）';

// 機種名が読めない動画をファイル名の付け方で分ける
const VIDEO_NAME_GROUPS = [
  [/^(?:GOPR\d{4}|G[HXP]\d{6})(?!\d)/i, 'GoPro（ファイル名から推定）'],
  [/^MVI_\d/i, 'Canon（ファイル名から推定）'],
  [/^DJI_\d/i, 'DJI（ファイル名から推定）'],
  [/^(?:PXL|VID|IMG)_/i, 'スマートフォン動画（ファイル名から推定）'],
];

/** Drive またはファイルのメタデータから読んだ機種名（なければ ''） */
function deviceLabel(file, extracted) {
  const im = file.imageMediaMetadata || {};
  const label = cameraLabel(im.cameraMake, im.cameraModel);
  if (label || !extracted) return label;
  return cameraLabel(extracted.make, extracted.model);
}

/** カメラ（機種）のグループ名。機種が分からなければファイル名から推定、それも無理なら「機種不明」 */
export function cameraGroup(file, extracted, kind) {
  const label = deviceLabel(file, extracted);
  if (label) return label;
  if (kind === 'video') {
    const name = typeof file.name === 'string' ? file.name.trim() : '';
    for (const [re, group] of VIDEO_NAME_GROUPS) if (re.test(name)) return group;
    return UNKNOWN_VIDEO_GROUP;
  }
  return UNKNOWN_PHOTO_GROUP;
}

/**
 * resolveCaptureTime の結果が UTC オフセット付きの時刻か（カメラの時計の時差設定に左右されない）。
 * EXIF の OffsetTime*、Apple の creationdate / ©day の時差、Pixel のファイル名（UTC）が該当。
 */
export function hasExplicitOffset(file, extracted, source) {
  if (source === 'exif-offset') return true;
  if (source === 'mp4-apple' || source === 'mp4-day') return Number.isFinite(extracted?.offsetMinutes);
  if (source === 'filename') return !!parseFilenameTime(file.name)?.utc;
  return false;
}

/**
 * 記録されていた UTC オフセットが、その時刻の撮影地（timeZone）のオフセットと同じか。
 * 同じなら現地時刻として読んでも同じ時刻になる（あとから EXIF を読んでも時刻の基準が変わらない）
 */
export function offsetMatchesZone(extracted, epoch, timeZone) {
  const off = extracted && extracted.offsetMinutes;
  if (!Number.isFinite(off) || !Number.isFinite(epoch) || !timeZone) return false;
  try {
    return Math.round(tzOffsetMs(epoch, timeZone) / 60000) === off;
  } catch {
    return false;
  }
}

/**
 * カメラ別時刻補正のグループ名。
 *  - 撮影地と違う UTC オフセット付きの時刻は「<機種>（タイムゾーン記録あり）」にして、現地時刻として読んだ時刻向けの
 *    補正が（あとから EXIF を読んだときなどに）二重にかからないようにする。オフセットが撮影地と同じなら
 *    どちらで読んでも同じ時刻なので分けない（時計のずれの補正がそのまま効く）
 *  - 機種名の分かる動画で mvhd（UTC として読む）の時刻は「<機種>（動画）」にして、写真とは別に補正できるようにする
 * @param {{epoch?:number, timeZone?:string}} [at]  resolveCaptureTime の時刻と撮影地のタイムゾーン
 */
export function correctionGroup(file, extracted, kind, source, { epoch, timeZone } = {}) {
  const base = cameraGroup(file, extracted, kind);
  if (hasExplicitOffset(file, extracted, source)) {
    if (source !== 'filename' && offsetMatchesZone(extracted, epoch, timeZone)) return base;
    return `${base}${ZONED_GROUP_SUFFIX}`;
  }
  if (kind === 'video' && source === 'mp4-mvhd' && deviceLabel(file, extracted)) return `${base}${MVHD_VIDEO_GROUP_SUFFIX}`;
  return base;
}

/**
 * 1ファイルの撮影日時（epoch ms）と取得元を決める。
 * 優先順位:
 *  1. 画像: ファイルから直接読んだ EXIF の DateTimeOriginal（OffsetTimeOriginal があればそれで、なければ timeZone で解釈）
 *  2. 画像: Drive の imageMediaMetadata.time（撮影地の現地時刻として timeZone で解釈）
 *  3. 動画: MP4/MOV のメタデータ（Apple creationdate → ©day → mvhd(UTC)）
 *  4. ファイル名の日時（Pixel の PXL_ は UTC、それ以外は現地時刻）
 *  5. ドライブ上の更新日時と作成日時の早い方
 * 撮影地と違うオフセット付きで解釈した時刻（source 'exif-offset'、時差付きの mp4-apple / mp4-day）と
 * PXL_ のファイル名（UTC）は、補正グループが別になる（correctionGroup）。
 */
export function resolveCaptureTime(file, extracted, timeZone) {
  const mt = normalizeMimeType(file.mimeType, file.name);
  const kind = mediaKind(mt, file.name);
  if (kind === 'image') {
    const fromFile = (ex) =>
      ex.offsetMinutes != null ? wallClockWithOffsetToEpoch(ex.wall, ex.offsetMinutes) : wallClockToEpoch(ex.wall, timeZone);
    // ファイルから直接読んだ DateTimeOriginal（タイムゾーン付きならより正確）を最優先
    if (extracted && extracted.wall && extracted.tag !== 'datetime') {
      return { epoch: fromFile(extracted), source: extracted.offsetMinutes != null ? 'exif-offset' : 'exif' };
    }
    const w = file.imageMediaMetadata && parseExifDateTime(file.imageMediaMetadata.time);
    if (w) return { epoch: wallClockToEpoch(w, timeZone), source: 'exif' };
    if (extracted && extracted.wall) {
      return { epoch: fromFile(extracted), source: extracted.offsetMinutes != null ? 'exif-offset' : 'exif' };
    }
  } else if (kind === 'video') {
    if (extracted && Number.isFinite(extracted.epoch) && extracted.source) {
      return { epoch: extracted.epoch, source: extracted.source };
    }
  }
  const fn = parseFilenameTime(file.name);
  if (fn) {
    const epoch = fn.utc
      ? Date.UTC(fn.wall.y, fn.wall.mo - 1, fn.wall.d, fn.wall.h, fn.wall.mi, fn.wall.s, fn.wall.ms || 0)
      : wallClockToEpoch(fn.wall, timeZone);
    return { epoch, source: 'filename' };
  }
  const times = [parseRfc3339(file.modifiedTime), parseRfc3339(file.createdTime)].filter((t) => t != null);
  if (times.length) return { epoch: Math.min(...times), source: 'drive-times' };
  return { epoch: 0, source: 'drive-times' };
}

/**
 * スライド項目を作って撮影日時順に並べる。
 * @param {object[]} files       Drive のファイル情報（folderPath 付き）
 * @param {Map<string,object>|object} extractedById  解析結果
 * @param {{timeZone:string, cameraOffsets?:Record<string,number>}} opts
 *   cameraOffsets は { [補正グループ名]: 分 }（このフォルダ分。settings.offsetsForFolder の戻り値）
 */
export function buildCatalog(files, extractedById, { timeZone, cameraOffsets } = {}) {
  const get = (id) => (extractedById instanceof Map ? extractedById.get(id) : extractedById?.[id]) || null;
  const offsets = cameraOffsets && typeof cameraOffsets === 'object' ? cameraOffsets : {};
  const items = [];
  for (const f of files) {
    const mimeType = normalizeMimeType(f.mimeType, f.name);
    const kind = mediaKind(mimeType, f.name);
    if (!kind) continue;
    const ex = get(f.id);
    const { epoch: rawEpoch, source } = resolveCaptureTime(f, ex, timeZone);
    const group = correctionGroup(f, ex, kind, source, { epoch: rawEpoch, timeZone });
    const offsetMin = (Object.prototype.hasOwnProperty.call(offsets, group) && Math.round(Number(offsets[group]))) || 0;
    const epoch = rawEpoch + offsetMin * 60000;
    const im = f.imageMediaMetadata || {};
    const vm = f.videoMediaMetadata || {};
    items.push({
      id: f.id,
      name: f.name,
      kind,
      mimeType,
      epoch,
      rawEpoch,
      timeSource: source,
      group,
      offsetMinutes: offsetMin,
      width: Number(im.width || vm.width) || 0,
      height: Number(im.height || vm.height) || 0,
      rotation: Number(im.rotation) || 0,
      durationMs: Number(vm.durationMillis) || 0,
      size: Number(f.size) || 0,
      thumbnailLink: f.thumbnailLink || '',
      hasThumbnail: f.hasThumbnail !== false && !!f.thumbnailLink,
      resourceKey: f.resourceKey || '',
      webViewLink: f.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(f.id)}/view`,
      location: im.location && Number.isFinite(im.location.latitude) ? im.location : null,
      folderPath: f.folderPath || [],
      modifiedTime: f.modifiedTime || '',
      day: dayKey(epoch, timeZone),
    });
  }
  items.sort(compareItems);
  return items;
}

export function compareItems(a, b) {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  const n = a.name.localeCompare(b.name, 'ja', { numeric: true, sensitivity: 'base' });
  if (n) return n;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** カメラグループごとの件数（時刻補正 UI 用） */
export function summarizeGroups(items) {
  const m = new Map();
  for (const it of items) {
    const g = m.get(it.group) || { group: it.group, count: 0, photos: 0, videos: 0, first: Infinity, last: -Infinity, offsetMinutes: it.offsetMinutes };
    g.count++;
    if (it.kind === 'video') g.videos++;
    else g.photos++;
    g.first = Math.min(g.first, it.epoch);
    g.last = Math.max(g.last, it.epoch);
    m.set(it.group, g);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/** これより長く（日数）間が空いた日は別のまとまりとみなす */
export const OUTLIER_GAP_DAYS = 30;

/**
 * 旅行の主な期間。撮影日を OUTLIER_GAP_DAYS 日を超える空きで区切ったまとまりのうち、件数が最も多いもの
 * （同数なら早い方）。時計が未設定のカメラ（2000年1月1日など）や日時推定のファイルが「1日目」を決めないようにする。
 * @returns {null|{firstDay:string, lastDay:string, count:number}}
 */
export function mainDayRange(items) {
  const counts = new Map();
  for (const it of items) counts.set(it.day, (counts.get(it.day) || 0) + 1);
  const days = [...counts.keys()].sort();
  if (!days.length) return null;
  let best = null;
  let cur = null;
  for (const day of days) {
    if (cur && daysBetween(cur.lastDay, day) > OUTLIER_GAP_DAYS) {
      if (!best || cur.count > best.count) best = cur;
      cur = null;
    }
    if (!cur) cur = { firstDay: day, lastDay: day, count: 0 };
    cur.lastDay = day;
    cur.count += counts.get(day);
  }
  if (!best || cur.count > best.count) best = cur;
  return best;
}

/** 主な期間の何日目か（期間外の日は null） */
function dayNumberIn(range, day) {
  if (!range || day < range.firstDay || day > range.lastDay) return null;
  return daysBetween(range.firstDay, day) + 1;
}

/**
 * スライド列（タイトル・日付カード・写真/動画）を作る。
 * 日付カードの dayNumber は主な期間（mainDayRange）の初日を 1 とした暦日。期間外の日は null（日付だけ表示する）。
 * @returns {Array<{key:string,type:'title'|'day'|'media', item?:object, day?:string, dayIndex?:number, dayNumber?:number|null, count?:number}>}
 */
export function buildSlides(items, { showTitleCard = true, showDayCards = true } = {}) {
  const slides = [];
  if (!items.length) return slides;
  if (showTitleCard) slides.push({ key: 'title', type: 'title' });
  const days = [];
  for (const it of items) if (days[days.length - 1] !== it.day) days.push(it.day);
  const counts = new Map();
  for (const it of items) counts.set(it.day, (counts.get(it.day) || 0) + 1);
  const main = mainDayRange(items);
  let lastDay = null;
  for (const it of items) {
    if (showDayCards && it.day !== lastDay) {
      slides.push({
        key: `day:${it.day}`,
        type: 'day',
        day: it.day,
        dayIndex: days.indexOf(it.day),
        dayNumber: dayNumberIn(main, it.day),
        count: counts.get(it.day),
      });
    }
    lastDay = it.day;
    slides.push({ key: `media:${it.id}`, type: 'media', item: it });
  }
  return slides;
}

function rangeOf(list) {
  let first = Infinity;
  let last = -Infinity;
  const days = new Set();
  for (const it of list) {
    if (it.epoch < first) first = it.epoch;
    if (it.epoch > last) last = it.epoch;
    days.add(it.day);
  }
  const sorted = [...days].sort();
  return { first, last, firstDay: sorted[0], lastDay: sorted[sorted.length - 1], dayCount: sorted.length };
}

/**
 * 旅行の期間・件数をまとめる（タイトルカード用）。
 * first / last / firstDay / lastDay / dayCount は主な期間（= main）のもの。全件の範囲は all。
 * outliers は主な期間の外にある件数。
 */
export function tripSummary(items) {
  if (!items.length) return null;
  const range = mainDayRange(items);
  const main = rangeOf(items.filter((i) => dayNumberIn(range, i.day) != null));
  return {
    ...main,
    main,
    all: rangeOf(items),
    outliers: items.length - range.count,
    photos: items.filter((i) => i.kind === 'image').length,
    videos: items.filter((i) => i.kind === 'video').length,
  };
}
