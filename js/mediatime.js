// 写真・動画ファイルのバイナリから撮影日時を読み取る（DOM 非依存。Node のテストからも使う）
//  - MP4 / MOV: mvhd の creation_time、Apple の com.apple.quicktime.creationdate、©day
//    （機種名: Apple / Android の mdta キー、©mak/©mod、Canon の CNMN・CMT1）
//  - JPEG: EXIF DateTimeOriginal / OffsetTimeOriginal
//  - HEIC/HEIF: Exif アイテム
// ファイル全体はダウンロードせず、RangeReader を通じて必要な部分だけ Range リクエストで読む。

import { parseExifDateTime, parseIsoDateTime, parseUtcOffset } from './timeutil.js';

const MAC_EPOCH_OFFSET_SEC = 2082844800; // 1904-01-01 → 1970-01-01
const MIN_VALID_EPOCH = Date.UTC(2000, 0, 1);
const MAX_VALID_EPOCH = Date.UTC(2200, 0, 1);

/**
 * ブロック単位でキャッシュしながら任意範囲を読むリーダー。
 * fetchRange(start, endInclusive) は ArrayBuffer を返す Promise。サーバーが Range を無視して
 * ファイル全体を返した場合にも対応する（その場合は全体をキャッシュする）。
 */
export class RangeReader {
  constructor(fetchRange, size, { blockSize = 64 * 1024, maxBytes = 8 * 1024 * 1024 } = {}) {
    this.fetchRange = fetchRange;
    this.size = Number.isFinite(size) && size > 0 ? size : Infinity;
    this.blockSize = blockSize;
    this.maxBytes = maxBytes; // 1ファイルあたりの読み込み上限（暴走防止）
    this.blocks = new Map(); // blockIndex -> Promise<Uint8Array>
    this.whole = null; // サーバーが全体を返した場合
    this.bytesFetched = 0;
    this.requests = 0;
  }

  _block(idx) {
    let p = this.blocks.get(idx);
    if (!p) {
      const start = idx * this.blockSize;
      const end = Math.min(start + this.blockSize, this.size) - 1;
      if (this.bytesFetched + (end - start + 1) > this.maxBytes) {
        return Promise.reject(new Error('RangeReader: read limit exceeded'));
      }
      this.bytesFetched += end - start + 1;
      this.requests++;
      p = Promise.resolve(this.fetchRange(start, end)).then((buf) => {
        const u8 = new Uint8Array(buf);
        if (u8.length > end - start + 1 && start === 0) {
          // Range が無視され全体が返ってきた
          this.whole = u8;
          if (!Number.isFinite(this.size)) this.size = u8.length;
          return u8.subarray(0, end - start + 1);
        }
        if (u8.length > end - start + 1) {
          // 想定外の長さ（先頭以外で全体が返った等）は先頭からの全体とみなす
          this.whole = u8;
          return u8.subarray(start, end + 1);
        }
        return u8;
      });
      this.blocks.set(idx, p);
      p.catch(() => this.blocks.delete(idx));
    }
    return p;
  }

  /** offset から length バイトを読む（ファイル末尾を超える分は切り詰め） */
  async read(offset, length) {
    if (offset < 0 || length < 0) throw new RangeError('negative read');
    if (offset >= this.size) return new Uint8Array(0);
    const end = Math.min(offset + length, this.size); // exclusive
    if (this.whole) return this.whole.subarray(offset, Math.min(end, this.whole.length));
    const first = Math.floor(offset / this.blockSize);
    const last = Math.floor((end - 1) / this.blockSize);
    const parts = [];
    for (let i = first; i <= last; i++) parts.push(this._block(i));
    const blocks = await Promise.all(parts);
    if (this.whole) return this.whole.subarray(offset, Math.min(end, this.whole.length));
    const out = new Uint8Array(end - offset);
    let pos = 0;
    for (let i = first; i <= last; i++) {
      const b = blocks[i - first];
      const bStart = i * this.blockSize;
      const from = Math.max(offset, bStart) - bStart;
      const to = Math.min(end, bStart + b.length) - bStart;
      if (to <= from) break;
      out.set(b.subarray(from, to), pos);
      pos += to - from;
      if (b.length < this.blockSize && i < last) break; // ファイル末尾
    }
    return pos === out.length ? out : out.subarray(0, pos);
  }
}

