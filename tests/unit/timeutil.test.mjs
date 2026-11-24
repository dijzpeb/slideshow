import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wallClockToEpoch,
  tzOffsetMs,
  parseExifDateTime,
  parseUtcOffset,
  parseIsoDateTime,
  parseFilenameTime,
  dayKey,
  formatDateJa,
  formatDateTimeJa,
  daysBetween,
  isValidTimeZone,
  formatOffset,
} from '../../js/timeutil.js';

const HEL = 'Europe/Helsinki';

test('tzOffsetMs: Helsinki summer is UTC+3, winter UTC+2', () => {
  assert.equal(tzOffsetMs(Date.UTC(2025, 6, 12, 12), HEL), 3 * 3600e3);
  assert.equal(tzOffsetMs(Date.UTC(2025, 0, 12, 12), HEL), 2 * 3600e3);
  assert.equal(tzOffsetMs(Date.UTC(2025, 6, 12, 12), 'Asia/Tokyo'), 9 * 3600e3);
  assert.equal(tzOffsetMs(Date.UTC(2025, 6, 12, 12), 'UTC'), 0);
});

test('wallClockToEpoch converts Helsinki wall clock to the right instant', () => {
  const w = { y: 2025, mo: 7, d: 12, h: 14, mi: 30, s: 0 };
  assert.equal(new Date(wallClockToEpoch(w, HEL)).toISOString(), '2025-07-12T11:30:00.000Z');
  const wWinter = { y: 2025, mo: 12, d: 24, h: 18, mi: 0, s: 0 };
  assert.equal(new Date(wallClockToEpoch(wWinter, HEL)).toISOString(), '2025-12-24T16:00:00.000Z');
  assert.equal(new Date(wallClockToEpoch(w, 'Asia/Tokyo')).toISOString(), '2025-07-12T05:30:00.000Z');
  assert.equal(new Date(wallClockToEpoch({ ...w, ms: 250 }, HEL)).toISOString(), '2025-07-12T11:30:00.250Z');
});

test('wallClockToEpoch handles DST transitions (Helsinki 2025-03-30 03:00→04:00, 2025-10-26 04:00→03:00)', () => {
  // 存在しない時刻 03:30 → 前のオフセット（UTC+2）で解釈 = 01:30Z
  const gap = wallClockToEpoch({ y: 2025, mo: 3, d: 30, h: 3, mi: 30 }, HEL);
  assert.ok([Date.UTC(2025, 2, 30, 1, 30), Date.UTC(2025, 2, 30, 0, 30)].includes(gap), new Date(gap).toISOString());
  // 重複する時刻 03:30 → 早い方（夏時間 UTC+3）= 00:30Z
  const overlap = wallClockToEpoch({ y: 2025, mo: 10, d: 26, h: 3, mi: 30 }, HEL);
  assert.equal(new Date(overlap).toISOString(), '2025-10-26T00:30:00.000Z');
  // 前後の普通の時刻
  assert.equal(new Date(wallClockToEpoch({ y: 2025, mo: 3, d: 30, h: 2, mi: 30 }, HEL)).toISOString(), '2025-03-30T00:30:00.000Z');
  assert.equal(new Date(wallClockToEpoch({ y: 2025, mo: 3, d: 30, h: 4, mi: 30 }, HEL)).toISOString(), '2025-03-30T01:30:00.000Z');
});

test('parseExifDateTime', () => {
  assert.deepEqual(parseExifDateTime('2025:07:12 14:30:05'), { y: 2025, mo: 7, d: 12, h: 14, mi: 30, s: 5, ms: 0 });
  assert.deepEqual(parseExifDateTime('2025-07-12 14:30:05.123'), { y: 2025, mo: 7, d: 12, h: 14, mi: 30, s: 5, ms: 123 });
  assert.deepEqual(parseExifDateTime('2025:07:12 14:30:05\u0000'), { y: 2025, mo: 7, d: 12, h: 14, mi: 30, s: 5, ms: 0 });
  assert.equal(parseExifDateTime('0000:00:00 00:00:00'), null);
  assert.equal(parseExifDateTime('    :  :     :  :  '), null);
  assert.equal(parseExifDateTime(''), null);
  assert.equal(parseExifDateTime(undefined), null);
  assert.equal(parseExifDateTime('2025:02:30 10:00:00'), null);
});

