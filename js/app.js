// アプリ本体: 設定画面 → フォルダの読み込み → 撮影日時の解析 → スライドショー

import { $, $$, h, icon, toast } from './dom.js';
import {
  loadSettings,
  saveSettings,
  sanitize,
  buildShareUrl,
  resolveApiBase,
  DEFAULTS,
  offsetsForFolder,
  withFolderOffsets,
  legacyOffsetsForFolder,
  withoutLegacyOffsets,
  authLock,
  applyAuthLock,
  linkAuthConflict,
  updateStoredSettings,
  withFolderOffsetsFrom,
} from './settings.js';
import { OAuthSession, AuthError, EXPIRY_WARNING_MS } from './auth.js';
import { DriveClient, DriveError, AuthRequiredError, parseFolderInput } from './drive.js';
import { extractAll, readCached, clearMetaCache, hasMetaCache } from './extract.js';
import {
  buildCatalog,
  summarizeGroups,
  buildSlides,
  migrateLegacyOffsets,
  TIME_SOURCE_LABELS,
  ZONED_GROUP_SUFFIX,
  MVHD_VIDEO_GROUP_SUFFIX,
} from './catalog.js';
import { MediaLoader, setupServiceWorker } from './loader.js';
import { Player } from './player.js';
import { formatDateJa, formatTimeJa, formatDateTimeJa, isValidTimeZone, tzOffsetMs, formatOffset } from './timeutil.js';

const params = new URLSearchParams(location.search);
const apiBase = resolveApiBase(location);
const deployConfig = window.SLIDESHOW_CONFIG || {};
/** config.js で固定された接続設定（OAuth クライアント ID / API キー）。URL・保存済みの値・フォームより優先 */
const lock = authLock(deployConfig);
/** 固定されていない配布で、リンクの接続設定が保存済みの値と違う（黙って使わず、確かめてもらう） */
const linkConflict = linkAuthConflict(deployConfig, location.search);
/** 保存済みの設定の一部だけを書き換える（リンクで渡されただけの値は保存しない） */
const storeOnly = (patch) => updateStoredSettings(patch, { fallbackFolder: deployConfig.folder || '' });
/** 再生中にプレイヤーが変える設定（これだけを保存する） */
const PLAYER_SETTINGS = ['videoMuted'];

const state = {
  settings: loadSettings(deployConfig, location.search),
  session: null, // OAuthSession
  drive: null, // DriveClient
  sw: null,
  swPromise: null,
  loader: null,
  player: null,
  root: null, // ルートフォルダのメタデータ
  files: [],
  extracted: new Map(),
  items: [],
  loadAbort: null,
  refineAbort: null,
  refineInterrupted: false, // 撮影日時の精密解析がログイン切れで止まった（ログインし直したらやり直す）
  refreshAbort: null,
  refreshTimer: null,
  refreshing: false,
  screen: 'setup',
};

/** start() / backToSetup() のたびに増える。古い読み込み・更新・解析が新しい状態に書き込まないようにする */
let sessionGen = 0;
/** トークンの残りがこれより短ければ、開始・フォルダ検索の前にログインし直す */
const MIN_TOKEN_MS = 5 * 60000;

// ---------------------------------------------------------------------------
// 画面切り替え

function showScreen(name) {
  state.screen = name;
  for (const id of ['setup', 'loading', 'player']) $(`#${id}`).hidden = id !== name;
  document.body.dataset.screen = name;
}

// ---------------------------------------------------------------------------
// 設定フォーム

const form = $('#setup-form');

function fillForm(s) {
  form.folder.value = s.folder;
  form.clientId.value = s.clientId;
  form.apiKey.value = s.apiKey;
  for (const r of $$('input[name="authMode"]', form)) r.checked = r.value === s.authMode;
  for (const name of ['photoSeconds', 'videoMaxSeconds', 'transition', 'captions', 'timeZone', 'refreshMinutes', 'imageQuality', 'title']) {
    form[name].value = s[name];
  }
  for (const name of ['kenBurns', 'blurBackground', 'showTitleCard', 'showDayCards', 'videoMuted', 'loop', 'includeSubfolders', 'preciseTimes']) {
    form[name].checked = !!s[name];
  }
  // 配布時に config.js でクライアント ID が設定済みなら詳細欄は閉じておく
  $('#oauth-advanced').open = !s.clientId;
  syncModePanels();
}

function readForm() {
  const s = { ...state.settings };
  s.folder = form.folder.value.trim();
  s.clientId = form.clientId.value.trim();
  s.apiKey = form.apiKey.value.trim();
  s.authMode = ($('input[name="authMode"]:checked', form) || {}).value || 'oauth';
  for (const name of ['photoSeconds', 'videoMaxSeconds', 'refreshMinutes']) s[name] = Number(form[name].value);
  for (const name of ['transition', 'captions', 'imageQuality', 'title']) s[name] = form[name].value;
  s.timeZone = form.timeZone.value.trim() || DEFAULTS.timeZone;
  for (const name of ['kenBurns', 'blurBackground', 'showTitleCard', 'showDayCards', 'videoMuted', 'loop', 'includeSubfolders', 'preciseTimes']) {
    s[name] = form[name].checked;
  }
  // config.js で固定された接続設定は、フォームの値（書き換えられていても）より優先する
  return applyAuthLock(s, lock);
}

/** フォームの接続設定（固定された値を当てはめたもの） */
function formAuth() {
  const mode = ($('input[name="authMode"]:checked', form) || {}).value || 'oauth';
  return applyAuthLock({ authMode: mode, clientId: form.clientId.value.trim(), apiKey: form.apiKey.value.trim() }, lock);
}

