// アプリ本体: 設定画面 → フォルダの読み込み → 撮影日時の解析 → スライドショー

import { $, $$, h, icon, toast } from './dom.js';
import { loadSettings, saveSettings, sanitize, buildShareUrl, resolveApiBase, DEFAULTS } from './settings.js';
import { OAuthSession, AuthError } from './auth.js';
import { DriveClient, DriveError, AuthRequiredError, parseFolderInput } from './drive.js';
import { extractAll, readCached } from './extract.js';
import { buildCatalog, summarizeGroups, buildSlides, TIME_SOURCE_LABELS } from './catalog.js';
import { MediaLoader, setupServiceWorker } from './loader.js';
import { Player } from './player.js';
import { formatDateJa, formatTimeJa, formatDateTimeJa, isValidTimeZone, tzOffsetMs, formatOffset } from './timeutil.js';

const params = new URLSearchParams(location.search);
const apiBase = resolveApiBase(location);
const deployConfig = window.SLIDESHOW_CONFIG || {};

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
  refreshTimer: null,
  refreshing: false,
  screen: 'setup',
};

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
  return s;
}

function syncModePanels() {
  const mode = ($('input[name="authMode"]:checked', form) || {}).value || 'oauth';
  for (const p of $$('[data-mode]')) p.hidden = p.dataset.mode !== mode;
  if (mode === 'oauth') {
    ensureSession(form.clientId.value.trim());
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
  let zones = ['Europe/Helsinki', 'Asia/Tokyo', 'Europe/Stockholm', 'Europe/Oslo', 'Europe/Tallinn', 'Europe/London', 'Europe/Paris', 'UTC'];
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
  if (!clientId) {
    state.session = null;
    return null;
  }
  if (state.session && state.session.clientId === clientId) return state.session;
  const session = new OAuthSession(clientId);
  session.addEventListener('change', () => {
    updateLoginStatus();
    pushCreds();
  });
  session.addEventListener('expiring', onTokenExpiring);
  session.addEventListener('expired', onTokenExpired);
  state.session = session;
  // ボタンを押したときにすぐポップアップを開けるよう、ライブラリを先に読み込んでおく
  session.init().catch((e) => {
    if (state.screen === 'setup') updateLoginStatus(e.message);
  });
  return session;
}

function updateLoginStatus(errorMsg) {
  const el = $('#login-status');
  const session = state.session;
  if (!form.clientId.value.trim()) {
    el.replaceChildren(h('span', { class: 'muted' }, ['OAuth クライアント ID を入力してください。']));
    return;
  }
  if (errorMsg) {
    el.replaceChildren(h('span', { class: 'error-text' }, [errorMsg]));
    return;
  }
  if (session && session.signedIn) {
    const mins = Math.max(0, Math.round((session.expiresAt - Date.now()) / 60000));
    el.replaceChildren(
      h('span', { class: 'ok-text' }, [`ログイン中（あと約 ${mins} 分有効）`]),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => session.signOut() }, ['ログアウト']),
    );
  } else {
    el.replaceChildren(
      h('span', { class: 'muted' }, ['「スライドショーを開始」を押すと Google のログイン画面が開きます。']),
      h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => signIn().catch((e) => updateLoginStatus(e.message)) }, ['ログイン']),
    );
  }
}

/** ログインする（ユーザー操作の中で呼ぶこと） */
async function signIn() {
  const session = ensureSession(form.clientId.value.trim() || state.settings.clientId);
  if (!session) throw new AuthError('OAuth クライアント ID を入力してください。', 'config');
  if (!session.client) await session.init();
  const token = await session.request({ prompt: '' });
  return token;
}

let expiringToast = null;
function onTokenExpiring() {
  if (state.screen !== 'player') return;
  expiringToast?.remove();
  expiringToast = h('div', { class: 'expiring-banner' }, [
    h('span', {}, ['まもなくログインの有効期限が切れます。']),
    h('button', {
      type: 'button',
      class: 'btn btn-light btn-sm',
      onclick: async () => {
        try {
          await state.session.request({ prompt: '' });
          expiringToast?.remove();
          toast('ログインを延長しました');
        } catch (e) {
          toast(e.message, { kind: 'warn' });
        }
      },
    }, ['延長する']),
    h('button', { type: 'button', class: 'ctl', 'aria-label': '閉じる', onclick: () => expiringToast?.remove() }, [icon('close')]),
  ]);
  $('#player').append(expiringToast);
}

