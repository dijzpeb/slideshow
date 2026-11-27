// 写真・動画の読み込み（Service Worker 経由のストリーミング、Blob、HEIC 変換、サムネイル）

import { AuthRequiredError, safeMediaType, prefersThumbnail } from './drive.js';
import { RangeReader, readJpegExifThumbnail } from './mediatime.js';

// HEIC を表示できないブラウザ（Safari 以外）向けの変換ライブラリ（js/vendor/ に同梱）。必要になったときだけ読み込む
const HEIC_TO_SRC = new URL('./vendor/heic-to.js', import.meta.url).href;

/** 写真の元ファイルの一時的なエラー（429 / 5xx）を再試行する回数 */
const PHOTO_RETRIES = 3;

/** promise が ms 以内に決着しなければ null で解決する（後から失敗しても未処理にはならない） */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** このアプリの Service Worker のスクリプトの URL（ページと同じ場所の sw.js） */
export function appServiceWorkerUrl(baseUrl = location.href) {
  return new URL('sw.js', baseUrl).href;
}

/**
 * メッセージの送り主がこのアプリの Service Worker か。同じオリジンの別のアプリ（同じ github.io の別リポジトリなど）の
 * Service Worker も、制御していないページにメッセージを送れるため、それに接続情報を渡したり、
 * トークンを捨てさせたり（force）しない
 */
export function isOwnServiceWorker(source, baseUrl = location.href) {
  return typeof ServiceWorker !== 'undefined' && source instanceof ServiceWorker && source.scriptURL === appServiceWorkerUrl(baseUrl);
}

/** Service Worker を登録し、ページを制御下に置く。使えない環境では null */
export async function setupServiceWorker({ getCreds, timeoutMs = 4000 } = {}) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  const container = navigator.serviceWorker;
  try {
    container.addEventListener('message', async (event) => {
      const data = event.data || {};
      if (data.type !== 'need-creds' || !event.ports || !event.ports[0]) return;
      if (!isOwnServiceWorker(event.source)) return;
      let creds = null;
      try {
        creds = await getCreds(!!data.force, data.failedToken || null);
      } catch {
        creds = null;
      }
      event.ports[0].postMessage({ type: 'creds', creds });
    });
    const reg = await withTimeout(container.register('./sw.js', { scope: './' }), timeoutMs);
    // ブラウザの設定などで Service Worker が有効にならないと ready はいつまでも解決しない
    if (!reg || !(await withTimeout(container.ready, timeoutMs))) {
      console.warn('Service Worker が有効になりませんでした');
      return null;
    }
    if (!container.controller) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        container.addEventListener(
          'controllerchange',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    }
    if (!container.controller) return null; // 強制再読み込み（Shift+リロード）時など
    // 実際に応答するか確認
    const ok = await new Promise((resolve) => {
      const ch = new MessageChannel();
      const t = setTimeout(() => resolve(false), 2000);
      ch.port1.onmessage = () => {
        clearTimeout(t);
        resolve(true);
      };
      container.controller.postMessage({ type: 'ping' }, [ch.port2]);
    });
    if (!ok) return null;
    return {
      registration: reg,
      scope: reg.scope,
      /** このタブの接続情報を渡す（Service Worker はタブごとに保持する。null はこのタブの分を消す） */
      pushCreds(creds) {
        const target = container.controller || reg.active;
        target?.postMessage({ type: 'creds', creds: creds || null });
      },
    };
  } catch (e) {
    console.warn('Service Worker を利用できません:', e);
    return null;
  }
}

let heicLibPromise = null;
function loadHeicTo() {
  if (!heicLibPromise) {
    heicLibPromise = import(/* @vite-ignore */ HEIC_TO_SRC).catch((e) => {
      heicLibPromise = null;
      throw new Error(`HEIC 変換ライブラリを読み込めませんでした: ${e && e.message}`);
    });
  }
  return heicLibPromise;
}

function isHeic(item) {
  return /^image\/hei[cf]/i.test(item.mimeType) || /\.(heic|heif)$/i.test(item.name);
}

/** 中止（別の写真へ移った等）を表すエラー。呼び出し側はトーストを出さない */
function abortError() {
  return new DOMException('写真の読み込みを中止しました', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

/** 画像の URL が表示できるか（デコードできるか）を確かめる */
function probeImage(url, timeoutMs = 30000, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    const onAbort = () => {
      clearTimeout(t);
      img.onload = img.onerror = null;
      img.src = '';
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      img.src = '';
      reject(new Error('画像の読み込みがタイムアウトしました'));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    img.onload = () => {
      clearTimeout(t);
      const done = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      if (img.decode) img.decode().then(done, done);
      else done();
    };
    img.onerror = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('画像を表示できませんでした'));
    };
    img.src = url;
  });
}

