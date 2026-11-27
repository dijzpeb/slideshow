// 設定の既定値・保存・URL パラメータ

import { isValidTimeZone, deviceTimeZone } from './timeutil.js';
import { DRIVE_API_DEFAULT, parseFolderInput } from './drive.js';

const STORAGE_KEY = 'photo-slideshow.settings.v1';

export const DEFAULTS = Object.freeze({
  authMode: 'oauth', // 'oauth' | 'apikey'
  clientId: '',
  apiKey: '',
  folder: '', // フォルダの URL または ID
  title: '', // タイトルカードの見出し（空ならフォルダ名）
  photoSeconds: 6,
  transition: 'fade', // 'fade' | 'none'
  kenBurns: true,
  blurBackground: true,
  videoMaxSeconds: 0, // 0 = 最後まで再生
  videoMuted: false,
  captions: 'datetime', // 'datetime' | 'datetime-name' | 'none'
  showTitleCard: true,
  showDayCards: true,
  loop: true,
  includeSubfolders: true,
  refreshMinutes: 5, // 0 = 自動更新しない
  timeZone: deviceTimeZone(), // 撮影地のタイムゾーン。既定はこの端末のタイムゾーン
  imageQuality: 'original', // 'original' | 'fast'
  preciseTimes: true, // 写真の EXIF をファイルから直接読んで撮影時刻を補正する
  cameraOffsets: {}, // { [フォルダ ID]: { [補正グループ名]: 分 } }
  // 以前の版で保存した（グループの分け方が今と違う）補正。最初にそのフォルダを開いたときに今のグループに移す
  legacyCameraOffsets: {}, // { [フォルダ ID]: { [以前のグループ名]: 分 } }
});

const MAX_OFFSET_MINUTES = 48 * 60;
const MAX_OFFSET_FOLDERS = 50;
const MAX_OFFSET_GROUPS = 100;
const MAX_LABEL_LENGTH = 200;
const FOLDER_ID_RE = /^[-\w]{1,200}$/;
/** 共有リンクの fix=* : リンクの fix がそのフォルダの補正のすべて */
const FIX_COMPLETE = '*';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validFolderId = (id) => typeof id === 'string' && FOLDER_ID_RE.test(id) && id !== '__proto__';

/** 分を整数にして ±48 時間に丸める（数値でなければ null） */
function toOffsetMinutes(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (typeof v === 'string' && !v.trim()) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_OFFSET_MINUTES, Math.max(-MAX_OFFSET_MINUTES, n));
}

/** { [グループ名]: 分 } を検証する（0 や不正な値は除く） */
function sanitizeGroupOffsets(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= MAX_OFFSET_GROUPS) break;
    if (!k || k.length > MAX_LABEL_LENGTH || k === '__proto__') continue;
    const m = toOffsetMinutes(v);
    if (!m) continue;
    out[k] = m;
    n++;
  }
  return out;
}

/** { [フォルダ ID]: { [グループ名]: 分 } } を検証する。旧形式（フォルダ別でない { グループ名: 分 }）は捨てる（loadSettings で移行済み） */
function sanitizeFolderOffsets(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  const entries = [];
  for (const [fid, groups] of Object.entries(raw)) {
    if (!validFolderId(fid) || !isPlainObject(groups)) continue;
    const g = sanitizeGroupOffsets(groups);
    if (Object.keys(g).length) entries.push([fid, g]);
  }
  // 上限を超えたら古いもの（先頭）から捨てる。withFolderOffsets は更新したフォルダを末尾に置く
  for (const [fid, g] of entries.slice(-MAX_OFFSET_FOLDERS)) out[fid] = g;
  return out;
}

/** このフォルダのカメラ別補正 { [補正グループ名]: 分 }（buildCatalog の cameraOffsets に渡す） */
export function offsetsForFolder(settings, folderId) {
  const all = settings && settings.cameraOffsets;
  if (!isPlainObject(all) || !validFolderId(folderId) || !hasOwn(all, folderId)) return {};
  return sanitizeGroupOffsets(all[folderId]);
}

/** このフォルダの、以前の版で保存した補正 { [以前のグループ名]: 分 }（catalog.migrateLegacyOffsets に渡す） */
export function legacyOffsetsForFolder(settings, folderId) {
  const all = settings && settings.legacyCameraOffsets;
  if (!isPlainObject(all) || !validFolderId(folderId) || !hasOwn(all, folderId)) return {};
  return sanitizeGroupOffsets(all[folderId]);
}