function onTokenExpired() {
  expiringToast?.remove();
  if (state.screen === 'player') {
    state.player?.pause();
    showAuthOverlay();
  } else if (state.screen === 'setup') {
    updateLoginStatus();
  }
}

function showAuthOverlay() {
  $('#auth-error').textContent = '';
  $('#auth-overlay').hidden = false;
  $('#btn-reauth').focus();
}

$('#btn-reauth').addEventListener('click', async () => {
  try {
    await state.session.request({ prompt: '' });
    $('#auth-overlay').hidden = true;
    pushCreds();
    state.player?.play();
    state.player?.retry();
  } catch (e) {
    $('#auth-error').textContent = e.message;
  }
});
$('#btn-auth-cancel').addEventListener('click', () => {
  $('#auth-overlay').hidden = true;
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
    () => {},
  );
}

function ensureServiceWorker() {
  if (!state.swPromise) {
    state.swPromise = setupServiceWorker({ getCreds }).then((sw) => {
      state.sw = sw;
      if (!sw) console.info('Service Worker を使わずに再生します（動画は全体をダウンロードしてから再生）');
      return sw;
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

function validate(s) {
  if (!s.folder) return 'フォルダの URL または ID を入力してください。';
  if (!parseFolderInput(s.folder)) return 'フォルダの URL の形式が正しくありません。ドライブでフォルダを開いたときの URL を貼り付けてください。';
  if (s.authMode === 'apikey' && !s.apiKey) return 'API キーを入力してください。';
  if (s.authMode === 'oauth' && !s.clientId) return 'OAuth クライアント ID を入力してください（「OAuth クライアント ID」の欄）。';
  if (!isValidTimeZone(s.timeZone)) return `タイムゾーン「${s.timeZone}」が正しくありません（例：Europe/Helsinki）。`;
  return null;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setupError(null);
  const s = sanitize(readForm());
  const err = validate(s);
  if (err) {
    setupError(err);
    return;
  }
  state.settings = s;
  saveSettings(s);
  if (s.authMode === 'oauth') {
    const session = ensureSession(s.clientId);
    if (!session.signedIn) {
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
  const s = sanitize(readForm());
  if (!s.folder) {
    setupError('先にフォルダの URL を入力してください。');
    return;
  }
  const url = buildShareUrl(location.href, s);
  try {
    await navigator.clipboard.writeText(url);
    toast('共有用リンクをコピーしました');
  } catch {
    window.prompt('このリンクをコピーしてください', url);
  }
});

$('#btn-cancel-load').addEventListener('click', () => {
  state.loadAbort?.abort();
  showScreen('setup');
});

async function start() {
  const s = state.settings;
  showScreen('loading');
  setLoading('Google ドライブに接続中…');
  state.loadAbort?.abort();
  const abort = new AbortController();
  state.loadAbort = abort;
  stopRefreshTimer();
  state.refineAbort?.abort();
  try {
    state.drive = makeDrive(s);
    const folder = parseFolderInput(s.folder);
    if (folder.resourceKey) state.drive.rememberResourceKey(folder.id, folder.resourceKey);
    const swP = ensureServiceWorker();
    const listing = await state.drive.listMediaTree(folder.id, {
      recursive: s.includeSubfolders,
      signal: abort.signal,
      onProgress: ({ folders, files }) => setLoading('フォルダを読み込み中…', `${folders} フォルダ・写真と動画 ${files} 件`),
    });
    if (abort.signal.aborted) return;
    state.root = listing.root;
    state.files = listing.files;
    if (!state.files.length) {
      throw new DriveError(
        `フォルダ「${listing.root.name}」に写真・動画が見つかりませんでした。${s.includeSubfolders ? '' : '（サブフォルダを含める設定もお試しください）'}`,
      );
    }
    setLoading('撮影日時を確認中…', '', 0);
    const required = await extractAll(state.drive, state.files, {
      phases: ['required'],
      signal: abort.signal,
      onProgress: (done, total) => total && setLoading('撮影日時を確認中…', `${done} / ${total}（動画など）`, done / total),
    });
    if (abort.signal.aborted) return;
    // 以前に精密解析した結果があれば最初から使う（残りは再生しながら裏で解析）
    state.extracted = s.preciseTimes ? new Map([...readCached(state.files, ['refine']), ...required]) : required;
    await swP;
    pushCreds();
    rebuildCatalog();
    startPlayer();
    startRefreshTimer();
    refineInBackground();
  } catch (e) {
    if (abort.signal.aborted) return;
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
  if (!state.settings.preciseTimes || !state.drive) return;
  const abort = new AbortController();
  state.refineAbort = abort;
  const drive = state.drive;
  const files = state.files;
  let pending = 0;
  const apply = () => {
    if (!pending || abort.signal.aborted) return;
    pending = 0;
    const before = state.items.map((i) => `${i.id}@${i.epoch}`).join();
    rebuildCatalog();
    const after = state.items.map((i) => `${i.id}@${i.epoch}`).join();
    if (before !== after) {
      state.player?.setItems(state.items);
      if (!$('#grid-overlay').hidden) renderGrid();
    }
  };
  try {
    await extractAll(drive, files, {
      phases: ['refine'],
      signal: abort.signal,
      concurrency: 3,
      onResult: (id, data) => {
        if (abort.signal.aborted || state.drive !== drive) return;
        if (data) {
          state.extracted.set(id, data);
          pending++;
        }
        if (pending >= 40) apply();
      },
    });
  } catch (e) {
    if (!abort.signal.aborted) console.info('撮影日時の精密解析を中断しました:', e && e.message);
  }
  if (state.drive === drive) apply();
}

function rebuildCatalog() {
  const s = state.settings;
  state.items = buildCatalog(state.files, state.extracted, { timeZone: s.timeZone, cameraOffsets: s.cameraOffsets });
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
      onAuthRequired: () => showAuthOverlay(),
      onOpenGrid: () => openGrid(),
      onOpenSettings: () => backToSetup(),
    });
    state.player.addEventListener('settingschange', () => saveSettings(state.settings));
  } else {
    state.player.loader = state.loader;
  }
  state.player.setItems(state.items);
  document.title = `${title()} - スライドショー`;
  showScreen('player');
  state.player.start(0);
}

function backToSetup() {
  stopRefreshTimer();
  state.refineAbort?.abort();
  state.player?.stop();
  $('#grid-overlay').hidden = true;
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

async function refresh({ silent = false } = {}) {
  if (state.refreshing || !state.drive || !state.root) return;
  state.refreshing = true;
  try {
    const listing = await state.drive.listMediaTree(state.root.id, { recursive: state.settings.includeSubfolders });
    const before = new Set(state.files.map(fileKey));
    const after = new Set(listing.files.map(fileKey));
    const beforeIds = new Set(state.files.map((f) => f.id));
    const afterIds = new Set(listing.files.map((f) => f.id));
    const added = listing.files.filter((f) => !beforeIds.has(f.id)).length;
    const removed = state.files.filter((f) => !afterIds.has(f.id)).length;
    const changed = [...after].some((k) => !before.has(k)) || removed > 0;
    const required = await extractAll(state.drive, listing.files, { phases: ['required'] });
    const extracted = new Map(state.extracted);
    for (const [id, v] of required) extracted.set(id, v);
    if (state.settings.preciseTimes) for (const [id, v] of readCached(listing.files, ['refine'])) extracted.set(id, v);
    // サムネイルの URL は数時間で失効するので、変化がなくても最新の一覧に置き換える
    state.files = listing.files;
    state.extracted = extracted;
    state.root = listing.root;
    rebuildCatalog();
    state.player?.setItems(state.items);
    if (!$('#grid-overlay').hidden) renderGrid();
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
    console.warn('自動更新に失敗:', e);
    if (e instanceof AuthRequiredError) {
      if (state.screen === 'player') {
        state.player?.pause();
        showAuthOverlay();
      }
    } else if (!silent) toast(e.message || '更新に失敗しました', { kind: 'warn' });
  } finally {
    state.refreshing = false;
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
  $('#grid-overlay').hidden = false;
  const cur = state.player?.currentItem;
  const tile = cur && $(`#grid-body [data-id="${CSS.escape(cur.id)}"]`);
  if (tile) {
    tile.scrollIntoView({ block: 'center' });
    tile.focus({ preventScroll: true });
  } else $('#btn-grid-close').focus();
}

function closeGrid({ resume = gridWasPlaying } = {}) {
  $('#grid-overlay').hidden = true;
  if (resume) state.player?.play();
}

$('#btn-grid-close').addEventListener('click', () => closeGrid());
$('#grid-overlay').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
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
          h('h3', {}, [h('span', { class: 'day-num' }, [`${sl.dayNumber}日目`]), ' ', first ? formatDateJa(first.epoch, s.timeZone) : sl.day, h('span', { class: 'muted' }, [` ${sl.count}件`])]),
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
          closeGrid({ resume: true });
          state.player?.goToItem(it.id);
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
}

function renderTimeFix() {
  const s = state.settings;
  const groups = summarizeGroups(state.items);
  const rows = groups.map((g) => {
    const off = Number(s.cameraOffsets[g.group]) || 0;
    const sign = off < 0 ? -1 : 1;
    const hh = h('input', { type: 'number', min: '-48', max: '48', step: '1', value: String(sign * Math.floor(Math.abs(off) / 60)), 'aria-label': `${g.group} の補正（時間）`, class: 'num-sm' });
    const mm = h('input', { type: 'number', min: '-59', max: '59', step: '1', value: String(sign * (Math.abs(off) % 60)), 'aria-label': `${g.group} の補正（分）`, class: 'num-sm' });
    const range = g.count ? `${formatDateTimeJa(g.first, s.timeZone)} 〜 ${formatDateTimeJa(g.last, s.timeZone)}` : '';
    return h('div', { class: 'fix-row', dataset: { group: g.group } }, [
      h('div', { class: 'fix-name' }, [h('strong', {}, [g.group]), h('span', { class: 'muted' }, [` 写真 ${g.photos}・動画 ${g.videos}`]), h('div', { class: 'muted small' }, [range])]),
      h('label', { class: 'fix-input' }, [hh, ' 時間 ', mm, ' 分']),
    ]);
  });
  const off = tzOffsetMs(state.items[0]?.epoch || Date.now(), s.timeZone);
  $('#time-fix-table').replaceChildren(
    h('p', { class: 'muted small' }, [`撮影地のタイムゾーン: ${s.timeZone}（${formatOffset(off)}）`]),
    ...rows,
  );
}

$('#btn-time-fix-apply').addEventListener('click', () => {
  const offsets = {};
  for (const row of $$('#time-fix-table .fix-row')) {
    const [hh, mm] = $$('input', row).map((i) => Number(i.value) || 0);
    const total = Math.round(hh * 60 + mm);
    if (total) offsets[row.dataset.group] = total;
  }
  state.settings = sanitize({ ...state.settings, cameraOffsets: offsets });
  saveSettings(state.settings);
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
  if (!session.signedIn) {
    try {
      if (!session.client) await session.init();
      await session.request({ prompt: '' });
    } catch (e) {
      setupError(e.message);
      return;
    }
  }
  state.drive = makeDrive({ ...s, authMode: 'oauth' });
  $('#folder-overlay').hidden = false;
  $('#folder-query').focus();
  searchFolders('');
});

async function searchFolders(q) {
  const ul = $('#folder-results');
  ul.replaceChildren(h('li', { class: 'muted' }, ['検索中…']));
  try {
    const folders = await state.drive.searchFolders(q);
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
    ul.replaceChildren(h('li', { class: 'error-text' }, [e.message]));
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
  fillForm(state.settings);
  showScreen('setup');
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