/** 単一の Uint8Array をソースにする RangeReader 互換リーダー（テスト・Blob 用） */
export class BufferReader {
  constructor(u8) {
    this.u8 = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    this.size = this.u8.length;
  }
  async read(offset, length) {
    return this.u8.subarray(offset, Math.min(offset + length, this.size));
  }
}

// ---------------------------------------------------------------------------
// バイト列ユーティリティ

function u16be(b, o) {
  return (b[o] << 8) | b[o + 1];
}
function u32be(b, o) {
  return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
}
function u64be(b, o) {
  return u32be(b, o) * 4294967296 + u32be(b, o + 4);
}
function fourcc(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}
function latin1(b, start, end) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}
function utf8(b, start, end) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(start, end));
  } catch {
    return latin1(b, start, end);
  }
}
function readUintN(b, o, n) {
  if (n === 0) return 0;
  if (n === 1) return b[o];
  if (n === 2) return u16be(b, o);
  if (n === 4) return u32be(b, o);
  if (n === 8) return u64be(b, o);
  throw new Error(`unsupported int size ${n}`);
}

// ---------------------------------------------------------------------------
// ISO BMFF (MP4 / MOV / HEIF) のボックス走査

/** offset のボックスヘッダを読む。戻り値 {type, start, headerSize, size, end} または null */
async function readBoxHeader(reader, offset, limit) {
  if (offset + 8 > limit) return null;
  const h = await reader.read(offset, 16);
  if (h.length < 8) return null;
  let size = u32be(h, 0);
  const type = fourcc(h, 4);
  let headerSize = 8;
  if (size === 1) {
    if (h.length < 16) return null;
    size = u64be(h, 8);
    headerSize = 16;
  } else if (size === 0) {
    size = (Number.isFinite(limit) ? limit : reader.size) - offset; // 末尾まで
  }
  if (!Number.isFinite(size) || size < headerSize) return null;
  return { type, start: offset, headerSize, size, end: offset + size };
}

/** [start, end) の範囲の子ボックスを列挙（最大 maxBoxes 個） */
async function listBoxes(reader, start, end, maxBoxes = 512) {
  const boxes = [];
  let off = start;
  while (off < end && boxes.length < maxBoxes) {
    const box = await readBoxHeader(reader, off, end);
    if (!box) break;
    if (box.end > end) {
      // 子ボックスが親をはみ出している → 壊れているので打ち切り（ただしこのボックス自体は返す）
      box.end = end;
      box.size = end - box.start;
      boxes.push(box);
      break;
    }
    boxes.push(box);
    off = box.end;
  }
  return boxes;
}

const MAX_SMALL_BOX = 1024 * 1024; // meta / udta / keys 等として読み込む最大サイズ

/**
 * MP4 / MOV から撮影日時を取得する。
 * @returns {Promise<null|{epoch:number, source:'mp4-apple'|'mp4-day'|'mp4-mvhd', offsetMinutes?:number|null, make?:string, model?:string, legacyLabel?:boolean, mvhdEpoch?:number|null}>}
 *   legacyLabel: 機種名を以前の版も読んでいたキー（Apple の mdta、©mak / ©mod）から読めたか。
 *   以前の版で保存した時刻補正を今のグループに移すときに、そのファイルの以前のグループを決めるのに使う
 */
