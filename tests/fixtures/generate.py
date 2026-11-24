#!/usr/bin/env python3
"""Generate the media fixtures and manifest.json used by the slideshow E2E tests.

Usage:
    python3 tests/fixtures/generate.py [--out tests/fixtures/out] [--force] [--clean]

The output directory (default: tests/fixtures/out next to this script) receives

    files/<parentFolderId>/<name>   the media / binary files served by the mock Drive
    thumbs/<id>_s220.jpg            pre-generated thumbnails (max side 220)
    thumbs/<id>_s1024.jpg           pre-generated thumbnails (max side 1024)
    manifest.json                   Drive v3 File resources + "_test" oracle data
    .cache.json                     spec hashes (skip re-encoding unchanged files)

The script is idempotent: media whose spec did not change are not re-encoded, the
manifest is always rebuilt from the bytes on disk, and every oracle value is
re-derived from the generated files (independent EXIF / MP4 box parsing + ffprobe)
and asserted before manifest.json is written.

Requirements: python3 (3.9+), Pillow, pillow_heif, ffmpeg + ffprobe (libx264, libx265, aac).
"""
from __future__ import annotations

import argparse
import colorsys
import hashlib
import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFont, ImageOps

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:  # pragma: no cover
    sys.exit('pillow_heif is required: pip3 install pillow-heif')

GEN_VERSION = 4
HERE = Path(__file__).resolve().parent
# any edit to this script invalidates the cache (a full rebuild only takes a few seconds)
SCRIPT_HASH = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:16]
DEFAULT_OUT = HERE / 'out'

TRIP_TZ_NAME = 'Europe/Helsinki'
HEL = ZoneInfo(TRIP_TZ_NAME)
UTC = timezone.utc
TRIP_DAY1 = datetime(2025, 7, 12).date()

MYDRIVE = 'mydrive_root'  # pseudo id of "My Drive" (not served as an item)
ROOT = 'folder_root'
MIME_FOLDER = 'application/vnd.google-apps.folder'
MIME_SHORTCUT = 'application/vnd.google-apps.shortcut'
MIME_GDOC = 'application/vnd.google-apps.document'

CANON_MODEL = 'Canon EOS R6'
CANON_FIX_MINUTES = -360  # per-camera offset that fixes the Canon (clock left on JST)

UPLOAD_BASE = datetime(2025, 7, 16, 18, 0, 0, tzinfo=UTC)  # bulk upload after the trip
HIDDEN_UPLOAD_BASE = datetime(2025, 7, 18, 9, 0, 0, tzinfo=UTC)  # "added later"

CAMERAS = {
    'iphone15': ('Apple', 'iPhone 15', '17.5.1'),
    'iphone15pro': ('Apple', 'iPhone 15 Pro', '17.5.1'),
    'iphone14': ('Apple', 'iPhone 14', '17.4'),
    'canon': ('Canon', CANON_MODEL, 'Firmware Version 1.8.2'),
    'sony': ('SONY', 'ILCE-7M4', 'ILCE-7M4 v3.01'),
    'pixel8': ('Google', 'Pixel 8', 'HDR+ 1.0.641377693'),
}

# --------------------------------------------------------------------------------------
# Fixture plan
# --------------------------------------------------------------------------------------
# Folders. "public" means "anyone with the link" (API-key access allowed). Children
# inherit the effective public flag of their parent unless they override it.
FOLDERS = [
    dict(id=ROOT, name='フィンランド旅行 2025', parent=MYDRIVE, public=True),
    dict(id='folder_day1', name='Day1 Helsinki', parent=ROOT),
    dict(id='folder_day2', name='Day2 Rovaniemi', parent=ROOT),
    dict(id='folder_day3', name='Day3 Lapland', parent=ROOT),
    dict(id='folder_aurora', name='Aurora', parent='folder_day3'),
    dict(id='folder_day4', name='Day4 Porvoo', parent=ROOT),
    dict(id='folder_other', name="Friend's photos", parent=MYDRIVE, public=False),
    dict(id='folder_extra', name='Extra (shared)', parent=MYDRIVE, public=True),
    dict(id='folder_private', name='Private trip', parent=MYDRIVE, public=False),
    dict(id='folder_reskey', name='Old shared folder', parent=MYDRIVE, public=True,
         resourceKey='0-ABCdef'),
    dict(id='folder_big', name='Big folder (pagination)', parent=MYDRIVE, public=True),
]


def photo(id, name, parent, local, title, camera=None, fmt='jpeg', skew=0, offset_tag=None,
          drive_time=True, orientation=1, gps=None, hidden=False, trashed=False, public=None,
          resource_key=None, jfif=False, size=(1280, 853), created=None, modified=None):
    """A still image. `local` is the TRUE Helsinki wall clock of the capture.

    skew:       minutes the camera clock is ahead of Helsinki (EXIF wall clock = local + skew)
    offset_tag: EXIF OffsetTimeOriginal written into the file (None = not written)
    drive_time: whether Drive's imageMediaMetadata.time is present (False = "not processed")
    camera=None means: no EXIF at all.
    """
    return dict(kind='photo', id=id, name=name, parent=parent, local=local, title=title,
                camera=camera, fmt=fmt, skew=skew, offset_tag=offset_tag, drive_time=drive_time,
                orientation=orientation, gps=gps, hidden=hidden, trashed=trashed, public=public,
                resource_key=resource_key, jfif=jfif, size=size, created=created,
                modified=modified)


def video(id, name, parent, local, title, container='mp4', codec='h264', duration=3,
          faststart=False, mvhd='true', apple=None, hidden=False, public=None, created=None,
          modified=None):
    """A video. mvhd: 'true' = mvhd creation_time is the true instant (UTC), 'none' = 0,
    or an explicit ISO string. apple: com.apple.quicktime.creationdate value (moov/meta)."""
    return dict(kind='video', id=id, name=name, parent=parent, local=local, title=title,
                container=container, codec=codec, duration=duration, faststart=faststart,
                mvhd=mvhd, apple=apple, hidden=hidden, trashed=False, public=public,
                resource_key=None, created=created, modified=modified)


