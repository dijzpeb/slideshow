// 写真・動画の読み込み（Service Worker 経由のストリーミング、Blob、HEIC 変換、サムネイル）

import { AuthRequiredError } from './drive.js';
import { RangeReader, readJpegExifThumbnail } from './mediatime.js';

// HEIC を表示できないブラウザ（Safari 以外）向けの変換ライブラリ。必要になったときだけ読み込む
const HEIC_TO_SRC = 'https://cdn.jsdelivr.net/npm/heic-to@1.6.7/dist/heic-to.js';

/** Service Worker を登録し、ページを制御下に置く。使えない環境では null */
export async function setupServiceWorker({ getCreds, timeoutMs = 4000 } = {}) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    navigator.serviceWorker.addEventListener('message', async (event) => {
      const data = event.data || {};
      if (data.type !== 'need-creds' || !event.ports || !event.ports[0]) return;
      let creds = null;
      try {
        creds = await getCreds(!!data.force, data.failedToken || null);
      } catch {
        creds = null;
      }
      event.ports[0].postMessage({ type: 'creds', creds });
    });
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    }
    if (!navigator.serviceWorker.controller) return null; // 強制再読み込み（Shift+リロード）時など
    // 実際に応答するか確認
    const ok = await new Promise((resolve) => {
      const ch = new MessageChannel();
      const t = setTimeout(() => resolve(false), 2000);
      ch.port1.onmessage = () => {
        clearTimeout(t);
        resolve(true);
      };
      navigator.serviceWorker.controller.postMessage({ type: 'ping' }, [ch.port2]);
    });
    if (!ok) return null;
    return {
      registration: reg,
      scope: reg.scope,
      pushCreds(creds) {
        navigator.serviceWorker.controller?.postMessage({ type: 'creds', creds });
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

/** 画像の URL が表示できるか（デコードできるか）を確かめる */
function probeImage(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    const t = setTimeout(() => {
      img.src = '';
      reject(new Error('画像の読み込みがタイムアウトしました'));
    }, timeoutMs);
    img.onload = () => {
      clearTimeout(t);
      const done = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      if (img.decode) img.decode().then(done, done);
      else done();
    };
    img.onerror = () => {
      clearTimeout(t);
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
    this.cache = new Map(); // id -> {promise, url, revoke, lastUsed}
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

  _evict(keep) {
    if (this.cache.size <= this.maxCached) return;
    const entries = [...this.cache.entries()].filter(([id]) => !keep.has(id)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (this.cache.size > this.maxCached && entries.length) {
      const [id, e] = entries.shift();
      this.cache.delete(id);
      e.promise.then((r) => r && r.revoke && r.revoke()).catch(() => {});
    }
  }

  /** 保持している写真のうち keepIds 以外を解放する */
  retain(keepIds) {
    const keep = new Set(keepIds);
    this._evict(keep);
  }

  /**
   * 写真を読み込む。戻り値 {url, width, height, via, revoke}
   */
  loadImage(item, { keep = [] } = {}) {
    const hit = this.cache.get(item.id);
    if (hit && hit.sig === item.modifiedTime) {
      this._touch(item.id);
      return hit.promise;
    }
    const entry = { sig: item.modifiedTime, lastUsed: performance.now(), promise: null };
    entry.promise = this._loadImage(item).catch((e) => {
      if (this.cache.get(item.id) === entry) this.cache.delete(item.id);
      throw e;
    });
    this.cache.set(item.id, entry);
    this._evict(new Set([item.id, ...keep]));
    return entry.promise;
  }

  async _loadImage(item) {
    const settings = this.getSettings();
    const errors = [];
    // 高速モード: Google が生成した縮小画像を使う（HEIC も JPEG で返ってくる）
    if (settings.imageQuality === 'fast' && item.thumbnailLink && !this.thumbFailed) {
      try {
        return await this._loadThumbnail(item);
      } catch (e) {
        errors.push(e);
      }
    }
    // 元画像
    let blob = null;
    try {
      blob = await this._fetchBlob(item);
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      errors.push(e);
    }
    if (blob) {
      const url = URL.createObjectURL(blob);
      try {
        const dim = await probeImage(url);
        return { url, ...dim, via: 'original', revoke: () => URL.revokeObjectURL(url) };
      } catch (e) {
        URL.revokeObjectURL(url);
        errors.push(e);
      }
      // HEIC はブラウザが対応していなければ変換する（Safari 17 以降は上でそのまま表示できる）
      if (isHeic(item)) {
        try {
          const { heicTo } = await loadHeicTo();
          const out = await heicTo({ blob, type: 'image/jpeg', quality: 0.9 });
          const url2 = URL.createObjectURL(out);
          try {
            const dim = await probeImage(url2);
            return { url: url2, ...dim, via: 'heic', revoke: () => URL.revokeObjectURL(url2) };
          } catch (e) {
            URL.revokeObjectURL(url2);
            throw e;
          }
        } catch (e) {
          errors.push(e);
        }
      }
    }
    // 最後の手段: サムネイル
    if (item.thumbnailLink && settings.imageQuality !== 'fast') {
      try {
        return await this._loadThumbnail(item);
      } catch (e) {
        errors.push(e);
      }
    }
    const err = new Error(`写真を表示できませんでした: ${item.name}`);
    err.causes = errors;
    throw err;
  }

  async _loadThumbnail(item) {
    const url = resizeThumbnailLink(item.thumbnailLink, this.screenSize());
    try {
      const dim = await probeImage(url, 20000);
      this.thumbFailures = 0;
      return { url, ...dim, via: 'thumbnail', revoke: () => {} };
    } catch (e) {
      this.noteThumbnailFailure();
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

  async _fetchBlob(item) {
    const sw = this.swUrl(item);
    if (sw) {
      const res = await fetch(sw, { credentials: 'same-origin' });
      if (res.status === 401) {
        if (this.drive.mode === 'oauth') throw new AuthRequiredError();
        throw new Error('認証エラー');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    }
    const res = await this.drive.fetchMedia(item.id);
    return res.blob();
  }

  /**
   * 動画を Blob としてダウンロードする（ストリーミングできない環境用）。
   * @returns {Promise<{url:string, revoke:()=>void}>}
   */
  async loadVideoBlob(item, { signal, onProgress, maxBytes = 400 * 1024 * 1024 } = {}) {
    if (item.size && item.size > maxBytes) throw new Error('動画が大きすぎるため、このブラウザでは再生できません');
    const res = await this.drive.fetchMedia(item.id, { signal });
    const total = Number(res.headers.get('content-length')) || item.size || 0;
    if (!res.body || !onProgress) {
      const blob = await res.blob();
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
    const blob = new Blob(chunks, { type: item.mimeType === 'video/quicktime' ? 'video/mp4' : item.mimeType });
    const url = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }

  clear() {
    for (const e of this.cache.values()) e.promise.then((r) => r && r.revoke && r.revoke()).catch(() => {});
    this.cache.clear();
    for (const p of this.exifThumbs.values()) p.then((u) => u && URL.revokeObjectURL(u)).catch(() => {});
    this.exifThumbs.clear();
  }
}