/** thumbnailLink のサイズ指定を差し替える（例: "...=s220" → "...=s1920"） */
export function resizeThumbnailLink(link, size) {
  if (!link) return '';
  const px = Math.max(64, Math.min(4096, Math.round(size)));
  if (/=s\d+(-[a-z0-9-]+)?$/i.test(link)) return link.replace(/=s\d+(-[a-z0-9-]+)?$/i, `=s${px}`);
  if (/=w\d+-h\d+(-[a-z0-9-]+)?$/i.test(link)) return link.replace(/=w\d+-h\d+(-[a-z0-9-]+)?$/i, `=s${px}`);
  if (/googleusercontent\.com\//.test(link) && !/=/.test(link.split('/').pop())) return `${link}=s${px}`;
  return link;
}

/**
 * 写真・動画の読み込み管理。読み込んだ写真は Blob URL として少数だけ保持する。
 */
export class MediaLoader {
  /**
   * @param {object} opts
   * @param {import('./drive.js').DriveClient} opts.drive
   * @param {object|null} opts.sw   setupServiceWorker() の戻り値
   * @param {()=>object} opts.getSettings
   */
  constructor({ drive, sw, getSettings }) {
    this.drive = drive;
    this.sw = sw;
    this.getSettings = getSettings;
    this.cache = new Map(); // id -> {id, sig, promise, ctrl, settled, lastUsed, waiters, pinned}
    this._keepBatch = null; // _cancelOthers() でまとめて残す id
    this.maxCached = 8;
    this.thumbFailed = false; // サムネイル URL が使えない環境か（非公開ファイルでは使えないことが多い）
    this.thumbFailures = 0;
    this.exifThumbs = new Map(); // id -> Promise<string|null>
  }

  screenSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return Math.max(window.screen?.width || 1920, window.screen?.height || 1080, window.innerWidth, window.innerHeight) * dpr;
  }

  thumbnailUrl(item, size = 400) {
    if (!item.thumbnailLink || this.thumbFailed) return '';
    return resizeThumbnailLink(item.thumbnailLink, size);
  }

  /** Service Worker 経由の URL */
  swUrl(item) {
    if (!this.sw) return null;
    const u = new URL(`__drive/media/${encodeURIComponent(item.id)}`, this.sw.scope);
    if (item.resourceKey) u.searchParams.set('rk', item.resourceKey);
    if (item.mimeType) u.searchParams.set('mt', item.mimeType);
    if (item.size) u.searchParams.set('sz', String(item.size));
    return u.toString();
  }

  /** <video> にそのまま設定できる URL（Service Worker / API キー）。なければ null */
  streamUrl(item) {
    const sw = this.swUrl(item);
    if (sw) return sw;
    if (this.drive.mode === 'apikey' && !item.resourceKey) return this.drive.mediaUrl(item.id);
    return null;
  }

  _touch(id) {
    const e = this.cache.get(id);
    if (e) e.lastUsed = performance.now();
  }

  /** 読み込み中の写真のダウンロード・変換を中止し、キャッシュから外す（次の要求で読み直す） */
  _abortEntry(e) {
    if (this.cache.get(e.id) === e) this.cache.delete(e.id);
    if (!e.settled) e.ctrl.abort(abortError());
  }

  /** キャッシュから外して、読み込み中なら中止し、読み込めたら Blob URL を解放する */
  _release(e) {
    this._abortEntry(e);
    e.promise.then((r) => r && r.revoke && r.revoke()).catch(() => {});
  }

  _evict(keep) {
    if (this.cache.size <= this.maxCached) return;
    const entries = [...this.cache.entries()].filter(([id]) => !keep.has(id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (this.cache.size > this.maxCached && entries.length) {
      const [, e] = entries.shift();
      this._release(e);
    }
  }

  /**
   * keep に含まれない読み込み中の写真を中止する（スキップされた写真が帯域を使い続けないように）。
   * 同じタスク内の呼び出し（表示する写真 + 先読みの一連の呼び出し）はまとめて扱い、その全部を残す。
   */
  _cancelOthers(keepIds) {
    if (!this._keepBatch) {
      const batch = new Set();
      this._keepBatch = batch;
      queueMicrotask(() => {
        if (this._keepBatch === batch) this._keepBatch = null;
        for (const [id, e] of [...this.cache]) if (!e.settled && !batch.has(id)) this._abortEntry(e);
      });
    }
    for (const id of keepIds) this._keepBatch.add(id);
  }

  /** 保持している写真のうち keepIds 以外を解放し、keepIds 以外の読み込みは中止する */
  retain(keepIds) {
    const keep = new Set(keepIds);
    this._evict(keep);
    this._cancelOthers(keep);
  }

  /**
   * 写真を読み込む。戻り値 {url, width, height, via, revoke}
   * keep を渡すと、item と keep 以外の読み込み中の写真を中止する（中止された側は AbortError で失敗する）。
   * signal を渡すと、その中止で戻り値が AbortError になる。この写真を待つ呼び出しが
   * すべて中止されたときはダウンロードも中止する。
   */
  loadImage(item, { keep, signal } = {}) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    let entry = this.cache.get(item.id);
    if (entry && entry.sig === item.modifiedTime) {
      this._touch(item.id);
    } else {
      // ファイルが更新された（modifiedTime が変わった）: 古い版の読み込みを止めて Blob URL を解放する
      if (entry) this._release(entry);
      entry = this._startImage(item);
      this._evict(new Set([item.id, ...(keep || [])]));
    }
    if (keep) this._cancelOthers([item.id, ...keep]);
    if (!signal) {
      entry.pinned = true;
      return entry.promise;
    }
    entry.waiters++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        reject(abortError());
        if (--entry.waiters === 0 && !entry.pinned && !entry.settled) this._abortEntry(entry);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  _startImage(item) {
    const ctrl = new AbortController();
    const entry = { id: item.id, sig: item.modifiedTime, lastUsed: performance.now(), promise: null, ctrl, settled: false, waiters: 0, pinned: false };
    const work = this._loadImage(item, ctrl.signal);
    entry.promise = new Promise((resolve, reject) => {
      const settle = (fn, v) => {
        if (entry.settled) return false;
        entry.settled = true;
        ctrl.signal.removeEventListener('abort', onAbort);
        fn(v);
        return true;
      };
      const onAbort = () => settle(reject, abortError());
      ctrl.signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (r) => {
          if (!settle(resolve, r)) r && r.revoke && r.revoke(); // 中止後に届いた結果は捨てる
        },
        (e) => settle(reject, e),
      );
    });
    entry.promise.catch(() => {
      if (this.cache.get(item.id) === entry) this.cache.delete(item.id);
    });
    this.cache.set(item.id, entry);
    return entry;
  }

  async _loadImage(item, signal) {
    const settings = this.getSettings();
    const errors = [];
    // 高速モード: Google が生成した縮小画像を使う（HEIC も JPEG で返ってくる）。
    // ブラウザが表示できない形式（カメラの RAW など）も、大きな元ファイルをダウンロードせずに縮小画像を使う
    const thumbFirst = settings.imageQuality === 'fast' || prefersThumbnail(item.mimeType);
    let triedThumb = false;
    if (thumbFirst && item.thumbnailLink && !this.thumbFailed) {
      triedThumb = true;
      try {
        return await this._loadThumbnail(item, signal);
      } catch (e) {
        throwIfAborted(signal);
        errors.push(e);
      }
    }
    // 元画像
    let blob = null;
    try {
      blob = await this._fetchBlob(item, { signal });
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      throwIfAborted(signal);
      errors.push(e);
    }
    if (blob) {
      const url = URL.createObjectURL(blob);
      try {
        const dim = await probeImage(url, 30000, signal);
        return { url, ...dim, via: 'original', revoke: () => URL.revokeObjectURL(url) };
      } catch (e) {
        URL.revokeObjectURL(url);
        throwIfAborted(signal);
        errors.push(e);
      }
      // HEIC はブラウザが対応していなければ変換する（Safari 17 以降は上でそのまま表示できる）
      if (isHeic(item)) {
        try {
          const { heicTo } = await loadHeicTo();
          throwIfAborted(signal); // 変換は途中で止められないので、始める前に確認
          const out = await heicTo({ blob, type: 'image/jpeg', quality: 0.9 });
          throwIfAborted(signal);
          const url2 = URL.createObjectURL(out);
          try {
            const dim = await probeImage(url2, 30000, signal);
            return { url: url2, ...dim, via: 'heic', revoke: () => URL.revokeObjectURL(url2) };
          } catch (e) {
            URL.revokeObjectURL(url2);
            throw e;
          }
        } catch (e) {
          throwIfAborted(signal);
          errors.push(e);
        }
      }
    }
    // 最後の手段: サムネイル
    if (item.thumbnailLink && settings.imageQuality !== 'fast' && !triedThumb) {
      try {
        return await this._loadThumbnail(item, signal);
      } catch (e) {
        throwIfAborted(signal);
        errors.push(e);
      }
    }
    const err = new Error(`写真を表示できませんでした: ${item.name}`);
    err.causes = errors;
    throw err;
  }

  async _loadThumbnail(item, signal = null) {
    const url = resizeThumbnailLink(item.thumbnailLink, this.screenSize());
    try {
      const dim = await probeImage(url, 20000, signal);
      this.thumbFailures = 0;
      return { url, ...dim, via: 'thumbnail', revoke: () => {} };
    } catch (e) {
      if (!(signal && signal.aborted)) this.noteThumbnailFailure();
      throw e;
    }
  }

  /** サムネイル URL の読み込み失敗を記録（続けて失敗する環境では以後使わない） */
  noteThumbnailFailure() {
    this.thumbFailures++;
    if (this.thumbFailures >= 3) this.thumbFailed = true;
  }

  noteThumbnailSuccess() {
    this.thumbFailures = 0;
  }

  /**
   * JPEG の EXIF に埋め込まれた小さなサムネイル（一覧表示用）。ファイル先頭の 64KB だけ読む。
   * @returns {Promise<string|null>} Blob URL
   */
  exifThumbnail(item) {
    if (!/^image\/(jpeg|jpg|pjpeg)$/i.test(item.mimeType)) return Promise.resolve(null);
    let p = this.exifThumbs.get(item.id);
    if (!p) {
      p = this._exifThumbnail(item).catch(() => null);
      this.exifThumbs.set(item.id, p);
    }
    return p;
  }

  async _exifThumbnail(item) {
    const size = item.size || Infinity;
    const reader = new RangeReader((s, e) => this.drive.fetchRange(item.id, s, Number.isFinite(size) ? Math.min(e, size - 1) : e), size, {
      blockSize: 64 * 1024,
      maxBytes: 192 * 1024,
    });
    const t = await readJpegExifThumbnail(reader);
    if (!t) return null;
    let blob = new Blob([t.bytes], { type: 'image/jpeg' });
    // 埋め込みサムネイルには向きの情報が反映されていないので回転する
    const rot = { 3: 180, 6: 90, 8: 270 }[t.orientation];
    if (rot && typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(blob, { imageOrientation: 'none' });
        const c = document.createElement('canvas');
        const swap = rot !== 180;
        c.width = swap ? bmp.height : bmp.width;
        c.height = swap ? bmp.width : bmp.height;
        const ctx = c.getContext('2d');
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
        bmp.close?.();
        blob = await new Promise((res) => c.toBlob((b) => res(b || blob), 'image/jpeg', 0.85));
      } catch {
        /* 回転できなくても表示はする */
      }
    }
    return URL.createObjectURL(blob);
  }

  /**
   * 写真の元ファイルをページから直接ダウンロードする（Service Worker は通さない）。
   * Service Worker 経由だと、別の写真へ移って中止してもブラウザ（Chromium）が中止を Service Worker に
   * 伝えないため、スキップした写真のダウンロードや再試行が続いてしまう
   */
  async _fetchBlob(item, { signal } = {}) {
    if (item.resourceKey) this.drive.rememberResourceKey(item.id, item.resourceKey);
    const res = await this.drive.fetchMedia(item.id, { signal, retries: PHOTO_RETRIES });
    const blob = await res.blob();
    // 応答の Content-Type をそのまま Blob URL に使わない（SVG などとして開かれないよう、安全な型に付け替える）
    return new Blob([blob], { type: safeMediaType(res.headers.get('content-type'), item.mimeType) });
  }

  /**
   * 動画を Blob としてダウンロードする（ストリーミングできない環境用）。
   * @returns {Promise<{url:string, revoke:()=>void}>}
   */
  async loadVideoBlob(item, { signal, onProgress, maxBytes = 400 * 1024 * 1024 } = {}) {
    if (item.size && item.size > maxBytes) throw new Error('動画が大きすぎるため、このブラウザでは再生できません');
    const res = await this.drive.fetchMedia(item.id, { signal });
    const total = Number(res.headers.get('content-length')) || item.size || 0;
    // QuickTime (.mov) の H.264 動画は MP4 として扱えば Chrome / Firefox でも再生できることが多い（sw.js と同じ）
    const t = safeMediaType(res.headers.get('content-type'), item.mimeType);
    const type = t === 'video/quicktime' ? 'video/mp4' : t;
    if (!res.body || !onProgress) {
      const blob = new Blob([await res.blob()], { type });
      const url = URL.createObjectURL(blob);
      return { url, revoke: () => URL.revokeObjectURL(url) };
    }
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (got > maxBytes) {
        reader.cancel().catch(() => {});
        throw new Error('動画が大きすぎます');
      }
      onProgress(total ? got / total : 0);
    }
    const blob = new Blob(chunks, { type });
    const url = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }

  clear() {
    for (const e of [...this.cache.values()]) this._release(e);
    this.cache.clear();
    for (const p of this.exifThumbs.values()) p.then((u) => u && URL.revokeObjectURL(u)).catch(() => {});
    this.exifThumbs.clear();
  }
}
