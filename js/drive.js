// Google Drive API v3 の最小クライアント（fetch ベース、依存なし）

export const DRIVE_API_DEFAULT = 'https://www.googleapis.com';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

/** 一覧取得時に要求するフィールド（実際の Drive API は要求しないフィールドを返さない） */
export const FILE_FIELDS = [
  'id',
  'name',
  'mimeType',
  'parents',
  'trashed',
  'createdTime',
  'modifiedTime',
  'size',
  'md5Checksum',
  'resourceKey',
  'thumbnailLink',
  'hasThumbnail',
  'webViewLink',
  'imageMediaMetadata(width,height,rotation,time,cameraMake,cameraModel,location)',
  'videoMediaMetadata(width,height,durationMillis)',
  'shortcutDetails(targetId,targetMimeType,targetResourceKey)',
].join(',');

export class DriveError extends Error {
  constructor(message, { status = 0, reason = '', googleStatus = '', detail = '' } = {}) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.reason = reason;
    this.googleStatus = googleStatus;
    this.detail = detail;
  }
}

/** 認証が必要（トークン切れでユーザー操作による再ログインが必要）なことを表すエラー */
export class AuthRequiredError extends Error {
  constructor(message = 'ログインの有効期限が切れました') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/**
 * フォルダの URL または ID を解析する。
 * 対応: https://drive.google.com/drive/folders/ID?resourcekey=KEY, .../drive/u/0/folders/ID,
 *       https://drive.google.com/open?id=ID, .../folderview?id=ID, 生の ID
 * @returns {{id:string, resourceKey:string|null}|null}
 */
export function parseFolderInput(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    let url;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    const rk = url.searchParams.get('resourcekey') || url.searchParams.get('resourceKey');
    let m = url.pathname.match(/\/folders\/([-\w]+)/);
    if (m) return { id: m[1], resourceKey: rk || null };
    m = url.pathname.match(/\/file\/d\/([-\w]+)/);
    if (m) return { id: m[1], resourceKey: rk || null };
    const id = url.searchParams.get('id');
    if (id && /^[-\w]+$/.test(id)) return { id, resourceKey: rk || null };
    return null;
  }
  // "ID?resourcekey=..." のような貼り付けにも対応
  const m = s.match(/^([-\w]+)(?:[?&]resource[kK]ey=([-\w]+))?$/);
  if (m) return { id: m[1], resourceKey: m[2] || null };
  return null;
}

/** Drive 検索クエリ用の文字列エスケープ */
export function escapeQueryValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** 画像・動画かどうか */
export function mediaKind(mimeType, name = '') {
  const mt = (mimeType || '').toLowerCase();
  if (mt.startsWith('image/')) {
    if (mt === 'image/svg+xml' || mt === 'image/x-icon' || mt === 'image/vnd.microsoft.icon') return null;
    return 'image';
  }
  if (mt.startsWith('video/')) return 'video';
  // Drive が application/octet-stream と判定した場合の拡張子による救済
  if (mt === 'application/octet-stream' || !mt) {
    const ext = (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'm4v', 'webm', '3gp'].includes(ext)) return 'video';
  }
  return null;
}

/** 拡張子などから MIME タイプを補正（Drive が octet-stream を返す場合など） */
export function normalizeMimeType(mimeType, name = '') {
  const mt = (mimeType || '').toLowerCase();
  if (mt && mt !== 'application/octet-stream') return mt;
  const ext = (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
    avif: 'image/avif',
    mp4: 'video/mp4',
    m4v: 'video/x-m4v',
    mov: 'video/quicktime',
    webm: 'video/webm',
    '3gp': 'video/3gpp',
  };
  return map[ext] || mt;
}

