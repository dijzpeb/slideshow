// スライドショーのプレイヤー

import { h, icon, toast } from './dom.js';
import { buildSlides, tripSummary } from './catalog.js';
import { formatDateJa, formatDateTimeJa, epochToWall } from './timeutil.js';
import { AuthRequiredError } from './drive.js';

const CARD_SECONDS = 3.5;
const TITLE_SECONDS = 5;
const VIDEO_READY_WAIT = 8000;
const VIDEO_STALL_TIMEOUT = 45000;
const VIDEO_PAUSED_STALL = 3000; // 再生中なのに動画が止まったままの時間（ブラウザに止められた等）
const HUD_HIDE_MS = 3000;
/** 別のスライドへ移るキー */
const NAV_KEYS = new Set(['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp', 'Home', 'End']);

/** Google ドライブの埋め込みプレーヤーの URL */
export function drivePreviewUrl(item, { autoplay = false } = {}) {
  const u = new URL(`https://drive.google.com/file/d/${encodeURIComponent(item.id)}/preview`);
  if (item.resourceKey) u.searchParams.set('resourcekey', item.resourceKey);
  if (autoplay) u.searchParams.set('autoplay', '1');
  return u.toString();
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export class Player extends EventTarget {
  /**
   * @param {HTMLElement} root
   * @param {object} opts
   * @param {import('./loader.js').MediaLoader} opts.loader
   * @param {()=>object} opts.getSettings
   * @param {()=>string} opts.getTitle
   * @param {(err:Error, info:{wasPlaying:boolean})=>void} opts.onAuthRequired  wasPlaying: 止める直前に再生中だったか
   * @param {()=>void} opts.onOpenGrid
   * @param {()=>void} opts.onOpenSettings
   */
  constructor(root, opts) {
    super();
    this.root = root;
    this.loader = opts.loader;
    this.getSettings = opts.getSettings;
    this.getTitle = opts.getTitle;
    this.onAuthRequired = opts.onAuthRequired;
    this.onOpenGrid = opts.onOpenGrid;
    this.onOpenSettings = opts.onOpenSettings;

    this.items = [];
    this.slides = [];
    this.index = 0;
    this.playing = false;
    this.active = false;
    this.seq = 0;
    this.current = null; // {el, slide, cleanup(), kind}
    this.timer = null; // {start, remaining, handle, duration}
    this.consecutiveErrors = 0;
    this.wakeLock = null;
    this.hudTimer = null;
    this.spinnerTimer = null;
    this.audioUnlocked = false;
    // 表示中のスライドが一覧から消えた（更新で削除された）とき true。index は次に表示するスライドを指す
    this.detached = false;
    this.drivePlayer = null; // {el, close}
    this._staleFns = new Set(); // seq が変わったときに呼ぶ関数
    this._retriedAbort = false;

    this._build();
    this._onKey = this._onKey.bind(this);
    this._onActivity = this._onActivity.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onFullscreen = this._onFullscreen.bind(this);
    this._onWindowBlur = this._onWindowBlur.bind(this);
  }

  // -------------------------------------------------------------------------
  // DOM

  _build() {
    // nav: 別のスライドへ移るボタン。音声は有効にするが、出ていく動画の音は出さない
    const btn = (name, label, onClick, cls = '', { unlock = true, nav = false } = {}) =>
      h('button', { type: 'button', class: `ctl ${cls}`.trim(), title: label, 'aria-label': label, onclick: (e) => {
        e.stopPropagation();
        // マウスで押した後にフォーカスが残ると、Space キーでボタンも反応して二重操作になるため外す
        if (e.detail > 0) e.currentTarget.blur();
        // クリックはユーザー操作なので音声を有効にできる（ミュートボタンは toggleMute で扱う）
        if (unlock) this._unlockAudio({ apply: !nav });
        onClick();
      } }, [icon(name)]);

    this.stage = h('div', { class: 'stage', 'aria-live': 'off' });
    this.caption = h('div', { class: 'caption' });
    this.counter = h('div', { class: 'counter' });
    this.bar = h('div', { class: 'progress-bar' });
    this.progress = h('div', { class: 'progress', 'aria-hidden': 'true' }, [this.bar]);
    this.btnPlay = btn('pause', '一時停止 (Space)', () => this.toggle(), 'ctl-play');
    this.btnMute = btn('volume', 'ミュート (M)', () => this.toggleMute(), 'ctl-mute', { unlock: false });
    this.btnFs = btn('fullscreen', '全画面 (F)', () => this.toggleFullscreen(), 'ctl-fs');
    this.controls = h('div', { class: 'controls' }, [
      h('div', { class: 'controls-left' }, [
        btn('prev', '前へ (←)', () => this.prev(), 'ctl-prev', { nav: true }),
        this.btnPlay,
        btn('next', '次へ (→)', () => this.next(), 'ctl-next', { nav: true }),
        this.btnMute,
      ]),
      h('div', { class: 'controls-center' }, [this.counter]),
      h('div', { class: 'controls-right' }, [
        btn('grid', '一覧 (G)', () => this.onOpenGrid?.(), 'ctl-grid'),
        btn('settings', '設定', () => this.onOpenSettings?.(), 'ctl-settings'),
        this.btnFs,
      ]),
    ]);
    this.hud = h('div', { class: 'hud' }, [this.progress, this.controls]);
    this.spinner = h('div', { class: 'spinner', role: 'progressbar', 'aria-label': '読み込み中' });
    this.pauseBadge = h('div', { class: 'pause-badge', 'aria-hidden': 'true' }, [icon('pause')]);
    this.root.replaceChildren(this.stage, this.caption, this.hud, this.spinner, this.pauseBadge);

    // タッチ（スワイプ）とクリック
    let down = null;
    this.stage.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    this.stage.addEventListener('pointerup', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      const dt = performance.now() - down.t;
      down = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 800) {
        this._unlockAudio({ apply: false });
        if (dx < 0) this.next();
        else this.prev();
        return;
      }
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
        if (e.target.closest('button, a, iframe')) return;
        // 音声が自動再生の制限で止まっている動画では、最初のタップは一時停止せずに音声を有効にする
        const blocked = this._soundBlocked();
        if (this._unlockAudio() && blocked) {
          this._showHud();
          return;
        }
        // タップ: 操作パネルが隠れていれば表示、表示中なら再生/一時停止
        if (this.root.classList.contains('hud-hidden')) this._showHud();
        else if (e.pointerType === 'mouse') this.toggle();
        else this._showHud();
      }
    });

    // キーボード（Tab）で操作パネルにフォーカスがある間はパネルを表示したままにする
    this.root.addEventListener('focusin', (e) => {
      if (this.hud.contains(e.target)) this._showHud();
    });
    this.root.addEventListener('focusout', (e) => {
      if (this.hud.contains(e.target) && !this.hud.contains(e.relatedTarget)) this._showHud();
    });
  }

  // -------------------------------------------------------------------------
  // 公開 API

  /** 項目をセットする。再生中なら現在のスライドを保ったまま並びを更新する */
  setItems(items) {
    const s = this.getSettings();
    const old = this.slides;
    const oldIndex = this.index;
    const wasEmpty = !!this.current?.empty;
    const curKey = this.detached ? null : old[oldIndex]?.key;
    this.items = items;
    this.slides = buildSlides(items, { showTitleCard: s.showTitleCard, showDayCards: s.showDayCards });
    if (!this.active || !old.length) {
      this.index = Math.min(this.index, Math.max(0, this.slides.length - 1));
      this.detached = false;
    } else {
      const pos = new Map(this.slides.map((sl, i) => [sl.key, i]));
      if (curKey && pos.has(curKey)) {
        this.index = pos.get(curKey);
        this.detached = false;
      } else {
        // 表示中のスライドが消えた: 残っている直前のスライドの次（消えた位置に繰り上がったもの）を次に表示する
        let next = 0;
        for (let k = Math.min(oldIndex, old.length) - 1; k >= 0; k--) {
          const i = pos.get(old[k].key);
          if (i !== undefined) {
            next = i + 1;
            break;
          }
        }
        this.index = next;
        this.detached = true;
      }
    }
    this._updateCounter();
    if (this.active) {
      // 空になった / 空から戻った
      if (!this.slides.length) {
        if (!wasEmpty) this.goTo(0);
      } else if (wasEmpty) this.goTo(0);
    }
  }

  start(startIndex = 0) {
    this.active = true;
    this.root.hidden = false;
    document.addEventListener('keydown', this._onKey);
    this.root.addEventListener('pointermove', this._onActivity);
    document.addEventListener('visibilitychange', this._onVisibility);
    document.addEventListener('fullscreenchange', this._onFullscreen);
    window.addEventListener('blur', this._onWindowBlur);
    this.detached = false;
    this.audioUnlocked = navigator.userActivation ? navigator.userActivation.hasBeenActive : true;
    this._syncMuteButton();
    this._onFullscreen();
    this.playing = true;
    this._syncPlayButton();
    this._requestWakeLock();
    this._setMediaSession(true);
    this._showHud();
    this.goTo(startIndex);
  }

  stop() {
    this.active = false;
    this.playing = false;
    this._nextSeq();
    this._clearTimer();
    this._releaseWakeLock();
    this._setMediaSession(false);
    this._closeDrivePlayer();
    clearTimeout(this.hudTimer);
    document.removeEventListener('keydown', this._onKey);
    this.root.removeEventListener('pointermove', this._onActivity);
    document.removeEventListener('visibilitychange', this._onVisibility);
    document.removeEventListener('fullscreenchange', this._onFullscreen);
    window.removeEventListener('blur', this._onWindowBlur);
    this.detached = false;
    if (this.current) {
      this.current.cleanup();
      this.current.el.remove();
      this.current = null;
    }
    this.stage.replaceChildren();
    this._setSpinner(false);
    this.root.hidden = true;
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this._syncPlayButton();
    this._requestWakeLock();
    const cur = this.current;
    if (!cur) {
      this.goTo(this.index);
      return;
    }
    if (cur.kind === 'end') {
      if (!cur.empty || this.slides.length) this.goTo(0);
      return;
    }
    if (cur.video && !cur.videoFailed) {
      this._playVideo(cur.video);
    } else {
      this._resumeTimer();
    }
    this._setKenBurnsPaused(false);
    this._showHud();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this._syncPlayButton();
    this._releaseWakeLock();
    this._pauseTimer();
    if (this.current?.video) this.current.video.pause();
    this._setKenBurnsPaused(true);
    this._showHud(true);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  next() {
    if (!this.slides.length) return;
    // 表示中のスライドが消えていれば、index はすでに次のスライドを指している
    const target = this.detached ? this.index : this.index + 1;
    if (target > this.slides.length - 1) {
      if (this.getSettings().loop) this.goTo(0, 1);
      else this._showEnd();
      return;
    }
    this.goTo(target, 1);
  }

  prev() {
    if (!this.slides.length) return;
    if (this.current?.kind === 'end' && !this.current.empty) {
      this.goTo(this.slides.length - 1, -1);
      return;
    }
    this.goTo(Math.max(0, this.index - 1), -1);
  }

  /**
   * 指定の写真・動画へ移る。play: true なら（一時停止中でも）そのスライドから再生を始める。
   * 今のスライドの動画は再開しない。見つかれば true
   */
  goToItem(id, { play = false } = {}) {
    const i = this.slides.findIndex((s) => s.type === 'media' && s.item.id === id);
    if (i < 0) return false;
    if (play && !this.playing) {
      this.playing = true;
      this._syncPlayButton();
      this._requestWakeLock();
      this._showHud();
    }
    this.goTo(i);
    return true;
  }

  /** 現在のスライドを読み込み直す（再ログイン後など） */
  retry() {
    this.goTo(this.index);
  }

  toggleMute() {
    const s = this.getSettings();
    if (!s.videoMuted && !this.audioUnlocked) {
      // 自動再生の制限でミュートになっているだけなら、設定は変えずに音声を有効にする（操作の中で呼ばれる）
      this._unlockAudio();
      return;
    }
    s.videoMuted = !s.videoMuted;
    this.dispatchEvent(new CustomEvent('settingschange', { detail: { videoMuted: s.videoMuted } }));
    if (!s.videoMuted) this._unlockAudio();
    this._applyVideoMute();
    this._syncMuteButton();
  }

  toggleFullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else if (el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }

  get currentItem() {
    if (this.detached) return null;
    const s = this.slides[this.index];
    return s && s.type === 'media' ? s.item : null;
  }

  // -------------------------------------------------------------------------
  // スライドの表示

  async goTo(index, direction = 0) {
    if (!this.active) return;
    this.detached = false;
    if (!this.slides.length) {
      this._nextSeq();
      this._clearTimer();
      this._setSpinner(false);
      this.index = 0;
      this._swap(this._renderMessage('表示できる写真・動画がありません'), { kind: 'end', empty: true });
      this.caption.replaceChildren();
      this._updateCounter();
      this._showHud(true);
      return;
    }
    index = Math.max(0, Math.min(index, this.slides.length - 1));
    this.index = index;
    const seq = this._nextSeq();
    this._clearTimer();
    this._updateCounter();
    const slide = this.slides[index];
    this._spinnerSoon();
    let prepared;
    try {
      prepared = await this._prepare(slide, seq);
    } catch (e) {
      if (seq !== this.seq) return;
      this._setSpinner(false);
      if (e instanceof AuthRequiredError) {
        const wasPlaying = this.playing;
        this.pause();
        this.onAuthRequired?.(e, { wasPlaying });
        return;
      }
      // 表示しようとしている写真の読み込みが中止された（通常は起きない）: 一度だけ読み直す
      if (e && e.name === 'AbortError' && !this._retriedAbort) {
        this._retriedAbort = true;
        this.goTo(index, direction);
        return;
      }
      console.warn('スライドを表示できません:', slide, e);
      this.consecutiveErrors++;
      if (this.consecutiveErrors === 1) toast(e.message || '読み込みに失敗したためスキップしました', { kind: 'warn' });
      if (this.consecutiveErrors >= Math.min(10, this.slides.length)) {
        this.pause();
        this._swap(this._renderMessage('写真・動画を読み込めませんでした。ネットワークや共有設定を確認してください。'), { kind: 'end' });
        return;
      }
      // スキップ（戻る途中で先頭が読めなければ先へ進む）
      if (direction < 0 && index > 0) this.goTo(index - 1, -1);
      else if (index < this.slides.length - 1) this.goTo(index + 1, 1);
      else if (this.getSettings().loop) this.goTo(0, 1);
      else this._showEnd();
      return;
    }
    if (seq !== this.seq) {
      prepared.cleanup();
      return;
    }
    this._retriedAbort = false;
    this.consecutiveErrors = 0;
    this._setSpinner(false);
    this._swap(prepared.el, prepared);
    this._updateCaption(slide);
    this._begin(prepared);
    this._preloadAround(index);
  }

  _swap(el, prepared) {
    const s = this.getSettings();
    const old = this.current;
    const fade = s.transition === 'fade' && !prefersReducedMotion();
    el.classList.add('slide');
    if (fade) el.classList.add('fade');
    this.stage.append(el);
    // 次のフレームで表示（CSS トランジション）
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('visible')));
    if (old) {
      old.el.classList.remove('visible');
      old.el.classList.add('leaving');
      // 出ていく動画はすぐ止める（フェードは見た目だけ。音が重ならないように）
      old.video?.pause();
      old.stop?.();
      const remove = () => {
        old.cleanup();
        old.el.remove();
      };
      if (fade) setTimeout(remove, 1300);
      else remove();
    }
    this.current = { cleanup: () => {}, ...prepared, el };
    // 埋め込みプレーヤーにフォーカスが入ったままだとキー操作が届かないので戻す
    this._reclaimFocus();
    if (prepared.kind === 'video-embed' || old?.kind === 'video-embed') this._showHud();
  }

  _begin(prepared) {
    const s = this.getSettings();
    if (prepared.kind === 'video' && prepared.video && !prepared.videoFailed) {
      this._startVideo(prepared);
      return;
    }
    if (prepared.kind === 'end') return;
    if (prepared.kind === 'video-embed') {
      this._startTimer(prepared.holdMs);
      if (!this.playing) this._pauseTimer();
      return;
    }
    let seconds = s.photoSeconds;
    if (prepared.kind === 'title') seconds = TITLE_SECONDS;
    else if (prepared.kind === 'day') seconds = CARD_SECONDS;
    this._startTimer(seconds * 1000);
    if (!this.playing) {
      this._pauseTimer();
      this._setKenBurnsPaused(true);
    }
  }

  async _prepare(slide, seq) {
    if (slide.type === 'title') return this._prepareTitle();
    if (slide.type === 'day') return this._prepareDay(slide);
    const item = slide.item;
    if (item.kind === 'image') return this._prepareImage(item);
    return this._prepareVideo(item, seq);
  }

  _kenBurnsClass(item) {
    // ファイル ID から決まる方向でゆっくりズーム
    let hsh = 0;
    for (const ch of item.id) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
    return `kb kb-${hsh % 4}`;
  }

  async _prepareImage(item) {
    const s = this.getSettings();
    const img = await this.loader.loadImage(item, { keep: this._neighborIds() });
    const photo = h('img', { class: 'photo', src: img.url, alt: item.name, draggable: 'false' });
    const children = [];
    if (s.blurBackground) children.push(h('img', { class: 'backdrop', src: img.url, alt: '', 'aria-hidden': 'true', draggable: 'false' }));
    const frame = h('div', { class: 'photo-frame' }, [photo]);
    if (s.kenBurns && !prefersReducedMotion()) {
      frame.className += ` ${this._kenBurnsClass(item)}`;
      frame.style.setProperty('--kb-duration', `${s.photoSeconds + 1.5}s`);
    }
    children.push(frame);
    const el = h('div', { class: 'slide-image', dataset: { id: item.id, kind: 'image' } }, children);
    return { el, kind: 'image', item, cleanup: () => {} };
  }

  async _prepareVideo(item, seq) {
    const s = this.getSettings();
    let src = this.loader.streamUrl(item);
    let blobHandle = null;
    if (!src) {
      // ストリーミングできない環境（Service Worker 無効など）では全体をダウンロード
      this._setSpinner(true);
      const ctrl = new AbortController();
      const offBlob = this._whenStale(seq, () => ctrl.abort());
      try {
        blobHandle = await this.loader.loadVideoBlob(item, {
          signal: ctrl.signal,
          onProgress: (p) => {
            if (seq === this.seq) this.spinner.style.setProperty('--p', String(p));
          },
        });
        src = blobHandle.url;
      } finally {
        offBlob();
      }
    }
    const video = h('video', {
      class: 'video',
      playsinline: true,
      'webkit-playsinline': true,
      preload: 'auto',
      disablepictureinpicture: true,
    });
    video.muted = s.videoMuted || !this.audioUnlocked;
    const poster = this.loader.thumbnailUrl(item, 1280);
    if (poster) video.poster = poster;
    const el = h('div', { class: 'slide-video', dataset: { id: item.id, kind: 'video' } }, [video]);
    const cleanup = () => {
      video.pause();
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        /* ignore */
      }
      blobHandle?.revoke();
    };
    let ready = false;
    let off = () => {};
    try {
      // 最初のフレームが読めるまで少し待つ（iOS などは再生を始めるまで読み込まないので、待ちすぎない）
      ready = await new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(false), VIDEO_READY_WAIT);
        // 別のスライドへ移ったらすぐにやめて、読み込みを止める
        off = this._whenStale(seq, () => {
          clearTimeout(t);
          reject(new DOMException('動画の読み込みを中止しました', 'AbortError'));
        });
        if (seq !== this.seq) return;
        const ok = () => {
          clearTimeout(t);
          // 映像トラックを再生できない（例: HEVC 非対応）場合は videoWidth が 0 になる
          if (!video.videoWidth) reject(new Error('no-video-track'));
          else resolve(true);
        };
        video.addEventListener('loadeddata', ok, { once: true });
        video.addEventListener(
          'error',
          () => {
            clearTimeout(t);
            reject(new Error(`media-error-${video.error?.code || 0}`));
          },
          { once: true },
        );
        video.src = src;
      });
    } catch (e) {
      cleanup();
      if (seq !== this.seq) throw e;
      return this._videoFailed(item, e);
    } finally {
      off();
    }
    return { el, kind: 'video', item, video, ready, cleanup };
  }

  /** 動画が再生できなかったときの代わりのスライド（ログイン切れならログインを求める） */
  async _videoFailed(item, err) {
    console.warn('動画を再生できません:', item.name, err);
    if (this.loader.drive.mode === 'oauth' && !(await this._tokenStillValid())) throw new AuthRequiredError();
    return this._prepareVideoFallback(item);
  }

  /** 表示中の動画を代わりのスライドに差し替える */
  async _replaceWithFallback(cur, err) {
    if (this.current !== cur) return;
    const seq = this.seq;
    let prepared;
    try {
      prepared = await this._videoFailed(cur.item, err);
    } catch (e) {
      if (seq !== this.seq || this.current !== cur) return;
      if (e instanceof AuthRequiredError) {
        const wasPlaying = this.playing;
        this.pause();
        this.onAuthRequired?.(e, { wasPlaying });
      }
      return;
    }
    if (seq !== this.seq || this.current !== cur) {
      prepared.cleanup();
      return;
    }
    this._clearTimer();
    this._swap(prepared.el, prepared);
    this._begin(prepared);
  }

  async _tokenStillValid() {
    try {
      const c = await this.loader.drive.credentials(false);
      return !!c;
    } catch {
      return false;
    }
  }

  /**
   * 再生できない動画（HEVC 非対応のブラウザなど）。
   *  - 公開フォルダ（API キー）: Google ドライブの埋め込みプレーヤーで自動再生し、動画の長さだけ表示する
   *  - それ以外: サムネイルと「ドライブで再生」ボタンを表示する
   */
  _prepareVideoFallback(item) {
    const s = this.getSettings();
    const poster = this.loader.thumbnailUrl(item, 1280);
    if (this.loader.drive.mode === 'apikey' && item.durationMs > 0) {
      const maxMs = s.videoMaxSeconds > 0 ? s.videoMaxSeconds * 1000 : Infinity;
      const holdMs = Math.min(item.durationMs + 2500, maxMs);
      const iframe = h('iframe', {
        class: 'drive-embed',
        src: drivePreviewUrl(item, { autoplay: true }),
        allow: 'autoplay; fullscreen',
        title: item.name,
      });
      const el = h('div', { class: 'slide-video-embed', dataset: { id: item.id, kind: 'video' } }, [iframe]);
      const stop = () => {
        iframe.style.visibility = 'hidden';
        iframe.src = 'about:blank';
      };
      return { el, kind: 'video-embed', item, holdMs, stop, cleanup: stop };
    }
    const open = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-light',
        onclick: (e) => {
          e.stopPropagation();
          if (e.detail > 0) e.currentTarget.blur(); // Space で再び押されないように
          this.openDrivePlayer(item);
        },
      },
      [icon('video'), ' Google ドライブのプレーヤーで再生'],
    );
    const el = h('div', { class: 'slide-video-fallback', dataset: { id: item.id, kind: 'video' } }, [
      poster ? h('img', { class: 'backdrop', src: poster, alt: '', 'aria-hidden': 'true' }) : null,
      poster ? h('div', { class: 'photo-frame' }, [h('img', { class: 'photo', src: poster, alt: item.name })]) : null,
      h('div', { class: 'fallback-note' }, [h('p', {}, ['この動画はこのブラウザでは直接再生できません（形式が未対応の可能性があります）。']), open]),
    ]);
    return { el, kind: 'video', item, videoFailed: true, cleanup: () => {} };
  }

  /** Google ドライブの埋め込みプレーヤーで動画を開く（スライドショーは一時停止） */
  openDrivePlayer(item) {
    this._closeDrivePlayer();
    this.pause();
    const iframe = h('iframe', {
      src: drivePreviewUrl(item, { autoplay: true }),
      allow: 'autoplay; fullscreen',
      allowfullscreen: true,
      title: item.name,
    });
    const close = () => {
      if (this.drivePlayer !== dp) return;
      this.drivePlayer = null;
      document.removeEventListener('keydown', onKey, true);
      iframe.src = 'about:blank';
      overlay.remove();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const overlay = h('div', { class: 'drive-player', role: 'dialog', 'aria-label': item.name }, [
      h('div', { class: 'drive-player-bar' }, [
        h('span', {}, [item.name]),
        h('a', { href: item.webViewLink, target: '_blank', rel: 'noopener', class: 'ctl', title: '新しいタブで開く' }, [icon('external')]),
        h('button', { type: 'button', class: 'ctl', title: '閉じる', 'aria-label': '閉じる', onclick: close }, [icon('close')]),
      ]),
      iframe,
    ]);
    const dp = { el: overlay, close };
    this.drivePlayer = dp;
    document.addEventListener('keydown', onKey, true);
    this.root.append(overlay);
  }

  _closeDrivePlayer() {
    this.drivePlayer?.close();
    this.drivePlayer = null;
  }

  _startVideo(prepared) {
    const s = this.getSettings();
    const video = prepared.video;
    const maxSec = s.videoMaxSeconds > 0 ? s.videoMaxSeconds : Infinity;
    let lastProgressAt = performance.now();
    let lastTime = -1;
    let finished = false;
    const finish = () => {
      if (finished || this.current !== cur) return;
      finished = true;
      this.next();
    };
    const cur = this.current;
    const onTime = () => {
      const dur = Math.min(Number.isFinite(video.duration) ? video.duration : Infinity, maxSec);
      if (Number.isFinite(dur) && dur > 0) this._setProgress(video.currentTime / dur);
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        lastProgressAt = performance.now();
      }
      if (video.currentTime >= maxSec) finish();
    };
    const onEnded = () => finish();
    // アプリ以外（メディアキー、ヘッドホンのボタンや取り外し、OS など）が動画を止めた・動かしたら、スライドショーも合わせる。
    // アプリ自身が止めるときは先に playing を変える（または別のスライドに替える）ので、ここでは何もしない
    const external = () => !finished && this.current === cur && !video.ended && !document.hidden;
    const onPause = () => {
      if (external() && this.playing && video.paused) this.pause();
    };
    const onPlay = () => {
      if (external() && !this.playing && !video.paused) this.play();
    };
    const onError = () => {
      if (finished || this.current !== cur) return;
      finished = true;
      // 読み込み前のエラー（形式が未対応など）は代わりのスライドへ、再生途中のエラーは次へ
      if (!sawFrame) this._replaceWithFallback(cur, new Error(`media-error-${video.error?.code || 0}`));
      else this.next();
    };
    let sawFrame = !!prepared.ready;
    const onLoaded = () => {
      sawFrame = true;
      if (!video.videoWidth && !finished && this.current === cur) {
        finished = true;
        this._replaceWithFallback(cur, new Error('no-video-track'));
      }
    };
    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    video.addEventListener('pause', onPause);
    video.addEventListener('play', onPlay);
    if (video.error) {
      // 準備中にすでにエラーになっていた
      queueMicrotask(onError);
      return;
    }
    // 長時間止まったまま（通信が途切れた等）なら次へ。
    // 再生中なのに再生が始まらない（自動再生の制限など）なら再生し直し（音声付きが拒否されたらミュート）、それでもだめなら次へ
    let pausedSince = 0;
    let retried = false;
    const watchdog = setInterval(() => {
      if (finished || this.current !== cur) return;
      const now = performance.now();
      if (!this.playing || document.hidden) {
        lastProgressAt = now;
        pausedSince = 0;
        return;
      }
      if (video.paused) {
        lastProgressAt = now;
        if (!pausedSince) pausedSince = now;
        else if (now - pausedSince > VIDEO_PAUSED_STALL) {
          if (!retried) {
            retried = true;
            pausedSince = now;
            this._playVideo(video);
          } else {
            toast('動画を再生できないため、次へ進みます', { kind: 'warn' });
            finish();
          }
        }
        return;
      }
      pausedSince = 0;
      if (now - lastProgressAt > VIDEO_STALL_TIMEOUT) {
        toast('動画の読み込みが止まったため、次へ進みます', { kind: 'warn' });
        finish();
      }
    }, 1000);
    const prevCleanup = prepared.cleanup;
    cur.cleanup = () => {
      clearInterval(watchdog);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('loadeddata', onLoaded);
      prevCleanup();
    };
    this._setProgress(0);
    this.bar.classList.remove('animating');
    video.muted = s.videoMuted || !this.audioUnlocked;
    if (!this.playing) return;
    const p = video.play();
    if (p && p.catch) {
      p.catch((err) => {
        if (finished || this.current !== cur) return;
        if (err && err.name === 'NotAllowedError' && !video.muted) {
          // 音声付き自動再生がブロックされた → ミュートで再生
          video.muted = true;
          this.audioUnlocked = false;
          this._syncMuteButton();
          toast('自動再生の制限のため音声をミュートしました。画面をタップ（クリック）すると音声が出ます。', { timeout: 6000 });
          video.play().catch(() => (sawFrame ? finish() : onError()));
        } else if (err && err.name !== 'AbortError') {
          if (sawFrame) finish();
          else onError();
        }
      });
    }
  }

  _prepareTitle() {
    const sum = tripSummary(this.items);
    const s = this.getSettings();
    const tz = s.timeZone;
    let range = '';
    if (sum) {
      const a = epochToWall(sum.first, tz);
      const b = epochToWall(sum.last, tz);
      range =
        a.y === b.y && a.mo === b.mo && a.d === b.d
          ? formatDateJa(sum.first, tz)
          : a.y === b.y
            ? `${formatDateJa(sum.first, tz)} – ${b.mo}月${b.d}日`
            : `${formatDateJa(sum.first, tz)} – ${formatDateJa(sum.last, tz)}`;
    }
    const counts = sum ? [sum.photos ? `写真 ${sum.photos}枚` : '', sum.videos ? `動画 ${sum.videos}本` : ''].filter(Boolean).join('・') : '';
    const el = h('div', { class: 'slide-card slide-title', dataset: { kind: 'title' } }, [
      this._cardBackdrop(this._backdropItem({ type: 'title' })),
      h('div', { class: 'card-inner' }, [
        h('h1', { class: 'card-title' }, [this.getTitle() || 'スライドショー']),
        range ? h('p', { class: 'card-sub' }, [range]) : null,
        counts ? h('p', { class: 'card-meta' }, [`${counts}${sum && sum.dayCount > 1 ? `・${sum.dayCount}日間` : ''}`]) : null,
      ]),
    ]);
    return { el, kind: 'title', cleanup: () => {} };
  }

  _prepareDay(slide) {
    const first = this._backdropItem(slide);
    const anyItem = this.items.find((i) => i.day === slide.day);
    const s = this.getSettings();
    const el = h('div', { class: 'slide-card slide-day', dataset: { kind: 'day', day: slide.day } }, [
      this._cardBackdrop(first),
      h('div', { class: 'card-inner' }, [
        // 主な期間の外の日（dayNumber が null）は日付だけ
        slide.dayNumber != null ? h('p', { class: 'card-kicker' }, [`${slide.dayNumber}日目`]) : null,
        h('h2', { class: 'card-title' }, [anyItem ? formatDateJa(anyItem.epoch, s.timeZone) : slide.day]),
        h('p', { class: 'card-meta' }, [`${slide.count}件`]),
      ]),
    ]);
    return { el, kind: 'day', cleanup: () => {} };
  }

  /** カードの背景（その日の最初の写真をぼかして表示。読み込み済みなら即座に） */
  _cardBackdrop(item) {
    const bg = h('div', { class: 'card-backdrop', 'aria-hidden': 'true' });
    if (!item) return bg;
    this.loader
      .loadImage(item, { keep: this._neighborIds() })
      .then((r) => {
        const img = h('img', { src: r.url, alt: '' });
        img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
        bg.append(img);
      })
      .catch(() => {});
    return bg;
  }

  _renderMessage(text) {
    return h('div', { class: 'slide-card slide-message' }, [h('div', { class: 'card-inner' }, [h('p', { class: 'card-sub' }, [text])])]);
  }

  _showEnd() {
    this._nextSeq();
    this._clearTimer();
    this._setSpinner(false);
    this.playing = false;
    this._syncPlayButton();
    this._releaseWakeLock();
    const el = h('div', { class: 'slide-card slide-end', dataset: { kind: 'end' } }, [
      h('div', { class: 'card-inner' }, [
        h('h2', { class: 'card-title' }, ['おわり']),
        h('div', { class: 'card-actions' }, [
          h('button', { type: 'button', class: 'btn btn-light', onclick: (e) => {
            e.stopPropagation();
            if (e.detail > 0) e.currentTarget.blur();
            this._unlockAudio();
            this.playing = true;
            this._syncPlayButton();
            this._requestWakeLock();
            this.goTo(0);
          } }, ['もう一度見る']),
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: (e) => {
            e.stopPropagation();
            if (e.detail > 0) e.currentTarget.blur();
            this.onOpenGrid?.();
          } }, ['一覧を見る']),
        ]),
      ]),
    ]);
    this._swap(el, { kind: 'end', cleanup: () => {} });
    this.caption.replaceChildren();
    this._showHud(true);
  }

  // -------------------------------------------------------------------------
  // 先読み

  _neighborIds() {
    const ids = [];
    for (let d = -1; d <= 3; d++) {
      const s = this.slides[this.index + d];
      if (s && s.type === 'media') ids.push(s.item.id);
      // タイトル・日付カードの背景の写真（先頭が動画の日は先読みの範囲外のことがある）
      const bg = s && this._backdropItem(s);
      if (bg && !ids.includes(bg.id)) ids.push(bg.id);
    }
    return ids;
  }

  /** タイトル・日付カードの背景に使う写真 */
  _backdropItem(slide) {
    if (slide.type === 'title') return this.items.find((i) => i.kind === 'image') || null;
    if (slide.type === 'day') return this.items.find((i) => i.day === slide.day && i.kind === 'image') || null;
    return null;
  }

  _preloadAround(index) {
    const keep = this._neighborIds();
    let n = 0;
    for (let i = index + 1; i < this.slides.length && n < 3; i++) {
      const s = this.slides[i];
      if (s.type !== 'media') continue;
      n++;
      if (s.item.kind === 'image') this.loader.loadImage(s.item, { keep }).catch(() => {});
    }
    if (this.getSettings().loop && index >= this.slides.length - 3) {
      const first = this.slides.find((s) => s.type === 'media' && s.item.kind === 'image');
      if (first) this.loader.loadImage(first.item, { keep }).catch(() => {});
    }
    this.loader.retain(keep);
  }

  // -------------------------------------------------------------------------
  // タイマー・進捗

  _startTimer(ms) {
    this._clearTimer();
    this.timer = { duration: ms, remaining: ms, start: performance.now(), handle: setTimeout(() => this._onTimer(), ms) };
    this._animateBar(0, ms);
  }

  _onTimer() {
    this.timer = null;
    if (this.playing) this.next();
  }

  _pauseTimer() {
    if (!this.timer || this.timer.handle == null) return;
    clearTimeout(this.timer.handle);
    this.timer.handle = null;
    this.timer.remaining -= performance.now() - this.timer.start;
    const done = 1 - Math.max(0, this.timer.remaining) / this.timer.duration;
    this.bar.classList.remove('animating');
    this._setProgress(done);
  }

  _resumeTimer() {
    if (!this.timer || this.timer.handle != null) return;
    const rem = Math.max(200, this.timer.remaining);
    this.timer.start = performance.now();
    this.timer.handle = setTimeout(() => this._onTimer(), rem);
    this._animateBar(1 - rem / this.timer.duration, rem);
  }

  _clearTimer() {
    if (this.timer && this.timer.handle != null) clearTimeout(this.timer.handle);
    this.timer = null;
    this.bar.classList.remove('animating');
    this._setProgress(0);
  }

  _animateBar(from, ms) {
    this.bar.classList.remove('animating');
    this.bar.style.transitionDuration = '0ms';
    this._setProgress(from);
    void this.bar.offsetWidth; // reflow
    this.bar.style.transitionDuration = `${ms}ms`;
    this.bar.classList.add('animating');
    this._setProgress(1);
  }

  _setProgress(frac) {
    this.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;
  }

  _setKenBurnsPaused(paused) {
    const f = this.current?.el.querySelector('.kb');
    if (f) f.style.animationPlayState = paused ? 'paused' : 'running';
  }

  // -------------------------------------------------------------------------
  // HUD

  _updateCaption(slide) {
    const s = this.getSettings();
    if (slide.type !== 'media' || s.captions === 'none') {
      this.caption.replaceChildren();
      return;
    }
    const it = slide.item;
    const daySlide = this.slides.find((x) => x.type === 'day' && x.day === it.day);
    const parts = [h('span', { class: 'cap-date' }, [formatDateTimeJa(it.epoch, s.timeZone)])];
    if (daySlide && daySlide.dayNumber != null) parts.push(h('span', { class: 'cap-day' }, [`${daySlide.dayNumber}日目`]));
    if (it.timeSource === 'drive-times') parts.push(h('span', { class: 'cap-warn', title: '撮影日時が見つからないため、ドライブ上の日時で並べています' }, ['日時推定']));
    if (s.captions === 'datetime-name') parts.push(h('span', { class: 'cap-name' }, [it.name]));
    this.caption.replaceChildren(...parts);
  }

  _updateCounter() {
    const mediaSlides = this.slides.filter((s) => s.type === 'media');
    const cur = this.slides[this.index];
    let pos = 0;
    if (cur) {
      for (let i = 0; i <= this.index; i++) if (this.slides[i].type === 'media') pos++;
    }
    // 表示中のスライドが一覧から消えたときは、次の項目の番号を出さないように隠す
    this.counter.textContent = !this.detached && mediaSlides.length && cur && cur.type === 'media' ? `${pos} / ${mediaSlides.length}` : '';
  }

  _syncPlayButton() {
    this.btnPlay.replaceChildren(icon(this.playing ? 'pause' : 'play'));
    const label = this.playing ? '一時停止 (Space)' : '再生 (Space)';
    this.btnPlay.title = label;
    this.btnPlay.setAttribute('aria-label', label);
    this.root.classList.toggle('paused', !this.playing);
    if (this.active && navigator.mediaSession) {
      try {
        navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
      } catch {
        /* ignore */
      }
    }
  }

  _syncMuteButton() {
    // 設定だけでなく、自動再生の制限でミュートになっている状態も表す
    const muted = this.getSettings().videoMuted || !this.audioUnlocked;
    this.btnMute.replaceChildren(icon(muted ? 'mute' : 'volume'));
    const label = muted ? 'ミュート解除 (M)' : 'ミュート (M)';
    this.btnMute.title = label;
    this.btnMute.setAttribute('aria-label', label);
  }

  _onFullscreen() {
    const fs = !!document.fullscreenElement;
    this.btnFs.replaceChildren(icon(fs ? 'exitFullscreen' : 'fullscreen'));
    const label = fs ? '全画面を終了 (F)' : '全画面 (F)';
    this.btnFs.title = label;
    this.btnFs.setAttribute('aria-label', label);
  }

  _showHud(sticky = false) {
    this.root.classList.remove('hud-hidden');
    clearTimeout(this.hudTimer);
    if (!sticky && this.playing) {
      this.hudTimer = setTimeout(() => {
        if (this.playing && !this._hudPinned()) this.root.classList.add('hud-hidden');
      }, HUD_HIDE_MS);
    }
  }

  /** 操作パネルを隠さない状態か（ドライブのプレーヤー・埋め込み動画の表示中、パネル内にフォーカスがあるとき） */
  _hudPinned() {
    if (this.drivePlayer || this.root.querySelector('.drive-player')) return true;
    if (this.current?.kind === 'video-embed') return true;
    const a = document.activeElement;
    return !!(a && a !== document.body && this.hud.contains(a));
  }

  _onActivity() {
    // マウスの移動はユーザー操作（activation）ではないので、ここでは音声を有効にしない
    this._showHud();
  }

  /** 埋め込みプレーヤー（別オリジンの iframe）にフォーカスが移ると、マウスやキーの操作が届かなくなる */
  _onWindowBlur() {
    setTimeout(() => {
      const a = document.activeElement;
      if (this.active && a && a.tagName === 'IFRAME' && this.stage.contains(a)) this._showHud();
    }, 0);
  }

  /** 表示中のスライドの iframe にあるフォーカスをプレイヤーに戻す */
  _reclaimFocus() {
    const a = document.activeElement;
    if (!a || a.tagName !== 'IFRAME' || !this.stage.contains(a)) return;
    this.root.tabIndex = -1;
    this.root.focus({ preventScroll: true });
    this.root.addEventListener('blur', () => this.root.removeAttribute('tabindex'), { once: true });
  }

  /** 音声付きの動画が、自動再生の制限でミュートになって表示されているか */
  _soundBlocked() {
    const cur = this.current;
    return !this.audioUnlocked && !this.getSettings().videoMuted && !!cur?.video && !cur.videoFailed;
  }

  /**
   * ユーザー操作（クリック・タップ・キー）の中で呼ぶ。自動再生の制限で止めていた音声を有効にする。
   * 操作の直後（transient activation）でなければ何もしない。有効にしたら true。
   * apply: false は今の動画のミュートを変えない（次へ・前へなど、出ていく動画の音を出さないとき）
   */
  _unlockAudio({ apply = true } = {}) {
    if (this.audioUnlocked) return false;
    const ua = navigator.userActivation;
    if (ua && !ua.isActive) return false;
    this.audioUnlocked = true;
    this._syncMuteButton();
    if (apply) this._applyVideoMute();
    return true;
  }

  /** 表示中の動画のミュートを、設定と自動再生の制限に合わせる */
  _applyVideoMute() {
    const cur = this.current;
    const v = cur?.video;
    if (!v || cur.videoFailed) return;
    const muted = this.getSettings().videoMuted || !this.audioUnlocked;
    if (v.muted === muted) return;
    v.muted = muted;
    if (!muted && this.playing) this._playVideo(v);
  }

  /** 動画を再生する。音声付きの再生が拒否されたら（Safari など）ミュートにして再生し直す */
  _playVideo(v) {
    const p = v.play();
    if (!p || !p.catch) return;
    p.catch((err) => {
      if (!err || err.name !== 'NotAllowedError' || v.muted || this.current?.video !== v) return;
      v.muted = true;
      this.audioUnlocked = false;
      this._syncMuteButton();
      if (this.playing) v.play().catch(() => {});
    });
  }

  /** seq を進める（進行中の読み込みは古くなる） */
  _nextSeq() {
    const seq = ++this.seq;
    const fns = [...this._staleFns];
    this._staleFns.clear();
    for (const fn of fns) {
      try {
        fn();
      } catch (e) {
        console.warn(e);
      }
    }
    return seq;
  }

  /** seq が変わったら fn を呼ぶ。戻り値で登録を外す */
  _whenStale(seq, fn) {
    if (seq !== this.seq) {
      fn();
      return () => {};
    }
    this._staleFns.add(fn);
    return () => this._staleFns.delete(fn);
  }

  _spinnerSoon() {
    clearTimeout(this.spinnerTimer);
    this.spinnerTimer = setTimeout(() => this._setSpinner(true), 700);
  }

  _setSpinner(on) {
    clearTimeout(this.spinnerTimer);
    this.spinner.classList.toggle('on', on);
    if (!on) this.spinner.style.removeProperty('--p');
  }

  _onKey(e) {
    if (!this.active || e.defaultPrevented) return;
    const target = e.target && e.target.closest ? e.target : null;
    if (target && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (this.drivePlayer || document.querySelector('.overlay:not([hidden]), .drive-player')) return;
    // フォーカスのある（表示されている）ボタンやリンクは Space / Enter でそのまま押せるようにする
    const control = (e.key === ' ' || e.key === 'Enter') && target ? target.closest('button, a, summary, [role="button"]') : null;
    if (control && control.getClientRects().length) {
      this._showHud();
      return;
    }
    // M はミュートボタンと同じく toggleMute で音声の制限を扱う。別のスライドへ移るキーでは出ていく動画の音は出さない
    if (e.key !== 'm' && e.key !== 'M') this._unlockAudio({ apply: !NAV_KEYS.has(e.key) });
    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        e.preventDefault();
        this.toggle();
        break;
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault();
        this.next();
        break;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        this.prev();
        break;
      case 'Home':
        e.preventDefault();
        this.goTo(0);
        break;
      case 'End':
        e.preventDefault();
        this.goTo(this.slides.length - 1);
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        this.toggleFullscreen();
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        this.toggleMute();
        break;
      case 'g':
      case 'G':
        e.preventDefault();
        this.onOpenGrid?.();
        break;
      case 'Tab':
        // フォーカスが見えない操作パネルに移らないよう、パネルを表示する
        break;
      default:
        return;
    }
    this._showHud();
  }

  // -------------------------------------------------------------------------
  // 画面のスリープ防止

  async _requestWakeLock() {
    if (!('wakeLock' in navigator) || this.wakeLock || document.visibilityState !== 'visible') return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
      });
    } catch {
      this.wakeLock = null;
    }
  }

  /** メディアキーやヘッドホンのボタンでスライドショーを操作する（ブラウザに動画だけを止めさせない） */
  _setMediaSession(on) {
    const ms = navigator.mediaSession;
    if (!ms || typeof ms.setActionHandler !== 'function') return;
    const handlers = {
      play: () => this.play(),
      pause: () => this.pause(),
      nexttrack: () => this.next(),
      previoustrack: () => this.prev(),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try {
        ms.setActionHandler(action, on ? fn : null);
      } catch {
        /* 未対応の操作 */
      }
    }
    if (!on) {
      try {
        ms.playbackState = 'none';
      } catch {
        /* ignore */
      }
    }
  }

  _releaseWakeLock() {
    const wl = this.wakeLock;
    this.wakeLock = null;
    wl?.release().catch(() => {});
  }

  _onVisibility() {
    if (document.visibilityState === 'visible' && this.playing) this._requestWakeLock();
  }
}