MEDIA = [
    # ---------------- Day 1 (2025-07-12, Helsinki) ----------------
    photo('img_senate_square', 'IMG_1203.JPG', 'folder_day1', '2025-07-12 12:05:00',
          'Senate Square', 'iphone15', offset_tag='+03:00'),
    photo('img_helsinki_cathedral', 'IMG_1207.JPG', 'folder_day1', '2025-07-12 12:20:00',
          'Helsinki Cathedral', 'iphone15', offset_tag='+03:00', orientation=6),
    video('vid_harbour_ferry', 'harbour_ferry.mp4', 'folder_day1', '2025-07-12 13:30:00',
          'Harbour ferry', faststart=True, duration=3),
    photo('img_market_square_canon', '_MG_2041.JPG', 'folder_day1', '2025-07-12 14:10:00',
          'Market Square', 'canon', skew=360),
    photo('img_suomenlinna_gps', 'IMG_1240.JPG', 'folder_day1', '2025-07-12 16:00:00',
          'Suomenlinna', 'iphone15', offset_tag='+03:00', gps=(60.145400, 24.988100, 12.0)),
    photo('img_trashed', 'IMG_1250.JPG', 'folder_day1', '2025-07-12 17:00:00',
          'Blurry (trashed)', 'iphone15', trashed=True),
    video('vid_tram', 'VID_20250712_183000.mp4', 'folder_day1', '2025-07-12 18:30:00',
          'Tram ride', faststart=False, duration=3),
    photo('img_sauna', 'sauna.jpg', 'folder_day1', '2025-07-12 21:40:00', 'Sauna', None,
          drive_time=False, modified='TRUE', created='2025-07-19T07:45:12.000Z'),
    # ---------------- Day 2 (2025-07-13, Rovaniemi) ----------------
    photo('img_screenshot', 'Screenshot_20250713-101500.png', 'folder_day2',
          '2025-07-13 10:15:00', 'Train ticket', None, fmt='png', size=(720, 1280),
          drive_time=False),
    photo('img_exif_range', 'IMG_1310.JPG', 'folder_day2', '2025-07-13 11:30:00',
          'Rovaniemi station', 'iphone15', offset_tag='+03:00', drive_time=False),
    photo('img_hidden_rovaniemi', 'IMG_1315.JPG', 'folder_day2', '2025-07-13 12:40:00',
          'Lunch (added later)', 'iphone15', offset_tag='+03:00', hidden=True),
    photo('img_sony_offset', 'DSC01234.JPG', 'folder_day2', '2025-07-13 13:05:00',
          'Kemijoki river', 'sony', skew=360, offset_tag='+09:00', drive_time=False),
    photo('img_arctic_circle_heic', 'IMG_1322.HEIC', 'folder_day2', '2025-07-13 14:45:00',
          'Arctic Circle', 'iphone15pro', fmt='heic', offset_tag='+03:00'),
    photo('img_santa_canon', '_MG_2107.JPG', 'folder_day2', '2025-07-13 16:20:00',
          'Santa Claus Village', 'canon', skew=360),
    video('vid_hevc', 'drone_hevc.mp4', 'folder_day2', '2025-07-13 19:55:00', 'Drone (HEVC)',
          codec='hevc', faststart=True, duration=3),
    video('vid_reindeer_mov', 'IMG_4321.MOV', 'folder_day2', '2025-07-13 21:10:00', 'Reindeer',
          container='mov', mvhd='2025-07-16T08:00:00Z', apple='2025-07-13T21:10:00+0300',
          duration=3),
    # ---------------- Day 3 (2025-07-14, Lapland) ----------------
    photo('img_breakfast', 'IMG_1401.JPG', 'folder_day3', '2025-07-14 08:45:00', 'Breakfast',
          'iphone15', offset_tag='+03:00'),
    video('vid_pxl_husky', 'PXL_20250714_063000123.mp4', 'folder_day3',
          '2025-07-14 09:30:00.123', 'Husky ride', mvhd='none', duration=2),
    photo('img_lake', 'IMG_1410.JPG', 'folder_day3', '2025-07-14 11:00:00', 'Lake Inari',
          'iphone15', offset_tag='+03:00'),
    photo('img_hidden_lapland', 'IMG_1415.JPG', 'folder_day3', '2025-07-14 13:15:00',
          'Cloudberries (added later)', 'iphone15', offset_tag='+03:00', hidden=True),
    video('vid_long_walk', 'long_walk.mp4', 'folder_day3', '2025-07-14 14:30:00',
          'Forest walk (8 s)', duration=8),
    photo('img_aurora_1', 'IMG_1450.JPG', 'folder_aurora', '2025-07-14 23:40:00',
          'Midnight sky 1', 'iphone15', offset_tag='+03:00'),
    photo('img_aurora_canon', '_MG_2203.JPG', 'folder_aurora', '2025-07-14 23:55:00',
          'Midnight sky (Canon)', 'canon', skew=360),
    photo('img_aurora_2', 'IMG_1452.JPG', 'folder_aurora', '2025-07-15 00:30:00',
          'Midnight sky 2', 'iphone15', offset_tag='+03:00'),
    # ---------------- Day 4 (2025-07-15, Porvoo) + shortcut targets ----------------
    photo('img_other_kauppatori', 'IMG_5001.JPG', 'folder_other', '2025-07-15 10:15:00',
          'Kauppatori (via shortcut)', 'iphone14', offset_tag='+03:00', public=True,
          created='2025-07-15T19:30:00.000Z'),
    photo('img_porvoo', 'IMG_1480.JPG', 'folder_day4', '2025-07-15 11:30:00',
          'Porvoo old town', 'iphone15', offset_tag='+03:00'),
    photo('img_extra_porvoo', 'PXL_20250715_100000000.jpg', 'folder_extra',
          '2025-07-15 13:00:00', 'Porvoo river (shortcut folder)', 'pixel8',
          offset_tag='+03:00', jfif=True, created='2025-07-15T20:30:00.000Z'),
    photo('img_airport', 'IMG_1501.JPG', 'folder_day4', '2025-07-15 16:45:00',
          'Helsinki Airport', 'iphone15', offset_tag='+03:00'),
    # ---------------- outside the trip tree ----------------
    photo('img_private_1', 'IMG_2001.JPG', 'folder_private', '2025-07-16 10:00:00',
          'Private A', 'iphone15', offset_tag='+03:00'),
    photo('img_private_2', 'IMG_2002.JPG', 'folder_private', '2025-07-16 09:00:00',
          'Private B', 'iphone15', offset_tag='+03:00'),
    photo('img_reskey_1', 'old_photo_a.jpg', 'folder_reskey', '2024-02-10 12:00:00',
          'Old photo A', 'iphone14', resource_key='0-imgAkey1'),
    photo('img_reskey_2', 'old_photo_b.jpg', 'folder_reskey', '2024-02-10 11:00:00',
          'Old photo B', 'iphone14', resource_key='0-imgBkey2'),
]

OTHER_ITEMS = [
    dict(kind='text', id='txt_notes', name='notes.txt', parent=ROOT,
         content='Finland trip 2025 notes\n- Helsinki 12.7.\n- Rovaniemi 13.7.\n'
                 '- Lapland 14.7.\n- Porvoo 15.7.\nこのファイルはスライドショーに表示されない。\n'),
    dict(kind='gdoc', id='doc_itinerary', name='旅程表 (itinerary)', parent=ROOT),
    dict(kind='shortcut', id='sc_img_other', name='IMG_5001.JPG', parent=ROOT,
         target='img_other_kauppatori'),
    dict(kind='shortcut', id='sc_folder_extra', name='Extra (shared)', parent=ROOT,
         target='folder_extra'),
]

BIG_COUNT = 120
BIG_BASE_LOCAL = datetime(2025, 7, 20, 8, 0, 0)


def big_items():
    out = []
    for i in range(BIG_COUNT):
        slot = (i * 37) % BIG_COUNT  # deterministic shuffle: name order != time order
        local = BIG_BASE_LOCAL + timedelta(minutes=3 * slot)
        out.append(photo(f'big_{i + 1:03d}', f'big_{i + 1:03d}.jpg', 'folder_big',
                         local.strftime('%Y-%m-%d %H:%M:%S'), f'#{i + 1:03d}', 'iphone15',
                         offset_tag='+03:00', size=(64, 48)))
    return out


# --------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------

def parse_local(s: str) -> datetime:
    fmt = '%Y-%m-%d %H:%M:%S.%f' if '.' in s else '%Y-%m-%d %H:%M:%S'
    return datetime.strptime(s, fmt)


def hel_to_utc(naive: datetime) -> datetime:
    return naive.replace(tzinfo=HEL).astimezone(UTC)


def iso_ms(dt: datetime) -> str:
    dt = dt.astimezone(UTC)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def parse_iso(s: str) -> datetime:
    s = s.strip()
    if s.endswith('Z'):
        s = s[:-1] + '+00:00'
    m = re.match(r'^(.*[T ]\d\d:\d\d:\d\d(?:\.\d+)?)([+-])(\d\d):?(\d\d)$', s)
    if m:
        s = f'{m.group(1)}{m.group(2)}{m.group(3)}:{m.group(4)}'
    return datetime.fromisoformat(s).astimezone(UTC)


def exif_wall(naive: datetime) -> str:
    return naive.strftime('%Y:%m:%d %H:%M:%S')


def label_for(local: datetime, title: str) -> str:
    day = (local.date() - TRIP_DAY1).days + 1
    if 1 <= day <= 4:
        return f'Day{day} {local:%H:%M} {title}'
    return f'{local:%Y-%m-%d %H:%M} {title}'


def sha256_json(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        raise RuntimeError(f'command failed ({r.returncode}): {" ".join(map(str, cmd))}\n'
                           f'{r.stderr[-3000:]}')
    return r.stdout


# --------------------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------------------
FONT_CANDIDATES = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    'C:/Windows/Fonts/arialbd.ttf',
]
FONT_PATH = next((p for p in FONT_CANDIDATES if os.path.exists(p)), None)


def font(size: int):
    if FONT_PATH:
        return ImageFont.truetype(FONT_PATH, size)
    return ImageFont.load_default(size=size)


def text_color(bg):
    r, g, b = bg
    return (0, 0, 0) if (0.299 * r + 0.587 * g + 0.114 * b) > 150 else (255, 255, 255)