/** config.js で固定された接続設定: 使えない接続方法と、固定された入力欄を隠す */
function applyLockToForm() {
  if (!lock.any) return;
  for (const radio of $$('input[name="authMode"]', form)) {
    const usable = !lock.authMode || radio.value === lock.authMode;
    radio.disabled = !usable;
    radio.closest('.radio-card').hidden = !usable;
  }
  if (lock.clientId || lock.authMode === 'apikey') {
    $('#oauth-advanced').hidden = true;
    form.clientId.readOnly = true;
  }
  if (lock.apiKey || lock.authMode === 'oauth') {
    $('#apikey-field').hidden = true;
    form.apiKey.readOnly = true;
  }
  $('#apikey-locked').hidden = !lock.apiKey;
  // 「はじめての方へ」: クライアント ID / API キーを作る手順は不要（入力欄もない）
  for (const li of $$('[data-help="setup"]')) li.hidden = true;
  $('#help-locked').hidden = false;
}

/** リンクの接続設定が保存済みの値と違うときの警告（「保存済みの設定に戻す」で元に戻せる） */
function showLinkAuthWarning() {
  const box = $('#link-auth-warning');
  box.hidden = false;
  if (linkConflict.clientId) $('#oauth-advanced').open = true;
  box.scrollIntoView({ block: 'nearest' });
}

$('#btn-link-auth-revert').addEventListener('click', () => {
  if (!linkConflict) return;
  const st = linkConflict.stored;
  form.clientId.value = st.clientId;
  form.apiKey.value = st.apiKey;
  for (const radio of $$('input[name="authMode"]', form)) radio.checked = radio.value === st.authMode;
  state.settings = { ...state.settings, ...st };
  $('#link-auth-warning').hidden = true;
  syncModePanels();
  toast('保存済みの接続設定に戻しました');
});

function syncModePanels() {
  const mode = ($('input[name="authMode"]:checked', form) || {}).value || 'oauth';
  for (const p of $$('[data-mode]')) p.hidden = p.dataset.mode !== mode;
  if (mode === 'oauth') {
    ensureSession(formAuth().clientId);
    updateLoginStatus();
  }
}

function setupError(msg) {
  const box = $('#setup-error');
  if (!msg) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  box.textContent = msg;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function fillTimeZones() {
  const list = $('#tz-list');
  // 先頭はこの端末のタイムゾーン（既定値）と、よく使うもの
  let zones = [DEFAULTS.timeZone, 'Asia/Tokyo', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'UTC'];
  try {
    if (Intl.supportedValuesOf) zones = [...new Set([...zones, ...Intl.supportedValuesOf('timeZone')])];
  } catch {
    /* ignore */
  }
  list.replaceChildren(...zones.map((z) => h('option', { value: z })));
}

// ---------------------------------------------------------------------------
// ログイン（OAuth）

function ensureSession(clientId) {
  if (state.session && clientId && state.session.clientId === clientId) return state.session;
  disposeSession(state.session);
  state.session = null;
  if (!clientId) return null;
  const session = new OAuthSession(clientId);
  session.addEventListener('change', onSessionChange);
  session.addEventListener('expiring', onTokenExpiring);
  session.addEventListener('expired', onTokenExpired);
  state.session = session;
  // ボタンを押したときにすぐポップアップを開けるよう、ライブラリを先に読み込んでおく
  session.init().catch((e) => {
    if (state.screen === 'setup') updateLoginStatus(e.message);
  });
  return session;
}

/** 使わなくなったセッションのイベントとタイマーを止める */
function disposeSession(session) {
  if (!session) return;
  session.removeEventListener('change', onSessionChange);
  session.removeEventListener('expiring', onTokenExpiring);
  session.removeEventListener('expired', onTokenExpired);
  session.dispose?.();
}

/** 今のスライドショーが OAuth でこのセッションを使っているか */
function isPlayerSession(session) {
  return !!session && session === state.session && state.drive?.mode === 'oauth';
}

function onSessionChange(e) {
  const session = e.target;
  if (session !== state.session) return;
  // 十分に長いトークンになったら「まもなく期限切れ」の表示は不要
  if (session.isValidFor(EXPIRY_WARNING_MS)) removeExpiringBanner();
  updateLoginStatus();
  pushCreds();
  if (state.screen === 'player' && isPlayerSession(session) && session.signedIn) {
    // ログインし直せた（「ログインして続ける」でも「延長する」でも）: 期限切れの画面が出ていれば閉じて続きから再生し、
    // ログイン切れで止まった撮影日時の精密解析をやり直す
    if (!$('#auth-overlay').hidden) resumeAfterLogin();
    if (state.refineInterrupted) refineInBackground();
  }
}

function updateLoginStatus(errorMsg) {
  const el = $('#login-status');
  const session = state.session;
  if (!formAuth().clientId) {
    el.replaceChildren(h('span', { class: 'muted' }, ['OAuth クライアント ID を入力してください。']));
    return;
  }
  if (errorMsg) {
    el.replaceChildren(h('span', { class: 'error-text' }, [errorMsg]));
    return;
  }
  const loginBtn = () =>
    h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => signIn().catch((e) => updateLoginStatus(e.message)) }, ['ログイン']);
  const logoutBtn = () => h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => signOut(session) }, ['ログアウト']);
  if (session && session.signedIn) {
    const mins = Math.max(0, Math.round((session.expiresAt - Date.now()) / 60000));
    el.replaceChildren(h('span', { class: 'ok-text' }, [`ログイン中（あと約 ${mins} 分有効）`]), logoutBtn());
  } else if (session && session.hasToken) {
    // 期限切れのトークンが残っている: ログインし直すか、ログアウトして消せる
    el.replaceChildren(h('span', { class: 'muted' }, ['ログインの有効期限が切れました。']), loginBtn(), logoutBtn());
  } else {
    // トークンはないが、以前の撮影日時の解析結果が残っている（API に拒否された、タブを開き直したなど）: ログアウトで消せる
    const extra = hasMetaCache() ? [logoutBtn()] : [];
    el.replaceChildren(h('span', { class: 'muted' }, ['「スライドショーを開始」を押すと Google のログイン画面が開きます。']), loginBtn(), ...extra);
  }
}

/**
 * ログアウト: トークンを取り消して消し、このブラウザに残した撮影日時の解析結果と読み込んだ写真も消す
 * （保存した設定（フォルダ・時刻補正など）は残す）。トークンがなくても（期限切れ・拒否のあと）解析結果は消す
 */
