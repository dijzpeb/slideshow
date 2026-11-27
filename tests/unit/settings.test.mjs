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
  legacyOffsetsForFolder,
  withoutLegacyOffsets,
  saveSettings,
  DEFAULTS,
  authLock,
  applyAuthLock,
  linkAuthConflict,
  updateStoredSettings,
  withFolderOffsetsFrom,
} from '../../js/settings.js';
import { deviceTimeZone } from '../../js/timeutil.js';

const FOLDER = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

/** localStorage stand-in that keeps what is written (raw JSON text in .data) */
function withMemStorage(stored, fn) {
  const mem = { data: stored == null ? null : JSON.stringify(stored) };
  global.localStorage = {
    getItem: () => mem.data,
    setItem: (k, v) => {
      mem.data = v;
    },
    removeItem: () => {
      mem.data = null;
    },
  };
  try {
    fn(mem);
    return mem.data == null ? null : JSON.parse(mem.data);
  } finally {
    delete global.localStorage;
  }
}

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
  // fix=* で、このフォルダの補正のすべてであることを示す
  assert.deepEqual(u.searchParams.getAll('fix'), ['-360:Canon EOS R6', '90:SONY ILCE-7M4（タイムゾーン記録あり）', '5:Odd: name & co?', '*']);
  assert.equal(u.searchParams.get('old'), null);
  // URL から読み直すと、そのフォルダの補正になる
  const fromUrl = settingsFromUrl(u.search);
  assert.deepEqual(fromUrl.cameraOffsets, { [FOLDER]: { 'Canon EOS R6': -360, 'SONY ILCE-7M4（タイムゾーン記録あり）': 90, 'Odd: name & co?': 5 } });
  const loaded = withStorage(null, () => loadSettings({}, u.search));
  assert.deepEqual(offsetsForFolder(loaded, FOLDER), { 'Canon EOS R6': -360, 'SONY ILCE-7M4（タイムゾーン記録あり）': 90, 'Odd: name & co?': 5 });
  assert.equal(loaded.authMode, 'apikey');
  assert.equal(loaded.apiKey, 'K');
  // 補正がないフォルダでも fix=*（開いた側の古い補正を消す）
  const plain = new URL(buildShareUrl('https://x.github.io/slideshow/', { ...settings, folder: 'NOFIX' }));
  assert.deepEqual(plain.searchParams.getAll('fix'), ['*']);
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