def render_card(w, h, bg, lines, footer=None):
    """Solid background + centred text. The outer 10 % margin stays pure `bg` so tests can
    sample the corner colour to identify which item is on screen."""
    img = Image.new('RGB', (w, h), bg)
    d = ImageDraw.Draw(img)
    fg = text_color(bg)
    max_w = int(w * 0.8)
    rendered = []
    for text, rel in lines:
        size = max(8, int(min(w, h * 1.5) * rel))
        while True:
            f = font(size)
            bbox = d.textbbox((0, 0), text, font=f)
            if bbox[2] - bbox[0] <= max_w or size <= 8:
                break
            size = int(size * 0.92)
        rendered.append((text, f, bbox))
    gap = int(h * 0.03)
    total = sum(b[3] - b[1] for _, _, b in rendered) + gap * (len(rendered) - 1)
    y = (h - total) // 2
    for text, f, bbox in rendered:
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        d.text(((w - tw) // 2 - bbox[0], y - bbox[1]), text, font=f, fill=fg)
        y += th + gap
    if footer:
        f = font(max(8, int(h * 0.03)))
        bbox = d.textbbox((0, 0), footer, font=f)
        d.text(((w - (bbox[2] - bbox[0])) // 2, int(h * 0.84)), footer, font=f, fill=fg)
    return img


def make_palette(n):
    """Greedy max-min selection from a 6x6x6 RGB grid (deterministic). Very dark / very
    light colours are excluded so a slide is never confused with the page background."""
    levels = (0, 51, 102, 153, 204, 255)
    cands = [(r, g, b) for r in levels for g in levels for b in levels
             if 45 <= 0.299 * r + 0.587 * g + 0.114 * b <= 215]
    chosen = [(204, 51, 51)]
    while len(chosen) < n:
        best = max(cands, key=lambda c: min(color_dist(c, x) for x in chosen))
        chosen.append(best)
    return chosen


def color_dist(a, b):
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5


def hexcolor(c):
    return '#%02x%02x%02x' % c


# --------------------------------------------------------------------------------------
# EXIF writing + independent EXIF reading
# --------------------------------------------------------------------------------------

def to_dms(value):
    value = abs(value)
    d = int(value)
    m = int((value - d) * 60)
    s = round((value - d - m / 60) * 3600, 4)
    return (float(d), float(m), float(s))


def build_exif(cam_key, wall: datetime, offset_tag, orientation, size, gps):
    make, model, software = CAMERAS[cam_key]
    ws = exif_wall(wall)
    ex = Image.Exif()
    ex[0x010F] = make
    ex[0x0110] = model
    ex[0x0112] = orientation
    ex[0x0131] = software
    ex[0x0132] = ws
    sub = ex.get_ifd(0x8769)
    sub[0x9000] = b'0232'
    sub[0x9003] = ws  # DateTimeOriginal
    sub[0x9004] = ws  # DateTimeDigitized
    if offset_tag:
        sub[0x9010] = offset_tag
        sub[0x9011] = offset_tag  # OffsetTimeOriginal
        sub[0x9012] = offset_tag
    sub[0xA002] = size[0]
    sub[0xA003] = size[1]
    if gps:
        lat, lon, alt = gps
        g = ex.get_ifd(0x8825)
        g[0x0000] = b'\x02\x02\x00\x00'
        g[0x0001] = 'N' if lat >= 0 else 'S'
        g[0x0002] = to_dms(lat)
        g[0x0003] = 'E' if lon >= 0 else 'W'
        g[0x0004] = to_dms(lon)
        g[0x0005] = b'\x00'
        g[0x0006] = float(alt)
    return ex.tobytes()


def strip_app0(data: bytes) -> bytes:
    """Remove the JFIF APP0 segment Pillow always writes (phones/cameras put Exif first)."""
    assert data[:2] == b'\xff\xd8'
    if data[2:4] == b'\xff\xe0':
        seg_len = struct.unpack('>H', data[4:6])[0]
        return data[:2] + data[4 + seg_len:]
    return data


def read_exif_head(head: bytes):
    """Minimal independent EXIF reader working on the first bytes of a JPEG only
    (what the app gets from a Range request). Returns dict or None."""
    if head[:2] != b'\xff\xd8':
        return None
    i = 2
    while i + 4 <= len(head):
        if head[i] != 0xFF:
            return None
        marker = head[i + 1]
        if marker in (0xD9, 0xDA):
            return None
        seg_len = struct.unpack('>H', head[i + 2:i + 4])[0]
        seg_end = i + 2 + seg_len
        if marker == 0xE1 and head[i + 4:i + 10] == b'Exif\x00\x00':
            if seg_end > len(head):
                raise AssertionError('EXIF APP1 not contained in the head bytes')
            return parse_tiff(head[i + 10:seg_end], app1_offset=i, app1_end=seg_end)
        i = seg_end
    return None


def parse_tiff(t: bytes, app1_offset=0, app1_end=0):
    bo = t[:2]
    e = '<' if bo == b'II' else '>'
    assert struct.unpack(e + 'H', t[2:4])[0] == 42

    def ifd(off):
        n = struct.unpack(e + 'H', t[off:off + 2])[0]
        entries = {}
        for k in range(n):
            p = off + 2 + 12 * k
            tag, typ, cnt = struct.unpack(e + 'HHI', t[p:p + 8])
            size = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 12: 8}.get(typ, 1) * cnt
            raw = t[p + 8:p + 12] if size <= 4 else t[struct.unpack(e + 'I', t[p + 8:p + 12])[0]:][:size]
            if typ == 2:
                val = raw[:cnt].split(b'\x00')[0].decode('ascii', 'replace')
            elif typ == 3:
                val = struct.unpack(e + 'H', raw[:2])[0]
            elif typ == 4:
                val = struct.unpack(e + 'I', raw[:4])[0]
            else:
                val = raw
            entries[tag] = val
        return entries

    ifd0 = ifd(struct.unpack(e + 'I', t[4:8])[0])
    sub = ifd(ifd0[0x8769]) if 0x8769 in ifd0 else {}
    return dict(make=ifd0.get(0x010F), model=ifd0.get(0x0110), orientation=ifd0.get(0x0112, 1),
                dateTimeOriginal=sub.get(0x9003), offsetTimeOriginal=sub.get(0x9011),
                hasGps=0x8825 in ifd0, app1Offset=app1_offset, app1End=app1_end,
                byteOrder=bo.decode())


# --------------------------------------------------------------------------------------
# MP4 / QuickTime box helpers (writing tweaks + independent parsing)
# --------------------------------------------------------------------------------------
MAC_EPOCH = datetime(1904, 1, 1, tzinfo=UTC)


def iter_boxes(data, start, end):
    i = start
    while i + 8 <= end:
        size, typ = struct.unpack('>I4s', data[i:i + 8])
        hdr = 8
        if size == 1:
            size = struct.unpack('>Q', data[i + 8:i + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - i
        if size < hdr:
            break
        yield typ.decode('latin1'), i, i + hdr, i + size
        i += size


def box(typ: str, payload: bytes) -> bytes:
    return struct.pack('>I4s', 8 + len(payload), typ.encode('latin1')) + payload


def find_child(data, start, end, typ):
    for t, s, p, e in iter_boxes(data, start, end):
        if t == typ:
            return s, p, e
    return None


def parse_mp4(data: bytes):
    """Independent parser: top-level layout, mvhd creation_time, QuickTime mdta keys."""
    top = [(t, s, e) for t, s, p, e in iter_boxes(data, 0, len(data))]
    info = dict(topLevel=[t for t, _, _ in top], mvhdCreation=None, mvhdCreationRaw=None,
                appleCreationDate=None, mdtaKeys={}, moovOffset=None, moovAtEnd=None,
                metaLocation=None)
    moov = find_child(data, 0, len(data), 'moov')
    mdat = find_child(data, 0, len(data), 'mdat')
    if not moov:
        return info
    ms, mp, me = moov
    info['moovOffset'] = ms
    info['moovAtEnd'] = bool(mdat and mdat[0] < ms)
    mvhd = find_child(data, mp, me, 'mvhd')
    if mvhd:
        _, pp, _ = mvhd
        ver = data[pp]
        raw = struct.unpack('>Q', data[pp + 4:pp + 12])[0] if ver == 1 else \
            struct.unpack('>I', data[pp + 4:pp + 8])[0]
        info['mvhdCreationRaw'] = raw
        info['mvhdCreation'] = iso_ms(MAC_EPOCH + timedelta(seconds=raw)) if raw else None
    metas = []
    m = find_child(data, mp, me, 'meta')
    if m:
        metas.append(('moov/meta', m))
    udta = find_child(data, mp, me, 'udta')
    if udta:
        m2 = find_child(data, udta[1], udta[2], 'meta')
        if m2:
            metas.append(('moov/udta/meta', m2))
    for where, (s, p, e) in metas:
        # QuickTime 'meta' has no version/flags; ISO 'meta' is a full box (+4 bytes)
        q = p
        if data[p + 4:p + 8] not in (b'hdlr', b'keys', b'ilst'):
            q = p + 4
        keys_box = find_child(data, q, e, 'keys')
        ilst_box = find_child(data, q, e, 'ilst')
        if not keys_box or not ilst_box:
            continue
        _, kp, ke = keys_box
        n = struct.unpack('>I', data[kp + 4:kp + 8])[0]
        k, names = kp + 8, []
        for _ in range(n):
            ksize = struct.unpack('>I', data[k:k + 4])[0]
            names.append(data[k + 8:k + ksize].decode('utf-8'))
            k += ksize
        for t, s2, p2, e2 in iter_boxes(data, ilst_box[1], ilst_box[2]):
            idx = struct.unpack('>I', t.encode('latin1'))[0]
            d = find_child(data, p2, e2, 'data')
            if d and 1 <= idx <= len(names):
                info['mdtaKeys'][names[idx - 1]] = data[d[1] + 8:d[2]].decode('utf-8', 'replace')
        info['metaLocation'] = where
    info['appleCreationDate'] = info['mdtaKeys'].get('com.apple.quicktime.creationdate')
    return info


def iphone_style_mov(data: bytes, mvhd_time: datetime | None) -> bytes:
    """Post-process an ffmpeg QuickTime file to look like an iPhone MOV:
    move udta/meta (hdlr=mdta, keys, ilst) to moov/meta and set mvhd/tkhd/mdhd
    creation+modification times. Requires moov after mdat (no stco fix-ups needed)."""
    moov = find_child(data, 0, len(data), 'moov')
    mdat = find_child(data, 0, len(data), 'mdat')
    assert moov and mdat and mdat[0] < moov[0], 'moov must be at the end'
    ms, mp, me = moov
    secs = int((mvhd_time - MAC_EPOCH).total_seconds()) if mvhd_time else 0

    def patch_times(buf: bytearray, s, e, typ):
        for t, bs, bp, be in iter_boxes(buf, s, e):
            if t == typ and buf[bp] == 0:
                struct.pack_into('>II', buf, bp + 4, secs, secs)
            if t in ('trak', 'mdia'):
                patch_times(buf, bp, be, typ)

    children, meta_bytes = [], None
    for t, s, p, e in iter_boxes(data, mp, me):
        if t == 'udta':
            kept = []
            for t2, s2, p2, e2 in iter_boxes(data, p, e):
                if t2 == 'meta':
                    meta_bytes = data[s2:e2]
                else:
                    kept.append(data[s2:e2])
            if kept:
                children.append(box('udta', b''.join(kept)))
        else:
            children.append(bytes(data[s:e]))
    assert meta_bytes, 'expected udta/meta written by ffmpeg use_metadata_tags'
    children.append(meta_bytes)
    new_moov = bytearray(box('moov', b''.join(children)))
    for typ in ('mvhd', 'tkhd', 'mdhd'):
        patch_times(new_moov, 8, len(new_moov), typ)
    return bytes(data[:ms]) + bytes(new_moov) + bytes(data[me:])


def ffprobe(path: Path):
    out = run(['ffprobe', '-v', 'error', '-show_entries',
               'format=duration,size,format_name:format_tags:stream=codec_type,codec_name,'
               'codec_tag_string,width,height', '-of', 'json', str(path)])
    return json.loads(out)


# --------------------------------------------------------------------------------------
# Filename / time rules (the oracle used to cross-check the plan)
# --------------------------------------------------------------------------------------
RE_PXL = re.compile(r'^PXL_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(\d{3})')
RE_PREFIXED = re.compile(r'^(?:IMG|VID|PANO|Screenshot)_(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})')
RE_PLAIN = re.compile(r'^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})')
RE_DASHED = re.compile(r'(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})\.(\d{2})')


def time_from_filename(name: str):
    m = RE_PXL.match(name)
    if m:
        y, mo, d, h, mi, s, ms = map(int, m.groups())
        return datetime(y, mo, d, h, mi, s, ms * 1000, tzinfo=UTC)
    for rx in (RE_PREFIXED, RE_PLAIN, RE_DASHED):
        m = (rx.match if rx is not RE_DASHED else rx.search)(name)
        if m:
            y, mo, d, h, mi, s = map(int, m.groups())
            return hel_to_utc(datetime(y, mo, d, h, mi, s))
    return None


def parse_offset(tag: str) -> timedelta:
    sign = -1 if tag.startswith('-') else 1
    h, m = tag[1:].split(':')
    return sign * timedelta(hours=int(h), minutes=int(m))


def derive_app_time(rec: dict, data: bytes | None, camera_offsets: dict):
    """Re-derive the app's capture time from Drive metadata + file bytes, following the
    documented rules. Returns (utc datetime, source)."""
    mime = rec['mimeType']
    imm = rec.get('imageMediaMetadata') or {}
    model = imm.get('cameraModel')
    if mime.startswith('image/'):
        if imm.get('time'):
            wall = datetime.strptime(imm['time'], '%Y:%m:%d %H:%M:%S')
            t = hel_to_utc(wall)
            return t + timedelta(minutes=camera_offsets.get(model, 0)), 'exif'
        if mime == 'image/jpeg' and data is not None:
            ex = read_exif_head(data[:65536])
            if ex and ex['dateTimeOriginal']:
                wall = datetime.strptime(ex['dateTimeOriginal'], '%Y:%m:%d %H:%M:%S')
                if ex['offsetTimeOriginal']:
                    t = (wall - parse_offset(ex['offsetTimeOriginal'])).replace(tzinfo=UTC)
                else:
                    t = hel_to_utc(wall)
                return t + timedelta(minutes=camera_offsets.get(ex['model'], 0)), 'exif-range'
    if mime.startswith('video/') and data is not None:
        mp4 = parse_mp4(data)
        if mp4['appleCreationDate']:
            return parse_iso(mp4['appleCreationDate']), 'mp4-apple'
        if mp4['mvhdCreation'] and parse_iso(mp4['mvhdCreation']).year > 2000:
            return parse_iso(mp4['mvhdCreation']), 'mp4-mvhd'
    t = time_from_filename(rec['name'])
    if t:
        return t, 'filename'
    return min(parse_iso(rec['modifiedTime']), parse_iso(rec['createdTime'])), 'drive-times'


# --------------------------------------------------------------------------------------
# Generation
# --------------------------------------------------------------------------------------
class Gen:
    def __init__(self, out: Path, force: bool):
        self.out = out
        self.force = force
        self.cache_path = out / '.cache.json'
        self.cache = {}
        if self.cache_path.exists() and not force:
            try:
                self.cache = json.loads(self.cache_path.read_text())
            except ValueError:
                self.cache = {}
        self.new_cache = {}
        self.stats = dict(built=0, cached=0)

    def fresh(self, rel: str, key: str) -> bool:
        """True if `rel` exists and was produced from the same spec hash."""
        self.new_cache[rel] = key
        p = self.out / rel
        if not self.force and p.exists() and self.cache.get(rel) == key:
            self.stats['cached'] += 1
            return True
        p.parent.mkdir(parents=True, exist_ok=True)
        self.stats['built'] += 1
        return False

    def save_cache(self):
        self.cache_path.write_text(json.dumps(self.new_cache, indent=1, sort_keys=True))

    def thumbs(self, item_id: str, key: str, make_image):
        rels = {'s220': f'thumbs/{item_id}_s220.jpg', 's1024': f'thumbs/{item_id}_s1024.jpg'}
        need = [not self.fresh(rel, key) for rel in rels.values()]
        if any(need):
            img = make_image().convert('RGB')
            for name, rel in rels.items():
                n = int(name[1:])
                t = img.copy()
                t.thumbnail((n, n), Image.LANCZOS)
                t.save(self.out / rel, 'JPEG', quality=75)
        return rels


def generate(out: Path, force=False):
    out.mkdir(parents=True, exist_ok=True)
    gen = Gen(out, force)
    tmp = Path(tempfile.mkdtemp(prefix='fixtures-'))
    try:
        return _generate(gen, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _generate(gen: Gen, tmp: Path):
    out = gen.out
    folders = {f['id']: dict(f) for f in FOLDERS}
    media = MEDIA + big_items()
    items_by_id = {}

    # effective public flag (inheritance)
    def eff_public(parent_id, override):
        if override is not None:
            return override
        p = folders.get(parent_id)
        if not p:
            return False
        return eff_public(p['parent'], p.get('public'))

    def folder_path(fid):
        parts = []
        while fid in folders:
            parts.append(folders[fid]['name'])
            fid = folders[fid]['parent']
        return '/'.join(reversed(parts))

    def in_root_tree(fid):
        while fid in folders:
            if fid == ROOT:
                return True
            fid = folders[fid]['parent']
        return False

    # colours: one distinct colour per non-big media item
    distinct = [m for m in media if not m['id'].startswith('big_')]
    pal = make_palette(len(distinct))
    min_d = min(color_dist(a, b) for i, a in enumerate(pal) for b in pal[i + 1:])
    assert min_d >= 60, f'palette not distinct enough ({min_d:.1f})'
    colors = {m['id']: pal[i] for i, m in enumerate(distinct)}
    for i, m in enumerate(media):
        if m['id'].startswith('big_'):
            r, g, b = colorsys.hsv_to_rgb((i * 0.0833) % 1.0, 0.6, 0.85)
            colors[m['id']] = (round(r * 255), round(g * 255), round(b * 255))

    # createdTime (upload order = folder path + name order, like a bulk upload)
    in_tree_sorted = sorted([m for m in media if in_root_tree(m['parent']) and not m['hidden']],
                            key=lambda m: (folder_path(m['parent']), m['name']))
    upload_rank = {m['id']: k for k, m in enumerate(in_tree_sorted)}
    hidden_rank = {m['id']: k for k, m in enumerate([m for m in media if m['hidden']])}

    records = []
    # ---- folders ----
    fcreated = datetime(2025, 7, 16, 17, 55, 0, tzinfo=UTC)
    for k, f in enumerate(FOLDERS):
        ct = fcreated + timedelta(seconds=k)
        rec = {
            'kind': 'drive#file', 'id': f['id'], 'name': f['name'], 'mimeType': MIME_FOLDER,
            'parents': [f['parent']], 'trashed': False, 'explicitlyTrashed': False,
            'createdTime': iso_ms(ct), 'modifiedTime': iso_ms(ct),
            'hasThumbnail': False,
            'iconLink': 'https://drive-thirdparty.googleusercontent.com/16/type/'
                        'application/vnd.google-apps.folder',
            'webViewLink': f'https://drive.google.com/drive/folders/{f["id"]}'
                           + (f'?resourcekey={f["resourceKey"]}' if f.get('resourceKey') else ''),
        }
        if f.get('resourceKey'):
            rec['resourceKey'] = f['resourceKey']
        rec['_test'] = {
            'public': eff_public(f['parent'], f.get('public')),
            'inRootTree': in_root_tree(f['id']),
            'folderPath': folder_path(f['id']),
            'expected': {'include': False, 'reason': 'folder'},
        }
        if f.get('resourceKey'):
            rec['_test']['resourceKey'] = f['resourceKey']
        records.append(rec)
        items_by_id[f['id']] = rec

    # ---- media ----
    for m in media:
        mid, parent = m['id'], m['parent']
        local = parse_local(m['local'])
        true_utc = hel_to_utc(local)
        title = m['title']
        label = label_for(local, title) if not mid.startswith('big_') else \
            f'{title} {local:%m-%d %H:%M}'
        bg = colors[mid]
        ext = os.path.splitext(m['name'])[1].lower()
        rel = f'files/{parent}/{m["name"]}'
        spec_key = sha256_json([GEN_VERSION, SCRIPT_HASH, m, bg, FONT_PATH])
        disp_w, disp_h = m['size'] if m['kind'] == 'photo' else (640, 360)
        test = {'path': rel, 'label': label, 'bgColor': hexcolor(bg),
                'trueCaptureUtc': iso_ms(true_utc),
                'trueCaptureLocal': local.strftime('%Y-%m-%dT%H:%M:%S') + '+03:00'}
        drive_extra = {}

        if m['kind'] == 'photo':
            w, h = m['size']
            if mid.startswith('big_'):
                lines = [(title, 0.28), (f'{local:%H:%M}', 0.22)]
                footer = None
            else:
                parts = label.split(' ', 2)
                lines = [(f'{parts[0]} {parts[1]}', 0.13), (parts[2], 0.065)]
                footer = f'id: {mid}'
            if m['orientation'] == 6:
                # displayed image is portrait; stored pixels are rotated 90° CCW
                disp = render_card(h, w, bg, lines, footer)
                stored = disp.rotate(90, expand=True)
                disp_w, disp_h = h, w
            else:
                disp = render_card(w, h, bg, lines, footer)
                stored = disp
            wall = local + timedelta(minutes=m['skew'])
            if not gen.fresh(rel, spec_key):
                if m['fmt'] == 'jpeg':
                    buf = io.BytesIO()
                    if m['camera']:
                        exif = build_exif(m['camera'], wall, m['offset_tag'], m['orientation'],
                                          stored.size, m['gps'])
                        stored.save(buf, 'JPEG', quality=70, exif=exif)
                        data = buf.getvalue()
                        if not m['jfif']:
                            data = strip_app0(data)
                    else:
                        stored.save(buf, 'JPEG', quality=70)
                        data = buf.getvalue()
                    (out / rel).write_bytes(data)
                elif m['fmt'] == 'png':
                    stored.save(out / rel, 'PNG', optimize=True)
                elif m['fmt'] == 'heic':
                    exif = build_exif(m['camera'], wall, m['offset_tag'], 1, stored.size, m['gps'])
                    stored.save(out / rel, format='HEIF', quality=55, exif=exif)
                else:
                    raise ValueError(m['fmt'])
            test['thumbs'] = gen.thumbs(mid, spec_key, lambda: disp)
            mime = {'jpeg': 'image/jpeg', 'png': 'image/png', 'heic': 'image/heic'}[m['fmt']]
            imm = {'width': stored.size[0], 'height': stored.size[1],
                   'rotation': 1 if m['orientation'] == 6 else 0}
            if m['camera'] and m['drive_time']:
                make, model, _ = CAMERAS[m['camera']]
                imm.update(time=exif_wall(wall), cameraMake=make, cameraModel=model)
                if m['gps']:
                    imm['location'] = {'latitude': m['gps'][0], 'longitude': m['gps'][1],
                                       'altitude': m['gps'][2]}
            drive_extra['imageMediaMetadata'] = imm
            if m['camera']:
                make, model, _ = CAMERAS[m['camera']]
                test['exif'] = {'make': make, 'model': model,
                                'dateTimeOriginal': exif_wall(wall),
                                'offsetTimeOriginal': m['offset_tag'],
                                'orientation': m['orientation'] if m['fmt'] != 'heic' else 1,
                                'clockSkewMinutes': m['skew']}
            if m['orientation'] == 6:
                test['expected_display'] = dict(displayRotation=90, displayWidth=disp_w,
                                                displayHeight=disp_h)
        else:  # video
            if not gen.fresh(rel, spec_key):
                make_video(m, out / rel, tmp, bg, label, true_utc)
            test['thumbs'] = gen.thumbs(mid, spec_key,
                                        lambda: video_frame(out / rel, tmp, mid))
            mime = 'video/quicktime' if m['container'] == 'mov' else 'video/mp4'
            probe = ffprobe(out / rel)
            vs = next(s for s in probe['streams'] if s['codec_type'] == 'video')
            drive_extra['videoMediaMetadata'] = {
                'width': vs['width'], 'height': vs['height'],
                'durationMillis': str(round(float(probe['format']['duration']) * 1000))}
            mp4 = parse_mp4((out / rel).read_bytes())
            test['mp4'] = {'codec': vs['codec_name'], 'codecTag': vs['codec_tag_string'],
                           'moovAtEnd': mp4['moovAtEnd'], 'moovOffset': mp4['moovOffset'],
                           'topLevelBoxes': mp4['topLevel'],
                           'mvhdCreationUtc': mp4['mvhdCreation'],
                           'appleCreationDate': mp4['appleCreationDate'],
                           'appleMetaLocation': mp4['metaLocation'] if mp4['appleCreationDate'] else None,
                           'ffprobeTags': probe['format'].get('tags', {})}
            test['playableInChromium'] = m['codec'] == 'h264'

        data = (out / rel).read_bytes()
        public = eff_public(parent, m['public'])
        if m['hidden']:
            created = HIDDEN_UPLOAD_BASE + timedelta(seconds=17 * hidden_rank[mid])
        elif m['created']:
            created = parse_iso(m['created'])
        elif mid in upload_rank:
            created = UPLOAD_BASE + timedelta(seconds=7 * upload_rank[mid])
        else:
            created = datetime(2025, 7, 17, 6, 0, 0, tzinfo=UTC) + \
                timedelta(seconds=len(records))
        modified = true_utc if m['modified'] == 'TRUE' else created
        rec = {
            'kind': 'drive#file', 'id': mid, 'name': m['name'], 'mimeType': mime,
            'parents': [parent], 'trashed': m['trashed'], 'explicitlyTrashed': m['trashed'],
            'createdTime': iso_ms(created), 'modifiedTime': iso_ms(modified),
            'size': str(len(data)), 'md5Checksum': hashlib.md5(data).hexdigest(),
            'originalFilename': m['name'], 'fileExtension': ext[1:],
            'fullFileExtension': ext[1:],
            'hasThumbnail': True,
            'thumbnailLink': f'{{BASE_URL}}/thumb/{mid}=s220',
            'iconLink': f'https://drive-thirdparty.googleusercontent.com/16/type/{mime}',
            'webViewLink': f'https://drive.google.com/file/d/{mid}/view?usp=drivesdk'
                           + (f'&resourcekey={m["resource_key"]}' if m['resource_key'] else ''),
        }
        rec.update(drive_extra)
        if m['resource_key']:
            rec['resourceKey'] = m['resource_key']
            test['resourceKey'] = m['resource_key']
        test['public'] = public
        if m['hidden']:
            test['hiddenUntilRevealed'] = True
        test['inRootTree'] = in_root_tree(parent)
        test['folderPath'] = folder_path(parent)
        rec['_test'] = test
        # planned (intended) app time, computed from the plan, not from the bytes
        rec['_plan'] = plan_app_time(m, local, true_utc, rec)
        records.append(rec)
        items_by_id[mid] = rec

    # ---- other items (text, google doc, shortcuts) ----
    for k, o in enumerate(OTHER_ITEMS):
        ct = UPLOAD_BASE + timedelta(seconds=7 * len(upload_rank) + 7 * k)
        rec = {'kind': 'drive#file', 'id': o['id'], 'name': o['name'], 'parents': [o['parent']],
               'trashed': False, 'explicitlyTrashed': False,
               'createdTime': iso_ms(ct), 'modifiedTime': iso_ms(ct)}
        test = {'public': eff_public(o['parent'], None), 'inRootTree': in_root_tree(o['parent']),
                'folderPath': folder_path(o['parent'])}
        if o['kind'] == 'text':
            rel = f'files/{o["parent"]}/{o["name"]}'
            data = o['content'].encode('utf-8')
            if not gen.fresh(rel, sha256_json([GEN_VERSION, o])):
                (out / rel).write_bytes(data)
            rec.update(mimeType='text/plain', size=str(len(data)),
                       md5Checksum=hashlib.md5(data).hexdigest(), originalFilename=o['name'],
                       fileExtension='txt', fullFileExtension='txt', hasThumbnail=False,
                       iconLink='https://drive-thirdparty.googleusercontent.com/16/type/text/plain',
                       webViewLink=f'https://drive.google.com/file/d/{o["id"]}/view?usp=drivesdk')
            test['path'] = rel
            test['expected'] = {'include': False, 'reason': 'not-media'}
        elif o['kind'] == 'gdoc':
            rec.update(mimeType=MIME_GDOC, hasThumbnail=False,
                       iconLink='https://drive-thirdparty.googleusercontent.com/16/type/'
                                'application/vnd.google-apps.document',
                       webViewLink=f'https://docs.google.com/document/d/{o["id"]}/edit?usp=drivesdk')
            test['expected'] = {'include': False, 'reason': 'google-doc'}
        elif o['kind'] == 'shortcut':
            target = items_by_id[o['target']]
            sd = {'targetId': target['id'], 'targetMimeType': target['mimeType']}
            if target.get('resourceKey'):
                sd['targetResourceKey'] = target['resourceKey']
            rec.update(mimeType=MIME_SHORTCUT, shortcutDetails=sd, hasThumbnail=False,
                       iconLink='https://drive-thirdparty.googleusercontent.com/16/type/'
                                'application/vnd.google-apps.shortcut',
                       webViewLink=f'https://drive.google.com/file/d/{o["id"]}/view?usp=drivesdk')
            test['expected'] = {'include': False, 'reason': 'shortcut (target is included)',
                                'resolvesTo': target['id']}
        rec['_test'] = test
        records.append(rec)
        items_by_id[o['id']] = rec

    # ---- which media belong to the folder_root slideshow (recursion + shortcuts) ----
    children = {}
    for r in records:
        for p in r['parents']:
            children.setdefault(p, []).append(r)

    reachable, via_shortcut = [], set()

    def walk(fid, seen, through_shortcut):
        if fid in seen:
            return
        seen.add(fid)
        for c in children.get(fid, []):
            if c.get('trashed'):
                continue
            mt = c['mimeType']
            if mt == MIME_FOLDER:
                walk(c['id'], seen, through_shortcut)
            elif mt == MIME_SHORTCUT:
                tgt = items_by_id[c['shortcutDetails']['targetId']]
                if tgt['mimeType'] == MIME_FOLDER:
                    walk(tgt['id'], seen, True)
                elif not tgt.get('trashed'):
                    reachable.append(tgt['id'])
                    via_shortcut.add(tgt['id'])
            elif mt.startswith('image/') or mt.startswith('video/'):
                reachable.append(c['id'])
                if through_shortcut:
                    via_shortcut.add(c['id'])

    walk(ROOT, set(), False)
    reachable_set = set(reachable)

    # ---- independent verification + expected values ----
    canon_fix = {CANON_MODEL: CANON_FIX_MINUTES}
    problems = []
    for r in records:
        if '_plan' not in r:
            continue
        plan = r.pop('_plan')
        data = (out / r['_test']['path']).read_bytes()
        t_def, src_def = derive_app_time(r, data, {})
        t_fix, src_fix = derive_app_time(r, data, canon_fix)
        if src_def != plan['timeSource']:
            problems.append(f'{r["id"]}: derived source {src_def} != planned {plan["timeSource"]}')
        if iso_ms(t_def) != iso_ms(plan['appTimeUtc']):
            problems.append(f'{r["id"]}: derived time {iso_ms(t_def)} != planned '
                            f'{iso_ms(plan["appTimeUtc"])}')
        if iso_ms(t_fix) != r['_test']['trueCaptureUtc']:
            problems.append(f'{r["id"]}: canon-fixed time {iso_ms(t_fix)} != true '
                            f'{r["_test"]["trueCaptureUtc"]}')
        verify_file(r, data, problems)
        exp = {'include': r['id'] in reachable_set, 'timeSource': src_def,
               'appTimeUtcDefault': iso_ms(t_def), 'appTimeUtcCanonFix': iso_ms(t_fix)}
        if r['trashed']:
            exp['reason'] = 'trashed'
        elif r['id'] in via_shortcut:
            exp['reason'] = 'via-shortcut'
        elif not r['_test']['inRootTree']:
            exp['reason'] = 'outside-root'
        if r['_test'].get('hiddenUntilRevealed'):
            exp['reason'] = 'hidden-until-revealed'
        if 'expected_display' in r['_test']:
            exp.update(r['_test'].pop('expected_display'))
        if r['mimeType'].startswith('video/') and not r['_test'].get('playableInChromium'):
            exp['optional'] = True
            exp['reason'] = ('HEVC: Chromium may not decode it (Playwright Chromium plays the audio '
                             'track but videoWidth stays 0, no error event); app may skip it or '
                             'show the poster/thumbnail')
        r['_test']['expected'] = exp
    if problems:
        raise AssertionError('fixture verification failed:\n  ' + '\n  '.join(problems))

    # ---- oracles ----
    def order(ids, key):
        return [i for i in sorted(ids, key=lambda i: (key(items_by_id[i]), items_by_id[i]['name']))]

    inc_all = [i for i in reachable]
    inc_default = [i for i in inc_all if not items_by_id[i]['_test'].get('hiddenUntilRevealed')]
    k_def = lambda r: r['_test']['expected']['appTimeUtcDefault']
    k_fix = lambda r: r['_test']['expected']['appTimeUtcCanonFix']
    k_true = lambda r: r['_test']['trueCaptureUtc']
    expected_default = order(inc_default, k_def)
    expected_reveal = order(inc_all, k_def)
    expected_fix = order(inc_default, k_fix)
    true_order = order(inc_default, k_true)
    true_order_all = order(inc_all, k_true)

    # naive orders the fixtures are designed to defeat
    def exif_as_utc(r):
        imm = r.get('imageMediaMetadata') or {}
        if imm.get('time'):
            return datetime.strptime(imm['time'], '%Y:%m:%d %H:%M:%S').replace(tzinfo=UTC)
        return parse_iso(r['_test']['expected']['appTimeUtcDefault'])
    naive = {
        'byName': sorted(inc_default, key=lambda i: items_by_id[i]['name']),
        'byCreatedTime': order(inc_default, lambda r: r['createdTime']),
        'byModifiedTime': order(inc_default, lambda r: r['modifiedTime']),
        'exifWallClockAsUtc': order(inc_default, exif_as_utc),
        'folderThenName': sorted(inc_default, key=lambda i: (items_by_id[i]['_test']['folderPath'],
                                                             items_by_id[i]['name'])),
    }

    checks = []
    checks.append((expected_fix == true_order, 'canon-fix order must equal the true order'))
    checks.append((order(inc_all, k_fix) == true_order_all, 'canon-fix (revealed) == true'))
    checks.append((expected_default != true_order, 'default order must differ from true order'))
    for n, o in naive.items():
        checks.append((o != true_order, f'naive order {n} must differ from the true order'))
    non_canon = [i for i in inc_default
                 if (items_by_id[i].get('imageMediaMetadata') or {}).get('cameraModel') != CANON_MODEL]
    canon_ids = [i for i in inc_default if i not in non_canon]
    checks.append((len(canon_ids) >= 3, 'need >= 3 Canon photos'))
    for c in canon_ids:
        before_def = set(expected_default[:expected_default.index(c)]) & set(non_canon)
        before_true = set(true_order[:true_order.index(c)]) & set(non_canon)
        checks.append((before_def != before_true,
                       f'Canon {c} must be misplaced with default settings'))
    for i in inc_default:
        if i in non_canon:
            r = items_by_id[i]
            checks.append((r['_test']['expected']['appTimeUtcDefault'] == r['_test']['trueCaptureUtc'],
                           f'{i}: non-Canon default time must be the true instant'))
    trues = sorted(items_by_id[i]['_test']['trueCaptureUtc'] for i in inc_all)
    for a, b in zip(trues, trues[1:]):
        checks.append(((parse_iso(b) - parse_iso(a)) >= timedelta(minutes=5),
                       f'true capture times must be >= 5 min apart ({a}, {b})'))
    defs = [items_by_id[i]['_test']['expected']['appTimeUtcDefault'] for i in inc_all]
    checks.append((len(set(defs)) == len(defs), 'default app times must be unique'))
    # every source type is covered
    covered = {items_by_id[i]['_test']['expected']['timeSource'] for i in inc_all}
    for s in ('exif', 'exif-range', 'mp4-apple', 'mp4-mvhd', 'filename', 'drive-times'):
        checks.append((s in covered, f'time source {s} must be covered'))
    failed = [msg for ok, msg in checks if not ok]
    if failed:
        raise AssertionError('oracle self-check failed:\n  ' + '\n  '.join(failed))

    by_folder = {}
    for fid in ('folder_private', 'folder_reskey', 'folder_big', 'folder_extra', 'folder_other'):
        ids = [c['id'] for c in children.get(fid, []) if c['mimeType'].startswith(('image/', 'video/'))]
        by_folder[fid] = order(ids, k_def)

    # folder summary
    folder_summary = []
    for f in FOLDERS:
        rec = items_by_id[f['id']]
        kids = children.get(f['id'], [])
        folder_summary.append({
            'id': f['id'], 'name': f['name'], 'parentId': f['parent'],
            'path': rec['_test']['folderPath'], 'public': rec['_test']['public'],
            'resourceKey': f.get('resourceKey'), 'inRootTree': rec['_test']['inRootTree'],
            'childIds': [c['id'] for c in kids],
            'mediaCount': sum(1 for c in kids if c['mimeType'].startswith(('image/', 'video/'))),
        })

    manifest = {
        'schemaVersion': 1,
        'generator': 'tests/fixtures/generate.py',
        'generatorVersion': GEN_VERSION,
        'tripTimeZone': TRIP_TZ_NAME,
        'rootFolderId': ROOT,
        'myDriveRootId': MYDRIVE,
        'auth': {'bearerTokens': ['test-token'], 'apiKeys': ['TESTKEY'],
                 'resourceKeyHeader': 'X-Goog-Drive-Resource-Keys'},
        'thumbnailLinkTemplate': '{BASE_URL}/thumb/{id}=s220',
        'cameraOffsetsCanonFix': {CANON_MODEL: CANON_FIX_MINUTES},
        'timeRules': [
            '1 image with Drive imageMediaMetadata.time -> wall clock in tripTimeZone',
            '2 JPEG without Drive time -> EXIF DateTimeOriginal (+OffsetTimeOriginal if present, '
            'else tripTimeZone) read from the first 64 KiB',
            '3 video -> com.apple.quicktime.creationdate, else mvhd creation_time if year > 2000',
            '4 filename: PXL_YYYYMMDD_HHMMSSmmm = UTC; IMG_/VID_/PANO_/Screenshot_ + '
            'YYYYMMDD[_-]HHMMSS, YYYYMMDD_HHMMSS, "YYYY-MM-DD HH.MM.SS" = tripTimeZone',
            '5 min(modifiedTime, createdTime)',
            'per-camera offsets (minutes) are added to times from rules 1-2 for that cameraModel',
        ],
        'folders': folder_summary,
        'files': records,
        'expectedOrderDefault': expected_default,
        'expectedOrderWithReveal': expected_reveal,
        'expectedOrderCanonFix': expected_fix,
        'expectedOrderTrue': true_order,
        'expectedOrderByFolder': by_folder,
        'hiddenIds': [i for i in inc_all if items_by_id[i]['_test'].get('hiddenUntilRevealed')],
        'optionalIds': [i for i in inc_all if items_by_id[i]['_test']['expected'].get('optional')],
        'canonIds': canon_ids,
        'naiveOrders': naive,
    }
    (out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    gen.save_cache()
    return manifest, gen.stats


def plan_app_time(m, local, true_utc, rec):
    """What the app SHOULD compute with default settings, derived from the plan."""
    name = m['name']
    if m['kind'] == 'photo':
        wall = local + timedelta(minutes=m['skew'])
        if m['camera'] and m['drive_time']:
            return {'timeSource': 'exif', 'appTimeUtc': hel_to_utc(wall)}
        if m['camera'] and m['fmt'] == 'jpeg':
            if m['offset_tag']:
                t = (wall - parse_offset(m['offset_tag'])).replace(tzinfo=UTC)
            else:
                t = hel_to_utc(wall)
            return {'timeSource': 'exif-range', 'appTimeUtc': t}
    else:
        if m['apple']:
            return {'timeSource': 'mp4-apple', 'appTimeUtc': parse_iso(m['apple'])}
        if m['mvhd'] == 'true':
            return {'timeSource': 'mp4-mvhd', 'appTimeUtc': true_utc.replace(microsecond=0)}
        if m['mvhd'] not in ('none', None):
            return {'timeSource': 'mp4-mvhd', 'appTimeUtc': parse_iso(m['mvhd'])}
    t = time_from_filename(name)
    if t:
        return {'timeSource': 'filename', 'appTimeUtc': t}
    return {'timeSource': 'drive-times',
            'appTimeUtc': min(parse_iso(rec['modifiedTime']), parse_iso(rec['createdTime']))}


def verify_file(rec, data, problems):
    """Cross-check Drive metadata against the actual bytes (Pillow / ffprobe / own parsers)."""
    rid, mime, t = rec['id'], rec['mimeType'], rec['_test']
    if mime.startswith('image/'):
        img = Image.open(io.BytesIO(data))
        imm = rec['imageMediaMetadata']
        if (img.width, img.height) != (imm['width'], imm['height']):
            problems.append(f'{rid}: dimension mismatch')
        fmt = {'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/heic': 'HEIF'}[mime]
        if img.format != fmt:
            problems.append(f'{rid}: format {img.format} != {fmt}')
        exif = img.getexif()
        sub = exif.get_ifd(0x8769)
        if 'exif' in t:
            if sub.get(0x9003) != t['exif']['dateTimeOriginal']:
                problems.append(f'{rid}: Pillow EXIF DTO {sub.get(0x9003)} mismatch')
            if imm.get('time') and imm['time'] != sub.get(0x9003):
                problems.append(f'{rid}: Drive time != EXIF DTO')
            if sub.get(0x9011) != t['exif']['offsetTimeOriginal']:
                problems.append(f'{rid}: OffsetTimeOriginal mismatch')
            if mime == 'image/jpeg':
                head = read_exif_head(data[:65536])
                if not head or head['dateTimeOriginal'] != t['exif']['dateTimeOriginal']:
                    problems.append(f'{rid}: EXIF not readable from first 64 KiB')
                elif head['app1End'] > 65536:
                    problems.append(f'{rid}: EXIF APP1 beyond 64 KiB')
                if head and head['orientation'] != t['exif']['orientation']:
                    problems.append(f'{rid}: orientation mismatch')
                if t['exif']['orientation'] == 6:
                    up = ImageOps.exif_transpose(img)
                    if up.size != (imm['height'], imm['width']):
                        problems.append(f'{rid}: orientation 6 does not produce portrait')
        else:
            if len(exif) or (mime == 'image/jpeg' and read_exif_head(data[:65536])):
                problems.append(f'{rid}: expected no EXIF')
    elif mime.startswith('video/'):
        mp4 = parse_mp4(data)
        probe = t['mp4']['ffprobeTags']
        if mp4['mvhdCreation']:
            ff = probe.get('creation_time')
            if not ff or parse_iso(ff) != parse_iso(mp4['mvhdCreation']):
                problems.append(f'{rid}: ffprobe creation_time {ff} != mvhd {mp4["mvhdCreation"]}')
        elif 'creation_time' in probe:
            problems.append(f'{rid}: unexpected creation_time tag')
        if mp4['appleCreationDate'] != probe.get('com.apple.quicktime.creationdate'):
            problems.append(f'{rid}: apple creationdate mismatch with ffprobe')
        if rid == 'vid_tram' and (not mp4['moovAtEnd'] or mp4['moovOffset'] < 256 * 1024):
            problems.append(f'{rid}: moov must be at the end, beyond the first 256 KiB')
        if rid == 'vid_harbour_ferry' and mp4['moovAtEnd']:
            problems.append(f'{rid}: expected faststart (moov first)')
        if rid == 'vid_pxl_husky' and mp4['mvhdCreationRaw'] != 0:
            problems.append(f'{rid}: mvhd creation_time must be 0')
        if rid == 'vid_reindeer_mov' and mp4['metaLocation'] != 'moov/meta':
            problems.append(f'{rid}: Apple keys must live in moov/meta')
        dur = int(rec['videoMediaMetadata']['durationMillis'])
        if not (1500 <= dur <= 9000):
            problems.append(f'{rid}: odd duration {dur}')


def video_frame(path: Path, tmp: Path, mid: str):
    png = tmp / f'{mid}_frame.png'
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', '1.0', '-i', str(path),
         '-frames:v', '1', str(png)])
    return Image.open(png).convert('RGB')


def make_video(m, dest: Path, tmp: Path, bg, label, true_utc):
    parts = label.split(' ', 2)
    frame = render_card(640, 360, bg, [(f'{parts[0]} {parts[1]}', 0.16), (parts[2], 0.075)],
                        f'id: {m["id"]}')
    frame_png = tmp / f'{m["id"]}_card.png'
    frame.save(frame_png)
    fg = text_color(bg)
    box_color = '0x%02x%02x%02x' % fg
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
           '-loop', '1', '-framerate', '30', '-i', str(frame_png),
           '-f', 'lavfi', '-i', f'color=c={box_color}:s=36x36:r=30',
           '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
           '-filter_complex',
           "[0:v][1:v]overlay=x='mod(t*220,W-w-80)+40':y=H-h-6:shortest=1,format=yuv420p[v]",
           '-map', '[v]', '-map', '2:a', '-t', str(m['duration']), '-r', '30']
    if m['codec'] == 'hevc':
        cmd += ['-c:v', 'libx265', '-tag:v', 'hvc1', '-preset', 'fast', '-b:v', '700k',
                '-x265-params', 'log-level=error:pools=1:frame-threads=1']
    else:
        cmd += ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high',
                '-b:v', '1200k', '-minrate', '1200k', '-maxrate', '1200k', '-bufsize', '1200k',
                '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-g', '30', '-threads', '1']
    cmd += ['-c:a', 'aac', '-b:a', '48k']
    movflags = []
    if m['faststart']:
        movflags.append('+faststart')
    if m['apple']:
        cmd += ['-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
                '-metadata', 'com.apple.quicktime.location.ISO6709=+66.5436+025.8473+105.000/',
                '-metadata', 'com.apple.quicktime.make=Apple',
                '-metadata', 'com.apple.quicktime.model=iPhone 15',
                '-metadata', 'com.apple.quicktime.software=17.5.1',
                '-metadata', f'com.apple.quicktime.creationdate={m["apple"]}']
        movflags.append('+use_metadata_tags')
    elif m['mvhd'] == 'none':
        cmd += ['-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact',
                '-flags:a', '+bitexact']
    else:
        ct = true_utc if m['mvhd'] == 'true' else parse_iso(m['mvhd'])
        cmd += ['-metadata', 'creation_time=' + ct.strftime('%Y-%m-%dT%H:%M:%S.000000Z')]
    if movflags:
        cmd += ['-movflags', ''.join(movflags)]
    cmd += ['-f', 'mov' if m['container'] == 'mov' else 'mp4']
    raw = tmp / (m['id'] + ('.mov' if m['container'] == 'mov' else '.mp4'))
    run(cmd + [str(raw)])
    data = raw.read_bytes()
    if m['apple']:
        mv = parse_iso(m['mvhd']) if m['mvhd'] not in ('true', 'none') else true_utc
        data = iphone_style_mov(data, mv)
    dest.write_bytes(data)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--out', default=str(DEFAULT_OUT), help='output directory')
    ap.add_argument('--force', action='store_true', help='re-encode everything')
    ap.add_argument('--clean', action='store_true', help='delete the output directory first')
    args = ap.parse_args(argv)
    for tool in ('ffmpeg', 'ffprobe'):
        if not shutil.which(tool):
            sys.exit(f'{tool} not found in PATH')
    out = Path(args.out).resolve()
    if args.clean and out.exists():
        shutil.rmtree(out)
    manifest, stats = generate(out, force=args.force)
    n_files = sum(1 for f in manifest['files'] if f['mimeType'] != MIME_FOLDER)
    print(f'fixtures: {out}')
    print(f'  {len(manifest["folders"])} folders, {n_files} files '
          f'({stats["built"]} outputs built, {stats["cached"]} up to date)')
    print(f'  expectedOrderDefault ({len(manifest["expectedOrderDefault"])}): '
          + ' '.join(manifest['expectedOrderDefault']))
    print('  self-checks passed')


if __name__ == '__main__':
    main()
