// Browser port of gpmf.py — walks an MP4 container's `moov` atom to find the
// GoPro `MET` metadata track, locates every GPMF sample in `mdat` via the
// standard `stco/co64 + stsz + stsc` sample tables, then walks each sample's
// DEVC -> STRM -> KLV structure to pull out GPS5 / GPS9 points, anchored to
// real UTC time via the GPSU key (falling back to the MP4 `mvhd` recording-
// start time when GPSU isn't present).
//
// Unlike gpmf.py (which reads each GPMF sample with a cheap local seek()),
// each read here is an async File.slice().arrayBuffer() call with real
// per-call overhead — so nearby sample ranges are coalesced into larger
// batched reads (see readGpmfSamples) instead of one read per sample.

export const NO_GPS_MESSAGE =
  'No GPS telemetry found in this video. GoPro GPS must be enabled (HERO 5+).'

const MAC_EPOCH_OFFSET = 2082844800 // seconds between 1904-01-01 (mvhd epoch) and 1970-01-01
const GPSU_RE = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/
const SAMPLE_MERGE_GAP = 512 * 1024 // merge sample reads separated by less than this

// ── low-level reads ─────────────────────────────────────────────────────

async function readSlice(file, start, len) {
  const end = Math.min(start + len, file.size)
  const buf = await file.slice(start, end).arrayBuffer()
  return new Uint8Array(buf)
}

function u32(dv, o) { return dv.getUint32(o, false) }
function u16(dv, o) { return dv.getUint16(o, false) }
function i32(dv, o) { return dv.getInt32(o, false) }

function key4(bytes, o) {
  if (o + 4 > bytes.length) return '????'
  let s = ''
  for (let i = 0; i < 4; i++) {
    const c = bytes[o + i]
    s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '�'
  }
  return s
}

// ── MP4 box walking ──────────────────────────────────────────────────────

async function findMoov(file) {
  const fileSize = file.size
  let o = 0
  while (o + 8 <= fileSize) {
    const h = await readSlice(file, o, 16)
    if (h.length < 8) break
    const dv = new DataView(h.buffer)
    let bs = u32(dv, 0)
    const tp = key4(h, 4)
    if (bs === 1 && h.length >= 16) {
      bs = u32(dv, 8) * 4294967296 + u32(dv, 12)
    }
    if (bs === 0) bs = fileSize - o
    if (bs < 8) break
    if (tp === 'moov') return { off: o, size: bs }
    o += bs
  }
  return null
}

function blist(bytes, s, e) {
  const r = []
  let o = s
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  while (o + 8 <= e) {
    const sz = u32(dv, o)
    const tp = key4(bytes, o + 4)
    if (sz < 8 || o + sz > e) break
    r.push({ tp, s: o, sz, d: o + 8 })
    o += sz
  }
  return r
}

function bfind(bytes, s, e, path) {
  const [head, ...rest] = path
  for (const b of blist(bytes, s, e)) {
    if (b.tp === head) {
      return rest.length ? bfind(bytes, b.d, b.s + b.sz, rest) : b
    }
  }
  return null
}

function bfall(bytes, s, e, tp) {
  return blist(bytes, s, e).filter(b => b.tp === tp)
}

// ── GoPro MET track -> GPMF sample ranges ────────────────────────────────
//
// A file can have more than one `meta`-handler track (e.g. auxiliary
// chapter/thumbnail metadata some encoders add) — matching just the first
// structural hit can silently lock onto the wrong track, so every candidate
// track is tried, name matches are preferred over bare handler-type matches,
// and only a candidate that actually yields a non-empty sample list is used.

