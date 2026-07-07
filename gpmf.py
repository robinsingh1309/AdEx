"""
GoPro GPMF telemetry extractor.

Walks an MP4 container's `moov` atom to find the GoPro `MET` metadata track,
locates every GPMF sample in `mdat` via the standard `stco/co64 + stsz + stsc`
sample tables, then walks each sample's DEVC -> STRM -> KLV structure to pull
out GPS5 / GPS9 points, anchored to real UTC time via the GPSU key (falling
back to the MP4 `mvhd` recording-start time when GPSU isn't present).

Direct Python port of the browser-based reference implementation, adapted to
read the file with plain seek()/read() instead of sliced ArrayBuffer reads
(no need to batch/merge adjacent sample ranges — local disk I/O is cheap).
"""

import math
import re
import struct
from datetime import datetime, timezone


def _u32(buf, o):
    return struct.unpack_from('>I', buf, o)[0]


def _u16(buf, o):
    return struct.unpack_from('>H', buf, o)[0]


def _i32(buf, o):
    return struct.unpack_from('>i', buf, o)[0]


def _key4(buf, o):
    if o + 4 > len(buf):
        return '????'
    return buf[o:o + 4].decode('ascii', errors='replace')


# ── MP4 box walking ──────────────────────────────────────────────────────

def _find_moov(f, file_size):
    o = 0
    while o + 8 <= file_size:
        f.seek(o)
        h = f.read(16)
        if len(h) < 8:
            break
        bs = struct.unpack_from('>I', h, 0)[0]
        tp = h[4:8].decode('ascii', errors='replace')
        if bs == 1 and len(h) >= 16:
            bs = struct.unpack_from('>Q', h, 8)[0]
        if bs == 0:
            bs = file_size - o
        if bs < 8:
            break
        if tp == 'moov':
            return o, bs
        o += bs
    return None


def _blist(buf, s, e):
    r = []
    o = s
    while o + 8 <= e:
        sz = _u32(buf, o)
        tp = _key4(buf, o + 4)
        if sz < 8 or o + sz > e:
            break
        r.append({'tp': tp, 's': o, 'sz': sz, 'd': o + 8})
        o += sz
    return r


def _bfind(buf, s, e, path):
    head, *rest = path
    for b in _blist(buf, s, e):
        if b['tp'] == head:
            return _bfind(buf, b['d'], b['s'] + b['sz'], rest) if rest else b
    return None


def _bfall(buf, s, e, tp):
    return [b for b in _blist(buf, s, e) if b['tp'] == tp]


# ── GoPro MET track -> GPMF sample ranges ────────────────────────────────

def _get_gpmf_ranges(moov):
    """Returns the GPMF sample-range list for the GoPro MET track, or None.

    A file can have more than one `meta`-handler track (e.g. auxiliary
    chapter/thumbnail metadata some encoders add) — matching just the first
    structural hit and returning immediately, as the original reference tool
    did, can silently lock onto the wrong track and report "no GPS" even
    though the real GoPro MET track exists later in the file. So every
    candidate track is tried, name matches are preferred over bare
    handler-type matches, and only a candidate that actually yields a
    non-empty sample list is accepted.
    """
    end = len(moov)
    candidates = []  # (priority, samp) — priority 0 (name match) preferred over 1 (type-only)
    for trak in _bfall(moov, 8, end, 'trak'):
        mdia = _bfind(moov, trak['d'], trak['s'] + trak['sz'], ['mdia'])
        if not mdia:
            continue
        hdlr = _bfind(moov, mdia['d'], mdia['s'] + mdia['sz'], ['hdlr'])
        if not hdlr:
            continue
        ht = _key4(moov, hdlr['d'] + 8)
        hn = moov[hdlr['d'] + 24:hdlr['s'] + hdlr['sz']].decode('utf-8', errors='replace') \
            .replace('\x00', '').strip()
        name_match = 'gopro met' in hn.lower()
        type_match = ht == 'meta'
        if not name_match and not type_match:
            continue

        minf = _bfind(moov, mdia['d'], mdia['s'] + mdia['sz'], ['minf'])
        stbl = minf and _bfind(moov, minf['d'], minf['s'] + minf['sz'], ['stbl'])
        if not stbl:
            continue

        co = []
        stco = _bfind(moov, stbl['d'], stbl['s'] + stbl['sz'], ['stco'])
        co64 = _bfind(moov, stbl['d'], stbl['s'] + stbl['sz'], ['co64'])
        if stco:
            n = _u32(moov, stco['d'] + 4)
            co = [_u32(moov, stco['d'] + 8 + i * 4) for i in range(n)]
        elif co64:
            n = _u32(moov, co64['d'] + 4)
            co = [struct.unpack_from('>Q', moov, co64['d'] + 8 + i * 8)[0] for i in range(n)]

        stsz = _bfind(moov, stbl['d'], stbl['s'] + stbl['sz'], ['stsz'])
        if not stsz:
            continue
        dz = _u32(moov, stsz['d'] + 4)
        sc = _u32(moov, stsz['d'] + 8)
        if dz == 0:
            ss = [_u32(moov, stsz['d'] + 12 + i * 4) for i in range(sc)]
        else:
            ss = [dz] * sc

        stsc = _bfind(moov, stbl['d'], stbl['s'] + stbl['sz'], ['stsc'])
        if not stsc:
            continue
        ne = _u32(moov, stsc['d'] + 4)
        ste = []
        for i in range(ne):
            b = stsc['d'] + 8 + i * 12
            ste.append({'fc': _u32(moov, b), 'spc': _u32(moov, b + 4)})

        samp = []
        si = 0
        ci = 0
        while ci < len(co) and si < sc:
            cn = ci + 1
            spc = 1
            for ei in range(len(ste) - 1, -1, -1):
                if ste[ei]['fc'] <= cn:
                    spc = ste[ei]['spc']
                    break
            bo = co[ci]
            s = 0
            while s < spc and si < sc:
                samp.append({'o': bo, 'sz': ss[si]})
                bo += ss[si]
                s += 1
                si += 1
            ci += 1

        if samp:
            candidates.append((0 if name_match else 1, samp))

    if not candidates:
        return None
    candidates.sort(key=lambda c: c[0])
    return candidates[0][1]