test('share link replaces the recipient\'s corrections for that folder (fix=*); a hand-written fix= list merges', () => {
  const settings = sanitize({ ...DEFAULTS, folder: FOLDER, authMode: 'apikey', apiKey: 'K', cameraOffsets: { [FOLDER]: { 'Canon EOS R6': -360 } } });
  // the recipient opened an older link (Canon −6 h, Sony +30 min) and has a correction for another folder
  const recipient = {
    folder: FOLDER,
    cameraOffsets: { [FOLDER]: { 'Canon EOS R6': -300, 'SONY ILCE-7M4': 30 }, OTHER: { cam: 5 } },
    legacyCameraOffsets: { [FOLDER]: { '動画（機種不明）': -180 }, OTHER: { cam: 5 } },
  };
  const link = new URL(buildShareUrl('https://x.github.io/slideshow/', settings));
  const fromUrl = settingsFromUrl(link.search);
  assert.equal(fromUrl.replaceCameraOffsets, true);
  const loaded = withStorage(recipient, () => loadSettings({}, link.search));
  assert.deepEqual(loaded.cameraOffsets, { OTHER: { cam: 5 }, [FOLDER]: { 'Canon EOS R6': -360 } }, 'the link\'s set, not merged');
  assert.deepEqual(loaded.legacyCameraOffsets, { OTHER: { cam: 5 } }, 'old corrections of that folder are not migrated over the link');
  assert.equal('replaceCameraOffsets' in loaded, false);
  // the sharer removed every correction: the link still clears the recipient's
  const none = new URL(buildShareUrl('https://x.github.io/slideshow/', { ...settings, cameraOffsets: {} }));
  assert.deepEqual(settingsFromUrl(none.search).cameraOffsets, { [FOLDER]: {} });
  assert.deepEqual(withStorage(recipient, () => loadSettings({}, none.search)).cameraOffsets, { OTHER: { cam: 5 } });
  // a hand-written link without fix=* merges into the saved corrections
  const partial = withStorage(recipient, () => loadSettings({}, `?folder=${FOLDER}&fix=-360:Canon%20EOS%20R6`));
  assert.deepEqual(partial.cameraOffsets[FOLDER], { 'Canon EOS R6': -360, 'SONY ILCE-7M4': 30 });
  assert.deepEqual(partial.legacyCameraOffsets, recipient.legacyCameraOffsets);
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
    // 以前のグループ名のままの値も残す（グループの分け方が変わったファイルに移すため。catalog.migrateLegacyOffsets）
    assert.deepEqual(legacyOffsetsForFolder(loaded, FOLDER), { 'Canon EOS R6': -360, '動画（機種不明）': -540 });
    // 次の保存で新しい形式になる（消えない）
    saveSettings(loaded);
    assert.deepEqual(saved.cameraOffsets, { [FOLDER]: { 'Canon EOS R6': -360, '動画（機種不明）': -540 } });
    assert.deepEqual(saved.legacyCameraOffsets, { [FOLDER]: { 'Canon EOS R6': -360, '動画（機種不明）': -540 } });
    // 今のグループに移し終えたら消す（他のフォルダはそのまま）
    const done = withoutLegacyOffsets({ ...loaded, legacyCameraOffsets: { ...loaded.legacyCameraOffsets, B: { x: 1 } } }, FOLDER);
    assert.deepEqual(done.legacyCameraOffsets, { B: { x: 1 } });
    assert.deepEqual(legacyOffsetsForFolder(done, FOLDER), {});
    assert.deepEqual(done.cameraOffsets, loaded.cameraOffsets);
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

test('the default trip time zone is the device time zone; config.js, storage and the URL override it', () => {
  assert.equal(DEFAULTS.timeZone, deviceTimeZone());
  assert.equal(withStorage(null, () => loadSettings({}, '')).timeZone, DEFAULTS.timeZone);
  // config.js の空欄は既定値（この端末のタイムゾーン）
  assert.equal(withStorage(null, () => loadSettings({ timeZone: '' }, '')).timeZone, DEFAULTS.timeZone);
  assert.equal(withStorage(null, () => loadSettings({ timeZone: 'Europe/Paris' }, '')).timeZone, 'Europe/Paris');
  assert.equal(withStorage({ timeZone: 'Asia/Tokyo' }, () => loadSettings({ timeZone: 'Europe/Paris' }, '')).timeZone, 'Asia/Tokyo');
  assert.equal(withStorage({ timeZone: 'Asia/Tokyo' }, () => loadSettings({}, '?tz=America/New_York')).timeZone, 'America/New_York');
  // 不正な値は既定値に戻す
  assert.equal(sanitize({ timeZone: 'Mars/Olympus' }).timeZone, DEFAULTS.timeZone);
  // 共有リンクには既定値でも必ず付ける
  assert.equal(new URL(buildShareUrl('https://x.github.io/slideshow/', sanitize({ folder: FOLDER }))).searchParams.get('tz'), DEFAULTS.timeZone);
});

const CONFIG_CLIENT = '111-config.apps.googleusercontent.com';
const EVIL_CLIENT = '666-attacker.apps.googleusercontent.com';

test('config.js clientId locks the connection: URL / stored clientId, key and mode are ignored', () => {
  const lock = authLock({ clientId: ` ${CONFIG_CLIENT} ` });
  assert.deepEqual({ ...lock, values: { ...lock.values } }, { clientId: true, apiKey: false, any: true, authMode: 'oauth', values: { clientId: CONFIG_CLIENT, apiKey: '' } });
  const stored = { clientId: 'stored-evil', apiKey: 'STOREDKEY', authMode: 'apikey', folder: 'F1' };
  for (const search of [`?clientId=${EVIL_CLIENT}`, `?clientId=${EVIL_CLIENT}&mode=apikey&key=EVILKEY`, '?key=EVILKEY', '?apiKey=EVILKEY&mode=key', '']) {
    const s = withStorage(stored, () => loadSettings({ clientId: CONFIG_CLIENT }, search));
    assert.equal(s.clientId, CONFIG_CLIENT, search);
    assert.equal(s.authMode, 'oauth', search);
    assert.equal(s.apiKey, '', search);
  }
  // the other settings still come from storage / the URL
  assert.equal(withStorage(stored, () => loadSettings({ clientId: CONFIG_CLIENT }, '?folder=F2')).folder, 'F2');
  // a form edited in the page cannot override it either
  assert.deepEqual(applyAuthLock({ authMode: 'apikey', clientId: EVIL_CLIENT, apiKey: 'K', folder: 'F' }, lock), { authMode: 'oauth', clientId: CONFIG_CLIENT, apiKey: '', folder: 'F' });
});

test('config.js apiKey only → API-key mode with that key; both → mode selectable, values locked; none → unlocked', () => {
  const stored = { clientId: 'stored-client', apiKey: 'STOREDKEY', authMode: 'oauth' };
  const k = withStorage(stored, () => loadSettings({ apiKey: 'CONFIGKEY' }, `?mode=oauth&clientId=${EVIL_CLIENT}&key=EVILKEY`));
  assert.deepEqual([k.authMode, k.apiKey, k.clientId], ['apikey', 'CONFIGKEY', '']);
  const both = { clientId: CONFIG_CLIENT, apiKey: 'CONFIGKEY' };
  assert.equal(authLock(both).authMode, null);
  const b1 = withStorage(stored, () => loadSettings(both, `?mode=apikey&key=EVILKEY&clientId=${EVIL_CLIENT}`));
  assert.deepEqual([b1.authMode, b1.apiKey, b1.clientId], ['apikey', 'CONFIGKEY', CONFIG_CLIENT]);
  const b2 = withStorage(stored, () => loadSettings(both, ''));
  assert.deepEqual([b2.authMode, b2.apiKey, b2.clientId], ['oauth', 'CONFIGKEY', CONFIG_CLIENT]);
  // config.js authMode is the default when both are set
  assert.equal(withStorage(null, () => loadSettings({ ...both, authMode: 'apikey' }, '')).authMode, 'apikey');
  // unlocked (empty config.js): the share-link feature keeps working
  assert.equal(authLock({ clientId: '', apiKey: '  ' }).any, false);
  const u = withStorage(null, () => loadSettings({ clientId: '', apiKey: '' }, `?clientId=${EVIL_CLIENT}`));
  assert.equal(u.clientId, EVIL_CLIENT);
  const v = withStorage(null, () => loadSettings({}, '?key=LINKKEY'));
  assert.deepEqual([v.authMode, v.apiKey], ['apikey', 'LINKKEY']);
});

test('share link: connection values locked by config.js are left out (the recipient uses the deployed config)', () => {
  const s = sanitize({ folder: FOLDER, authMode: 'oauth', clientId: CONFIG_CLIENT, apiKey: '', timeZone: 'Europe/Paris' });
  const params = (u) => Object.fromEntries([...new URL(u).searchParams].filter(([k]) => ['mode', 'clientId', 'key'].includes(k)));
  assert.deepEqual(params(buildShareUrl('https://x.github.io/s/', s, authLock({ clientId: CONFIG_CLIENT }))), {});
  const k = sanitize({ folder: FOLDER, authMode: 'apikey', apiKey: 'CONFIGKEY' });
  assert.deepEqual(params(buildShareUrl('https://x.github.io/s/', k, authLock({ apiKey: 'CONFIGKEY' }))), {});
  // both set: the mode is still shared, the values are not
  const both = authLock({ clientId: CONFIG_CLIENT, apiKey: 'CONFIGKEY' });
  assert.deepEqual(params(buildShareUrl('https://x.github.io/s/', { ...k, clientId: CONFIG_CLIENT }, both)), { mode: 'apikey' });
  // unlocked: unchanged (mode + value)
  assert.deepEqual(params(buildShareUrl('https://x.github.io/s/', s)), { mode: 'oauth', clientId: CONFIG_CLIENT });
  assert.deepEqual(params(buildShareUrl('https://x.github.io/s/', k, authLock({}))), { mode: 'apikey', key: 'CONFIGKEY' });
});

test('linkAuthConflict: a link clientId / key that differs from a non-empty stored one (unlocked deployments only)', () => {
  const stored = { authMode: 'apikey', apiKey: 'MYKEY', clientId: 'my-client' };
  const c = withStorage(stored, () => linkAuthConflict({}, '?key=OTHERKEY&folder=F'));
  assert.deepEqual(c, { clientId: false, apiKey: true, stored: { authMode: 'apikey', clientId: 'my-client', apiKey: 'MYKEY' } });
  assert.equal(withStorage(stored, () => linkAuthConflict({}, `?clientId=${EVIL_CLIENT}`)).clientId, true);
  // same values, nothing stored, or no auth value in the link → no warning
  assert.equal(withStorage(stored, () => linkAuthConflict({}, '?key=MYKEY&clientId=my-client')), null);
  assert.equal(withStorage(null, () => linkAuthConflict({}, '?key=OTHERKEY')), null);
  assert.equal(withStorage({ apiKey: '' }, () => linkAuthConflict({}, '?key=OTHERKEY')), null);
  assert.equal(withStorage(stored, () => linkAuthConflict({}, '?folder=F&mode=oauth')), null);
  // locked by config.js: the link value is ignored anyway
  assert.equal(withStorage(stored, () => linkAuthConflict({ apiKey: 'CONFIGKEY' }, '?key=OTHERKEY')), null);
});

test('linkAuthConflict: a link that switches the connection mode and brings the other value is flagged too', () => {
  // only an API key saved; the link switches to OAuth with its own client (no saved client ID to compare with)
  const keyOnly = { authMode: 'apikey', apiKey: 'TESTKEY' };
  assert.deepEqual(withStorage(keyOnly, () => linkAuthConflict({}, `?mode=oauth&clientId=${EVIL_CLIENT}&folder=F`)), {
    clientId: true, apiKey: false, stored: { authMode: 'apikey', clientId: '', apiKey: 'TESTKEY' },
  });
  // only an OAuth client saved; the link brings an API key (which implies API-key mode)
  const clientOnly = { authMode: 'oauth', clientId: 'my-client' };
  assert.deepEqual(withStorage(clientOnly, () => linkAuthConflict({}, '?key=ATTACKERKEY&folder=F&autostart=1')), {
    clientId: false, apiKey: true, stored: { authMode: 'oauth', clientId: 'my-client', apiKey: '' },
  });
  // switching the mode alone (to a value this browser saved itself) is not a conflict
  const both = { authMode: 'oauth', clientId: 'my-client', apiKey: 'MYKEY' };
  assert.equal(withStorage(both, () => linkAuthConflict({}, '?mode=apikey')), null);
  assert.equal(withStorage(keyOnly, () => linkAuthConflict({}, '?mode=oauth')), null);
  // the app's own share link for the saved connection: no warning
  assert.equal(withStorage(clientOnly, () => linkAuthConflict({}, '?mode=oauth&clientId=my-client&folder=F')), null);
  // only a mode (or other settings) saved: nothing to protect, the link is used as before
  assert.equal(withStorage({ authMode: 'apikey', videoMuted: true }, () => linkAuthConflict({}, `?mode=oauth&clientId=${EVIL_CLIENT}`)), null);
});

test('config.js with both values: a link ?key= is ignored entirely (it does not pick API-key mode); mode= still does', () => {
  const both = { clientId: CONFIG_CLIENT, apiKey: 'AIzaCONFIGKEY123' };
  const s = withStorage(null, () => loadSettings(both, '?key=EVIL'));
  assert.deepEqual([s.authMode, s.apiKey, s.clientId], ['oauth', 'AIzaCONFIGKEY123', CONFIG_CLIENT]);
  const viaMode = withStorage(null, () => loadSettings(both, '?key=EVIL&mode=apikey'));
  assert.deepEqual([viaMode.authMode, viaMode.apiKey], ['apikey', 'AIzaCONFIGKEY123']);
  // a saved mode still applies
  assert.equal(withStorage({ authMode: 'apikey' }, () => loadSettings(both, '?key=EVIL')).authMode, 'apikey');
  // unlocked: ?key= alone still means API-key mode
  assert.equal(withStorage(null, () => loadSettings({}, '?key=LINKKEY')).authMode, 'apikey');
});

test('updateStoredSettings: only the changed fields are merged into the stored settings (no URL-only values)', () => {
  // an autostart link with someone else's folder / title / key, then M (videoMuted) is pressed
  const stored = { folder: 'MINE', title: 'Mine', photoSeconds: 3 };
  const search = '?folder=THEIRS&title=Theirs&key=THEIRKEY&tz=Asia%2FTokyo&autostart=1';
  const after = withMemStorage(stored, () => {
    const s = loadSettings({}, search);
    assert.equal(s.folder, 'THEIRS');
    updateStoredSettings({ videoMuted: !s.videoMuted });
  });
  assert.deepEqual(after, { folder: 'MINE', title: 'Mine', photoSeconds: 3, videoMuted: true });
  // nothing stored yet: only the patch (no defaults filled in, e.g. no device time zone)
  assert.deepEqual(withMemStorage(null, () => updateStoredSettings({ videoMuted: true })), { videoMuted: true });
  // values are still validated
  assert.deepEqual(withMemStorage(null, () => updateStoredSettings({ photoSeconds: 999 })), { photoSeconds: 120 });
  // a function patch gets the stored settings (older flat corrections migrated to the folder saved with them)
  const old = { folder: 'A', cameraOffsets: { cam: 15 } };
  const migrated = withMemStorage(old, () => updateStoredSettings((st) => ({ ...st, title: 'T' })));
  assert.deepEqual(migrated.cameraOffsets, { A: { cam: 15 } });
  assert.equal(migrated.title, 'T');
});

test('withFolderOffsetsFrom copies only that folder\'s corrections (time-fix 適用 persists nothing else)', () => {
  const stored = { folder: 'MINE', cameraOffsets: { OTHER: { cam: 5 }, F: { old: 1 } }, legacyCameraOffsets: { F: { x: 2 }, G: { y: 3 } } };
  const current = sanitize({ folder: 'F', title: 'From a link', apiKey: 'LINKKEY', cameraOffsets: { F: { 'Canon EOS R6': -360 }, H: { z: 9 } } });
  const next = withFolderOffsetsFrom(stored, current, 'F');
  assert.deepEqual(next.cameraOffsets, { OTHER: { cam: 5 }, F: { 'Canon EOS R6': -360 } });
  assert.deepEqual(next.legacyCameraOffsets, { G: { y: 3 } });
  assert.equal(next.folder, 'MINE');
  assert.equal(next.title, undefined);
  assert.equal(next.apiKey, undefined);
  // removing every correction of the folder
  assert.deepEqual(withFolderOffsetsFrom(stored, sanitize({}), 'F').cameraOffsets, { OTHER: { cam: 5 } });
  // legacy corrections not migrated yet are kept
  const withLegacy = sanitize({ legacyCameraOffsets: { F: { x: 4 } } });
  assert.deepEqual(withFolderOffsetsFrom(stored, withLegacy, 'F').legacyCameraOffsets, { G: { y: 3 }, F: { x: 4 } });
});
