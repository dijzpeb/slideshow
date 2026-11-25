// 公開サイトの設定（任意）。値があると、ページを開いた人は入力しなくてもすぐ使えます。
//
// このファイルは公開されます（サイトを開いた人は誰でも読めます）。リポジトリのこのファイルは空欄のままにしてください。
// GitHub Pages に公開するときは、リポジトリ変数（Settings → Secrets and variables → Actions → Variables の
// SLIDESHOW_CLIENT_ID / SLIDESHOW_API_KEY / SLIDESHOW_FOLDER / SLIDESHOW_TITLE / SLIDESHOW_TIME_ZONE）で値を渡します。
// デプロイのときに scripts/write-config.mjs が、その値から公開用の config.js を作ります（変数が一つもなければこのファイルをそのまま使う）。
// 「リンクを知っている全員」に共有したフォルダの URL は、ここにもリポジトリ変数にも書かないでください（誰でも写真を見られるようになります）。
//
// clientId / apiKey を書くと接続設定はその値に固定され、URL パラメータや画面の入力では変えられません
// （細工したリンクで別の OAuth クライアントや API キーを使わせないため）。
// folder / title / timeZone は既定値で、画面で入力した値（ブラウザに保存）や URL パラメータ（?folder=... など）が優先されます。
window.SLIDESHOW_CONFIG = {
  // Google アカウントでログインする場合の OAuth クライアント ID
  // 例: '1234567890-abcdefg.apps.googleusercontent.com'
  clientId: '',

  // ログインせずに「リンクを知っている全員」共有のフォルダを見る場合の API キー
  // 例: 'AIza...'
  apiKey: '',

  // 写真・動画を入れた Google ドライブのフォルダの URL または ID
  folder: '',

  // タイトル（空欄ならフォルダ名）
  title: '',

  // 撮影地のタイムゾーン（IANA 名。例: 'Europe/Paris'、'America/New_York'）
  // 空欄なら、ページを開いた端末のタイムゾーン
  timeZone: '',
};