/** このフォルダの、以前の版で保存した補正を消した新しい設定を返す（今のグループに移し終えたとき） */
export function withoutLegacyOffsets(settings, folderId) {
  const base = settings || {};
  const all = sanitizeFolderOffsets(base.legacyCameraOffsets);
  if (validFolderId(folderId)) delete all[folderId];
  return { ...base, legacyCameraOffsets: all };
}

/** このフォルダの補正を offsets に置き換えた新しい設定を返す（空ならフォルダごと消す。元の設定は変えない） */
export function withFolderOffsets(settings, folderId, offsets) {
  const base = settings || {};
  const all = sanitizeFolderOffsets(base.cameraOffsets);
  if (!validFolderId(folderId)) return { ...base, cameraOffsets: all };
  delete all[folderId];
  const groups = sanitizeGroupOffsets(offsets);
  if (Object.keys(groups).length) all[folderId] = groups;
  return { ...base, cameraOffsets: sanitizeFolderOffsets(all) };
}

function clampNum(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function bool(v, def) {
  if (typeof v === 'boolean') return v;
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return def;
}

/** 値を検証・正規化する（不正な値は既定値に戻す） */
export function sanitize(raw) {
  const s = { ...DEFAULTS, ...(raw || {}) };
  const out = {};
  out.authMode = s.authMode === 'apikey' ? 'apikey' : 'oauth';
  out.clientId = String(s.clientId || '').trim();
  out.apiKey = String(s.apiKey || '').trim();
  out.folder = String(s.folder || '').trim();
  out.title = String(s.title || '').slice(0, 120);
  out.photoSeconds = clampNum(s.photoSeconds, 1, 120, DEFAULTS.photoSeconds);
  out.transition = s.transition === 'none' ? 'none' : 'fade';
  out.kenBurns = bool(s.kenBurns, DEFAULTS.kenBurns);
  out.blurBackground = bool(s.blurBackground, DEFAULTS.blurBackground);
  out.videoMaxSeconds = clampNum(s.videoMaxSeconds, 0, 3600, DEFAULTS.videoMaxSeconds);
  out.videoMuted = bool(s.videoMuted, DEFAULTS.videoMuted);
  out.captions = ['datetime', 'datetime-name', 'none'].includes(s.captions) ? s.captions : DEFAULTS.captions;
  out.showTitleCard = bool(s.showTitleCard, DEFAULTS.showTitleCard);
  out.showDayCards = bool(s.showDayCards, DEFAULTS.showDayCards);
  out.loop = bool(s.loop, DEFAULTS.loop);
  out.includeSubfolders = bool(s.includeSubfolders, DEFAULTS.includeSubfolders);
  out.refreshMinutes = clampNum(s.refreshMinutes, 0, 1440, DEFAULTS.refreshMinutes);
  const tz = typeof s.timeZone === 'string' ? s.timeZone.trim() : '';
  out.timeZone = isValidTimeZone(tz) ? tz : DEFAULTS.timeZone;
  out.imageQuality = s.imageQuality === 'fast' ? 'fast' : 'original';
  out.preciseTimes = bool(s.preciseTimes, DEFAULTS.preciseTimes);
  out.cameraOffsets = sanitizeFolderOffsets(s.cameraOffsets);
  out.legacyCameraOffsets = sanitizeFolderOffsets(s.legacyCameraOffsets);
  return out;
}

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return isPlainObject(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * 以前の版で保存した補正（フォルダ別でない { グループ名: 分 }）を、そのとき保存されていたフォルダの分に移す。
 * 以前とグループの分け方が変わったファイル（機種名が読めるようになった動画など）にも同じ補正がかかるよう、
 * 元の値は legacyCameraOffsets にも残す（アプリがそのフォルダを開いたときに今のグループに移す）。
 * フォルダが分からなければ旧形式の分は捨てる
 */
export function migrateStoredOffsets(stored, fallbackFolder = '') {
  const co = stored && stored.cameraOffsets;
  if (!isPlainObject(co)) return stored;
  const flat = Object.entries(co).filter(([, v]) => !isPlainObject(v));
  if (!flat.length) return stored;
  const nested = Object.fromEntries(Object.entries(co).filter(([, v]) => isPlainObject(v)));
  const folderId = parseFolderInput(String(stored.folder || fallbackFolder || ''))?.id;
  if (folderId && validFolderId(folderId)) {
    // 新しい形式で保存済みの値を優先し、旧形式の値は足りない分だけ補う
    nested[folderId] = { ...Object.fromEntries(flat), ...(isPlainObject(nested[folderId]) ? nested[folderId] : {}) };
    const legacy = isPlainObject(stored.legacyCameraOffsets) ? { ...stored.legacyCameraOffsets } : {};
    legacy[folderId] = Object.fromEntries(flat);
    return { ...stored, cameraOffsets: nested, legacyCameraOffsets: legacy };
  }
  return { ...stored, cameraOffsets: nested };
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitize(settings)));
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

export function clearSettings() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** URL パラメータから読み取る設定 */
export function settingsFromUrl(search) {
  const p = new URLSearchParams(search);
  const o = {};
  const map = {
    folder: 'folder',
    key: 'apiKey',
    apiKey: 'apiKey',
    clientId: 'clientId',
    mode: 'authMode',
    tz: 'timeZone',
    interval: 'photoSeconds',
    title: 'title',
    loop: 'loop',
    muted: 'videoMuted',
    refresh: 'refreshMinutes',
  };
  for (const [param, key] of Object.entries(map)) {
    if (p.has(param)) o[key] = p.get(param);
  }
  if (o.authMode === 'key') o.authMode = 'apikey';
  // API キーだけが指定された共有リンクは API キーモード
  if (o.apiKey && !o.authMode) o.authMode = 'apikey';
  // カメラ別補正: fix=<分>:<グループ名>（複数可）。URL のフォルダの分として読む。
  // 0 も残す（loadSettings で保存済みの補正を打ち消せるように）。
  // fix=* があれば、このリンクの fix がそのフォルダの補正のすべて（保存済みの補正を置き換える。fix がなければ補正なし）
  const folderId = parseFolderInput(o.folder || '')?.id;
  if (folderId && validFolderId(folderId)) {
    const groups = {};
    let n = 0;
    let complete = false;
    for (const v of p.getAll('fix')) {
      if (v.trim() === FIX_COMPLETE) {
        complete = true;
        continue;
      }
      const m = /^\s*([+-]?\d{1,6})\s*:([\s\S]+)$/.exec(v);
      const label = m ? m[2].trim() : '';
      if (!label || label.length > MAX_LABEL_LENGTH || label === '__proto__') continue;
      if (!hasOwn(groups, label) && n++ >= MAX_OFFSET_GROUPS) break;
      groups[label] = toOffsetMinutes(m[1]);
    }
    if (n || complete) o.cameraOffsets = { [folderId]: groups };
    if (complete) o.replaceCameraOffsets = true;
  }
  return o;
}

/**
 * config.js で固定された接続設定。公開サイトで、細工したリンク（?clientId=... など）や保存済みの値に
 * 別の OAuth クライアント・API キーを使わせないため、config.js に値があればそれだけを使う。
 *  - clientId だけ: Google アカウントでのログインのみ（API キーは使えない）
 *  - apiKey だけ: API キーのみ（ログインは使えない）
 *  - 両方: 接続方法は選べるが、値は config.js のもの
 * @param {object} [deployConfig] window.SLIDESHOW_CONFIG
 * @returns {{clientId:boolean, apiKey:boolean, any:boolean, authMode:'oauth'|'apikey'|null, values:{clientId:string, apiKey:string}}}
 *   clientId / apiKey: その値が固定されているか。authMode: 接続方法が固定されていればその方法（選べるなら null）
 */
export function authLock(deployConfig) {
  const dc = deployConfig || {};
  const clientId = typeof dc.clientId === 'string' ? dc.clientId.trim() : '';
  const apiKey = typeof dc.apiKey === 'string' ? dc.apiKey.trim() : '';
  let authMode = null;
  if (clientId && !apiKey) authMode = 'oauth';
  else if (apiKey && !clientId) authMode = 'apikey';
  return Object.freeze({ clientId: !!clientId, apiKey: !!apiKey, any: !!(clientId || apiKey), authMode, values: Object.freeze({ clientId, apiKey }) });
}

/** 固定された接続設定を当てはめた新しい設定を返す（フォーム・URL・保存済みの値より常に優先） */
export function applyAuthLock(settings, lock) {
  const s = { ...(settings || {}) };
  if (!lock || !lock.any) return s;
  if (lock.clientId) s.clientId = lock.values.clientId;
  if (lock.apiKey) s.apiKey = lock.values.apiKey;
  if (lock.authMode === 'oauth') s.apiKey = '';
  if (lock.authMode === 'apikey') s.clientId = '';
  if (lock.authMode) s.authMode = lock.authMode;
  return s;
}

/** 固定された項目を取り除く（URL・保存済みの値から） */
function withoutLocked(o, lock) {
  const out = { ...o };
  if (lock.clientId || lock.authMode) delete out.clientId;
  if (lock.apiKey || lock.authMode) delete out.apiKey;
  if (lock.authMode) delete out.authMode;
  return out;
}

/**
 * 設定を読み込む。優先順位: URL パラメータ > ブラウザに保存した値 > config.js > 既定値。
 * ただし config.js に OAuth クライアント ID / API キーがあれば、接続設定はそれに固定する（authLock）
 * @param {object} [deployConfig] window.SLIDESHOW_CONFIG
 */
export function loadSettings(deployConfig = {}, search = '') {
  const dc = deployConfig || {};
  const lock = authLock(dc);
  const fromDeploy = {};
  if (dc.folder) fromDeploy.folder = dc.folder;
  if (dc.title) fromDeploy.title = dc.title;
  if (dc.timeZone) fromDeploy.timeZone = dc.timeZone;
  if (dc.authMode) fromDeploy.authMode = dc.authMode;
  const stored = migrateStoredOffsets(readStored(), fromDeploy.folder);
  const fromUrl = settingsFromUrl(search);
  const urlSettings = withoutLocked(fromUrl, lock);
  // API キーが固定されていれば、リンクの key は値も「key だけなら API キー方式」の規則も使わない（mode があればそれに従う）
  if (lock.apiKey && !new URLSearchParams(search).has('mode')) delete urlSettings.authMode;
  const merged = { ...fromDeploy, ...withoutLocked(stored, lock), ...urlSettings };
  if (fromUrl.cameraOffsets) {
    // URL の補正はそのフォルダの保存済みの補正に上書きでまとめる（他のフォルダはそのまま）。
    // fix=*（アプリが作る共有リンク）ならそのフォルダの補正を置き換える
    const all = sanitizeFolderOffsets(stored && stored.cameraOffsets);
    const legacy = sanitizeFolderOffsets(stored && stored.legacyCameraOffsets);
    for (const [fid, groups] of Object.entries(fromUrl.cameraOffsets)) {
      const prev = hasOwn(all, fid) && !fromUrl.replaceCameraOffsets ? all[fid] : {};
      delete all[fid];
      all[fid] = { ...prev, ...groups };
      if (fromUrl.replaceCameraOffsets) delete legacy[fid];
    }
    merged.cameraOffsets = all;
    merged.legacyCameraOffsets = legacy;
  }
  return sanitize(applyAuthLock(merged, lock));
}

/**
 * 接続設定が固定されていない配布で、リンク（URL）の OAuth クライアント ID / API キーが、このブラウザに
 * 保存済みの接続設定と違うか。違えば黙って使わず、利用者に確かめてもらう（細工したリンク対策）。
 * このブラウザに接続設定（クライアント ID か API キー）が保存されていれば、保存していない方式の値も
 * 「違う」とみなす（API キーだけを保存したブラウザに mode=oauth&clientId=... のリンクで別のクライアントを
 * 使わせる、などを防ぐ）。何も保存していなければ比べるものがないので null（初めて開くリンクはそのまま使う）。
 * @returns {{clientId:boolean, apiKey:boolean, stored:{authMode:string, clientId:string, apiKey:string}}|null}
 *   stored: 「保存済みの設定に戻す」で使う、保存済みの接続設定
 */
export function linkAuthConflict(deployConfig = {}, search = '') {
  if (authLock(deployConfig).any) return null;
  const stored = readStored();
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  if (!str(stored.clientId) && !str(stored.apiKey)) return null;
  const fromUrl = settingsFromUrl(search);
  const differs = (k) => !!str(fromUrl[k]) && str(fromUrl[k]) !== str(stored[k]);
  const clientId = differs('clientId');
  const apiKey = differs('apiKey');
  if (!clientId && !apiKey) return null;
  const s = sanitize(stored);
  return { clientId, apiKey, stored: { authMode: s.authMode, clientId: s.clientId, apiKey: s.apiKey } };
}

/**
 * 保存済みの設定の一部だけを書き換える（再生中のミュートの切り替え、時刻補正の適用など）。
 * 今の設定をまるごと保存すると、リンクで渡されただけの値（フォルダ・タイトル・API キーなど）まで
 * 保存されてしまうため、変えた項目だけを保存済みの値にまとめる。
 * @param {object|((stored:object)=>object)} patch 書き換える項目、または保存済みの設定から新しい設定を作る関数
 * @param {{fallbackFolder?:string}} [opts] 以前の版の補正を移すフォルダ（config.js のフォルダ）
 */
export function updateStoredSettings(patch, { fallbackFolder = '' } = {}) {
  const stored = migrateStoredOffsets(readStored(), fallbackFolder);
  const next = typeof patch === 'function' ? patch(stored) : { ...stored, ...(patch || {}) };
  // 検証はするが、既定値で埋めない（保存されていなかった項目は保存しないまま）
  const clean = sanitize(next);
  const out = {};
  for (const k of Object.keys(clean)) if (hasOwn(next, k)) out[k] = clean[k];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

/** source の、このフォルダの時刻補正（以前の版の補正も含む）だけを target に写した新しい設定を返す */
export function withFolderOffsetsFrom(target, source, folderId) {
  const s = withFolderOffsets(target, folderId, offsetsForFolder(source, folderId));
  const legacy = legacyOffsetsForFolder(source, folderId);
  const hasLegacy = Object.keys(legacy).length > 0 && validFolderId(folderId);
  // 以前の版の補正がどちらにもなければ、項目ごと書かない
  if (!hasLegacy && !(target && target.legacyCameraOffsets)) return s;
  const out = withoutLegacyOffsets(s, folderId);
  if (hasLegacy) out.legacyCameraOffsets = { ...out.legacyCameraOffsets, [folderId]: legacy };
  return out;
}

/**
 * 同じ設定で開ける共有用 URL を作る（OAuth の場合は各自がログインする）。
 * config.js で固定された接続設定（lock）はリンクに含めない（開いた側も同じ config.js を使う）
 */
export function buildShareUrl(baseUrl, settings, lock = authLock({})) {
  const u = new URL(baseUrl);
  u.search = '';
  u.hash = '';
  if (settings.folder) u.searchParams.set('folder', settings.folder);
  // 接続方法を選べる配布なら方法だけは伝える。クライアント ID / API キーは固定されていなければ付ける
  if (!lock.authMode) u.searchParams.set('mode', settings.authMode === 'apikey' ? 'apikey' : 'oauth');
  if (!lock.any) {
    if (settings.authMode === 'apikey') {
      if (settings.apiKey) u.searchParams.set('key', settings.apiKey);
    } else if (settings.clientId) {
      u.searchParams.set('clientId', settings.clientId);
    }
  }
  // 既定のタイムゾーンは開く人の端末によって違うので、同じ値でも必ず付ける
  u.searchParams.set('tz', settings.timeZone || DEFAULTS.timeZone);
  if (settings.title) u.searchParams.set('title', settings.title);
  // このフォルダのカメラ別補正（分を先に書くのでグループ名に ':' があってもよい）。
  // fix=* で、これがこのフォルダの補正のすべてであることを示す（開いた側の古い補正を残さない。補正がなくても付ける）
  const folderId = parseFolderInput(settings.folder || '')?.id;
  if (folderId && validFolderId(folderId)) {
    for (const [group, minutes] of Object.entries(offsetsForFolder(settings, folderId))) {
      u.searchParams.append('fix', `${minutes}:${group}`);
    }
    u.searchParams.append('fix', FIX_COMPLETE);
  }
  return u.toString();
}

/**
 * テスト用に Drive API の接続先を差し替える（localhost で開いた場合のみ許可。
 * 公開サイトで任意の接続先にトークンを送らせる攻撃を防ぐため）。
 */
export function resolveApiBase(location) {
  const p = new URLSearchParams(location.search);
  const override = p.get('apiBase');
  if (!override) return DRIVE_API_DEFAULT;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!local) return DRIVE_API_DEFAULT;
  try {
    const u = new URL(override);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return DRIVE_API_DEFAULT;
    return u.origin;
  } catch {
    return DRIVE_API_DEFAULT;
  }
}
