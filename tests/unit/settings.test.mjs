import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitize,
  settingsFromUrl,
  loadSettings,
  buildShareUrl,
  offsetsForFolder,
  withFolderOffsets,
  migrateStoredOffsets,
  saveSettings,
  DEFAULTS,
} from '../../js/settings.js';

const FOLDER = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

function withStorage(stored, fn) {
  global.localStorage = { getItem: () => (stored == null ? null : JSON.stringify(stored)), setItem() {}, removeItem() {} };
  try {
    return fn();
  } finally {
    delete global.localStorage;
  }
}

test('sanitize: per-folder cameraOffsets', () => {
  const s = sanitize({
    cameraOffsets: {
      F1: { 'Canon EOS R6': -360, zero: 0, str: '30', bad: 'x', nan: NaN, big: 100000, small: -99999, frac: 12.6, arr: [5], nul: null },
      F2: { only: 0 }, // 空になるフォルダは消す
      'bad id!': { a: 10 },
      F3: 15, // 旧形式の値は捨てる
      F4: [1, 2],
    },
  });
  assert.deepEqual(s.cameraOffsets, { F1: { 'Canon EOS R6': -360, str: 30, big: 2880, small: -2880, frac: 13 } });
  // 旧形式（フォルダ別でない { グループ名: 分 }）は黙って捨てる
  assert.deepEqual(sanitize({ cameraOffsets: { 'Canon EOS R6': -360 } }).cameraOffsets, {});
  assert.deepEqual(sanitize({ cameraOffsets: 'x' }).cameraOffsets, {});
  assert.deepEqual(sanitize({ cameraOffsets: null }).cameraOffsets, {});
  assert.deepEqual(sanitize({}).cameraOffsets, {});
  // __proto__ は通さない（プロトタイプ汚染の防止）
  const evil = sanitize(JSON.parse('{"cameraOffsets":{"__proto__":{"a":5},"F":{"__proto__":5,"b":1}}}'));
  assert.deepEqual(evil.cameraOffsets, { F: { b: 1 } });
  assert.equal(Object.getPrototypeOf(evil.cameraOffsets), Object.prototype);
});

test('sanitize: caps the number of folders and groups', () => {
  const many = {};
  for (let i = 0; i < 60; i++) many[`F${i}`] = { g: i + 1 };
  const s = sanitize({ cameraOffsets: many });
  const keys = Object.keys(s.cameraOffsets);
  assert.equal(keys.length, 50);
  assert.equal(keys[0], 'F10'); // 古い（先頭の）ものから捨てる
  assert.equal(keys[49], 'F59');
  const groups = {};
  for (let i = 0; i < 150; i++) groups[`g${i}`] = 1;
  assert.equal(Object.keys(sanitize({ cameraOffsets: { F: groups } }).cameraOffsets.F).length, 100);
});