function getGpmfRanges(bytes) {
  const end = bytes.length
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const candidates = [] // {priority, samp} — priority 0 (name match) preferred over 1 (type-only)

  for (const trak of bfall(bytes, 8, end, 'trak')) {
    const mdia = bfind(bytes, trak.d, trak.s + trak.sz, ['mdia'])
    if (!mdia) continue
    const hdlr = bfind(bytes, mdia.d, mdia.s + mdia.sz, ['hdlr'])
    if (!hdlr) continue
    const ht = key4(bytes, hdlr.d + 8)
    const hnBytes = bytes.slice(hdlr.d + 24, hdlr.s + hdlr.sz)
    const hn = new TextDecoder('utf-8', { fatal: false }).decode(hnBytes).replace(/\0/g, '').trim()
    const nameMatch = hn.toLowerCase().includes('gopro met')
    const typeMatch = ht === 'meta'
    if (!nameMatch && !typeMatch) continue

    const minf = bfind(bytes, mdia.d, mdia.s + mdia.sz, ['minf'])
    const stbl = minf && bfind(bytes, minf.d, minf.s + minf.sz, ['stbl'])
    if (!stbl) continue

    let co = []
    const stco = bfind(bytes, stbl.d, stbl.s + stbl.sz, ['stco'])
    const co64 = bfind(bytes, stbl.d, stbl.s + stbl.sz, ['co64'])
    if (stco) {
      const n = u32(dv, stco.d + 4)
      for (let i = 0; i < n; i++) co.push(u32(dv, stco.d + 8 + i * 4))
    } else if (co64) {
      const n = u32(dv, co64.d + 4)
      for (let i = 0; i < n; i++) co.push(u32(dv, co64.d + 8 + i * 8) * 4294967296 + u32(dv, co64.d + 8 + i * 8 + 4))
    }

    const stsz = bfind(bytes, stbl.d, stbl.s + stbl.sz, ['stsz'])
    if (!stsz) continue
    const dz = u32(dv, stsz.d + 4)
    const sc = u32(dv, stsz.d + 8)
    let ss
    if (dz === 0) {
      ss = []
      for (let i = 0; i < sc; i++) ss.push(u32(dv, stsz.d + 12 + i * 4))
    } else {
      ss = new Array(sc).fill(dz)
    }

    const stsc = bfind(bytes, stbl.d, stbl.s + stbl.sz, ['stsc'])
    if (!stsc) continue
    const ne = u32(dv, stsc.d + 4)
    const ste = []
    for (let i = 0; i < ne; i++) {
      const b = stsc.d + 8 + i * 12
      ste.push({ fc: u32(dv, b), spc: u32(dv, b + 4) })
    }

    const samp = []
    let si = 0, ci = 0
    while (ci < co.length && si < sc) {
      const cn = ci + 1
      let spc = 1
      for (let ei = ste.length - 1; ei >= 0; ei--) {
        if (ste[ei].fc <= cn) { spc = ste[ei].spc; break }
      }
      let bo = co[ci]
      let s = 0
      while (s < spc && si < sc) {
        samp.push({ o: bo, sz: ss[si] })
        bo += ss[si]
        s++; si++
      }
      ci++
    }

    if (samp.length) candidates.push({ priority: nameMatch ? 0 : 1, samp })
  }

  if (!candidates.length) return null
  candidates.sort((a, b) => a.priority - b.priority)
  return candidates[0].samp
}

// ── GPSU (UTC timestamp) parsing ─────────────────────────────────────────

function parseGpsu(text) {
  const s = text.replace(/\0/g, '').trim()
  const m = GPSU_RE.exec(s)
  if (!m) return null
  const yy = +m[1], mm = +m[2], dd = +m[3], hh = +m[4], mi = +m[5], ss = +m[6]
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 60) return null
  const micros = parseInt((m[7] || '0').padEnd(6, '0').slice(0, 6), 10)
  const baseMs = Date.UTC(2000 + yy, mm - 1, dd, hh, mi, ss, 0)
  if (Number.isNaN(baseMs)) return null
  return baseMs + micros / 1000
}

// ── KLV walking (DEVC -> STRM -> GPS5/GPS9) ──────────────────────────────

function decodeAsciiReplace(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]
    s += c < 128 ? String.fromCharCode(c) : '�'
  }
  return s
}

function parseStrm(bytes, off, end, pts, state) {
  const kvs = []
  let o = off
  let safety = 0
  while (o + 8 <= end && safety < 10000) {
    safety++
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const key = key4(bytes, o)
    const sz = bytes[o + 5]
    const rpt = u16(dv, o + 6)
    const dlen = sz * rpt
    const dpad = dlen === 0 ? 0 : Math.ceil(dlen / 4) * 4
    const ds = o + 8
    const raw = bytes.slice(ds, Math.min(ds + dlen, bytes.length))
    kvs.push({ key, sz, rpt, raw })
    if (dpad === 0) break
    o = ds + dpad
  }

  let scale = 0
  let gpsuMs = null
  for (const k of kvs) {
    if (k.key === 'SCAL') {
      const dv = new DataView(k.raw.buffer)
      if (k.sz === 4 && k.raw.length >= 4) scale = dv.getUint32(0, false)
      else if (k.sz === 2 && k.raw.length >= 2) scale = dv.getUint16(0, false)
      else if (k.sz === 1 && k.raw.length >= 1) scale = k.raw[0]
    } else if (k.key === 'GPSU') {
      const parsed = parseGpsu(decodeAsciiReplace(k.raw))
      if (parsed !== null) gpsuMs = parsed
    }
  }
  if (scale === 0) scale = 1

  const coords = []
  for (const k of kvs) {
    const dv = new DataView(k.raw.buffer)
    if (k.key === 'GPS5' && k.sz >= 20) {
      for (let i = 0; i < k.rpt; i++) {
        const b = i * k.sz
        if (b + 20 > k.raw.length) break
        coords.push([i32(dv, b) / scale, i32(dv, b + 4) / scale])
      }
    } else if (k.key === 'GPS9' && k.sz >= 32) {
      for (let i = 0; i < k.rpt; i++) {
        const b = i * k.sz
        if (b + 32 > k.raw.length) break
        coords.push([i32(dv, b) / scale, i32(dv, b + 4) / scale])
      }
    }
  }

  if (!coords.length) return

  const n = coords.length
  const periodMs = 1000.0 / n
  const chunkStartMs = state.elapsedMs
  state.elapsedMs = chunkStartMs + n * periodMs

  if (gpsuMs !== null && state.firstGpsuMs === null) {
    state.firstGpsuMs = gpsuMs
    state.firstGpsuRelMs = chunkStartMs
  }

  coords.forEach(([lat, lon], i) => {
    pts.push({ lat, lon, relMs: chunkStartMs + i * periodMs })
  })
}