export async function readMp4CreationTime(reader) {
  const size = reader.size;
  const top = await listBoxes(reader, 0, size, 64);
  if (!top.length) return null;
  // 先頭は ftyp / wide / free / skip / mdat / moov 等のはず。ISO BMFF でなければ終了
  const KNOWN_TOP = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid', 'meta', 'pdin', 'moof', 'mfra', 'styp', 'sidx', 'junk', 'PICT']);
  if (!KNOWN_TOP.has(top[0].type)) return null;
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return null;

  const children = await listBoxes(reader, moov.start + moov.headerSize, moov.end, 256);
  let mvhdEpoch = null;
  const found = { apple: null, day: null, make: null, model: null, legacyLabel: false };

  for (const box of children) {
    if (box.type === 'mvhd') {
      const b = await reader.read(box.start + box.headerSize, 20);
      if (b.length >= 8) {
        const version = b[0];
        let secs = null;
        if (version === 1 && b.length >= 12) secs = u64be(b, 4);
        else if (version === 0) secs = u32be(b, 4);
        if (secs != null && secs > 0) {
          const epoch = (secs - MAC_EPOCH_OFFSET_SEC) * 1000;
          if (epoch >= MIN_VALID_EPOCH && epoch < MAX_VALID_EPOCH) mvhdEpoch = epoch;
        }
      }
    } else if (box.type === 'meta' && box.size <= MAX_SMALL_BOX) {
      const b = await reader.read(box.start, box.size);
      parseMetaBox(b, 0, b.length, found);
    } else if (box.type === 'udta' && box.size <= MAX_SMALL_BOX) {
      const b = await reader.read(box.start, box.size);
      parseUdta(b, box.headerSize, b.length, found);
    } else if (box.type === 'uuid' && box.size <= MAX_SMALL_BOX && !(found.make && found.model)) {
      // Canon の MP4: moov/uuid の CMT1（IFD0）に Make / Model がある
      const head = await reader.read(box.start + box.headerSize, 16);
      if (head.length === 16 && hex(head) === CANON_UUID) {
        const b = await reader.read(box.start, box.size);
        parseCanonUuid(b, box.headerSize + 16, b.length, found);
      }
    }
  }

  const result = { make: found.make || undefined, model: found.model || undefined, legacyLabel: found.legacyLabel, mvhdEpoch };
  const apple = found.apple && parseIsoDateTime(found.apple);
  if (apple && apple.epoch != null) {
    return { ...result, epoch: apple.epoch, source: 'mp4-apple', offsetMinutes: apple.offsetMinutes };
  }
  const day = found.day && parseIsoDateTime(found.day);
  if (day && day.epoch != null) {
    return { ...result, epoch: day.epoch, source: 'mp4-day', offsetMinutes: day.offsetMinutes };
  }
  if (mvhdEpoch != null) return { ...result, epoch: mvhdEpoch, source: 'mp4-mvhd', offsetMinutes: null };
  if (found.make || found.model) return { ...result, epoch: null, source: null };
  return null;
}

// b[start..end) は 'meta' ボックス全体（ヘッダ含む）
function parseMetaBox(b, start, end, found) {
  if (end - start < 12) return;
  const headerSize = 8;
  let p = start + headerSize;
  // ISO の meta は FullBox（4 バイトの version/flags）、QuickTime の meta はそうでない。
  // 次の子ボックスの型が 'hdlr' になる方を採用する。
  if (end - p >= 12 && fourcc(b, p + 4) !== 'hdlr' && fourcc(b, p + 8) === 'hdlr') p += 4;
  else if (end - p >= 8 && u32be(b, p) === 0 && fourcc(b, p + 4) !== 'hdlr') p += 4;

  let keys = null;
  const boxes = [];
  while (p + 8 <= end) {
    let size = u32be(b, p);
    const type = fourcc(b, p + 4);
    let hs = 8;
    if (size === 1 && p + 16 <= end) {
      size = u64be(b, p + 8);
      hs = 16;
    } else if (size === 0) size = end - p;
    if (size < hs || p + size > end) break;
    boxes.push({ type, start: p, hs, end: p + size });
    p += size;
  }
  for (const bx of boxes) {
    if (bx.type === 'keys') keys = parseKeys(b, bx.start + bx.hs, bx.end);
  }
  for (const bx of boxes) {
    if (bx.type === 'ilst') parseIlst(b, bx.start + bx.hs, bx.end, keys, found);
  }
}

function parseKeys(b, start, end) {
  // FullBox: version(1) flags(3) entry_count(4)
  if (end - start < 8) return [];
  const count = u32be(b, start + 4);
  const keys = [null]; // 1-based
  let p = start + 8;
  for (let i = 0; i < count && p + 8 <= end; i++) {
    const ks = u32be(b, p);
    if (ks < 8 || p + ks > end) break;
    keys.push(utf8(b, p + 8, p + ks));
    p += ks;
  }
  return keys;
}