test('offsetsForFolder / withFolderOffsets', () => {
  const s0 = sanitize({ cameraOffsets: { A: { cam: 30 }, B: { cam: -60 } } });
  assert.deepEqual(offsetsForFolder(s0, 'A'), { cam: 30 });
  assert.deepEqual(offsetsForFolder(s0, 'C'), {});
  assert.deepEqual(offsetsForFolder(s0, ''), {});
  assert.deepEqual(offsetsForFolder(s0, undefined), {});
  assert.deepEqual(offsetsForFolder(s0, 'constructor'), {});
  assert.deepEqual(offsetsForFolder({}, 'A'), {});
  assert.deepEqual(offsetsForFolder(null, 'A'), {});
  // コピーを返す
  offsetsForFolder(s0, 'A').cam = 99;
  assert.equal(s0.cameraOffsets.A.cam, 30);

  const s1 = withFolderOffsets(s0, 'A', { cam: 45, other: 0, x: 'bad' });
  assert.notEqual(s1, s0);
  assert.deepEqual(s0.cameraOffsets, { A: { cam: 30 }, B: { cam: -60 } }, 'the original is not changed');
  assert.deepEqual(s1.cameraOffsets, { B: { cam: -60 }, A: { cam: 45 } });
  assert.equal(s1.timeZone, s0.timeZone);
  // 空にするとフォルダごと消える
  const s2 = withFolderOffsets(s1, 'A', {});
  assert.deepEqual(s2.cameraOffsets, { B: { cam: -60 } });
  assert.deepEqual(withFolderOffsets(s2, 'B', { cam: 0 }).cameraOffsets, {});
  // 新しいフォルダ・設定なし・不正なフォルダ ID
  assert.deepEqual(withFolderOffsets({ ...DEFAULTS }, 'N', { cam: 5 }).cameraOffsets, { N: { cam: 5 } });
  assert.deepEqual(withFolderOffsets(null, 'N', { cam: 5 }).cameraOffsets, { N: { cam: 5 } });
  assert.deepEqual(withFolderOffsets(s0, '', { cam: 5 }).cameraOffsets, s0.cameraOffsets);
  // sanitize を通しても同じ
  assert.deepEqual(sanitize(s1).cameraOffsets, s1.cameraOffsets);
});

test('share URL carries the current folder corrections and round-trips', () => {
  const settings = sanitize({
    ...DEFAULTS,
    folder: `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`,
    authMode: 'apikey',
    apiKey: 'K',
    cameraOffsets: {
      [FOLDER]: { 'Canon EOS R6': -360, 'SONY ILCE-7M4（タイムゾーン記録あり）': 90, 'Odd: name & co?': 5 },
      OTHER: { 'Canon EOS R6': 120 },
    },
  });
  const url = buildShareUrl('https://x.github.io/slideshow/?old=1#h', settings);
  const u = new URL(url);
  assert.deepEqual(u.searchParams.getAll('fix'), ['-360:Canon EOS R6', '90:SONY ILCE-7M4（タイムゾーン記録あり）', '5:Odd: name & co?']);
  assert.equal(u.searchParams.get('old'), null);
  // URL から読み直すと、そのフォルダの補正になる
  const fromUrl = settingsFromUrl(u.search);
  assert.deepEqual(fromUrl.cameraOffsets, { [FOLDER]: { 'Canon EOS R6': -360, 'SONY ILCE-7M4（タイムゾーン記録あり）': 90, 'Odd: name & co?': 5 } });
  const loaded = withStorage(null, () => loadSettings({}, u.search));
  assert.deepEqual(offsetsForFolder(loaded, FOLDER), { 'Canon EOS R6': -360, 'SONY ILCE-7M4（タイムゾーン記録あり）': 90, 'Odd: name & co?': 5 });
  assert.equal(loaded.authMode, 'apikey');
  assert.equal(loaded.apiKey, 'K');
  // 補正がないフォルダでは fix を付けない
  const plain = new URL(buildShareUrl('https://x.github.io/slideshow/', { ...settings, folder: 'NOFIX' }));
  assert.deepEqual(plain.searchParams.getAll('fix'), []);
  assert.equal(new URL(buildShareUrl('https://x.github.io/slideshow/', { ...settings, folder: '' })).searchParams.has('fix'), false);
});

test('settingsFromUrl: fix params need a valid folder; bad values are ignored', () => {
  assert.equal(settingsFromUrl('?fix=-360:Canon').cameraOffsets, undefined);
  assert.equal(settingsFromUrl('?folder=bad%20id!&fix=-360:Canon').cameraOffsets, undefined);
  assert.equal(settingsFromUrl('?folder=F').cameraOffsets, undefined);
  const o = settingsFromUrl('?folder=F&fix=-360:Canon&fix=abc&fix=10&fix=:x&fix=%2B30:Plus&fix=99999:Big&fix=0:Zero&fix=5:Canon');
  // 同じグループは後のものが有効。0 は保存済みの補正を消すために残る
  assert.deepEqual(o.cameraOffsets, { F: { Canon: 5, Plus: 30, Big: 2880, Zero: 0 } });
  assert.deepEqual(sanitize(o).cameraOffsets, { F: { Canon: 5, Plus: 30, Big: 2880 } });
});