function signOut(session) {
  clearMetaCache();
  state.loader?.clear();
  session?.signOut();
  updateLoginStatus();
  toast('ログアウトしました');
}

/** ログインする（ユーザー操作の中で呼ぶこと） */
async function signIn() {
  const session = ensureSession(formAuth().clientId || state.settings.clientId);
  if (!session) throw new AuthError('OAuth クライアント ID を入力してください。', 'config');
  if (!session.client) await session.init();
  const token = await session.request({ prompt: '' });
  return token;
}

let expiringToast = null;
function removeExpiringBanner() {
  expiringToast?.remove();
  expiringToast = null;
}

function onTokenExpiring(e) {
  const session = e.target;
  if (state.screen !== 'player' || !isPlayerSession(session)) return;
  showExpiringBanner(session);
}

/** 「まもなくログインの有効期限が切れます」の表示 */
function showExpiringBanner(session) {
  removeExpiringBanner();
  const banner = h('div', { class: 'expiring-banner' }, [
    h('span', {}, ['まもなくログインの有効期限が切れます。']),
    h('button', {
      type: 'button',
      class: 'btn btn-light btn-sm',
      onclick: async () => {
        try {
          await session.request({ prompt: '' });
          if (expiringToast === banner) removeExpiringBanner();
          toast('ログインを延長しました');
        } catch (err) {
          toast(err.message, { kind: 'warn' });
        }
      },
    }, ['延長する']),
    h('button', { type: 'button', class: 'ctl', 'aria-label': '閉じる', onclick: () => expiringToast === banner && removeExpiringBanner() }, [icon('close')]),
  ]);
  expiringToast = banner;
  $('#player').append(banner);
}

function onTokenExpired(e) {
  const session = e.target;
  if (session !== state.session) return;
  if (state.screen === 'player') {
    if (!isPlayerSession(session)) return;
    removeExpiringBanner();
    const wasPlaying = !!state.player?.playing;
    state.player?.pause();
    showAuthOverlay(wasPlaying);
  } else if (state.screen === 'setup') {
    removeExpiringBanner();
    updateLoginStatus();
  }
}

/** 再ログイン後に再生を続けるか（オーバーレイを開いたときに再生中だったか） */
let authWasPlaying = false;

/** 再ログインの画面を出す。wasPlaying: 出す直前まで再生中だったか */
function showAuthOverlay(wasPlaying = false) {
  const overlay = $('#auth-overlay');
  if (overlay.hidden) authWasPlaying = !!wasPlaying;
  // 期限切れのトークンを Service Worker からも消す（再ログイン直後の動画が古いトークンで 401 にならないように）
  pushCreds();
  $('#auth-error').textContent = '';
  overlay.hidden = false;
  // モーダル: 後ろのスライドショーと一覧にはフォーカスもクリックも届かないようにする
  $('#player').inert = true;
  $('#grid-overlay').inert = true;
  $('#btn-reauth').focus();
}

/** 再ログインの画面を閉じる（後ろの一覧が開いていれば、そこにフォーカスを戻す） */
function hideAuthOverlay() {
  const overlay = $('#auth-overlay');
  if (overlay.hidden) return;
  overlay.hidden = true;
  const grid = $('#grid-overlay');
  grid.inert = false;
  $('#player').inert = !grid.hidden;
  if (!grid.hidden) grid.focus({ preventScroll: true });
}

/** ログインし直せたあと: 再ログインの画面を閉じて、止まっていたスライドから続ける */
function resumeAfterLogin() {
  hideAuthOverlay();
  pushCreds();
  // 止まっていたスライドを読み込み直す（読み込めたときに再生中なら、そのまま再生が始まる）
  state.player?.retry();
  // 一覧が開いているときや一時停止中だったときは再生を始めない（一覧を閉じたときに決める）
  if (authWasPlaying && $('#grid-overlay').hidden) state.player?.play();
  authWasPlaying = false;
}

$('#btn-reauth').addEventListener('click', async () => {
  const session = state.session;
  if (!session || state.drive?.mode !== 'oauth') {
    hideAuthOverlay();
    return;
  }
  try {
    if (!session.client) await session.init();
    await session.request({ prompt: '' });
    // 新しいトークンが届いたときに onSessionChange が続きから再生している
    if (session === state.session && state.screen === 'player' && !$('#auth-overlay').hidden) resumeAfterLogin();
  } catch (e) {
    $('#auth-error').textContent = e.message;
  }
});
$('#btn-auth-cancel').addEventListener('click', () => {
  hideAuthOverlay();
  backToSetup();
});

// ---------------------------------------------------------------------------
// Drive / Service Worker

function makeDrive(s) {
  if (s.authMode === 'apikey') {
    return new DriveClient({ apiBase, mode: 'apikey', apiKey: s.apiKey });
  }
  const session = ensureSession(s.clientId);
  return new DriveClient({ apiBase, mode: 'oauth', getToken: (force, failedToken) => session.getToken(force, failedToken) });
}

async function getCreds(force, failedToken) {
  if (!state.drive) return null;
  return state.drive.credentials(force, failedToken);
}

function pushCreds() {
  if (!state.sw || !state.drive) return;
  state.drive.credentials(false).then(
    (c) => state.sw && state.sw.pushCreds(c),
    // 使えるトークンがなければ、このタブの古い接続情報を Service Worker から消す
    () => state.sw && state.sw.pushCreds(null),
  );
}

function ensureServiceWorker() {
  if (!state.swPromise) {
    state.swPromise = setupServiceWorker({ getCreds })
      .catch(() => null)
      .then((sw) => {
        state.sw = sw || null;
        if (!sw) console.info('Service Worker を使わずに再生します（動画は全体をダウンロードしてから再生）');
        return state.sw;
      });
  }
  return state.swPromise;
}

// ---------------------------------------------------------------------------
// 読み込み

function setLoading(title, detail = '', frac = null) {
  $('#loading-title').textContent = title;
  $('#loading-detail').textContent = detail;
  const bar = $('#loading-bar');
  bar.style.transform = `scaleX(${frac == null ? 0 : Math.max(0, Math.min(1, frac))})`;
  bar.parentElement.classList.toggle('indeterminate', frac == null);
}