function parseIlst(b, start, end, keys, found) {
  let p = start;
  while (p + 8 <= end) {
    const size = u32be(b, p);
    if (size < 8 || p + size > end) break;
    const itemEnd = p + size;
    const typeRaw = u32be(b, p + 4);
    const typeStr = fourcc(b, p + 4);
    let name = null;
    if (keys && typeRaw > 0 && typeRaw < keys.length) name = keys[typeRaw];
    else name = typeStr;
    // 中の 'data' ボックスを探す
    let q = p + 8;
    while (q + 16 <= itemEnd) {
      const ds = u32be(b, q);
      if (ds < 16 || q + ds > itemEnd) break;
      if (fourcc(b, q + 4) === 'data') {
        const typeInd = u32be(b, q + 8) & 0x00ffffff;
        // 1 = UTF-8, 2 = UTF-16 (まれ)
        if (typeInd === 1 || typeInd === 0) {
          const value = utf8(b, q + 16, q + ds).replace(/\u0000+$/, '');
          assignMeta(name, value, found);
        }
        break;
      }
      q += ds;
    }
    p = itemEnd;
  }
}

// 以前の版も機種名を読んでいたキー
const LEGACY_LABEL_KEYS = new Set(['com.apple.quicktime.make', '©mak', 'com.apple.quicktime.model', '©mod']);

function assignMeta(name, value, found) {
  if (!name || !value) return;
  if (LEGACY_LABEL_KEYS.has(name)) found.legacyLabel = true;
  switch (name) {
    case 'com.apple.quicktime.creationdate':
      found.apple = found.apple || value;
      break;
    case '©day':
    case 'com.apple.quicktime.content.creationdate':
      found.day = found.day || value;
      break;
    case 'com.apple.quicktime.make':
    case 'com.android.manufacturer':
    case '©mak':
    case 'CMT1.make':
      found.make = found.make || value;
      break;
    case 'com.apple.quicktime.model':
    case 'com.android.model':
    case '©mod':
    case 'CNMN':
    case 'CMT1.model':
      found.model = found.model || value;
      break;
    default:
      break;
  }
}

// udta の中身: QuickTime の "©xyz" テキスト形式、または iTunes 形式の meta
function parseUdta(b, start, end, found) {
  let p = start;
  while (p + 8 <= end) {
    const size = u32be(b, p);
    if (size < 8 || p + size > end) break;
    const type = latin1(b, p + 4, p + 8);
    if (type === 'meta') {
      parseMetaBox(b, p, p + size, found);
    } else if (b[p + 4] === 0xa9) {
      // QuickTime ユーザーデータのテキスト: [text_size(2) lang(2) text]...
      if (p + 12 <= p + size) {
        const ts = u16be(b, p + 8);
        if (ts > 0 && p + 12 + ts <= p + size) {
          const value = utf8(b, p + 12, p + 12 + ts).replace(/\u0000+$/, '');
          assignMeta(type, value, found);
        }
      }
    } else if (type === 'CNMN') {
      // Canon の MOV/MP4: 機種名の文字列そのもの
      assignMeta(type, latin1(b, p + 8, p + size).replace(/\u0000[\s\S]*$/, '').trim(), found);
    }
    p += size;
  }
}

const CANON_UUID = '85c0b687820f11e08111f4ce462b6a48';

function hex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

// Canon の uuid ボックスの子（CNCV, CMT1, THMB …）から CMT1 = TIFF の IFD0 を読む
function parseCanonUuid(b, start, end, found) {
  let p = start;
  while (p + 8 <= end) {
    const size = u32be(b, p);
    if (size < 8 || p + size > end) break;
    if (fourcc(b, p + 4) === 'CMT1') {
      const ifd0 = parseTiffExif(b.subarray(p + 8, p + size));
      if (ifd0) {
        assignMeta('CMT1.make', ifd0.make, found);
        assignMeta('CMT1.model', ifd0.model, found);
      }
      break;
    }
    p += size;
  }
}

// ---------------------------------------------------------------------------
// EXIF（TIFF 構造）

const TAG_ORIENTATION = 0x0112;
const TAG_THUMB_OFFSET = 0x0201;
const TAG_THUMB_LENGTH = 0x0202;
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_OFFSET_TIME = 0x9010;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_OFFSET_TIME_DIGITIZED = 0x9012;
const TAG_SUBSEC_ORIGINAL = 0x9291;

