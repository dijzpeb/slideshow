// 設定の既定値・保存・URL パラメータ

import { isValidTimeZone } from './timeutil.js';
import { DRIVE_API_DEFAULT } from './drive.js';

const STORAGE_KEY = 'finland-slideshow.settings.v1';

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
  timeZone: 'Europe/Helsinki',
  imageQuality: 'original', // 'original' | 'fast'
  preciseTimes: true, // 写真の EXIF をファイルから直接読んで撮影時刻を補正する
  cameraOffsets: {}, // { [カメラ名]: 分 }
});

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
  out.timeZone = isValidTimeZone(s.timeZone) ? s.timeZone : DEFAULTS.timeZone;
  out.imageQuality = s.imageQuality === 'fast' ? 'fast' : 'original';
  out.preciseTimes = bool(s.preciseTimes, DEFAULTS.preciseTimes);
  out.cameraOffsets = {};
  if (s.cameraOffsets && typeof s.cameraOffsets === 'object') {
    for (const [k, v] of Object.entries(s.cameraOffsets)) {
      const n = Math.round(Number(v));
      if (k && Number.isFinite(n) && n !== 0 && Math.abs(n) <= 48 * 60) out.cameraOffsets[k] = n;
    }
  }
  return out;
}

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
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
  return o;
}

/**
 * 設定を読み込む。優先順位: URL パラメータ > ブラウザに保存した値 > config.js > 既定値
 * @param {object} [deployConfig] window.SLIDESHOW_CONFIG
 */
export function loadSettings(deployConfig = {}, search = '') {
  const dc = deployConfig || {};
  const fromDeploy = {};
  if (dc.clientId) fromDeploy.clientId = dc.clientId;
  if (dc.apiKey) fromDeploy.apiKey = dc.apiKey;
  if (dc.folder) fromDeploy.folder = dc.folder;
  if (dc.title) fromDeploy.title = dc.title;
  if (dc.timeZone) fromDeploy.timeZone = dc.timeZone;
  if (dc.authMode) fromDeploy.authMode = dc.authMode;
  else if (dc.apiKey && !dc.clientId) fromDeploy.authMode = 'apikey';
  const stored = readStored();
  const fromUrl = settingsFromUrl(search);
  return sanitize({ ...fromDeploy, ...stored, ...fromUrl });
}

/** 同じ設定で開ける共有用 URL を作る（OAuth の場合は各自がログインする） */
export function buildShareUrl(baseUrl, settings) {
  const u = new URL(baseUrl);
  u.search = '';
  u.hash = '';
  if (settings.folder) u.searchParams.set('folder', settings.folder);
  if (settings.authMode === 'apikey') {
    u.searchParams.set('mode', 'apikey');
    if (settings.apiKey) u.searchParams.set('key', settings.apiKey);
  } else {
    u.searchParams.set('mode', 'oauth');
    if (settings.clientId) u.searchParams.set('clientId', settings.clientId);
  }
  if (settings.timeZone !== DEFAULTS.timeZone) u.searchParams.set('tz', settings.timeZone);
  if (settings.title) u.searchParams.set('title', settings.title);
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