function timeZoneError(tz) {
  return isValidTimeZone(tz) ? null : `タイムゾーン「${tz}」が正しくありません（例：Europe/Paris、America/New_York）。`;
}

function validate(s) {
  if (!s.folder) return 'フォルダの URL または ID を入力してください。';
  if (!parseFolderInput(s.folder)) return 'フォルダの URL の形式が正しくありません。ドライブでフォルダを開いたときの URL を貼り付けてください。';
  if (s.authMode === 'apikey' && !s.apiKey) return 'API キーを入力してください。';
  if (s.authMode === 'oauth' && !s.clientId) return 'OAuth クライアント ID を入力してください（「OAuth クライアント ID」の欄）。';
  return timeZoneError(s.timeZone);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setupError(null);
  // sanitize は不正な値を既定値に戻すので、入力そのものを先に検証する
  const raw = readForm();
  const err = validate(raw);
  if (err) {
    setupError(err);
    return;
  }
  const s = sanitize(raw);
  state.settings = s;
  // 画面に出ている値を保存する（リンクの接続設定の警告が出ていれば、利用者はそれを見て開始している）
  saveSettings(s);
  $('#link-auth-warning').hidden = true;
  if (s.authMode === 'oauth') {
    const session = ensureSession(s.clientId);
    if (!session.isValidFor(MIN_TOKEN_MS)) {
      try {
        // クリック直後に呼ぶ（ポップアップブロック回避）
        if (!session.client) await session.init();
        await session.request({ prompt: '' });
      } catch (e2) {
        setupError(e2.message);
        return;
      }
    }
  }
  start();
});

form.addEventListener('change', (e) => {
  if (e.target.name === 'authMode') syncModePanels();
  if (e.target.name === 'clientId') syncModePanels();
});
form.clientId.addEventListener('input', () => updateLoginStatus());

$('#btn-share').addEventListener('click', async () => {
  setupError(null);
  const raw = readForm();
  if (!raw.folder) {
    setupError('先にフォルダの URL を入力してください。');
    return;
  }
  // sanitize は不正なタイムゾーンを既定値に戻してしまうので、リンクを作る前に入力そのものを確かめる
  const err = parseFolderInput(raw.folder) ? timeZoneError(raw.timeZone) : validate(raw);
  if (err) {
    setupError(err);
    return;
  }
  const url = buildShareUrl(location.href, sanitize(raw), lock);
  try {
    await navigator.clipboard.writeText(url);
    toast('共有用リンクをコピーしました');
  } catch {
    window.prompt('このリンクをコピーしてください', url);
  }
});

$('#btn-cancel-load').addEventListener('click', () => {
  state.loadAbort?.abort();
  state.loadAbort = null;
  showScreen('setup');
});

/** 進行中の自動更新・精密解析を止め、古い処理の結果が使われないようにする */
function endSession() {
  sessionGen++;
  stopRefreshTimer();
  cancelRefresh();
  state.refineAbort?.abort();
  state.refineAbort = null;
  state.refineInterrupted = false;
}

async function start() {
  const s = state.settings;
  showScreen('loading');
  setLoading('Google ドライブに接続中…');
  state.loadAbort?.abort();
  const abort = new AbortController();
  state.loadAbort = abort;
  endSession();
  // フォルダ検索の画面は閉じる（ログインの完了を待っている間に開始が押された場合など）
  $('#folder-overlay').hidden = true;
  const stale = () => abort.signal.aborted || state.loadAbort !== abort;
  try {
    // この DriveClient がフォルダ・ファイルのリソースキーを覚えるので、再生・更新・精密解析にも同じものを使う
    const drive = makeDrive(s);
    state.drive = drive;
    const folder = parseFolderInput(s.folder);
    if (folder.resourceKey) drive.rememberResourceKey(folder.id, folder.resourceKey);
    const swP = ensureServiceWorker();
    const listing = await drive.listMediaTree(folder.id, {
      recursive: s.includeSubfolders,
      signal: abort.signal,
      onProgress: ({ folders, files }) => setLoading('フォルダを読み込み中…', `${folders} フォルダ・写真と動画 ${files} 件`),
    });
    if (stale()) return;
    state.root = listing.root;
    state.files = listing.files;
    if (!state.files.length) {
      throw new DriveError(
        `フォルダ「${listing.root.name}」に写真・動画が見つかりませんでした。${s.includeSubfolders ? '' : '（サブフォルダを含める設定もお試しください）'}`,
      );
    }
    setLoading('撮影日時を確認中…', '', 0);
    const required = await extractAll(drive, state.files, {
      phases: ['required'],
      signal: abort.signal,
      onProgress: (done, total) => total && setLoading('撮影日時を確認中…', `${done} / ${total}（動画など）`, done / total),
    });
    if (stale()) return;
    // 以前に精密解析した結果があれば最初から使う（残りは再生しながら裏で解析）
    state.extracted = s.preciseTimes ? new Map([...readCached(state.files, ['refine']), ...required]) : required;
    // Service Worker が使えなければ null（使わずに再生する）
    await swP;
    // 待っている間にキャンセル・別の開始があった
    if (stale()) return;
    pushCreds();
    rebuildCatalog();
    startPlayer();
    startRefreshTimer();
    refineInBackground();
    if (listing.skippedFolders) toast(`アクセスできないフォルダを ${listing.skippedFolders} 件スキップしました`, { kind: 'warn' });
  } catch (e) {
    if (stale()) return;
    console.error(e);
    showScreen('setup');
    if (e instanceof AuthRequiredError) {
      setupError('ログインの有効期限が切れました。もう一度「スライドショーを開始」を押してください。');
      state.session?.getToken(true);
    } else {
      setupError(e.message || String(e));
    }
  }
}

