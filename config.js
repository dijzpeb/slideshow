// 配布用の既定値（任意）。
// ここに値を書いておくと、ページを開いた人は入力しなくてもすぐ使えます。
// 画面で入力した値はブラウザに保存され、こちらより優先されます。
// URL パラメータ（?folder=...&key=...）はさらに優先されます。
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

  // 撮影地のタイムゾーン
  timeZone: 'Europe/Helsinki',
};
