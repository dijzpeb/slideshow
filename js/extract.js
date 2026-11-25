// 撮影日時の解析（Range リクエストでファイルの一部だけ読む）と、その結果のキャッシュ

import { RangeReader, extractCaptureInfo } from './mediatime.js';
import { extractionPhase, fileSignature } from './catalog.js';
import { mapLimit, AuthRequiredError, normalizeMimeType } from './drive.js';

const CACHE_KEY = 'photo-slideshow.meta.v1';
const CACHE_MAX = 5000;
// 解析処理を変えたら上げる（古い解析結果は読み直す）。2: 動画の機種名（Android / Canon）、EXIF の時差タグの選び方
const PARSER_VERSION = 2;

/** キャッシュの項目がこのファイルの今の解析結果として使えるか */
function usable(entry, file) {
  return !!entry && entry.v === PARSER_VERSION && entry.sig === fileSignature(file);
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function saveCache(cache) {
  const entries = Object.entries(cache);
  if (entries.length > CACHE_MAX) {
    entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    cache = Object.fromEntries(entries.slice(0, CACHE_MAX));
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // 容量不足なら半分に減らして再挑戦
    try {
      const half = Object.fromEntries(entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, Math.floor(entries.length / 2)));
      localStorage.setItem(CACHE_KEY, JSON.stringify(half));
    } catch {
      /* ignore */
    }
  }
  return cache;
}

/** このブラウザに撮影日時の解析結果が残っているか（ログアウトで消すものがあるか） */
export function hasMetaCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return !!raw && raw.trim() !== '{}';
  } catch {
    return false;
  }
}

export function clearMetaCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/** キャッシュ済みの解析結果だけを返す（ネットワークを使わない） */
export function readCached(files, phases = ['required', 'refine']) {
  const cache = loadCache();
  const result = new Map();
  for (const f of files) {
    if (!phases.includes(extractionPhase(f))) continue;
    const c = cache[f.id];
    if (usable(c, f)) result.set(f.id, c.data);
  }
  return result;
}

/**
 * 必要なファイルについて撮影日時を解析する。
 * @param {import('./drive.js').DriveClient} drive
 * @param {object[]} files
 * @param {{phases?:string[], signal?:AbortSignal, onProgress?:(done:number,total:number)=>void, onResult?:(id:string,data:object|null)=>void, concurrency?:number}} opts
 *   phases: 対象にする解析フェーズ（'required' = 必須、'refine' = 精度向上）
 * @returns {Promise<Map<string,object>>}  id -> 解析結果（null は解析不能）
 */
export async function extractAll(drive, files, { phases = ['required'], signal, onProgress, onResult, concurrency = 4 } = {}) {
  let cache = loadCache();
  const result = new Map();
  const todo = [];
  for (const f of files) {
    if (!phases.includes(extractionPhase(f))) continue;
    const c = cache[f.id];
    if (usable(c, f)) {
      result.set(f.id, c.data);
    } else {
      todo.push(f);
    }
  }
  let done = 0;
  onProgress?.(done, todo.length);
  let dirty = false;
  let lastSave = Date.now();
  await mapLimit(todo, concurrency, async (f) => {
    if (signal?.aborted) return;
    let data = null;
    let cacheable = true;
    try {
      const size = Number(f.size) || Infinity;
      const reader = new RangeReader((s, e) => drive.fetchRange(f.id, s, Number.isFinite(size) ? Math.min(e, size - 1) : e, { signal }), size, {
        blockSize: 64 * 1024,
        maxBytes: 6 * 1024 * 1024,
      });
      data = await extractCaptureInfo(reader, normalizeMimeType(f.mimeType, f.name));
    } catch (e) {
      if (e instanceof AuthRequiredError || signal?.aborted) throw e;
      // ネットワークエラー等は次回やり直せるようキャッシュしない（パース不能は null をキャッシュ）
      if (e && (e.name === 'DriveError' || e.name === 'TypeError')) cacheable = false;
      data = null;
    }
    result.set(f.id, data);
    onResult?.(f.id, data);
    if (cacheable) {
      cache[f.id] = { sig: fileSignature(f), v: PARSER_VERSION, data, at: Date.now() };
      dirty = true;
    }
    done++;
    onProgress?.(done, todo.length);
    if (dirty && Date.now() - lastSave > 3000) {
      cache = saveCache(cache);
      dirty = false;
      lastSave = Date.now();
    }
  });
  if (dirty) saveCache(cache);
  return result;
}