/** 写真の EXIF をファイルから直接読み、撮影時刻をより正確にする（再生を止めずに裏で実行） */
async function refineInBackground() {
  state.refineAbort?.abort();
  state.refineInterrupted = false;
  if (!state.settings.preciseTimes || !state.drive || !state.root) return;
  const abort = new AbortController();
  state.refineAbort = abort;
  const drive = state.drive;
  const rootId = state.root.id;
  const gen = sessionGen;
  const files = state.files;
  // 別のフォルダ・設定画面に移ったあとは何も書き込まない
  const stale = () => abort.signal.aborted || gen !== sessionGen || state.drive !== drive || state.root?.id !== rootId;
  let pending = 0;
  const timesSig = () => state.items.map((i) => `${i.id}@${i.epoch}`).join('\n');
  const groupsSig = () => state.items.map((i) => i.group).join('\n');
  const apply = () => {
    if (!pending || stale()) return;
    pending = 0;
    const beforeTimes = timesSig();
    const beforeGroups = groupsSig();
    rebuildCatalog();
    const timesChanged = beforeTimes !== timesSig();
    if (timesChanged) state.player?.setItems(state.items);
    if ($('#grid-overlay').hidden) return;
    // 一覧は時刻・順番が変わったときだけ作り直す。補正の表はグループが変わったときも作り直す
    if (timesChanged) renderGrid();
    if (timesChanged || beforeGroups !== groupsSig()) renderTimeFix({ keepEdits: true });
  };
  try {
    await extractAll(drive, files, {
      phases: ['refine'],
      signal: abort.signal,
      concurrency: 3,
      onResult: (id, data) => {
        if (stale()) return;
        if (data) {
          state.extracted.set(id, data);
          pending++;
        }
        if (pending >= 40) apply();
      },
    });
  } catch (e) {
    if (!stale()) {
      console.info('撮影日時の精密解析を中断しました:', e && e.message);
      if (e instanceof AuthRequiredError) state.refineInterrupted = true;
    }
  }
  if (!stale()) apply();
}

/** 時刻補正を保存するキー（設定のフォルダ ID。共有リンクの fix= と同じ） */
function currentFolderId() {
  return parseFolderInput(state.settings.folder)?.id || state.root?.id || '';
}

function rebuildCatalog() {
  const folderId = currentFolderId();
  // 以前の版で保存した補正を、グループの分け方が変わったファイル（機種名が読めるようになった動画など）の今のグループにも
  // 移す（以前と同じファイルに同じ補正がかかるように）。次に設定を保存したときに新しい形式で保存される
  const legacy = legacyOffsetsForFolder(state.settings, folderId);
  if (Object.keys(legacy).length) {
    const own = offsetsForFolder(state.settings, folderId);
    const moved = migrateLegacyOffsets(state.files, state.extracted, { timeZone: state.settings.timeZone, cameraOffsets: own, legacyOffsets: legacy });
    state.settings = sanitize(withoutLegacyOffsets(withFolderOffsets(state.settings, folderId, { ...moved, ...own }), folderId));
  }
  const s = state.settings;
  state.items = buildCatalog(state.files, state.extracted, { timeZone: s.timeZone, cameraOffsets: offsetsForFolder(s, folderId) });
}

function title() {
  return state.settings.title || (state.root && state.root.name) || 'スライドショー';
}

function startPlayer() {
  if (!state.loader || state.loader.drive !== state.drive) {
    state.loader?.clear();
    state.loader = new MediaLoader({ drive: state.drive, sw: state.sw, getSettings: () => state.settings });
  }
  if (!state.player) {
    state.player = new Player($('#player'), {
      loader: state.loader,
      getSettings: () => state.settings,
      getTitle: title,
      // info.wasPlaying: 止める直前に再生中だったか（渡されなければ再生中だったとみなす）
      onAuthRequired: (err, info) => {
        if (state.drive?.mode === 'oauth') showAuthOverlay(info?.wasPlaying ?? true);
      },
      onOpenGrid: () => openGrid(),
      onOpenSettings: () => backToSetup(),
    });
    // 変えた項目だけを保存する（リンクで渡されただけのフォルダ・タイトル・API キーなどは保存しない）
    state.player.addEventListener('settingschange', (e) => {
      const patch = {};
      for (const k of PLAYER_SETTINGS) if (e.detail && k in e.detail) patch[k] = e.detail[k];
      if (Object.keys(patch).length) storeOnly(patch);
    });
  } else {
    state.player.loader = state.loader;
  }
  state.player.setItems(state.items);
  document.title = `${title()} - スライドショー`;
  showScreen('player');
  state.player.start(0);
  // 読み込み中に「まもなく期限切れ」の時刻を過ぎていたら（'expiring' は読み込み中に届いて使われなかった）、ここで知らせる
  const session = state.session;
  if (isPlayerSession(session) && session.signedIn && !session.isValidFor(EXPIRY_WARNING_MS)) showExpiringBanner(session);
}

function backToSetup() {
  state.loadAbort?.abort();
  state.loadAbort = null;
  endSession();
  state.player?.stop();
  removeExpiringBanner();
  hideAuthOverlay();
  hideGrid();
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  fillForm(state.settings);
  showScreen('setup');
  document.title = '旅の写真スライドショー';
}

// ---------------------------------------------------------------------------
// 自動更新

function startRefreshTimer() {
  stopRefreshTimer();
  const min = state.settings.refreshMinutes;
  if (!min) return;
  state.refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && state.screen === 'player') refresh({ silent: true });
  }, min * 60000);
}

function stopRefreshTimer() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

function fileKey(f) {
  return `${f.id}|${f.modifiedTime || ''}|${f.md5Checksum || ''}`;
}

let refreshGen = 0;

/** 進行中の更新を中止する（結果は捨てる） */
function cancelRefresh() {
  refreshGen++;
  state.refreshAbort?.abort();
  state.refreshAbort = null;
  state.refreshing = false;
}

