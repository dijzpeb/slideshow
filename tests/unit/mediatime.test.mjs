import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BufferReader,
  RangeReader,
  readMp4CreationTime,
  readJpegExif,
  readHeifExif,
  parseTiffExif,
  exifToCapture,
  extractCaptureInfo,
} from '../../js/mediatime.js';

// --- ISO BMFF ビルダー ---------------------------------------------------
const enc = new TextEncoder();
function cat(...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function u32(n) {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}
function u16(n) {
  return new Uint8Array([(n >>> 8) & 255, n & 255]);
}
function box(type, ...payload) {
  const body = cat(...payload);
  const t = typeof type === 'string' ? (type.length === 4 ? Uint8Array.from(type, (c) => c.charCodeAt(0)) : null) : type;
  return cat(u32(8 + body.length), t, body);
}
function largeBox(type, ...payload) {
  const body = cat(...payload);
  const size = 16 + body.length;
  return cat(u32(1), Uint8Array.from(type, (c) => c.charCodeAt(0)), u32(0), u32(size), body);
}
const MAC = 2082844800;
function mvhd(epochSec, version = 0) {
  if (version === 1) {
    const secs = epochSec + MAC;
    return box('mvhd', new Uint8Array([1, 0, 0, 0]), u32(Math.floor(secs / 2 ** 32)), u32(secs >>> 0), new Uint8Array(100));
  }
  return box('mvhd', new Uint8Array([0, 0, 0, 0]), u32(epochSec ? epochSec + MAC : 0), new Uint8Array(92));
}
function appleMeta(entries, { fullBox = false } = {}) {
  const keys = box(
    'keys',
    new Uint8Array(4),
    u32(entries.length),
    ...entries.map(([k]) => cat(u32(8 + enc.encode(k).length), enc.encode('mdta'), enc.encode(k))),
  );
  const ilst = box(
    'ilst',
    ...entries.map(([, v], i) => cat(u32(8 + 16 + enc.encode(v).length), u32(i + 1), box('data', u32(1), u32(0), enc.encode(v)))),
  );
  const hdlr = box('hdlr', new Uint8Array(8), enc.encode('mdta'), new Uint8Array(13));
  return fullBox ? box('meta', new Uint8Array(4), hdlr, keys, ilst) : box('meta', hdlr, keys, ilst);
}
const epoch = (iso) => Date.parse(iso);

test('mp4: mvhd v0 with moov at end (after big mdat)', async () => {
  const t = Date.UTC(2025, 6, 12, 15, 30) / 1000;
  const file = cat(box('ftyp', enc.encode('isom'), u32(0)), box('mdat', new Uint8Array(300000)), box('moov', mvhd(t), box('trak', new Uint8Array(5000))));
  const rr = new RangeReader(async (s, e) => file.slice(s, e + 1).buffer, file.length, { blockSize: 4096 });
  const r = await readMp4CreationTime(rr);
  assert.equal(r.source, 'mp4-mvhd');
  assert.equal(new Date(r.epoch).toISOString(), '2025-07-12T15:30:00.000Z');
  assert.ok(rr.bytesFetched < 40000, `fetched ${rr.bytesFetched}`);
});

test('mp4: mvhd v1 (64-bit) and 64-bit largesize mdat', async () => {
  const t = Date.UTC(2025, 6, 14, 9) / 1000;
  const file = cat(box('ftyp', enc.encode('qt  '), u32(0)), largeBox('mdat', new Uint8Array(1000)), box('moov', mvhd(t, 1)));
  const r = await readMp4CreationTime(new BufferReader(file));
  assert.equal(new Date(r.epoch).toISOString(), '2025-07-14T09:00:00.000Z');
});

test('mp4: Apple creationdate wins over mvhd; model is read', async () => {
  const t = Date.UTC(2025, 7, 1) / 1000;
  for (const fullBox of [false, true]) {
    const meta = appleMeta(
      [
        ['com.apple.quicktime.make', 'Apple'],
        ['com.apple.quicktime.model', 'iPhone 15'],
        ['com.apple.quicktime.creationdate', '2025-07-13T21:10:00+0300'],
      ],
      { fullBox },
    );
    const file = cat(box('ftyp', enc.encode('qt  '), u32(0)), box('wide'), box('mdat', new Uint8Array(100)), box('moov', mvhd(t), box('trak', new Uint8Array(100)), meta));
    const r = await readMp4CreationTime(new BufferReader(file));
    assert.equal(r.source, 'mp4-apple', `fullBox=${fullBox}`);
    assert.equal(new Date(r.epoch).toISOString(), '2025-07-13T18:10:00.000Z');
    assert.equal(r.model, 'iPhone 15');
    assert.equal(r.make, 'Apple');
    assert.equal(new Date(r.mvhdEpoch).toISOString(), '2025-08-01T00:00:00.000Z');
  }
});

test('mp4: udta ©day (QuickTime text) is used when it has an offset', async () => {
  const text = enc.encode('2025-07-14T10:00:00+0300');
  const day = cat(u32(12 + text.length), new Uint8Array([0xa9, 0x64, 0x61, 0x79]), u16(text.length), u16(0x55c4), text);
  const file = cat(box('ftyp', enc.encode('qt  '), u32(0)), box('moov', mvhd(0), box('udta', day)));
  const r = await readMp4CreationTime(new BufferReader(file));
  assert.equal(r.source, 'mp4-day');
  assert.equal(new Date(r.epoch).toISOString(), '2025-07-14T07:00:00.000Z');
});

test('mp4: zero mvhd and no metadata → epoch null / null', async () => {
  const file = cat(box('ftyp', enc.encode('isom'), u32(0)), box('moov', mvhd(0)), box('mdat', new Uint8Array(10)));
  assert.equal(await readMp4CreationTime(new BufferReader(file)), null);
});

test('mp4: not a BMFF file → null; truncated file → no throw', async () => {
  assert.equal(await readMp4CreationTime(new BufferReader(enc.encode('this is not a video file at all'))), null);
  const t = Date.UTC(2025, 6, 12) / 1000;
  const file = cat(box('ftyp', enc.encode('isom'), u32(0)), box('moov', mvhd(t)));
  const truncated = file.slice(0, file.length - 50);
  await assert.doesNotReject(readMp4CreationTime(new BufferReader(truncated)));
});

// --- EXIF ---------------------------------------------------------------
function tiff({ le = false, make = 'Canon', model = 'Canon EOS R6', dto = '2025:07:12 20:00:00', oto = '+09:00' } = {}) {
  // IFD0: Make, Model, ExifIFD ; ExifIFD: DateTimeOriginal, OffsetTimeOriginal
  const w16 = (n) => (le ? new Uint8Array([n & 255, n >> 8]) : u16(n));
  const w32 = (n) => (le ? new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]) : u32(n));
  const strs = [make + '\0', model + '\0', dto + '\0', oto + '\0'].map((s) => enc.encode(s));
  const ifd0Off = 8;
  const ifd0Len = 2 + 3 * 12 + 4;
  const exifOff = ifd0Off + ifd0Len;
  const exifLen = 2 + 2 * 12 + 4;
  let dataOff = exifOff + exifLen;
  const offs = strs.map((s) => {
    const o = dataOff;
    dataOff += s.length;
    return o;
  });
  const entry = (tag, type, count, value) => cat(w16(tag), w16(type), w32(count), w32(value));
  const ifd0 = cat(w16(3), entry(0x010f, 2, strs[0].length, offs[0]), entry(0x0110, 2, strs[1].length, offs[1]), entry(0x8769, 4, 1, exifOff), w32(0));
  const exif = cat(w16(2), entry(0x9003, 2, strs[2].length, offs[2]), entry(0x9011, 2, strs[3].length, offs[3]), w32(0));
  return cat(enc.encode(le ? 'II' : 'MM'), w16(42), w32(ifd0Off), ifd0, exif, ...strs);
}