/** 403 のうち、待てば通るもの（レート制限など） */
const RATE_LIMIT_RE = /rateLimitExceeded|userRateLimitExceeded|backendError/i;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** 並列数を制限して非同期タスクを実行する */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export class DriveClient {
  /**
   * @param {object} opts
   * @param {string} [opts.apiBase]
   * @param {'oauth'|'apikey'} opts.mode
   * @param {string} [opts.apiKey]
   * @param {(force:boolean, failedToken?:string|null)=>Promise<string|null>} [opts.getToken]
   *   OAuth アクセストークンを返す。force=true は failedToken が 401 で拒否されたことの通知
   */
  constructor({ apiBase = DRIVE_API_DEFAULT, mode, apiKey = '', getToken = null } = {}) {
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.mode = mode;
    this.apiKey = apiKey;
    this.getToken = getToken;
    /** id -> resourceKey */
    this.resourceKeys = new Map();
  }

  rememberResourceKey(id, key) {
    if (id && key) this.resourceKeys.set(id, key);
  }

  _url(path, params = {}) {
    const u = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    if (this.mode === 'apikey' && this.apiKey) u.searchParams.set('key', this.apiKey);
    return u.toString();
  }

  _resourceKeyHeader(ids) {
    const parts = [];
    for (const id of ids) {
      const k = id && this.resourceKeys.get(id);
      if (k) parts.push(`${id}/${k}`);
    }
    return parts.length ? parts.join(',') : null;
  }

  async _headers(ids = [], extra = {}) {
    const h = { ...extra };
    const rk = this._resourceKeyHeader(ids);
    if (rk) h['X-Goog-Drive-Resource-Keys'] = rk;
    let token = null;
    if (this.mode === 'oauth') {
      token = this.getToken ? await this.getToken(false) : null;
      if (!token) throw new AuthRequiredError();
      h.Authorization = `Bearer ${token}`;
    }
    return { headers: h, token };
  }

  /**
   * 共通の fetch。401 は一度だけトークンを確認して再試行、429/5xx/レート制限は指数バックオフで再試行（最大 retries 回）。
   */
  async _fetch(url, { ids = [], headers = {}, signal, method = 'GET', retries = 4 } = {}) {
    let authRetried = false;
    for (let attempt = 0; ; attempt++) {
      const { headers: h, token } = await this._headers(ids, headers);
      let res;
      try {
        res = await fetch(url, { method, headers: h, signal, credentials: 'omit', mode: 'cors' });
      } catch (e) {
        if (signal?.aborted) throw e;
        if (attempt < Math.min(3, retries)) {
          await sleep(500 * 2 ** attempt, signal);
          continue;
        }
        throw new DriveError('Google ドライブに接続できませんでした。ネットワークを確認してください。', {
          status: 0,
          detail: String(e && e.message),
        });
      }
      if (res.ok) return res;
      if (res.status === 401 && this.mode === 'oauth' && !authRetried) {
        // このトークンは無効。別のトークン（再ログイン済み）があればそれで再試行
        authRetried = true;
        if (this.getToken) await this.getToken(true, token);
        continue;
      }
      const err = await toDriveError(res, this.mode);
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && RATE_LIMIT_RE.test(err.reason));
      if (retryable && attempt < retries) {
        await sleep(Math.min(8000, 600 * 2 ** attempt) + Math.floor(Math.random() * 300), signal);
        continue;
      }
      if (res.status === 401 && this.mode === 'oauth') throw new AuthRequiredError();
      throw err;
    }
  }

  async _json(path, params, opts = {}) {
    const res = await this._fetch(this._url(path, params), opts);
    return res.json();
  }

  /** ファイル（フォルダ）のメタデータ取得 */
  async getFile(id, fields = FILE_FIELDS, { signal } = {}) {
    const f = await this._json(
      `/drive/v3/files/${encodeURIComponent(id)}`,
      { fields, supportsAllDrives: 'true' },
      { ids: [id], signal },
    );
    if (f.resourceKey) this.rememberResourceKey(f.id, f.resourceKey);
    return f;
  }

  /** フォルダ直下の項目（ゴミ箱以外）をすべて取得 */
  async listChildren(folderId, { fields = FILE_FIELDS, signal, onPage } = {}) {
    const all = [];
    let pageToken;
    let guard = 0;
    do {
      const data = await this._json(
        '/drive/v3/files',
        {
          q: `'${escapeQueryValue(folderId)}' in parents and trashed = false`,
          fields: `nextPageToken,incompleteSearch,files(${fields})`,
          pageSize: 1000,
          pageToken,
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        },
        { ids: [folderId], signal },
      );
      const files = Array.isArray(data.files) ? data.files : [];
      for (const f of files) {
        if (f.resourceKey) this.rememberResourceKey(f.id, f.resourceKey);
        if (f.shortcutDetails?.targetResourceKey) {
          this.rememberResourceKey(f.shortcutDetails.targetId, f.shortcutDetails.targetResourceKey);
        }
      }
      all.push(...files);
      onPage?.(files.length, all.length);
      pageToken = data.nextPageToken;
    } while (pageToken && ++guard < 1000);
    return all;
  }

  /** 名前でフォルダを検索（OAuth モード用）。次のページも読む（最大 maxPages ページ・maxResults 件） */
  async searchFolders(text, { signal, maxPages = 5, maxResults = 200 } = {}) {
    const clauses = [`mimeType = '${FOLDER_MIME}'`, 'trashed = false'];
    if (text && text.trim()) clauses.push(`name contains '${escapeQueryValue(text.trim())}'`);
    const all = [];
    let pageToken;
    for (let page = 0; page < maxPages && all.length < maxResults; page++) {
      const data = await this._json(
        '/drive/v3/files',
        {
          q: clauses.join(' and '),
          fields: 'nextPageToken,files(id,name,modifiedTime,resourceKey,parents)',
          pageSize: Math.min(100, maxResults - all.length),
          pageToken,
          orderBy: 'modifiedTime desc',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        },
        { signal },
      );
      if (Array.isArray(data.files)) all.push(...data.files);
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return all.slice(0, maxResults);
  }

  /**
   * フォルダ配下の画像・動画を（必要ならサブフォルダも）列挙する。
   * ショートカットはリンク先を解決する。同じファイルは一度だけ返す。
   * 読めないサブフォルダ（ショートカット先の削除・権限なし）は飛ばして skippedFolders に数える。
   * @returns {Promise<{root:object, files:object[], folderCount:number, skipped:number, skippedFolders:number}>}
   */
  async listMediaTree(rootId, { recursive = true, signal, onProgress } = {}) {
    let root = await this.getFile(rootId, 'id,name,mimeType,resourceKey,shortcutDetails(targetId,targetMimeType,targetResourceKey)', { signal });
    if (root.mimeType === SHORTCUT_MIME && root.shortcutDetails?.targetMimeType === FOLDER_MIME) {
      if (root.shortcutDetails.targetResourceKey) {
        this.rememberResourceKey(root.shortcutDetails.targetId, root.shortcutDetails.targetResourceKey);
      }
      root = await this.getFile(root.shortcutDetails.targetId, 'id,name,mimeType,resourceKey', { signal });
    }
    if (root.mimeType !== FOLDER_MIME) {
      throw new DriveError('指定された ID はフォルダではありません。フォルダの URL を指定してください。', {
        status: 400,
        reason: 'notAFolder',
      });
    }
    const visited = new Set([root.id]);
    const media = new Map();
    const shortcutTargets = new Map(); // targetId -> folderPath
    let queue = [{ id: root.id, path: [] }];
    let folderCount = 1;
    let skipped = 0;
    let skippedFolders = 0;

    while (queue.length) {
      const batch = queue;
      queue = [];
      await mapLimit(batch, 3, async (folder) => {
        let children;
        try {
          children = await this.listChildren(folder.id, { signal });
        } catch (e) {
          if (folder.id === root.id || !isSkippableFolderError(e, signal)) throw e;
          skippedFolders++; // 権限のない・削除されたフォルダ（主にショートカット先）は飛ばす
          return;
        }
        for (const f of children) {
          if (f.trashed) continue;
          if (f.mimeType === FOLDER_MIME) {
            if (recursive && !visited.has(f.id)) {
              visited.add(f.id);
              folderCount++;
              queue.push({ id: f.id, path: [...folder.path, f.name] });
            }
            continue;
          }
          if (f.mimeType === SHORTCUT_MIME && f.shortcutDetails?.targetId) {
            const t = f.shortcutDetails;
            if (t.targetMimeType === FOLDER_MIME) {
              if (recursive && !visited.has(t.targetId)) {
                visited.add(t.targetId);
                folderCount++;
                queue.push({ id: t.targetId, path: [...folder.path, f.name] });
              }
            } else if (mediaKind(t.targetMimeType, f.name)) {
              if (!media.has(t.targetId)) shortcutTargets.set(t.targetId, folder.path);
            } else {
              skipped++;
            }
            continue;
          }
          if (mediaKind(f.mimeType, f.name)) {
            if (!media.has(f.id)) media.set(f.id, { ...f, folderPath: folder.path });
            shortcutTargets.delete(f.id);
          } else {
            skipped++;
          }
        }
        onProgress?.({ folders: folderCount, files: media.size + shortcutTargets.size });
      });
    }

    // ショートカット先のメタデータを取得
    const targets = [...shortcutTargets.entries()].filter(([id]) => !media.has(id));
    await mapLimit(targets, 4, async ([id, path]) => {
      try {
        const f = await this.getFile(id, FILE_FIELDS, { signal });
        if (!f.trashed && mediaKind(f.mimeType, f.name)) media.set(f.id, { ...f, folderPath: path });
      } catch (e) {
        if (signal?.aborted || e instanceof AuthRequiredError) throw e;
        skipped++; // リンク切れ・権限なしのショートカットは無視
      }
    });
    onProgress?.({ folders: folderCount, files: media.size });
    return { root, files: [...media.values()], folderCount, skipped, skippedFolders };
  }

  /** alt=media の URL（API キーで直接アクセスできる場合のみ意味がある） */
  mediaUrl(id) {
    return this._url(`/drive/v3/files/${encodeURIComponent(id)}`, { alt: 'media', supportsAllDrives: 'true' });
  }

  /** ファイル本体を取得（Response を返す）。retries: 一時的なエラーの再試行回数 */
  async fetchMedia(id, { signal, range, retries } = {}) {
    const headers = {};
    if (range) headers.Range = range;
    return this._fetch(this.mediaUrl(id), { ids: [id], headers, signal, retries });
  }

  /** バイト範囲 [start, end] を取得 */
  async fetchRange(id, start, end, { signal } = {}) {
    const res = await this.fetchMedia(id, { signal, range: `bytes=${start}-${end}` });
    return res.arrayBuffer();
  }

  /**
   * Service Worker / blob で使う接続情報。
   * force=true は「failedToken が 401 で拒否された」ことを表す（現在のトークンと同じなら破棄される）。
   */
  async credentials(force = false, failedToken = null) {
    const c = { apiBase: this.apiBase };
    if (this.mode === 'apikey') c.apiKey = this.apiKey;
    else {
      const token = this.getToken ? await this.getToken(force, failedToken) : null;
      if (!token) return null;
      c.token = token;
    }
    return c;
  }
}