# ── GPSU (UTC timestamp) parsing ─────────────────────────────────────────
#
# GPSU gives real UTC time but isn't emitted by every firmware/stream (some
# GPS9 cameras never emit it). We must never let a missing/unparsable GPSU
# discard otherwise-valid GPS5/GPS9 coordinates — every sample always gets a
# relative elapsed-time ("rel_ts", ms from the first GPS sample in the file,
# assuming each STRM chunk spans ~1 real second, GoPro's normal DEVC cadence).
# The first GPSU seen anywhere in the file (if any) is used purely to convert
# that relative timeline into a real UTC epoch after the fact.

_GPSU_RE = re.compile(r'^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$')


def _parse_gpsu(text):
    s = text.replace('\x00', '').strip()
    m = _GPSU_RE.match(s)
    if not m:
        return None
    yy, mm, dd, hh, mi, ss, frac = m.groups()
    micros = int((frac or '0').ljust(6, '0')[:6])
    try:
        dt = datetime(2000 + int(yy), int(mm), int(dd), int(hh), int(mi), int(ss), micros,
                       tzinfo=timezone.utc)
    except ValueError:
        return None
    return dt.timestamp() * 1000


# ── KLV walking (DEVC -> STRM -> GPS5/GPS9) ──────────────────────────────

def _parse_strm(buf, off, end, pts, state):
    kvs = []
    o = off
    safety = 0
    while o + 8 <= end and safety < 10000:
        safety += 1
        key = _key4(buf, o)
        sz = buf[o + 5]
        rpt = _u16(buf, o + 6)
        dlen = sz * rpt
        dpad = 0 if dlen == 0 else math.ceil(dlen / 4) * 4
        ds = o + 8
        raw = buf[ds:min(ds + dlen, len(buf))]
        kvs.append({'key': key, 'sz': sz, 'rpt': rpt, 'raw': raw})
        if dpad == 0:
            break
        o = ds + dpad

    scale = 0
    gpsu_ms = None
    for k in kvs:
        if k['key'] == 'SCAL':
            if k['sz'] == 4 and len(k['raw']) >= 4:
                scale = _u32(k['raw'], 0)
            elif k['sz'] == 2 and len(k['raw']) >= 2:
                scale = _u16(k['raw'], 0)
            elif k['sz'] == 1 and len(k['raw']) >= 1:
                scale = k['raw'][0]
        elif k['key'] == 'GPSU':
            parsed = _parse_gpsu(k['raw'].decode('ascii', errors='replace'))
            if parsed is not None:
                gpsu_ms = parsed
    if scale == 0:
        scale = 1

    coords = []
    for k in kvs:
        if k['key'] == 'GPS5' and k['sz'] >= 20:
            for i in range(k['rpt']):
                b = i * k['sz']
                if b + 20 > len(k['raw']):
                    break
                coords.append((_i32(k['raw'], b) / scale, _i32(k['raw'], b + 4) / scale))
        elif k['key'] == 'GPS9' and k['sz'] >= 32:
            for i in range(k['rpt']):
                b = i * k['sz']
                if b + 32 > len(k['raw']):
                    break
                coords.append((_i32(k['raw'], b) / scale, _i32(k['raw'], b + 4) / scale))

    if not coords:
        return

    n = len(coords)
    period_ms = 1000.0 / n
    chunk_start_ms = state['elapsed_ms']
    state['elapsed_ms'] = chunk_start_ms + n * period_ms

    if gpsu_ms is not None and state['first_gpsu_ms'] is None:
        state['first_gpsu_ms'] = gpsu_ms
        state['first_gpsu_rel_ms'] = chunk_start_ms

    for i, (lat, lon) in enumerate(coords):
        pts.append({'lat': lat, 'lon': lon, 'rel_ms': chunk_start_ms + i * period_ms})


