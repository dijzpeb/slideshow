// Drive のファイル情報と解析結果から、撮影日時順のスライド項目を作る（DOM 非依存）

import {
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

/** カメラ別時刻補正のグループ名 */
export function cameraGroup(file, extracted, kind) {
  const im = file.imageMediaMetadata || {};
  let label = cameraLabel(im.cameraMake, im.cameraModel);
  if (!label && extracted) label = cameraLabel(extracted.make, extracted.model);
  if (label) return label;
  return kind === 'video' ? UNKNOWN_VIDEO_GROUP : UNKNOWN_PHOTO_GROUP;
}

/**
 * 1ファイルの撮影日時（epoch ms）と取得元を決める。
 * 優先順位:
 *  1. 画像: ファイルから直接読んだ EXIF の DateTimeOriginal（OffsetTimeOriginal があればそれで、なければ timeZone で解釈）
 *  2. 画像: Drive の imageMediaMetadata.time（撮影地の現地時刻として timeZone で解釈）
 *  3. 動画: MP4/MOV のメタデータ（Apple creationdate → ©day → mvhd(UTC)）
 *  4. ファイル名の日時（Pixel の PXL_ は UTC、それ以外は現地時刻）
 *  5. ドライブ上の更新日時と作成日時の早い方
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
    if (extracted && extracted.wall) return { epoch: fromFile(extracted), source: 'exif' };
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
 * @param {{timeZone:string, cameraOffsets?:Record<string,number>}} opts  cameraOffsets は分単位
 */
export function buildCatalog(files, extractedById, { timeZone, cameraOffsets = {} } = {}) {
  const get = (id) => (extractedById instanceof Map ? extractedById.get(id) : extractedById?.[id]) || null;
  const items = [];
  for (const f of files) {
    const mimeType = normalizeMimeType(f.mimeType, f.name);
    const kind = mediaKind(mimeType, f.name);
    if (!kind) continue;
    const ex = get(f.id);
    const { epoch: rawEpoch, source } = resolveCaptureTime(f, ex, timeZone);
    const group = cameraGroup(f, ex, kind);
    const offsetMin = Number(cameraOffsets[group]) || 0;
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

/**
 * スライド列（タイトル・日付カード・写真/動画）を作る。
 * @returns {Array<{key:string,type:'title'|'day'|'media', item?:object, day?:string, dayIndex?:number, dayNumber?:number, count?:number}>}
 */
export function buildSlides(items, { showTitleCard = true, showDayCards = true } = {}) {
  const slides = [];
  if (!items.length) return slides;
  if (showTitleCard) slides.push({ key: 'title', type: 'title' });
  const days = [];
  for (const it of items) if (days[days.length - 1] !== it.day) days.push(it.day);
  const counts = new Map();
  for (const it of items) counts.set(it.day, (counts.get(it.day) || 0) + 1);
  let lastDay = null;
  for (const it of items) {
    if (showDayCards && it.day !== lastDay) {
      slides.push({
        key: `day:${it.day}`,
        type: 'day',
        day: it.day,
        dayIndex: days.indexOf(it.day),
        dayNumber: daysBetween(days[0], it.day) + 1,
        count: counts.get(it.day),
      });
    }
    lastDay = it.day;
    slides.push({ key: `media:${it.id}`, type: 'media', item: it });
  }
  return slides;
}

/** 日付キーの配列から旅行の日数・期間をまとめる */
export function tripSummary(items) {
  if (!items.length) return null;
  const days = [...new Set(items.map((i) => i.day))].sort();
  return {
    first: items[0].epoch,
    last: items[items.length - 1].epoch,
    firstDay: days[0],
    lastDay: days[days.length - 1],
    dayCount: days.length,
    photos: items.filter((i) => i.kind === 'image').length,
    videos: items.filter((i) => i.kind === 'video').length,
  };
}