test('loadSettings merges URL corrections over the stored ones for that folder only', () => {
  const stored = { folder: 'A', cameraOffsets: { A: { cam1: 10, cam2: 20, cam3: 30 }, B: { cam1: -60 } } };
  const loaded = withStorage(stored, () => loadSettings({}, '?folder=A&fix=25:cam2&fix=0:cam3&fix=7:cam4'));
  assert.deepEqual(loaded.cameraOffsets, { B: { cam1: -60 }, A: { cam1: 10, cam2: 25, cam4: 7 } });
  // URL に fix がなければ保存済みのまま
  const noFix = withStorage(stored, () => loadSettings({}, '?folder=A'));
  assert.deepEqual(noFix.cameraOffsets, stored.cameraOffsets);
  // 旧形式で保存されていた補正（フォルダが分からない）は捨てる
  const legacy = withStorage({ cameraOffsets: { 'Canon EOS R6': -360 } }, () => loadSettings({}, ''));
  assert.deepEqual(legacy.cameraOffsets, {});
  const legacyWithUrl = withStorage({ cameraOffsets: { 'Canon EOS R6': -360 } }, () => loadSettings({}, '?folder=A&fix=-360:Canon%20EOS%20R6'));
  assert.deepEqual(legacyWithUrl.cameraOffsets, { A: { 'Canon EOS R6': -360 } });
});

test('loadSettings migrates the previous flat cameraOffsets to the folder saved with them', () => {
  const url = `https://drive.google.com/drive/folders/${FOLDER}?resourcekey=0-x`;
  const old = { folder: url, cameraOffsets: { 'Canon EOS R6': -360, '動画（機種不明）': -540, bad: 'x' } };
  let saved = null;
  global.localStorage = {
    getItem: () => JSON.stringify(old),
    setItem: (k, v) => {
      saved = JSON.parse(v);
    },
    removeItem() {},
  };
  try {
    const loaded = loadSettings({}, '');
    assert.deepEqual(loaded.cameraOffsets, { [FOLDER]: { 'Canon EOS R6': -360, '動画（機種不明）': -540 } });
    assert.deepEqual(offsetsForFolder(loaded, FOLDER), { 'Canon EOS R6': -360, '動画（機種不明）': -540 });
    // 次の保存で新しい形式になる（消えない）
    saveSettings(loaded);
    assert.deepEqual(saved.cameraOffsets, { [FOLDER]: { 'Canon EOS R6': -360, '動画（機種不明）': -540 } });
  } finally {
    delete global.localStorage;
  }
  // URL の fix は移行した値に上書きでまとめる
  const merged = withStorage(old, () => loadSettings({}, `?folder=${FOLDER}&fix=-300:Canon%20EOS%20R6`));
  assert.deepEqual(merged.cameraOffsets, { [FOLDER]: { 'Canon EOS R6': -300, '動画（機種不明）': -540 } });
  // 保存されたフォルダがなければ config.js のフォルダの分にする
  const deploy = withStorage({ cameraOffsets: { cam: 15 } }, () => loadSettings({ folder: 'B' }, ''));
  assert.deepEqual(deploy.cameraOffsets, { B: { cam: 15 } });
  // 新旧が混ざっていても新しい形式の値が優先
  assert.deepEqual(
    migrateStoredOffsets({ folder: 'A', cameraOffsets: { cam: 15, other: 5, A: { cam: 30 }, B: { x: 1 } } }).cameraOffsets,
    { A: { cam: 30, other: 5 }, B: { x: 1 } },
  );
  // 新しい形式だけなら何もしない
  const fresh = { folder: 'A', cameraOffsets: { A: { cam: 30 } } };
  assert.equal(migrateStoredOffsets(fresh), fresh);
});
