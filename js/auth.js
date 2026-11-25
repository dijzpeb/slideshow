// Google アカウントでのログイン（Google Identity Services のトークンモデル）

export const GIS_SRC = 'https://accounts.google.com/gsi/client';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_KEY = 'photo-slideshow.token.v1';
/** 期限のこれだけ前からトークンは無効扱い（signedIn と accessToken で同じ基準） */
const TOKEN_MARGIN_MS = 60000;
/** ログインのポップアップが応答しないときに諦めるまでの時間 */
export const REQUEST_TIMEOUT_MS = 120000;
/** 期限のこれだけ前に 'expiring' を知らせる */
export const EXPIRY_WARNING_MS = 5 * 60000;

let gisPromise = null;

/** GIS ライブラリを読み込む */
export function loadGis(src = GIS_SRC) {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => {
        if (window.google?.accounts?.oauth2) resolve();
        else {
          gisPromise = null;
          reject(new Error('Google のログイン機能を初期化できませんでした。'));
        }
      };
      s.onerror = () => {
        gisPromise = null;
        s.remove();
        reject(new Error('Google のログイン機能を読み込めませんでした。ネットワークや広告ブロッカーの設定を確認してください。'));
      };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

export class AuthError extends Error {
  constructor(message, type = 'unknown') {
    super(message);
    this.name = 'AuthError';
    this.type = type;
  }
}

/**
 * OAuth トークンの管理。
 * イベント: 'change'（ログイン/ログアウト/更新）, 'expiring'（失効 5 分前）, 'expired'
 */
export class OAuthSession extends EventTarget {
  constructor(clientId) {
    super();
    this.clientId = clientId;
    this.client = null;
    this.pending = null;
    this.timers = [];
    this.disposed = false;
    this.tokenData = this._restore();
    this._schedule();
  }

  /**
   * このタブに保存したトークンを読み込む。期限切れのものも持っておく（hasToken。開き直したタブでも
   * 「ログアウト」で消せるように）。使えるかどうかは accessToken / signedIn で判断する
   */
  _restore() {
    try {
      const raw = sessionStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const t = JSON.parse(raw);
      if (t && t.clientId === this.clientId && typeof t.accessToken === 'string' && t.accessToken && Number.isFinite(t.expiresAt)) {
        return { accessToken: t.accessToken, expiresAt: t.expiresAt, clientId: t.clientId };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  _store() {
    try {
      if (this.tokenData) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(this.tokenData));
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  }

  _schedule() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (!this.tokenData || this.disposed) return;
    const now = Date.now();
    const exp = this.tokenData.expiresAt;
    const warnAt = exp - EXPIRY_WARNING_MS;
    // setTimeout の上限（約 24.8 日）を超えないよう念のため制限
    const clamp = (ms) => Math.min(Math.max(0, ms), 2 ** 31 - 1);
    if (warnAt > now) this.timers.push(setTimeout(() => this.dispatchEvent(new Event('expiring')), clamp(warnAt - now)));
    // 読み込んだ時点ですでに期限切れのトークン（タブを開き直したときなど）は、改めて知らせない
    if (exp > now) this.timers.push(setTimeout(() => this.dispatchEvent(new Event('expired')), clamp(exp - now)));
  }

  /** 使えるトークンがある（accessToken と同じ基準） */
  get signedIn() {
    return !!this.accessToken;
  }

  /** トークンを持っている（期限切れのものも含む。ログアウトで消すものがある） */
  get hasToken() {
    return !!this.tokenData;
  }

  /** トークンがあと ms ミリ秒以上有効か */
  isValidFor(ms) {
    return !!this.tokenData && this.tokenData.expiresAt > Date.now() + Math.max(ms, TOKEN_MARGIN_MS);
  }

  get expiresAt() {
    return this.tokenData ? this.tokenData.expiresAt : 0;
  }

  /** 有効なトークン（なければ null）。期限 1 分前からは無効扱い */
  get accessToken() {
    return this.tokenData && this.tokenData.expiresAt > Date.now() + TOKEN_MARGIN_MS ? this.tokenData.accessToken : null;
  }

  async init() {
    if (this.client) return;
    if (!this.clientId) throw new AuthError('OAuth クライアント ID が設定されていません。', 'config');
    await loadGis();
    this.client = window.google.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => this._onToken(resp),
      error_callback: (err) => this._onError(err),
    });
  }

  /**
   * トークンを要求する（ポップアップが開くため、クリックなどのユーザー操作の中で呼ぶこと）。
   * 一度許可済みなら、ポップアップはすぐに閉じる。
   * 前の要求が終わっていなければ（ポップアップが裏に隠れた等）もう一度開いて、同じ promise を返す。
   * GIS は同じ名前のポップアップを使い回して前面に出し、前の要求の結果は捨てる。ポップアップを閉じた通知は
   * 何度要求しても 1 回だけなので、待っている間に届いたエラーはそのまま要求の結果にする。
   * 応答がないまま REQUEST_TIMEOUT_MS たつと AuthError で失敗する。
   */
  request({ prompt = '' } = {}) {
    if (this.disposed) return Promise.reject(new AuthError('ログインが中止されました。', 'disposed'));
    if (!this.client) return Promise.reject(new AuthError('ログイン機能がまだ準備できていません。', 'not_ready'));
    const p = this.pending;
    if (p) {
      try {
        // GIS がポップアップを前面に出す（または開き直す）
        this.client.requestAccessToken({ prompt });
        this._armTimeout(p);
      } catch {
        /* 前の要求の結果を待つ */
      }
      return p.promise;
    }
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry = { promise, resolve, reject, timer: null };
    this.pending = entry;
    try {
      this.client.requestAccessToken({ prompt });
      this._armTimeout(entry);
    } catch (e) {
      this.pending = null;
      reject(new AuthError(`ログインを開始できませんでした: ${e && e.message}`));
    }
    return promise;
  }

  _armTimeout(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.pending !== entry) return;
      this._settle(false, new AuthError('ログイン画面から応答がありませんでした。もう一度お試しください。', 'timeout'));
    }, REQUEST_TIMEOUT_MS);
  }

  _settle(ok, value) {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    clearTimeout(p.timer);
    if (ok) p.resolve(value);
    else p.reject(value);
  }

  _onToken(resp) {
    if (!resp || resp.error) {
      const type = resp && resp.error;
      const msg =
        type === 'access_denied'
          ? 'Google ドライブへのアクセスが許可されませんでした。'
          : `ログインに失敗しました（${type || '不明なエラー'}）。`;
      this._settle(false, new AuthError(msg, type || 'unknown'));
      return;
    }
    const oauth2 = window.google?.accounts?.oauth2;
    if (oauth2?.hasGrantedAllScopes && !oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
      this._settle(
        false,
        new AuthError(
          'Google ドライブのファイルを表示する権限が許可されていません。ログイン画面でチェックボックスをオンにしてください。',
          'scope',
        ),
      );
      return;
    }
    const expiresIn = Number(resp.expires_in) || 3600;
    this.tokenData = {
      accessToken: resp.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
      clientId: this.clientId,
    };
    this._store();
    this._schedule();
    this.dispatchEvent(new Event('change'));
    this._settle(true, resp.access_token);
  }

  _onError(err) {
    const type = (err && err.type) || 'unknown';
    const msg =
      type === 'popup_failed_to_open'
        ? 'ログイン用のポップアップを開けませんでした。ポップアップのブロックを解除して、もう一度お試しください。'
        : type === 'popup_closed'
          ? 'ログインがキャンセルされました。'
          : 'ログインに失敗しました。';
    this._settle(false, new AuthError(msg, type));
  }

  /**
   * DriveClient / Service Worker から呼ばれる。有効なトークンがあれば返し、なければ null（再ログインが必要）。
   * force=true は「failedToken が API に 401 で拒否された」ことの通知。それが現在のトークンなら破棄する
   * （すでに再ログインして新しいトークンになっていれば、新しいトークンを返す）。
   * ユーザー操作なしでポップアップを開くとブロックされるため、ここでは自動更新しない。
   */
  async getToken(force = false, failedToken = null) {
    if (force && this.tokenData && (!failedToken || failedToken === this.tokenData.accessToken)) {
      this.tokenData = null;
      this._store();
      this._schedule();
      this.dispatchEvent(new Event('expired'));
      return null;
    }
    return this.accessToken;
  }

  /** このセッションを使わなくなったとき（クライアント ID の変更など）。タイマーを止め、待っている要求を終わらせる */
  dispose() {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this._settle(false, new AuthError('ログインが中止されました。', 'disposed'));
  }

  signOut() {
    const token = this.tokenData && this.tokenData.accessToken;
    this.tokenData = null;
    this._store();
    this._schedule();
    if (token && window.google?.accounts?.oauth2?.revoke) {
      try {
        window.google.accounts.oauth2.revoke(token, () => {});
      } catch {
        /* ignore */
      }
    }
    this.dispatchEvent(new Event('change'));
  }
}