/**
 * TIFF ヘッダから始まるバイト列を解析して日時関連タグを返す。
 * @returns {null|{dateTimeOriginal?:string, dateTimeDigitized?:string, dateTime?:string, offsetTimeOriginal?:string, offsetTimeDigitized?:string, offsetTime?:string, subSecOriginal?:string, make?:string, model?:string, orientation?:number, thumbnailOffset?:number, thumbnailLength?:number}}
 *   thumbnailOffset は TIFF ヘッダ先頭からのオフセット
 */
export function parseTiffExif(t) {
  if (!t || t.length < 8) return null;
  const order = latin1(t, 0, 2);
  let le;
  if (order === 'II') le = true;
  else if (order === 'MM') le = false;
  else return null;
  const r16 = (o) => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const r32 = (o) =>
    le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0 : u32be(t, o);
  if (r16(2) !== 42) return null;
  const out = {};

  const readIfd = (off, handler) => {
    if (off < 8 || off + 2 > t.length) return 0;
    const n = r16(off);
    if (n > 1000) return 0;
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > t.length) break;
      const tag = r16(e);
      const type = r16(e + 2);
      const count = r32(e + 4);
      handler(tag, type, count, e + 8);
    }
    const nextPos = off + 2 + n * 12;
    return nextPos + 4 <= t.length ? r32(nextPos) : 0; // 次の IFD（IFD1 = サムネイル）
  };
  const uint = (type, vo) => (type === 3 ? r16(vo) : type === 4 ? r32(vo) : null);
  const ascii = (type, count, valueOff) => {
    if (type !== 2 || count === 0 || count > 256) return null;
    const dataOff = count <= 4 ? valueOff : r32(valueOff);
    if (dataOff + count > t.length) return null;
    return latin1(t, dataOff, dataOff + count).replace(/\u0000[\s\S]*$/, '').trim();
  };

  let exifIfd = null;
  const ifd1 = readIfd(r32(4), (tag, type, count, vo) => {
    if (tag === TAG_MAKE) out.make = ascii(type, count, vo) || undefined;
    else if (tag === TAG_MODEL) out.model = ascii(type, count, vo) || undefined;
    else if (tag === TAG_DATETIME) out.dateTime = ascii(type, count, vo) || undefined;
    else if (tag === TAG_ORIENTATION) out.orientation = uint(type, vo) || undefined;
    else if (tag === TAG_EXIF_IFD && (type === 4 || type === 13)) exifIfd = r32(vo);
  });
  if (ifd1 && ifd1 !== r32(4)) {
    let off = null;
    let len = null;
    readIfd(ifd1, (tag, type, count, vo) => {
      if (tag === TAG_THUMB_OFFSET) off = uint(type, vo);
      else if (tag === TAG_THUMB_LENGTH) len = uint(type, vo);
    });
    if (off && len && off + len <= t.length) {
      out.thumbnailOffset = off;
      out.thumbnailLength = len;
    }
  }
  if (exifIfd) {
    readIfd(exifIfd, (tag, type, count, vo) => {
      if (tag === TAG_DATETIME_ORIGINAL) out.dateTimeOriginal = ascii(type, count, vo) || undefined;
      else if (tag === TAG_DATETIME_DIGITIZED) out.dateTimeDigitized = ascii(type, count, vo) || undefined;
      else if (tag === TAG_OFFSET_TIME_ORIGINAL) out.offsetTimeOriginal = ascii(type, count, vo) || undefined;
      else if (tag === TAG_OFFSET_TIME_DIGITIZED) out.offsetTimeDigitized = ascii(type, count, vo) || undefined;
      else if (tag === TAG_OFFSET_TIME) out.offsetTime = ascii(type, count, vo) || undefined;
      else if (tag === TAG_SUBSEC_ORIGINAL) out.subSecOriginal = ascii(type, count, vo) || undefined;
    });
  }
  return out;
}

/** JPEG の APP1 (Exif) を探して解析する */
export async function readJpegExif(reader) {
  const r = await readJpegExifRaw(reader);
  return r ? r.exif : null;
}

/** JPEG の EXIF に埋め込まれたサムネイル（小さな JPEG）と向き（Orientation）を返す */
export async function readJpegExifThumbnail(reader) {
  const r = await readJpegExifRaw(reader);
  if (!r || !r.exif || !r.exif.thumbnailLength) return null;
  const bytes = r.tiff.slice(r.exif.thumbnailOffset, r.exif.thumbnailOffset + r.exif.thumbnailLength);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  return { bytes, orientation: r.exif.orientation || 1 };
}