async function refresh({ silent = false } = {}) {
  if (state.refreshing || !state.drive || !state.root) return;
  state.refreshing = true;
  const gen = ++refreshGen;
  const sGen = sessionGen;
  const abort = new AbortController();
  state.refreshAbort = abort;
  const drive = state.drive;
  const rootId = state.root.id;
  // 別のフォルダを開いた・設定画面に戻ったなどで、この更新の結果はもう使わない
  const stale = () => abort.signal.aborted || gen !== refreshGen || sGen !== sessionGen || state.drive !== drive || state.root?.id !== rootId;
  try {
    const listing = await drive.listMediaTree(rootId, { recursive: state.settings.includeSubfolders, signal: abort.signal });
    if (stale()) return;
    const required = await extractAll(drive, listing.files, { phases: ['required'], signal: abort.signal });
    if (stale()) return;
    const before = new Set(state.files.map(fileKey));
    const after = new Set(listing.files.map(fileKey));
    const beforeIds = new Set(state.files.map((f) => f.id));
    const afterIds = new Set(listing.files.map((f) => f.id));
    const added = listing.files.filter((f) => !beforeIds.has(f.id)).length;
    const removed = state.files.filter((f) => !afterIds.has(f.id)).length;
    const changed = [...after].some((k) => !before.has(k)) || removed > 0;
    const extracted = new Map(state.extracted);
    for (const [id, v] of required) extracted.set(id, v);
    if (state.settings.preciseTimes) for (const [id, v] of readCached(listing.files, ['refine'])) extracted.set(id, v);
    // サムネイルの URL は数時間で失効するので、変化がなくても最新の一覧に置き換える
    state.files = listing.files;
    state.extracted = extracted;
    state.root = listing.root;
    rebuildCatalog();
    state.player?.setItems(state.items);
    if (!$('#grid-overlay').hidden) {
      renderGrid();
      renderTimeFix({ keepEdits: true });
    }
    if (!silent && listing.skippedFolders) toast(`アクセスできないフォルダを ${listing.skippedFolders} 件スキップしました`, { kind: 'warn' });
    if (!changed) {
      if (!silent) toast('新しい写真・動画はありませんでした');
      return;
    }
    const msgs = [];
    if (added) msgs.push(`${added} 件追加`);
    if (removed) msgs.push(`${removed} 件削除`);
    toast(msgs.length ? `フォルダが更新されました（${msgs.join('・')}）` : 'フォルダの内容が更新されました');
    refineInBackground();
  } catch (e) {
    if (stale()) return;
    console.warn('自動更新に失敗:', e);
    if (e instanceof AuthRequiredError) {
      if (state.screen === 'player' && state.drive?.mode === 'oauth') {
        const wasPlaying = !!state.player?.playing;
        state.player?.pause();
        showAuthOverlay(wasPlaying);
      }
    } else if (!silent) toast(e.message || '更新に失敗しました', { kind: 'warn' });
  } finally {
    if (gen === refreshGen) {
      state.refreshing = false;
      state.refreshAbort = null;
    }
  }
}

$('#btn-refresh').addEventListener('click', () => refresh({ silent: false }));

// ---------------------------------------------------------------------------
// 一覧・時刻補正

let gridWasPlaying = false;

function openGrid() {
  if (!state.items.length) return;
  gridWasPlaying = !!state.player?.playing;
  state.player?.pause();
  renderGrid();
  renderTimeFix();
  const overlay = $('#grid-overlay');
  overlay.hidden = false;
  // 一覧の後ろのスライドショーにはフォーカスもクリックも届かないようにする
  $('#player').inert = true;
  overlay.focus({ preventScroll: true });
  const cur = state.player?.currentItem;
  const tile = cur && $(`#grid-body [data-id="${CSS.escape(cur.id)}"]`);
  if (tile) {
    tile.scrollIntoView({ block: 'center' });
    tile.focus({ preventScroll: true });
  }
}

/** 一覧を閉じるだけ（再生はしない） */
function hideGrid() {
  $('#grid-overlay').hidden = true;
  $('#player').inert = false;
}

function closeGrid({ resume = gridWasPlaying } = {}) {
  if ($('#grid-overlay').hidden) return;
  hideGrid();
  if (resume) state.player?.play();
}

$('#btn-grid-close').addEventListener('click', () => closeGrid());
// 一覧の外にフォーカスがあっても（余白のクリック、再描画のあとなど）Escape / G で閉じる
document.addEventListener('keydown', (e) => {
  if ($('#grid-overlay').hidden || !$('#auth-overlay').hidden) return;
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
  const inField = !!e.target?.closest?.('input, textarea, select, [contenteditable="true"]');
  if (e.key === 'Escape' || ((e.key === 'g' || e.key === 'G') && !inField)) {
    e.preventDefault();
    closeGrid();
  }
});

/** 画面に入ったタイルだけ、順番にサムネイルを読み込む（同時 3 件まで） */
const thumbQueue = (() => {
  let observer = null;
  const jobs = new Map();
  const queue = [];
  let running = 0;
  const pump = () => {
    while (running < 3 && queue.length) {
      const job = queue.shift();
      running++;
      Promise.resolve()
        .then(job)
        .catch(() => {})
        .finally(() => {
          running--;
          pump();
        });
    }
  };
  return {
    reset() {
      observer?.disconnect();
      jobs.clear();
      queue.length = 0;
      observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const job = jobs.get(e.target);
            if (job) {
              jobs.delete(e.target);
              observer.unobserve(e.target);
              queue.push(job);
            }
          }
          pump();
        },
        { root: $('#grid-overlay'), rootMargin: '300px' },
      );
    },
    observe(el, job) {
      jobs.set(el, job);
      observer?.observe(el);
    },
  };
})();

