// 時刻・タイムゾーン関連の純粋関数（DOM に依存しない。Node のテストからも使う）

const dtfCache = new Map();

function getDtf(timeZone) {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

/** タイムゾーン名が有効か */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    getDtf(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** この端末のタイムゾーン（IANA 名）。取得できないか正しくなければ 'UTC' */
export function deviceTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 指定時刻（epoch ms）における timeZone の UTC オフセット（ms）。例: Europe/Paris の夏時間 → +2h */
export function tzOffsetMs(epochMs, timeZone) {
  const parts = getDtf(timeZone).formatToParts(new Date(epochMs));
  const v = {};
  for (const p of parts) v[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(v.year),
    Number(v.month) - 1,
    Number(v.day),
    Number(v.hour) % 24,
    Number(v.minute),
    Number(v.second),
  );
  // formatToParts は秒未満を落とすので、元の epoch も秒に揃えて比較する
  const flooredEpoch = Math.floor(epochMs / 1000) * 1000;
  return asUtc - flooredEpoch;
}

/**
 * 壁時計時刻（タイムゾーン timeZone における年月日時分秒）を epoch ms に変換する。
 * 夏時間の切り替えで存在しない時刻は前のオフセットで解釈し、重複する時刻は早い方を返す。
 * @param {{y:number,mo:number,d:number,h?:number,mi?:number,s?:number,ms?:number}} w  mo は 1〜12
 */
export function wallClockToEpoch(w, timeZone) {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h || 0, w.mi || 0, w.s || 0, w.ms || 0);
  if (!timeZone || timeZone === 'UTC' || timeZone === 'Etc/UTC') return guess;
  // 前後 1 日のオフセットを候補にし、実際にその壁時計時刻になる候補のうち早い方を採用する
  const before = tzOffsetMs(guess - 86400000, timeZone);
  const after = tzOffsetMs(guess + 86400000, timeZone);
  const candidates = [];
  for (const off of new Set([before, after, tzOffsetMs(guess, timeZone)])) {
    const t = guess - off;
    if (tzOffsetMs(t, timeZone) === off) candidates.push(t);
  }
  if (candidates.length) return Math.min(...candidates);
  // 夏時間開始で存在しない時刻: 切り替え前のオフセットで解釈
  return guess - before;
}

/** 壁時計時刻を固定オフセット（分）で epoch ms に変換 */
export function wallClockWithOffsetToEpoch(w, offsetMinutes) {
  return Date.UTC(w.y, w.mo - 1, w.d, w.h || 0, w.mi || 0, w.s || 0, w.ms || 0) - offsetMinutes * 60000;
}

function validWall(w) {
  if (!w) return false;
  const { y, mo, d, h = 0, mi = 0, s = 0 } = w;
  if (!(y >= 1971 && y <= 2200)) return false;
  if (!(mo >= 1 && mo <= 12)) return false;
  if (!(d >= 1 && d <= 31)) return false;
  if (!(h >= 0 && h <= 24)) return false;
  if (!(mi >= 0 && mi <= 59)) return false;
  if (!(s >= 0 && s <= 60)) return false;
  // 実在する日付かチェック（2月30日などを弾く）
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * EXIF 形式の日時文字列 "YYYY:MM:DD HH:MM:SS" を解析する。
 * "YYYY-MM-DD HH:MM:SS"、"YYYY:MM:DDTHH:MM:SS"、小数秒、末尾の空白や NUL も許容。
 * 無効（"0000:00:00 00:00:00" や空文字）の場合は null。
 */
export function parseExifDateTime(str) {
  if (typeof str !== 'string') return null;
  const m = str
    .replace(/\u0000/g, '')
    .trim()
    .match(/^(\d{4})[:\-/](\d{1,2})[:\-/](\d{1,2})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.,](\d{1,9}))?)?)?/);
  if (!m) return null;
  const w = {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: m[4] != null ? Number(m[4]) : 0,
    mi: m[5] != null ? Number(m[5]) : 0,
    s: m[6] != null ? Number(m[6]) : 0,
    ms: m[7] != null ? Math.round(Number(`0.${m[7]}`) * 1000) : 0,
  };
  if (w.ms >= 1000) w.ms = 999;
  return validWall(w) ? w : null;
}