async function readJpegExifRaw(reader) {
  const head = await reader.read(0, 4);
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let off = 2;
  for (let i = 0; i < 64; i++) {
    const m = await reader.read(off, 4);
    if (m.length < 4) return null;
    if (m[0] !== 0xff) return null;
    const marker = m[1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      off += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // 画像データ開始 / 終了
    const len = u16be(m, 2);
    if (len < 2) return null;
    if (marker === 0xe1 && len > 8) {
      const seg = await reader.read(off + 4, len - 2);
      if (latin1(seg, 0, 4) === 'Exif' && seg[4] === 0 && seg[5] === 0) {
        const tiff = seg.subarray(6);
        return { exif: parseTiffExif(tiff), tiff };
      }
    }
    off += 2 + len;
    if (off > 4 * 1024 * 1024) return null;
  }
  return null;
}

/** HEIF / HEIC の Exif アイテムを探して解析する */
export async function readHeifExif(reader) {
  const top = await listBoxes(reader, 0, reader.size, 32);
  if (!top.length || top[0].type !== 'ftyp') return null;
  const meta = top.find((b) => b.type === 'meta');
  if (!meta || meta.size > 4 * MAX_SMALL_BOX) return null;
  const b = await reader.read(meta.start, meta.size);
  // meta は FullBox
  let p = meta.headerSize + 4;
  let exifItemId = null;
  let iloc = null;
  while (p + 8 <= b.length) {
    let size = u32be(b, p);
    const type = fourcc(b, p + 4);
    let hs = 8;
    if (size === 1) {
      size = u64be(b, p + 8);
      hs = 16;
    } else if (size === 0) size = b.length - p;
    if (size < hs || p + size > b.length) break;
    if (type === 'iinf') exifItemId = findExifItemId(b, p + hs, p + size);
    else if (type === 'iloc') iloc = { start: p + hs, end: p + size };
    p += size;
  }
  if (exifItemId == null || !iloc) return null;
  const loc = findItemLocation(b, iloc.start, iloc.end, exifItemId);
  if (!loc || loc.length < 10 || loc.length > MAX_SMALL_BOX) return null;
  const data = await reader.read(loc.offset, loc.length);
  if (data.length < 10) return null;
  // 先頭 4 バイトは TIFF ヘッダまでのオフセット（通常 "Exif\0\0" の 6）
  const skip = u32be(data, 0);
  const tiffStart = 4 + skip;
  if (tiffStart >= data.length) return null;
  let tiff = data.subarray(tiffStart);
  // オフセットが 0 でも "Exif\0\0" が付いている実装があるので補正
  if (latin1(tiff, 0, 4) === 'Exif') tiff = tiff.subarray(6);
  return parseTiffExif(tiff);
}

function findExifItemId(b, start, end) {
  const version = b[start];
  let p = start + 4;
  let count;
  if (version === 0) {
    count = u16be(b, p);
    p += 2;
  } else {
    count = u32be(b, p);
    p += 4;
  }
  for (let i = 0; i < count && p + 8 <= end; i++) {
    const size = u32be(b, p);
    if (size < 8 || p + size > end) break;
    if (fourcc(b, p + 4) === 'infe') {
      const v = b[p + 8];
      const q = p + 12;
      if (v >= 2) {
        const idSize = v === 2 ? 2 : 4;
        const itemId = readUintN(b, q, idSize);
        const itemType = fourcc(b, q + idSize + 2);
        if (itemType === 'Exif') return itemId;
      }
    }
    p += size;
  }
  return null;
}

function findItemLocation(b, start, end, itemId) {
  const version = b[start];
  let p = start + 4;
  const offsetSize = b[p] >> 4;
  const lengthSize = b[p] & 0x0f;
  const baseOffsetSize = b[p + 1] >> 4;
  const indexSize = version === 1 || version === 2 ? b[p + 1] & 0x0f : 0;
  p += 2;
  let count;
  if (version < 2) {
    count = u16be(b, p);
    p += 2;
  } else {
    count = u32be(b, p);
    p += 4;
  }
  for (let i = 0; i < count && p < end; i++) {
    const id = version < 2 ? u16be(b, p) : u32be(b, p);
    p += version < 2 ? 2 : 4;
    let constructionMethod = 0;
    if (version === 1 || version === 2) {
      constructionMethod = u16be(b, p) & 0x0f;
      p += 2;
    }
    p += 2; // data_reference_index
    const baseOffset = readUintN(b, p, baseOffsetSize);
    p += baseOffsetSize;
    const extentCount = u16be(b, p);
    p += 2;
    let firstOffset = null;
    let totalLength = 0;
    let contiguous = true;
    let expectedNext = null;
    for (let e = 0; e < extentCount; e++) {
      p += indexSize;
      const eo = readUintN(b, p, offsetSize);
      p += offsetSize;
      const el = readUintN(b, p, lengthSize);
      p += lengthSize;
      if (firstOffset == null) firstOffset = baseOffset + eo;
      if (expectedNext != null && baseOffset + eo !== expectedNext) contiguous = false;
      expectedNext = baseOffset + eo + el;
      totalLength += el;
    }
    if (id === itemId) {
      if (constructionMethod !== 0 || !contiguous || firstOffset == null) return null;
      return { offset: firstOffset, length: totalLength };
    }
  }
  return null;
}

function sameWall(a, b) {
  return !!a && !!b && a.y === b.y && a.mo === b.mo && a.d === b.d && a.h === b.h && a.mi === b.mi && a.s === b.s;
}

/**
 * EXIF の解析結果から撮影日時情報を作る。
 * オフセットは各日時に対応するタグを使う（DateTimeOriginal → OffsetTimeOriginal、
 * DateTimeDigitized → OffsetTimeDigitized、DateTime → OffsetTime）。OffsetTime は DateTime（更新日時）の
 * 時差なので、DateTime と同じ時刻のとき（未編集のファイル）に限って他の日時にも使う。
 * @returns {null|{wall, offsetMinutes:number|null, tag:'original'|'digitized'|'datetime', make?:string, model?:string}}
 */
export function exifToCapture(exif) {
  if (!exif) return null;
  let tag = 'original';
  let wall = parseExifDateTime(exif.dateTimeOriginal);
  if (!wall) {
    tag = 'digitized';
    wall = parseExifDateTime(exif.dateTimeDigitized);
  }
  if (!wall) {
    tag = 'datetime';
    wall = parseExifDateTime(exif.dateTime);
  }
  if (!wall) return null;
  if (exif.dateTimeOriginal && exif.subSecOriginal && !wall.ms) {
    const ss = exif.subSecOriginal.replace(/\D/g, '').slice(0, 3);
    if (ss) wall.ms = Number(ss.padEnd(3, '0'));
  }
  const own = tag === 'original' ? exif.offsetTimeOriginal : tag === 'digitized' ? exif.offsetTimeDigitized : exif.offsetTime;
  let offsetMinutes = parseUtcOffset(own || '');
  if (offsetMinutes == null && tag !== 'datetime' && sameWall(wall, parseExifDateTime(exif.dateTime))) {
    offsetMinutes = parseUtcOffset(exif.offsetTime || '');
  }
  return { wall, offsetMinutes, tag, make: exif.make, model: exif.model };
}

/** ファイル種別に応じて撮影日時を読む。戻り値は metadata キャッシュに保存できる素朴なオブジェクト */
export async function extractCaptureInfo(reader, mimeType) {
  const mt = (mimeType || '').toLowerCase();
  if (mt.startsWith('video/')) {
    const r = await readMp4CreationTime(reader);
    if (!r) return null;
    return {
      kind: 'video',
      epoch: r.epoch,
      source: r.source,
      offsetMinutes: r.offsetMinutes ?? null,
      make: r.make,
      model: r.model,
      legacyLabel: r.legacyLabel,
    };
  }
  let exif = null;
  if (mt === 'image/jpeg' || mt === 'image/jpg' || mt === 'image/pjpeg') exif = await readJpegExif(reader);
  else if (mt === 'image/heic' || mt === 'image/heif' || mt === 'image/avif') exif = await readHeifExif(reader);
  const cap = exifToCapture(exif);
  if (!cap) return exif && (exif.make || exif.model) ? { kind: 'image', wall: null, make: exif.make, model: exif.model } : null;
  return { kind: 'image', wall: cap.wall, offsetMinutes: cap.offsetMinutes, tag: cap.tag, make: cap.make, model: cap.model };
}