test('parseUtcOffset', () => {
  assert.equal(parseUtcOffset('+03:00'), 180);
  assert.equal(parseUtcOffset('-05:30'), -330);
  assert.equal(parseUtcOffset('+0900'), 540);
  assert.equal(parseUtcOffset('Z'), 0);
  assert.equal(parseUtcOffset('garbage'), null);
  assert.equal(parseUtcOffset(''), null);
});

test('parseIsoDateTime', () => {
  const a = parseIsoDateTime('2025-07-13T21:10:00+0300');
  assert.equal(new Date(a.epoch).toISOString(), '2025-07-13T18:10:00.000Z');
  assert.equal(a.offsetMinutes, 180);
  const b = parseIsoDateTime('2025-07-13T18:10:00Z');
  assert.equal(new Date(b.epoch).toISOString(), '2025-07-13T18:10:00.000Z');
  const c = parseIsoDateTime('2025-07-13T21:10:00');
  assert.equal(c.epoch, null);
  assert.equal(c.offsetMinutes, null);
  const d = parseIsoDateTime('2025-07-13 21:10:00 +03:00');
  assert.equal(new Date(d.epoch).toISOString(), '2025-07-13T18:10:00.000Z');
  assert.equal(parseIsoDateTime('not a date'), null);
});

test('parseFilenameTime: common phone patterns', () => {
  const px = parseFilenameTime('PXL_20250714_063000123.mp4');
  assert.equal(px.utc, true);
  assert.deepEqual(px.wall, { y: 2025, mo: 7, d: 14, h: 6, mi: 30, s: 0, ms: 123 });
  const pxNight = parseFilenameTime('PXL_20250714_063000123.NIGHT.jpg');
  assert.equal(pxNight.utc, true);

  for (const name of ['IMG_20250712_143000.jpg', 'VID_20250712_143000.mp4', '20250712_143000.jpg', 'Screenshot_20250712-143000.png', 'PANO_20250712_143000.jpg', 'IMG20250712143000.jpg']) {
    const r = parseFilenameTime(name);
    assert.ok(r, name);
    assert.equal(r.utc, false, name);
    assert.deepEqual(r.wall, { y: 2025, mo: 7, d: 12, h: 14, mi: 30, s: 0, ms: 0 }, name);
  }
  const dropbox = parseFilenameTime('2025-07-12 14.30.00.jpg');
  assert.deepEqual(dropbox.wall, { y: 2025, mo: 7, d: 12, h: 14, mi: 30, s: 0, ms: 0 });
  const mac = parseFilenameTime('Screenshot 2025-07-12 at 2.30.00 PM.png');
  assert.equal(mac.wall.h, 14);
  const wa = parseFilenameTime('IMG-20250712-WA0003.jpg');
  assert.equal(wa.pattern, 'date-only');
  assert.equal(parseFilenameTime('IMG_1234.JPG'), null);
  assert.equal(parseFilenameTime('sauna.jpg'), null);
  assert.equal(parseFilenameTime('20251399_999999.jpg'), null);
});

test('dayKey / formatting', () => {
  const t = Date.UTC(2025, 6, 12, 22, 30); // Helsinki 01:30 on 7/13
  assert.equal(dayKey(t, HEL), '2025-07-13');
  assert.equal(dayKey(t, 'UTC'), '2025-07-12');
  assert.equal(formatDateJa(t, HEL), '2025年7月13日（日）');
  assert.equal(formatDateTimeJa(t, HEL), '7月13日（日） 01:30');
  assert.equal(daysBetween('2025-07-12', '2025-07-15'), 3);
  assert.equal(formatOffset(3 * 3600e3), 'UTC+3');
  assert.equal(formatOffset(5.5 * 3600e3), 'UTC+5:30');
});

test('isValidTimeZone', () => {
  assert.equal(isValidTimeZone('Europe/Helsinki'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(isValidTimeZone(''), false);
});