test('parseTiffExif big- and little-endian', () => {
  for (const le of [false, true]) {
    const r = parseTiffExif(tiff({ le }));
    assert.equal(r.make, 'Canon');
    assert.equal(r.model, 'Canon EOS R6');
    assert.equal(r.dateTimeOriginal, '2025:07:12 20:00:00');
    assert.equal(r.offsetTimeOriginal, '+09:00');
  }
  assert.equal(parseTiffExif(enc.encode('XX*garbage')), null);
});

test('readJpegExif finds APP1 after APP0', async () => {
  const t = tiff();
  const app1 = cat(new Uint8Array([0xff, 0xe1]), u16(2 + 6 + t.length), enc.encode('Exif\0\0'), t);
  const app0 = cat(new Uint8Array([0xff, 0xe0]), u16(16), enc.encode('JFIF\0'), new Uint8Array(9));
  const jpeg = cat(new Uint8Array([0xff, 0xd8]), app0, app1, new Uint8Array([0xff, 0xda, 0, 2]), new Uint8Array(1000));
  const r = await readJpegExif(new BufferReader(jpeg));
  assert.equal(r.dateTimeOriginal, '2025:07:12 20:00:00');
  const cap = exifToCapture(r);
  assert.equal(cap.offsetMinutes, 540);
  assert.deepEqual(cap.wall, { y: 2025, mo: 7, d: 12, h: 20, mi: 0, s: 0, ms: 0 });
  const info = await extractCaptureInfo(new BufferReader(jpeg), 'image/jpeg');
  assert.equal(info.model, 'Canon EOS R6');
  // EXIF なし JPEG
  const plain = cat(new Uint8Array([0xff, 0xd8]), app0, new Uint8Array([0xff, 0xda, 0, 2]));
  assert.equal(await readJpegExif(new BufferReader(plain)), null);
  assert.equal(await readJpegExif(new BufferReader(enc.encode('PNG....'))), null);
});