/** サブフォルダの一覧取得の失敗のうち、そのフォルダだけ飛ばしてよいもの（404 / 権限なしの 403） */
function isSkippableFolderError(e, signal) {
  if (signal?.aborted || e instanceof AuthRequiredError || e?.name === 'AbortError') return false;
  if (!(e instanceof DriveError)) return false;
  return e.status === 404 || (e.status === 403 && !RATE_LIMIT_RE.test(e.reason));
}

/** Drive API のエラーレスポンスを DriveError に変換し、日本語のメッセージを付ける */
export async function toDriveError(res, mode) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  const e = body && body.error ? body.error : {};
  const reason = (e.errors && e.errors[0] && e.errors[0].reason) || (e.details && e.details[0] && e.details[0].reason) || '';
  const gStatus = e.status || '';
  const raw = e.message || res.statusText || '';
  let msg;
  const s = res.status;
  if (s === 404) {
    msg =
      mode === 'apikey'
        ? 'ファイルまたはフォルダが見つかりません。フォルダの共有設定が「リンクを知っている全員」になっているか、URL が正しいかを確認してください。'
        : 'ファイルまたはフォルダが見つかりません。URL が正しいか、このアカウントにアクセス権があるかを確認してください。';
  } else if (/API_KEY_INVALID|keyInvalid/i.test(reason + raw) || (s === 400 && /API key not valid/i.test(raw))) {
    msg = 'API キーが無効です。Google Cloud コンソールで作成した API キーを確認してください。';
  } else if (/API_KEY_HTTP_REFERRER_BLOCKED|referer/i.test(reason + raw)) {
    msg = 'API キーのウェブサイト制限（HTTP リファラー）により拒否されました。このページの URL を API キーの許可リストに追加してください。';
  } else if (/accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(reason + raw + gStatus)) {
    msg = 'Google Drive API が有効になっていません。Google Cloud コンソールで「Google Drive API」を有効にしてください。';
  } else if (s === 401) {
    msg = 'ログインの有効期限が切れたか、認証情報が無効です。もう一度ログインしてください。';
  } else if (s === 403 && /insufficient|scope/i.test(reason + raw + gStatus)) {
    msg = 'Google ドライブの閲覧権限が許可されていません。ログイン時に「Google ドライブのファイルの表示」を許可してください。';
  } else if (s === 403 && /dailyLimitExceededUnreg|unregistered/i.test(reason + raw)) {
    msg = '認証情報がありません。API キーまたはログインが必要です。';
  } else if (s === 403 && /cannotDownloadAbusiveFile/i.test(reason)) {
    msg = 'このファイルは Google によりダウンロードが制限されています。';
  } else if (s === 403) {
    msg = `アクセスが拒否されました（${reason || gStatus || s}）。共有設定を確認してください。`;
  } else if (s === 429 || /rateLimit/i.test(reason)) {
    msg = 'Google ドライブへのリクエストが多すぎます。しばらく待ってからもう一度お試しください。';
  } else {
    msg = `Google ドライブでエラーが発生しました（HTTP ${s}${raw ? `: ${raw}` : ''}）。`;
  }
  return new DriveError(msg, { status: s, reason, googleStatus: gStatus, detail: raw });
}
