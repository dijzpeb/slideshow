#!/usr/bin/env node
// 公開（GitHub Pages へのデプロイ）のときに、GitHub Actions のリポジトリ変数から config.js を作る（依存パッケージなし）。
// リポジトリの config.js は空欄のままにして、公開するサイトの設定だけをリポジトリ変数で渡すため。
//
// 使い方: node scripts/write-config.mjs <出力先（例: _site/config.js）>
//   環境変数 SLIDESHOW_CLIENT_ID / SLIDESHOW_API_KEY / SLIDESHOW_FOLDER / SLIDESHOW_TITLE / SLIDESHOW_TIME_ZONE
//   のうち設定されているものを config.js に書く。どれも設定されていなければ、リポジトリの config.js をそのままコピーする。
//   値はすべて JSON.stringify で書き出す（値にどんな文字があってもスクリプトとしては解釈されない）。
//   正しくない値があればエラーで終了する（壊れた設定のサイトを公開しない）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** リポジトリの config.js（変数が一つも設定されていなければこれをコピーする） */
export const REPO_CONFIG = path.resolve(HERE, '..', 'config.js');

/** config.js の項目 → 環境変数（GitHub Actions のリポジトリ変数）の名前 */
export const VARIABLES = Object.freeze({
  clientId: 'SLIDESHOW_CLIENT_ID',
  apiKey: 'SLIDESHOW_API_KEY',
  folder: 'SLIDESHOW_FOLDER',
  title: 'SLIDESHOW_TITLE',
  timeZone: 'SLIDESHOW_TIME_ZONE',
});

// 制御文字（改行・タブを含む）
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** 各項目の検証。正しくなければ理由（日本語）を返す */
const CHECKS = {
  clientId: (v) =>
    /^[0-9A-Za-z-]{1,200}\.apps\.googleusercontent\.com$/.test(v)
      ? null
      : 'OAuth クライアント ID の形式ではありません（例: 1234567890-abc.apps.googleusercontent.com）。クライアント シークレットではなくクライアント ID を設定してください。',
  apiKey: (v) => (/^[0-9A-Za-z_-]{10,200}$/.test(v) ? null : 'API キーの形式ではありません（英数字・「-」「_」のみ）。'),
  folder: (v) => (v.length <= 2000 && !CONTROL_RE.test(v) ? null : 'フォルダの URL または ID が長すぎるか、改行などの制御文字を含んでいます。'),
  title: (v) => (v.length <= 120 && !CONTROL_RE.test(v) ? null : 'タイトルは改行などを含まない 120 文字以内にしてください。'),
  timeZone: (v) => (isValidTimeZone(v) ? null : `タイムゾーン「${v}」が正しくありません（IANA 名。例: Asia/Tokyo、Europe/Paris、America/New_York）。`),
};

/**
 * 環境変数から config.js の値を作る。
 * @param {Record<string, string|undefined>} env
 * @returns {{config: Record<string,string>|null, errors: string[]}} config: どれも設定されていなければ null
 */
export function configFromEnv(env = process.env) {
  const config = {};
  const errors = [];
  let any = false;
  for (const [key, name] of Object.entries(VARIABLES)) {
    const v = typeof env[name] === 'string' ? env[name].trim() : '';
    config[key] = v;
    if (!v) continue;
    any = true;
    const err = CHECKS[key](v);
    if (err) errors.push(`${name}: ${err}`);
  }
  return { config: any ? config : null, errors };
}

/** config.js の中身（値は JSON.stringify で書く） */
export function renderConfig(config) {
  return [
    '// このファイルは公開時に scripts/write-config.mjs が GitHub Actions のリポジトリ変数から作りました。',
    `window.SLIDESHOW_CONFIG = ${JSON.stringify(config, null, 2)};`,
    '',
  ].join('\n');
}

/**
 * config.js を書き出す。
 * @returns {'generated'|'copied'}
 * @throws {Error} 正しくない値があるとき（何も書かない）
 */
export function writeConfig(out, { env = process.env, source = REPO_CONFIG } = {}) {
  const { config, errors } = configFromEnv(env);
  if (errors.length) throw new Error(`config.js を作れません:\n${errors.join('\n')}`);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  if (!config) {
    fs.copyFileSync(source, out);
    return 'copied';
  }
  fs.writeFileSync(out, renderConfig(config));
  return 'generated';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = process.argv[2];
  if (!out) {
    console.error('使い方: node scripts/write-config.mjs <出力先（例: _site/config.js）>');
    process.exit(2);
  }
  try {
    const how = writeConfig(out);
    if (how === 'copied') console.log(`${out}: リポジトリ変数が設定されていないので、リポジトリの config.js をそのまま使います。`);
    else {
      const set = Object.entries(VARIABLES)
        .filter(([key]) => configFromEnv().config[key])
        .map(([, name]) => name);
      console.log(`${out}: リポジトリ変数（${set.join(', ')}）から作りました。`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