function formatDuration(ms) {
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function renderGrid() {
  const s = state.settings;
  const body = $('#grid-body');
  // 作り直したあとも同じタイルにフォーカスを戻す
  const active = document.activeElement;
  const focusedId = active && body.contains(active) ? active.dataset.id : null;
  const slides = buildSlides(state.items, { showTitleCard: false, showDayCards: true });
  $('#grid-title').textContent = `${title()}（${state.items.length}件）`;
  const frag = document.createDocumentFragment();
  let section = null;
  thumbQueue.reset();
  for (const sl of slides) {
    if (sl.type === 'day') {
      const first = state.items.find((i) => i.day === sl.day);
      section = h('div', { class: 'grid-tiles' });
      frag.append(
        h('section', { class: 'grid-day' }, [
          h('h3', {}, [
            // 主な期間の外の日（dayNumber が null）は日付だけ
            sl.dayNumber != null ? h('span', { class: 'day-num' }, [`${sl.dayNumber}日目`]) : null,
            sl.dayNumber != null ? ' ' : null,
            first ? formatDateJa(first.epoch, s.timeZone) : sl.day,
            h('span', { class: 'muted' }, [` ${sl.count}件`]),
          ]),
          section,
        ]),
      );
      continue;
    }
    const it = sl.item;
    const thumbUrl = state.loader?.thumbnailUrl(it, 400);
    const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', hidden: !thumbUrl });
    const tile = h(
      'button',
      {
        type: 'button',
        class: 'tile no-thumb',
        dataset: { id: it.id },
        title: `${it.name}\n${formatDateTimeJa(it.epoch, s.timeZone, { withYear: true })}\n${TIME_SOURCE_LABELS[it.timeSource] || ''}${it.offsetMinutes ? `（補正 ${it.offsetMinutes > 0 ? '+' : ''}${it.offsetMinutes}分）` : ''}`,
        onclick: () => {
          // 今のスライド（動画）を再開せずに、選んだ項目から再生する
          const wasPlaying = gridWasPlaying;
          closeGrid({ resume: false });
          if (!state.player?.goToItem(it.id, { play: true }) && wasPlaying) state.player?.play();
        },
      },
      [
        img,
        h('span', { class: 'tile-fallback' }, [icon(it.kind === 'video' ? 'video' : 'photo'), h('span', { class: 'tile-name' }, [it.name])]),
        h('span', { class: 'tile-time' }, [formatTimeJa(it.epoch, s.timeZone)]),
        it.kind === 'video' ? h('span', { class: 'tile-badge' }, [icon('video'), it.durationMs ? formatDuration(it.durationMs) : '']) : null,
        it.timeSource === 'drive-times' ? h('span', { class: 'tile-warn', title: '撮影日時が見つからないため推定' }, ['推定']) : null,
      ],
    );
    img.addEventListener('load', () => {
      tile.classList.remove('no-thumb');
      img.hidden = false;
    });
    let triedExif = false;
    const tryExifThumb = () => {
      if (triedExif || !state.loader) return;
      triedExif = true;
      thumbQueue.observe(tile, () =>
        state.loader.exifThumbnail(it).then((u) => {
          if (u) img.src = u;
        }),
      );
    };
    img.addEventListener('error', () => {
      img.hidden = true;
      if (img.src.startsWith('blob:')) return;
      state.loader?.noteThumbnailFailure();
      tryExifThumb();
    });
    if (thumbUrl) img.src = thumbUrl;
    else tryExifThumb();
    if (state.player?.currentItem?.id === it.id) tile.classList.add('current');
    (section || frag).append(tile);
  }
  body.replaceChildren(frag);
  if (focusedId) {
    const again = $(`#grid-body .tile[data-id="${CSS.escape(focusedId)}"]`);
    if (again) again.focus({ preventScroll: true });
    else if (!$('#grid-overlay').hidden) $('#grid-overlay').focus({ preventScroll: true });
  }
}

/**
 * カメラ別の時刻補正の表。keepEdits: 入力途中の値とフォーカスを残す（裏で一覧が変わったとき）
 */
function renderTimeFix({ keepEdits = false } = {}) {
  const s = state.settings;
  const table = $('#time-fix-table');
  const edits = new Map();
  let focus = null;
  if (keepEdits) {
    for (const row of $$('.fix-row', table)) {
      const inputs = $$('input', row);
      if (inputs.some((i) => i.value !== i.defaultValue)) edits.set(row.dataset.group, inputs.map((i) => i.value));
      const k = inputs.indexOf(document.activeElement);
      if (k >= 0) focus = { group: row.dataset.group, k };
    }
  }
  const saved = offsetsForFolder(s, currentFolderId());
  const groups = summarizeGroups(state.items);
  // 補正を保存してあっても今は該当するファイルがないグループ（裏の EXIF の解析が終わると現れるものなど）も、確認・取り消しできるよう表示する
  for (const g of Object.keys(saved)) {
    if (!groups.some((x) => x.group === g)) groups.push({ group: g, count: 0, photos: 0, videos: 0 });
  }
  const rows = groups.map((g) => {
    const off = (Object.prototype.hasOwnProperty.call(saved, g.group) && Number(saved[g.group])) || 0;
    const sign = off < 0 ? -1 : 1;
    const hh = h('input', { type: 'number', min: '-48', max: '48', step: '1', value: String(sign * Math.floor(Math.abs(off) / 60)), 'aria-label': `${g.group} の補正（時間）`, class: 'num-sm' });
    const mm = h('input', { type: 'number', min: '-59', max: '59', step: '1', value: String(sign * (Math.abs(off) % 60)), 'aria-label': `${g.group} の補正（分）`, class: 'num-sm' });
    const range = g.count ? `${formatDateTimeJa(g.first, s.timeZone)} 〜 ${formatDateTimeJa(g.last, s.timeZone)}` : '今は該当する写真・動画がありません';
    return h('div', { class: 'fix-row', dataset: { group: g.group } }, [
      h('div', { class: 'fix-name' }, [h('strong', {}, [g.group]), h('span', { class: 'muted' }, [` 写真 ${g.photos}・動画 ${g.videos}`]), h('div', { class: 'muted small' }, [range])]),
      h('label', { class: 'fix-input' }, [hh, ' 時間 ', mm, ' 分']),
    ]);
  });
  const off = tzOffsetMs(state.items[0]?.epoch || Date.now(), s.timeZone);
  const zoned = groups.some((g) => g.group.endsWith(ZONED_GROUP_SUFFIX));
  const mvhd = groups.some((g) => g.group.endsWith(MVHD_VIDEO_GROUP_SUFFIX));
  const note = (text) => h('p', { class: 'muted small' }, [text]);
  table.replaceChildren(
    note(`撮影地のタイムゾーン: ${s.timeZone}（${formatOffset(off)}）`),
    ...(zoned ? [note(`「${ZONED_GROUP_SUFFIX}」のグループは撮影時のタイムゾーンがファイルに記録されているため、通常は補正の必要はありません。`)] : []),
    ...(mvhd ? [note(`「${MVHD_VIDEO_GROUP_SUFFIX}」のグループは動画ファイルの作成日時を UTC として読んでいます。カメラが現地時刻で記録している場合は、写真とは別にここで補正してください。`)] : []),
    ...rows,
  );
  for (const row of rows) {
    const inputs = $$('input', row);
    const vals = edits.get(row.dataset.group);
    if (vals) inputs.forEach((i, k) => (i.value = vals[k] ?? i.value));
    if (focus && focus.group === row.dataset.group) inputs[focus.k]?.focus({ preventScroll: true });
  }
}

$('#btn-time-fix-apply').addEventListener('click', () => {
  const folderId = currentFolderId();
  // 表にあるグループだけを変える（表にないグループの保存済みの補正は残す）
  const offsets = offsetsForFolder(state.settings, folderId);
  for (const row of $$('#time-fix-table .fix-row')) {
    const [hh, mm] = $$('input', row).map((i) => Number(i.value) || 0);
    const total = Math.round(hh * 60 + mm);
    if (total) offsets[row.dataset.group] = total;
    else delete offsets[row.dataset.group];
  }
  state.settings = sanitize(withFolderOffsets(state.settings, folderId, offsets));
  // このフォルダの補正だけを保存する（リンクで渡されただけのフォルダ・タイトル・API キーなどは保存しない）
  const applied = state.settings;
  storeOnly((stored) => withFolderOffsetsFrom(stored, applied, folderId));
  rebuildCatalog();
  state.player?.setItems(state.items);
  renderGrid();
  renderTimeFix();
  toast('時刻の補正を適用しました');
});

// ---------------------------------------------------------------------------
// フォルダ検索（OAuth）

$('#btn-folder-search').addEventListener('click', async () => {
  setupError(null);
  const s = sanitize(readForm());
  if (!s.clientId) {
    setupError('先に OAuth クライアント ID を入力してください。');
    return;
  }
  const session = ensureSession(s.clientId);
  const gen = sessionGen;
  if (!session.isValidFor(MIN_TOKEN_MS)) {
    try {
      if (!session.client) await session.init();
      await session.request({ prompt: '' });
    } catch (e) {
      setupError(e.message);
      return;
    }
    // ログインを待っている間にスライドショーが始まった（「スライドショーを開始」も押された）: 検索は開かない
    if (state.screen !== 'setup' || gen !== sessionGen) return;
  }
  // 検索用の DriveClient（スライドショーの state.drive は変えない）
  folderDrive = makeDrive({ ...s, authMode: 'oauth' });
  $('#folder-overlay').hidden = false;
  $('#folder-query').focus();
  searchFolders('');
});

/** フォルダ検索に使う DriveClient */
let folderDrive = null;
let folderSearchSeq = 0;
async function searchFolders(q) {
  const ul = $('#folder-results');
  const seq = ++folderSearchSeq;
  ul.replaceChildren(h('li', { class: 'muted' }, ['検索中…']));
  try {
    if (!folderDrive) throw new Error('先に「フォルダを検索」を押してください。');
    const folders = await folderDrive.searchFolders(q);
    if (seq !== folderSearchSeq) return; // 新しい検索の結果を優先
    if (!folders.length) {
      ul.replaceChildren(h('li', { class: 'muted' }, ['見つかりませんでした']));
      return;
    }
    ul.replaceChildren(
      ...folders.map((f) =>
        h('li', {}, [
          h('button', {
            type: 'button',
            class: 'folder-item',
            onclick: () => {
              form.folder.value = `https://drive.google.com/drive/folders/${f.id}${f.resourceKey ? `?resourcekey=${f.resourceKey}` : ''}`;
              $('#folder-overlay').hidden = true;
              if (!form.title.value) form.title.placeholder = f.name;
            },
          }, [h('strong', {}, [f.name]), h('span', { class: 'muted small' }, [f.modifiedTime ? ` 更新: ${new Date(f.modifiedTime).toLocaleDateString('ja-JP')}` : ''])]),
        ]),
      ),
    );
  } catch (e) {
    if (seq === folderSearchSeq) ul.replaceChildren(h('li', { class: 'error-text' }, [e.message]));
  }
}

$('#folder-search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  searchFolders($('#folder-query').value);
});
$('#btn-folder-close').addEventListener('click', () => ($('#folder-overlay').hidden = true));
$('#folder-overlay').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#folder-overlay').hidden = true;
});