test('readHeifExif via iinf/iloc', async () => {
  const t = tiff({ dto: '2025:07:13 08:15:00', oto: '+03:00', make: 'Apple', model: 'iPhone 15' });
  const exifData = cat(u32(6), enc.encode('Exif\0\0'), t);
  const ftyp = box('ftyp', enc.encode('heic'), u32(0), enc.encode('mif1heic'));
  const infe1 = box('infe', new Uint8Array([2, 0, 0, 0]), u16(1), u16(0), enc.encode('hvc1'), new Uint8Array([0]));
  const infe2 = box('infe', new Uint8Array([2, 0, 0, 0]), u16(2), u16(0), enc.encode('Exif'), new Uint8Array([0]));
  const iinf = box('iinf', new Uint8Array([0, 0, 0, 0]), u16(2), infe1, infe2);
  const hdlr = box('hdlr', new Uint8Array(8), enc.encode('pict'), new Uint8Array(13));
  // iloc v1: offset_size=4,length_size=4, base_offset_size=0,index_size=0
  const makeIloc = (exifOffset) =>
    box(
      'iloc',
      new Uint8Array([1, 0, 0, 0]),
      new Uint8Array([0x44, 0x00]),
      u16(2),
      cat(u16(1), u16(0), u16(0), u16(1), u32(0), u32(10)),
      cat(u16(2), u16(0), u16(0), u16(1), u32(exifOffset), u32(exifData.length)),
    );
  let meta = box('meta', new Uint8Array(4), hdlr, iinf, makeIloc(0));
  const exifOffset = ftyp.length + meta.length + 8; // mdat header
  meta = box('meta', new Uint8Array(4), hdlr, iinf, makeIloc(exifOffset));
  const file = cat(ftyp, meta, box('mdat', exifData, new Uint8Array(10)));
  const r = await readHeifExif(new BufferReader(file));
  assert.equal(r.dateTimeOriginal, '2025:07:13 08:15:00');
  assert.equal(r.model, 'iPhone 15');
  const info = await extractCaptureInfo(new BufferReader(file), 'image/heic');
  assert.equal(info.offsetMinutes, 180);
});

test('RangeReader caches blocks and handles servers that ignore Range', async () => {
  const data = new Uint8Array(10000).map((_, i) => i & 255);
  let calls = 0;
  const rr = new RangeReader(async (s, e) => {
    calls++;
    return data.slice(s, e + 1).buffer;
  }, data.length, { blockSize: 1000 });
  const a = await rr.read(1500, 1000);
  assert.deepEqual([...a.slice(0, 3)], [1500 & 255, 1501 & 255, 1502 & 255]);
  assert.equal(a.length, 1000);
  await rr.read(1600, 10);
  assert.equal(calls, 2);
  const tail = await rr.read(9990, 100);
  assert.equal(tail.length, 10);

  const ignoring = new RangeReader(async () => data.slice().buffer, data.length, { blockSize: 1000 });
  const b = await ignoring.read(5000, 10);
  assert.equal(b[0], 5000 & 255);
  const c = await ignoring.read(0, 4);
  assert.deepEqual([...c], [0, 1, 2, 3]);
});

test('RangeReader enforces maxBytes', async () => {
  const rr = new RangeReader(async (s, e) => new Uint8Array(e - s + 1).buffer, 1e9, { blockSize: 1000, maxBytes: 3000 });
  await rr.read(0, 3000);
  await assert.rejects(rr.read(5000, 10));
});