def _parse_devc(buf, off, end, pts, state):
    while off + 8 <= end:
        key = _key4(buf, off)
        sz = buf[off + 5]
        rpt = _u16(buf, off + 6)
        dlen = sz * rpt
        dpad = 0 if dlen == 0 else math.ceil(dlen / 4) * 4
        ds = off + 8
        if key == 'STRM':
            _parse_strm(buf, ds, ds + dlen, pts, state)
        if dpad == 0:
            break
        off = ds + dpad


def _parse_chunk(buf, off, end, state):
    pts = []
    while off + 8 <= end:
        key = _key4(buf, off)
        sz = buf[off + 5]
        rpt = _u16(buf, off + 6)
        dlen = sz * rpt
        dpad = 0 if dlen == 0 else math.ceil(dlen / 4) * 4
        ds = off + 8
        if key == 'DEVC':
            _parse_devc(buf, ds, ds + dlen, pts, state)
        if dpad == 0:
            break
        off = ds + dpad
    return pts


# ── mvhd fallback (video start time, used when no GPSU is found anywhere) ──

_MAC_EPOCH_OFFSET = 2082844800  # seconds between 1904-01-01 (mvhd epoch) and 1970-01-01


def _get_mvhd_creation_ms(moov):
    mvhd = _bfind(moov, 8, len(moov), ['mvhd'])
    if not mvhd:
        return None
    d = mvhd['d']
    version = moov[d]
    creation_time = struct.unpack_from('>Q', moov, d + 4)[0] if version == 1 else _u32(moov, d + 4)
    unix_seconds = creation_time - _MAC_EPOCH_OFFSET
    return unix_seconds * 1000 if unix_seconds > 0 else None


# ── Public entry point ────────────────────────────────────────────────────

def extract_gps_from_video(path):
    """Returns a list of {ts, lat, lng} points (ts = epoch ms, UTC), sorted by ts.

    Every decoded GPS5/GPS9 coordinate is kept regardless of whether its own
    chunk carried a GPSU timestamp — timing comes from a relative elapsed-time
    clock (assuming ~1 real second per DEVC/STRM chunk) that is anchored to an
    absolute UTC time using, in order of preference: the first GPSU value seen
    anywhere in the file, or the MP4 `mvhd` box's recording start time.

    Returns [] only if the file has no GoPro MET track or no GPS5/GPS9 samples
    could be decoded at all.
    """
    file_size = path.stat().st_size

    with open(path, 'rb') as f:
        moov_info = _find_moov(f, file_size)
        if not moov_info:
            return []
        moov_off, moov_sz = moov_info
        f.seek(moov_off)
        moov = f.read(moov_sz)

        samp = _get_gpmf_ranges(moov)
        if not samp:
            return []

        state = {'elapsed_ms': 0.0, 'first_gpsu_ms': None, 'first_gpsu_rel_ms': None}
        raw_pts = []
        for s in samp:
            f.seek(s['o'])
            buf = f.read(s['sz'])
            raw_pts.extend(_parse_chunk(buf, 0, len(buf), state))

        if not raw_pts:
            return []

        if state['first_gpsu_ms'] is not None:
            offset_ms = state['first_gpsu_ms'] - state['first_gpsu_rel_ms']
        else:
            mvhd_ms = _get_mvhd_creation_ms(moov)
            offset_ms = mvhd_ms if mvhd_ms is not None else 0

    points = [
        {'ts': int(round(p['rel_ms'] + offset_ms)), 'lat': round(p['lat'], 7), 'lng': round(p['lon'], 7)}
        for p in raw_pts
    ]
    points.sort(key=lambda p: p['ts'])
    return points