function parseDevc(bytes, off, end, pts, state) {
  let o = off
  while (o + 8 <= end) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const key = key4(bytes, o)
    const sz = bytes[o + 5]
    const rpt = u16(dv, o + 6)
    const dlen = sz * rpt
    const dpad = dlen === 0 ? 0 : Math.ceil(dlen / 4) * 4
    const ds = o + 8
    if (key === 'STRM') parseStrm(bytes, ds, ds + dlen, pts, state)
    if (dpad === 0) break
    o = ds + dpad
  }
}

function parseChunk(bytes, off, end, state) {
  const pts = []
  let o = off
  while (o + 8 <= end) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const key = key4(bytes, o)
    const sz = bytes[o + 5]
    const rpt = u16(dv, o + 6)
    const dlen = sz * rpt
    const dpad = dlen === 0 ? 0 : Math.ceil(dlen / 4) * 4
    const ds = o + 8
    if (key === 'DEVC') parseDevc(bytes, ds, ds + dlen, pts, state)
    if (dpad === 0) break
    o = ds + dpad
  }
  return pts
}

// ── mvhd fallback (video start time, used when no GPSU is found anywhere) ──

function getMvhdCreationMs(bytes) {
  const mvhd = bfind(bytes, 8, bytes.length, ['mvhd'])
  if (!mvhd) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const d = mvhd.d
  const version = bytes[d]
  const creationTime = version === 1
    ? u32(dv, d + 4) * 4294967296 + u32(dv, d + 8)
    : u32(dv, d + 4)
  const unixSeconds = creationTime - MAC_EPOCH_OFFSET
  return unixSeconds > 0 ? unixSeconds * 1000 : null
}

// ── Sample reads, coalesced ───────────────────────────────────────────────
//
// Each GPMF sample is a small (~KB) telemetry chunk, one per ~1s of footage —
// reading each with its own File.slice().arrayBuffer() call would mean
// thousands of separate async reads for a long survey. Nearby samples (within
// SAMPLE_MERGE_GAP of each other) are read together in one larger slice
// instead, then split back into per-sample views.

async function readGpmfSamples(file, samp) {
  const sorted = [...samp].sort((a, b) => a.o - b.o)
  const groups = []
  let cur = null
  for (const s of sorted) {
    if (cur && s.o - cur.end <= SAMPLE_MERGE_GAP) {
      cur.end = Math.max(cur.end, s.o + s.sz)
      cur.items.push(s)
    } else {
      cur = { start: s.o, end: s.o + s.sz, items: [s] }
      groups.push(cur)
    }
  }

  const bufByEntry = new Map()
  for (const g of groups) {
    const bytes = await readSlice(file, g.start, g.end - g.start)
    for (const s of g.items) {
      const relStart = s.o - g.start
      bufByEntry.set(s, bytes.subarray(relStart, relStart + s.sz))
    }
  }
  return samp.map(s => bufByEntry.get(s))
}

// ── Public entry point ────────────────────────────────────────────────────
//
// Returns a list of {ts, lat, lng} points (ts = epoch ms, UTC), sorted by ts.
// Returns [] when the file has no GoPro MET track or no GPS5/GPS9 samples
// could be decoded — never throws for that case, only for genuine read
// failures. Mirrors gpmf.py::extract_gps_from_video exactly.

export async function extractGpsFromVideo(file) {
  const moovInfo = await findMoov(file)
  if (!moovInfo) return []

  const moovBytes = await readSlice(file, moovInfo.off, moovInfo.size)
  const samp = getGpmfRanges(moovBytes)
  if (!samp || !samp.length) return []

  const buffers = await readGpmfSamples(file, samp)

  const state = { elapsedMs: 0, firstGpsuMs: null, firstGpsuRelMs: null }
  const rawPts = []
  for (const buf of buffers) {
    rawPts.push(...parseChunk(buf, 0, buf.length, state))
  }
  if (!rawPts.length) return []

  const offsetMs = state.firstGpsuMs !== null
    ? state.firstGpsuMs - state.firstGpsuRelMs
    : (getMvhdCreationMs(moovBytes) ?? 0)

  const points = rawPts.map(p => ({
    ts: Math.round(p.relMs + offsetMs),
    lat: Math.round(p.lat * 1e7) / 1e7,
    lng: Math.round(p.lon * 1e7) / 1e7,
  }))
  points.sort((a, b) => a.ts - b.ts)
  return points
}