/** "+03:00" / "-0530" / "Z" → 分。解析できなければ null */
export function parseUtcOffset(str) {
  if (typeof str !== 'string') return null;
  const s = str.replace(/\u0000/g, '').trim();
  if (s === 'Z' || s === 'z') return 0;
  const m = s.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  const h = Number(m[2]);
  const mi = Number(m[3]);
  if (h > 14 || mi > 59) return null;
  return (m[1] === '-' ? -1 : 1) * (h * 60 + mi);
}

/**
 * ISO 8601 風の日時（オフセット付き）を解析する。
 * 例: "2025-07-13T21:10:00+0300", "2025-07-13T18:10:00Z", "2025-07-13 21:10:00 +03:00"
 * オフセットが無い場合は {wall, offsetMinutes: null} を返す（呼び出し側でタイムゾーンを補う）。
 */
export function parseIsoDateTime(str) {
  if (typeof str !== 'string') return null;
  const s = str.replace(/\u0000/g, '').trim();
  const m = s.match(
    /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2}):?(\d{2})(?::?(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/,
  );
  if (!m) return null;
  const w = {
    y: Number(m[1]),
    mo: Number(m[2]),
    d: Number(m[3]),
    h: m[4] != null ? Number(m[4]) : 0,
    mi: m[5] != null ? Number(m[5]) : 0,
    s: m[6] != null ? Number(m[6]) : 0,
    ms: m[7] != null ? Math.min(999, Math.round(Number(`0.${m[7]}`) * 1000)) : 0,
  };
  if (!validWall(w)) return null;
  const offsetMinutes = m[8] != null ? parseUtcOffset(m[8]) : null;
  if (m[8] != null && offsetMinutes == null) return null;
  return {
    wall: w,
    offsetMinutes,
    epoch: offsetMinutes != null ? wallClockWithOffsetToEpoch(w, offsetMinutes) : null,
  };
}

/**
 * ファイル名から撮影日時を推定する。
 * 戻り値: { wall, utc: boolean, pattern } または null
 *  - utc=true の場合 wall は UTC の時刻（Google Pixel の PXL_ 形式）
 *  - utc=false の場合 wall は撮影地の現地時刻
 */
export function parseFilenameTime(name) {
  if (typeof name !== 'string' || !name) return null;
  const base = name.replace(/\.[^.]+$/, '');

  // Google Pixel: PXL_20250714_063000123(.MP/.NIGHT 等) — UTC
  let m = base.match(/(?:^|[^A-Za-z0-9])PXL_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(\d{3})?/);
  if (m) {
    const w = mk(m[1], m[2], m[3], m[4], m[5], m[6], m[7]);
    if (validWall(w)) return { wall: w, utc: true, pattern: 'pixel' };
  }

  // 一般的な "YYYYMMDD_HHMMSS" / "YYYYMMDD-HHMMSS" / "YYYYMMDDHHMMSS"（IMG_, VID_, PANO_, Screenshot_, MVIMG_ 等の接頭辞を許容）
  m = base.match(/(?:^|[^0-9])(\d{4})(\d{2})(\d{2})[_\- ]?(\d{2})(\d{2})(\d{2})(?:(\d{3})(?!\d))?(?!\d)/);
  if (m) {
    const w = mk(m[1], m[2], m[3], m[4], m[5], m[6], m[7]);
    if (validWall(w)) return { wall: w, utc: false, pattern: 'compact' };
  }

  // "YYYY-MM-DD HH.MM.SS"（Dropbox 等）/ "YYYY-MM-DD_HH-MM-SS" / "YYYY-MM-DD-HH-MM-SS" / "YYYY-MM-DD at HH.MM.SS"
  m = base.match(
    /(?:^|[^0-9])(\d{4})-(\d{2})-(\d{2})(?:[ _\-T]|\s+at\s+)(\d{1,2})[.\-:_](\d{2})[.\-:_](\d{2})(?!\d)/,
  );
  if (m) {
    let w = mk(m[1], m[2], m[3], m[4], m[5], m[6]);
    // macOS のスクリーンショット "2025-07-13 at 9.15.00 PM" 形式
    const pm = /\s*PM\b/i.test(base.slice(m.index + m[0].length, m.index + m[0].length + 4));
    const am = /\s*AM\b/i.test(base.slice(m.index + m[0].length, m.index + m[0].length + 4));
    if (pm && w.h < 12) w = { ...w, h: w.h + 12 };
    if (am && w.h === 12) w = { ...w, h: 0 };
    if (validWall(w)) return { wall: w, utc: false, pattern: 'dashed' };
  }

  // WhatsApp: IMG-20250713-WA0001（日付のみ）
  m = base.match(/(?:^|[^0-9])(?:IMG|VID|AUD|PTT)-(\d{4})(\d{2})(\d{2})-WA\d+/i);
  if (m) {
    const w = mk(m[1], m[2], m[3], '12', '00', '00');
    if (validWall(w)) return { wall: w, utc: false, pattern: 'date-only' };
  }
  return null;
}