// ---------------------------------------------------------------------------
// 起動

function init() {
  fillTimeZones();
  applyLockToForm();
  fillForm(state.settings);
  showScreen('setup');
  // URL の tz= が正しくなければ（既定値に戻さず）入力欄に残して知らせる。自動開始もしない
  const urlTz = (params.get('tz') || '').trim();
  const tzErr = urlTz ? timeZoneError(urlTz) : null;
  if (tzErr) {
    form.timeZone.value = urlTz;
    setupError(tzErr);
  }
  // リンクの接続設定が保存済みの値と違う: 警告を出して確かめてもらう（自動開始もしない）
  if (linkConflict) showLinkAuthWarning();
  if (tzErr || linkConflict) return;
  // ?autostart=1 で設定が揃っていればすぐに開始（API キー、またはログイン済みの場合）
  if (params.get('autostart') === '1' && !validate(state.settings)) {
    if (state.settings.authMode === 'apikey' || ensureSession(state.settings.clientId)?.signedIn) {
      if (!params.has('muted')) state.settings.videoMuted = true; // 操作なしでは音声付き自動再生ができないため
      start();
    }
  }
}

// テストやデバッグ用に状態を公開（localhost のみ）
if (['localhost', '127.0.0.1'].includes(location.hostname)) window.__slideshow = state;

init();