function mk(y, mo, d, h, mi, s, ms) {
  return {
    y: Number(y),
    mo: Number(mo),
    d: Number(d),
    h: Number(h),
    mi: Number(mi),
    s: Number(s),
    ms: ms ? Number(ms) : 0,
  };
}

/** RFC3339 文字列 → epoch ms（不正なら null） */
export function parseRfc3339(str) {
  if (typeof str !== 'string' || !str) return null;
  const t = Date.parse(str);
  return Number.isFinite(t) ? t : null;
}

/** epoch ms → 指定タイムゾーンでの {y, mo, d, h, mi, s, weekday(0=日)} */
export function epochToWall(epochMs, timeZone) {
  const off = tzOffsetMs(epochMs, timeZone);
  const d = new Date(epochMs + off);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

/** 指定タイムゾーンでの日付キー "YYYY-MM-DD" */
export function dayKey(epochMs, timeZone) {
  const w = epochToWall(epochMs, timeZone);
  return `${w.y}-${pad2(w.mo)}-${pad2(w.d)}`;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** 例: "2025年7月13日（日）" */
export function formatDateJa(epochMs, timeZone) {
  const w = epochToWall(epochMs, timeZone);
  return `${w.y}年${w.mo}月${w.d}日（${WEEKDAYS_JA[w.weekday]}）`;
}

/** 例: "7月13日（日） 21:10" */
export function formatDateTimeJa(epochMs, timeZone, { withYear = false } = {}) {
  const w = epochToWall(epochMs, timeZone);
  const date = `${withYear ? `${w.y}年` : ''}${w.mo}月${w.d}日（${WEEKDAYS_JA[w.weekday]}）`;
  return `${date} ${pad2(w.h)}:${pad2(w.mi)}`;
}

/** 例: "21:10" */
export function formatTimeJa(epochMs, timeZone) {
  const w = epochToWall(epochMs, timeZone);
  return `${pad2(w.h)}:${pad2(w.mi)}`;
}

/** 2つの dayKey ("YYYY-MM-DD") の日数差 */
export function daysBetween(dayKeyA, dayKeyB) {
  const a = Date.parse(`${dayKeyA}T00:00:00Z`);
  const b = Date.parse(`${dayKeyB}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

/** UTC オフセットを "UTC+3" / "UTC+5:30" 形式で */
export function formatOffset(offsetMs) {
  const totalMin = Math.round(offsetMs / 60000);
  const sign = totalMin < 0 ? '-' : '+';
  const abs = Math.abs(totalMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${pad2(m)}` : ''}`;
}
