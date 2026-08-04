import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Button, Slider, Tooltip, Modal, Table, Progress, Tag, message, Spin, Row, Col, Divider, InputNumber, Input } from 'antd'
import { PlayCircleOutlined, PauseCircleOutlined, StepBackwardOutlined, StepForwardOutlined, AimOutlined, CheckOutlined, PlusOutlined, CloseOutlined, ScissorOutlined, ExclamationCircleOutlined } from '@ant-design/icons'
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { serverApi } from '../utils/api'
import { getGPSAtVideoTime, haversineMetres, formatVideoTime, nextSiteId, simplifyRoute } from '../utils/gps'
import { captureFrame, compareImages, getVideoRenderRect } from '../utils/imageCompare'

// ── Grabs the underlying Leaflet map instance into a ref, once ─────────────
function MapInstanceGrabber({ mapRef }) {
  const map = useMap()
  useEffect(() => { mapRef.current = map }, [map, mapRef])
  return null
}

function makeIcon(color, size = 12) {
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>`,
    iconSize: [size, size], iconAnchor: [size/2, size/2],
  })
}

const STEP_FRAME = 1/30 // ~1 frame at 30fps

export default function ReviewPage({ surveyData, inventory, onFinish, onPause, onInventoryUpdate }) {
  const { videoFile, videoName, videoPath, gpsPoints } = surveyData

  const videoRef  = useRef(null)
  const videoBoxRef = useRef(null)
  const [playing, setPlaying]       = useState(false)
  const [elapsed, setElapsed]       = useState(0)
  const [duration, setDuration]     = useState(0)
  const [currentGPS, setCurrentGPS] = useState(null)
  const [taggedSites, setTaggedSites] = useState([]) // sites tagged this session
  const [showTagModal, setShowTagModal] = useState(false)
  const [tagState, setTagState]     = useState(null)  // {capture, gps, candidates, step}
  const [comparing, setComparing]   = useState(false)
  const [compareProgress, setCompareProgress] = useState(0)
  const [radius, setRadius]         = useState(5)
  const [saving, setSaving]         = useState(false)
  const [zoomFrame, setZoomFrame]   = useState(null)
  const [videoError, setVideoError] = useState(null)
  const [brand, setBrand]           = useState('')
  const [productType, setProductType] = useState('')

  // ── Crop-to-billboard selection ──────────────────────────────────────────
  const [selectMode, setSelectMode] = useState(false)   // drag-to-select active
  const [cropRect, setCropRect]     = useState(null)    // {x,y,w,h} fractions of native video frame
  const [dragRect, setDragRect]     = useState(null)    // live rect while dragging (container px)
  const dragStartRef = useRef(null)
  const justSelectedRef = useRef(false)  // blocks the click that fires after a completed drag

  const videoUrl = videoPath
  const mapCenter = gpsPoints.length ? [gpsPoints[0].lat, gpsPoints[0].lng] : [20.5937, 78.9629]

  // ── Live-motion map refs ─────────────────────────────────────────────────
  // The marker/route/camera are moved imperatively (bypassing React render) so the
  // road stretch can glide smoothly at animation-frame rate instead of snapping
  // every ~250ms (the rate "timeupdate" fires at). React state (currentGPS/elapsed)
  // is still kept in sync for the on-screen text readouts and tagging logic.
  const leafletMapRef   = useRef(null)
  const markerRef       = useRef(null)
  const polylineRef     = useRef(null)
  const initialCenterRef   = useRef(mapCenter)   // stable — set once, never re-passed as a prop
  const initialPositionsRef = useRef([])         // stable — green Polyline starting positions (empty)

  // useMemo (not useRef) so react-leaflet sees a proper stable value on first render
  const fullRoutePositions = useMemo(() => gpsPoints.map(p => [p.lat, p.lng]), [gpsPoints])
  const routeInventory = useMemo(() => {
    const sample = gpsPoints.filter((_, i) => i % 10 === 0)
    if (!sample.length) return Object.values(inventory?.sites || {})
    return Object.values(inventory?.sites || {}).filter(s =>
      sample.some(p => haversineMetres(p.lat, p.lng, s.latitude, s.longitude) < 500)
    )
  }, [inventory, gpsPoints])
  const travelledLatLngsRef = useRef([])         // [lat,lng] points already passed
  const travelIdxRef        = useRef(0)          // cursor into gpsPoints
  const lastSyncedTsRef     = useRef(null)

  const syncMapToGPS = useCallback((gps) => {
    if (!gps || !gpsPoints.length) return

    // If we've jumped backward (seek/scrub back), rebuild the travelled trail from scratch.
    if (lastSyncedTsRef.current != null && gps.ts < lastSyncedTsRef.current - 250) {
      let cut = gpsPoints.findIndex(p => p.ts > gps.ts)
      if (cut === -1) cut = gpsPoints.length
      travelledLatLngsRef.current = gpsPoints.slice(0, cut).map(p => [p.lat, p.lng])
      travelIdxRef.current = cut
    }
    // Advance forward, appending any newly-passed GPS points.
    while (travelIdxRef.current < gpsPoints.length && gpsPoints[travelIdxRef.current].ts <= gps.ts) {
      travelledLatLngsRef.current.push([gpsPoints[travelIdxRef.current].lat, gpsPoints[travelIdxRef.current].lng])
      travelIdxRef.current++
    }
    lastSyncedTsRef.current = gps.ts

    const liveLatLng = [gps.lat, gps.lng]
    polylineRef.current?.setLatLngs([...travelledLatLngsRef.current, liveLatLng])
    markerRef.current?.setLatLng(liveLatLng)
    const map = leafletMapRef.current
    if (map) map.setView(liveLatLng, map.getZoom(), { animate: false })
  }, [gpsPoints])

  // ── Sync GPS with video time (text readouts, tagging, and a baseline map sync) ──
  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const t = v.currentTime
    setElapsed(t)
    const gps = getGPSAtVideoTime(gpsPoints, t)
    setCurrentGPS(gps)
    syncMapToGPS(gps)
  }, [gpsPoints, syncMapToGPS])

  // ── High-frequency map animation while playing ───────────────────────────
  // "timeupdate" only fires a few times/sec — far too choppy for a live-tracking
  // feel. While the video is playing, drive the marker/route/camera every frame.
  useEffect(() => {
    if (!playing) return
    let raf
    const tick = () => {
      const v = videoRef.current
      if (v) syncMapToGPS(getGPSAtVideoTime(gpsPoints, v.currentTime))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, gpsPoints, syncMapToGPS])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const syncDuration = () => {
      // GoPro files often report Infinity/NaN until enough of the file is parsed —
      // never let a stale "0" duration clamp seeks back to the start.
      if (Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration)
    }
    v.addEventListener('timeupdate', onTimeUpdate)
    v.addEventListener('loadedmetadata', syncDuration)
    v.addEventListener('durationchange', syncDuration)
    v.addEventListener('play',  () => setPlaying(true))
    v.addEventListener('pause', () => setPlaying(false))
    return () => {
      v.removeEventListener('timeupdate', onTimeUpdate)
      v.removeEventListener('loadedmetadata', syncDuration)
      v.removeEventListener('durationchange', syncDuration)
    }
  }, [onTimeUpdate])

  // Re-sync once after all react-leaflet refs are set (children effects run before parent).
  // Handles the race where timeupdate fired before polylineRef/markerRef were ready.
  useEffect(() => {
    const t = videoRef.current?.currentTime || 0
    const gps = getGPSAtVideoTime(gpsPoints, t)
    if (gps) syncMapToGPS(gps)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlay = async () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      try {
        await v.play()
      } catch (err) {
        if (err.name !== 'AbortError') {
          message.error(`Video playback failed: ${err.message}`)
        }
      }
    } else {
      v.pause()
    }
  }

  const seekTo = (secs, autoplay = false) => {
    const v = videoRef.current
    if (!v) return
    // Use a known finite duration if we have one; otherwise don't clamp the upper
    // bound at all (a stale "0" duration was previously forcing every seek back to 0).
    const max = duration > 0 ? duration : (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity)
    v.currentTime = Math.max(0, Math.min(max, secs))
    setElapsed(v.currentTime)
    if (autoplay) v.play()
  }

  const stepFrame = (dir) => { videoRef.current?.pause(); seekTo(elapsed + dir * STEP_FRAME) }

  // ── Tag Site ─────────────────────────────────────────────────────────────
  const handleTag = async (cropOverride = null) => {
    const v = videoRef.current
    if (!v) return
    v.pause()

    const cropToUse = cropOverride ?? cropRect
    const dataUrl = captureFrame(v, 1.0, cropToUse)

    // Convert to blob URL for <img> display — avoids CSP restrictions on data: URLs
    let captureUrl = dataUrl
    try {
      const [, b64] = dataUrl.split(',')
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
      captureUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
    } catch {}

    const gps = getGPSAtVideoTime(gpsPoints, elapsed)
    if (!gps) return message.error('No GPS data at this timestamp')

    // Route travelled up to this tag point (downsampled for storage in inventory.json)
    const route = simplifyRoute(gpsPoints.filter(p => p.ts <= gps.ts))

    // Search nearby inventory sites
    const allSites = Object.values(inventory?.sites || {})
    const nearby = allSites
      .map(s => {
        const distance = Math.round(haversineMetres(gps.lat, gps.lng, s.latitude, s.longitude))
        return { ...s, distance, gpsMatch: Math.max(0, Math.round((1 - distance / radius) * 100)) }
      })
      .filter(s => s.distance <= radius)
      .sort((a, b) => a.distance - b.distance)

    setTagState({ capture: dataUrl, captureUrl, gps, route, candidates: nearby, step: 'comparing', similarities: [] })
    setShowTagModal(true)

    if (nearby.length === 0) {
      setTagState(prev => ({ ...prev, step: 'nomatch' }))
      return
    }

    // Image comparison
    setComparing(true)
    const results = await Promise.all(nearby.map(async (site, i) => {
      const imgUrl = serverApi.imageUrl(site.master_image)
      let similarity = 0
      try {
        const r = await compareImages(dataUrl, imgUrl, p => setCompareProgress(Math.round(((i + p/100) / nearby.length) * 100)))
        similarity = r.score
      } catch (e) {
        console.warn('Image comparison failed:', e)
      }
      return { ...site, similarity, masterImageUrl: imgUrl }
    }))
    setComparing(false)
    setCompareProgress(0)
    results.sort((a, b) => b.similarity - a.similarity)
    setTagState(prev => ({ ...prev, step: 'results', similarities: results }))
  }

  // ── Save as new site ─────────────────────────────────────────────────────
  const saveNewSite = async () => {
    setSaving(true)
    try {
    const { capture, gps, route } = tagState
    const inv     = await serverApi.getInventory()
    const siteId  = nextSiteId(inv)
    const today   = new Date().toISOString().slice(0, 10)
    const filename = `site_master.jpg`
    const imagePath = `Sites/${siteId}/${filename}`

    await serverApi.saveImage(siteId, filename, capture)

    const newSite = {
      site_id:      siteId,
      latitude:     gps.lat,
      longitude:    gps.lng,
      created_at:   today,
      master_image: imagePath,
      surveys: [{
        survey_date:        today,
        image:              imagePath,
        video_file:         videoFile?.name ?? videoPath,
        timestamp_in_video: formatVideoTime(elapsed),
        real_world_time:    new Date(gps.ts).toLocaleTimeString('en-IN', { hour12: false }),
        route:              route || [],
        brand:              brand.trim() || null,
        product_type:       productType.trim() || null,
      }]
    }

    inv.sites[siteId] = newSite
    inv.total_sites = Object.keys(inv.sites).length
    await serverApi.putInventory(inv)

    setTaggedSites(prev => [...prev, { siteId, type: 'new', lat: gps.lat, lng: gps.lng }])
    closeTagModal()
    onInventoryUpdate()
    message.success(`New site created: ${siteId}`)
    } finally {
      setSaving(false)
    }
  }

  // ── Tag to existing site ─────────────────────────────────────────────────
  const saveToExisting = async (site) => {
    setSaving(true)
    try {
    const { capture, gps, route } = tagState
    const inv  = await serverApi.getInventory()
    const today = new Date().toISOString().slice(0, 10)
    const surveyImg = `survey_${today.replace(/-/g,'')}_${Date.now()}.jpg`

    await serverApi.saveImage(site.site_id, surveyImg, capture)

    const existing = inv.sites[site.site_id]
    if (!existing.surveys) existing.surveys = []
    existing.surveys.push({
      survey_date:        today,
      image:              `Sites/${site.site_id}/${surveyImg}`,
      video_file:         videoFile?.name ?? videoPath,
      timestamp_in_video: formatVideoTime(elapsed),
      real_world_time:    new Date(gps.ts).toLocaleTimeString('en-IN', { hour12: false }),
      route:              route || [],
      brand:              brand.trim() || null,
      product_type:       productType.trim() || null,
    })
    await serverApi.putInventory(inv)

    setTaggedSites(prev => [...prev, { siteId: site.site_id, type: 'existing', lat: gps.lat, lng: gps.lng }])
    closeTagModal()
    onInventoryUpdate()
    message.success(`Survey added to ${site.site_id}`)
    } finally {
      setSaving(false)
    }
  }

  const realTime = currentGPS ? new Date(currentGPS.ts).toLocaleTimeString('en-IN', { hour12: false }) : '--:--:--'

  // ── Crop-to-billboard drag handlers ──────────────────────────────────────
  const clientToContainerPx = (e) => {
    const box = videoBoxRef.current.getBoundingClientRect()
    return { x: e.clientX - box.left, y: e.clientY - box.top, box }
  }

  const onSelectMouseDown = (e) => {
    if (!selectMode) return
    e.preventDefault()
    const { x, y } = clientToContainerPx(e)
    dragStartRef.current = { x, y }
    setDragRect({ x, y, w: 0, h: 0 })
  }

  const onSelectMouseMove = (e) => {
    if (!selectMode || !dragStartRef.current) return
    const { x, y, box } = clientToContainerPx(e)
    const start = dragStartRef.current
    const cx = Math.max(0, Math.min(box.width, x))
    const cy = Math.max(0, Math.min(box.height, y))
    setDragRect({
      x: Math.min(start.x, cx), y: Math.min(start.y, cy),
      w: Math.abs(cx - start.x), h: Math.abs(cy - start.y),
    })
  }

  const onSelectMouseUp = () => {
    if (!selectMode || !dragStartRef.current || !dragRect) { dragStartRef.current = null; return }
    dragStartRef.current = null
    const v = videoRef.current
    if (!v || dragRect.w < 8 || dragRect.h < 8) { setDragRect(null); return } // ignore accidental clicks

    const render = getVideoRenderRect(v)
    // Clamp the drawn rectangle to the actual visible video area (excludes letterbox bars)
    const rx1 = Math.max(dragRect.x, render.x)
    const ry1 = Math.max(dragRect.y, render.y)
    const rx2 = Math.min(dragRect.x + dragRect.w, render.x + render.width)
    const ry2 = Math.min(dragRect.y + dragRect.h, render.y + render.height)

    if (rx2 - rx1 < 4 || ry2 - ry1 < 4) { setDragRect(null); return }

    const cr = {
      x: (rx1 - render.x) / render.width,
      y: (ry1 - render.y) / render.height,
      w: (rx2 - rx1) / render.width,
      h: (ry2 - ry1) / render.height,
    }
    setCropRect(cr)
    setDragRect(null)
    setSelectMode(false)
    justSelectedRef.current = true
    handleTag(cr)
  }

  // Where to draw the persistent crop-rect outline (container px), derived from the
  // stored fraction-based cropRect + the video's current rendered (letterboxed) area.
  const cropOverlayPx = (() => {
    const v = videoRef.current
    if (!cropRect || !v || !v.videoWidth) return null
    const render = getVideoRenderRect(v)
    return {
      left: render.x + cropRect.x * render.width,
      top: render.y + cropRect.y * render.height,
      width: cropRect.w * render.width,
      height: cropRect.h * render.height,
    }
  })()

  const closeTagModal = () => {
    if (tagState?.captureUrl?.startsWith('blob:')) URL.revokeObjectURL(tagState.captureUrl)
    setShowTagModal(false)
    setCropRect(null)
    setBrand('')
    setProductType('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>

      {/* Top bar */}
      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>Survey Review</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
          {videoName ?? videoFile?.name}
          <Tooltip title="Don't move, rename, or delete this video file until the survey is finished — it's read directly from its current location and never uploaded.">
            <ExclamationCircleOutlined style={{ color: 'var(--muted)', flexShrink: 0 }} />
          </Tooltip>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexShrink: 0 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Video Time</div>
            <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{formatVideoTime(elapsed)}</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Real Time (IST)</div>
            <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: 'var(--accent)' }}>{realTime}</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Lat / Lng</div>
            <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
              {currentGPS ? `${currentGPS.lat.toFixed(5)}, ${currentGPS.lng.toFixed(5)}` : '—'}
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tagged</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--green)' }}>{taggedSites.length}</div>
          </div>
          <Button
            onClick={() => { videoRef.current?.pause(); onPause() }}
            style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
          >
            Pause Survey
          </Button>
          <Button type="primary" onClick={() => { videoRef.current?.pause(); onFinish() }} style={{ background: 'var(--green)', borderColor: 'var(--green)', color: '#fff' }}>
            Save & Finish
          </Button>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', overflow: 'hidden' }}>

        {/* Left: Video */}
        <div style={{ display: 'flex', flexDirection: 'column', padding: 12, gap: 10, overflow: 'hidden', borderRight: '1px solid var(--border)' }}>
          {/* Video */}
          <div
            ref={videoBoxRef}
            style={{ flex: 1, background: '#000', borderRadius: 8, overflow: 'hidden', cursor: selectMode ? 'crosshair' : 'pointer', position: 'relative', minHeight: 0 }}
            onMouseDown={onSelectMouseDown}
            onMouseMove={onSelectMouseMove}
            onMouseUp={onSelectMouseUp}
          >
            <video
              ref={videoRef}
              src={videoUrl}
              preload="metadata"
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
              onClick={() => { if (justSelectedRef.current) { justSelectedRef.current = false; return } if (!selectMode) togglePlay() }}
              onError={(e) => {
                const code = e.currentTarget.error?.code
                const msgs = { 1: 'Video loading was aborted', 2: 'Network error while loading video', 3: 'Video decoding failed — codec may not be supported', 4: 'Video format not supported' }
                setVideoError(msgs[code] || 'Failed to load video')
              }}
            />

            {/* Video error overlay */}
            {videoError && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.75)' }}>
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '20px 24px', textAlign: 'center', maxWidth: 340 }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
                  <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>Video Error</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>{videoError}</div>
                  <Button size="small" onClick={() => { setVideoError(null); videoRef.current?.load() }}>Retry</Button>
                </div>
              </div>
            )}

            {/* Persistent crop-area outline (what will be captured) */}
            {cropOverlayPx && !selectMode && (
              <div style={{
                position: 'absolute', pointerEvents: 'none', boxSizing: 'border-box',
                left: cropOverlayPx.left, top: cropOverlayPx.top, width: cropOverlayPx.width, height: cropOverlayPx.height,
                border: '2px dashed var(--accent)', background: 'rgba(13,148,136,0.08)',
              }} />
            )}

            {/* Live drag rectangle while selecting */}
            {selectMode && dragRect && (
              <div style={{
                position: 'absolute', pointerEvents: 'none', boxSizing: 'border-box',
                left: dragRect.x, top: dragRect.y, width: dragRect.w, height: dragRect.h,
                border: '2px solid var(--accent)', background: 'rgba(13,148,136,0.15)',
              }} />
            )}

            {/* Select-mode hint */}
            {selectMode && (
              <div style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: 11, padding: '4px 8px', borderRadius: 6, pointerEvents: 'none' }}>
                Drag a box around the billboard
              </div>
            )}

            {/* Zoom overlay */}
            {zoomFrame && (
              <div onClick={() => setZoomFrame(null)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}>
                <img src={zoomFrame} alt="zoom" style={{ maxWidth: '90%', maxHeight: '90%', borderRadius: 6 }} />
              </div>
            )}
          </div>

          {/* Controls */}
          <div style={{ background: 'var(--surface2)', borderRadius: 8, padding: '10px 14px' }}>
            {/* Timeline */}
            <Slider
              min={0} max={duration || 100} step={0.1} value={elapsed}
              onChange={(v) => seekTo(v)}
              tooltip={{ formatter: formatVideoTime }}
              trackStyle={{ background: 'var(--accent)' }}
              handleStyle={{ borderColor: 'var(--accent)', background: 'var(--accent)' }}
              railStyle={{ background: 'var(--border)' }}
              style={{ marginBottom: 10 }}
            />

            {/* Playback buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
              <Tooltip title="Back 1 frame"><Button icon={<StepBackwardOutlined />} size="small" onClick={() => stepFrame(-1)} /></Tooltip>
              <Tooltip title="Back 5s"><Button size="small" onClick={() => seekTo(elapsed - 5)}>-5s</Button></Tooltip>

              <Button
                type="primary" size="large"
                icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                onClick={togglePlay}
                style={{ minWidth: 48 }}
              />

              <Tooltip title="Forward 5s"><Button size="small" onClick={() => seekTo(elapsed + 5)}>+5s</Button></Tooltip>
              <Tooltip title="Forward 1 frame"><Button icon={<StepForwardOutlined />} size="small" onClick={() => stepFrame(1)} /></Tooltip>

              <Tooltip title="Capture current frame (zoom)">
                <Button size="small" onClick={() => { videoRef.current?.pause(); setZoomFrame(captureFrame(videoRef.current, 0.92, cropRect)) }}>🔍 Zoom</Button>
              </Tooltip>

              <Tooltip title={cropRect ? 'Redraw the capture area' : 'Drag a box around the billboard to capture only that area'}>
                <Button
                  size="small" icon={<ScissorOutlined />}
                  type={selectMode ? 'primary' : 'default'}
                  onClick={() => { videoRef.current?.pause(); setSelectMode(s => !s) }}
                >
                  {cropRect ? 'Redo selection' : 'Select billboard'}
                </Button>
              </Tooltip>
              {cropRect && (
                <Tooltip title="Capture full frame again">
                  <Button size="small" icon={<CloseOutlined />} onClick={() => { setCropRect(null); setSelectMode(false) }} />
                </Tooltip>
              )}

              <Tooltip title={`Tag site (search within ${radius}m)`}>
                <Button
                  type="primary" icon={<AimOutlined />}
                  onClick={handleTag}
                  style={{ background: 'var(--green)', borderColor: 'var(--green)', color: '#fff', marginLeft: 8 }}
                >
                  Tag Site
                </Button>
              </Tooltip>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, justifyContent: 'center' }}>
              {cropRect && <span style={{ fontSize: 11, color: 'var(--accent)' }}>✂ Capturing billboard area only</span>}
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Search radius:</span>
              <InputNumber min={5} max={200} step={5} value={radius} onChange={setRadius} size="small" style={{ width: 70 }} />
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>metres</span>
            </div>
          </div>
        </div>

        {/* Right: Map */}
        <div style={{ position: 'relative', overflow: 'hidden' }}>
          <MapContainer center={mapCenter} zoom={16} style={{ width: '100%', height: '100%' }} zoomControl>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapInstanceGrabber mapRef={leafletMapRef} />

            {/* Full road stretch — static grey background, shows entire GPS route */}
            <Polyline positions={fullRoutePositions} pathOptions={{ color: '#6b7280', weight: 6, opacity: 0.85 }} />

            {/* Completed route — animated green, updated imperatively via polylineRef at 60fps */}
            <Polyline ref={polylineRef} positions={initialPositionsRef.current} pathOptions={{ color: '#22c55e', weight: 6, opacity: 0.9 }} />

            {/* Current position — moved imperatively via markerRef, glides at animation-frame rate while playing */}
            {gpsPoints.length > 0 && (
              <CircleMarker ref={markerRef} center={initialCenterRef.current} radius={8} pathOptions={{ color: '#fff', fillColor: 'var(--accent)', fillOpacity: 1, weight: 2 }}>
                {currentGPS && (
                  <Popup><span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{currentGPS.lat.toFixed(6)}<br />{currentGPS.lng.toFixed(6)}</span></Popup>
                )}
              </CircleMarker>
            )}

            {/* New sites tagged this session */}
            {taggedSites.filter(s => s.type === 'new').map((s, i) => (
              <Marker key={i} position={[s.lat, s.lng]} icon={makeIcon('#059669', 14)}>
                <Popup><strong style={{ fontFamily: 'var(--mono)' }}>{s.siteId}</strong><br /><span style={{ fontSize: 11, color: 'var(--muted)' }}>New site</span></Popup>
              </Marker>
            ))}

            {/* Inventory sites along this route */}
            {routeInventory.map(s => (
              <Marker key={s.site_id} position={[s.latitude, s.longitude]} icon={makeIcon('#94a3b8', 10)}>
                <Popup><strong style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{s.site_id}</strong></Popup>
              </Marker>
            ))}
          </MapContainer>

          {/* Map legend */}
          <div style={{ position: 'absolute', bottom: 12, left: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', zIndex: 1000, fontSize: 11 }}>
            {[['#6b7280','Full route'],['#22c55e','Completed route'],['#0d9488','Current position'],['#059669','New site (this session)'],['#94a3b8','Inventory (route)']].map(([c,l]) => (
              <div key={l} style={{ display:'flex', alignItems:'center', gap:6, marginBottom: 3 }}>
                <div style={{ width:8,height:8,borderRadius:'50%',background:c,border:'1px solid var(--border)',flexShrink:0 }} />
                <span style={{ color:'var(--muted)' }}>{l}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Tag Modal ── */}
      <Modal
        open={showTagModal}
        onCancel={() => closeTagModal()}
        title={<span style={{ color: 'var(--text)' }}>Tag OOH Site</span>}
        footer={null}
        width={780}
      >
        {tagState && (
          <div>
            {/* Captured frame */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>Captured frame · {formatVideoTime(elapsed)} → {realTime} IST</div>
              <img src={tagState.captureUrl} alt="capture" style={{ width: '100%', maxHeight: 220, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
              <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                📍 {tagState.gps?.lat?.toFixed(6)}, {tagState.gps?.lng?.toFixed(6)}
              </div>
            </div>

            {/* Brand / Product type (optional — describes what's currently on the billboard) */}
            <Row gutter={12} style={{ marginBottom: 4 }}>
              <Col span={12}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Brand (optional)</div>
                <Input placeholder="e.g. Coca-Cola" value={brand} onChange={e => setBrand(e.target.value)} />
              </Col>
              <Col span={12}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Product Type (optional)</div>
                <Input placeholder="e.g. Soft Drink" value={productType} onChange={e => setProductType(e.target.value)} />
              </Col>
            </Row>

            <Divider style={{ borderColor: 'var(--border)', margin: '12px 0' }} />

            {/* Comparing */}
            {tagState.step === 'comparing' && (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <Spin size="large" />
                <div style={{ marginTop: 12, color: 'var(--muted)' }}>Comparing with {tagState.candidates.length} nearby site{tagState.candidates.length !== 1 ? 's' : ''}…</div>
                {comparing && <Progress percent={compareProgress} strokeColor="var(--accent)" trailColor="var(--border)" style={{ marginTop: 12 }} />}
              </div>
            )}

            {/* No match */}
            {tagState.step === 'nomatch' && (
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>No sites within {radius}m</div>
                <div style={{ color: 'var(--muted)', marginBottom: 20 }}>This appears to be a new OOH site.</div>
                <Button type="primary" icon={<PlusOutlined />} onClick={saveNewSite} size="large" loading={saving} disabled={saving}>Create New Site</Button>
              </div>
            )}

            {/* Results */}
            {tagState.step === 'results' && (
              <>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
                    {tagState.similarities.length} nearby site{tagState.similarities.length !== 1 ? 's' : ''} found
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>Select a match or create a new site</div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16, maxHeight: 420, overflowY: 'auto' }}>
                  {tagState.similarities.map(site => {
                    const scoreColor = (v) => v >= 70 ? '#059669' : v >= 50 ? '#d97706' : '#6b7280'
                    return (
                      <div key={site.site_id} style={{ padding: '12px 14px', background: 'var(--surface2)', border: `1px solid ${site.similarity >= 70 ? 'rgba(5,150,105,0.4)' : 'var(--border)'}`, borderRadius: 10 }}>
                        {/* Header row */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                          <span className="mono" style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{site.site_id}</span>
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{site.distance}m away</span>
                          <Button type="primary" icon={<CheckOutlined />} onClick={() => saveToExisting(site)} size="small" loading={saving} disabled={saving} style={{ marginLeft: 'auto' }}>
                            Tag Here
                          </Button>
                        </div>

                        {/* Side-by-side images */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                          <div>
                            <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 3 }}>Captured</div>
                            <img src={tagState.captureUrl} alt="captured" style={{ width: '100%', height: 130, objectFit: 'contain', background: '#000', borderRadius: 6, border: '1px solid var(--border)' }} />
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 3 }}>Inventory — {site.site_id}</div>
                            <img src={site.masterImageUrl} alt={site.site_id} style={{ width: '100%', height: 130, objectFit: 'contain', background: '#000', borderRadius: 6, border: '1px solid var(--border)' }} />
                          </div>
                        </div>

                        {/* Score bars */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                          {[['GPS Match', site.gpsMatch], ['Visual Match', site.similarity]].map(([label, val]) => (
                            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 11, color: 'var(--muted)', width: 90, flexShrink: 0 }}>{label}</span>
                              <Progress percent={val} size="small" strokeColor={scoreColor(val)} trailColor="var(--border)" style={{ flex: 1, margin: 0 }} />
                            </div>
                          ))}
                        </div>

                        {/* Site details */}
                        <div style={{ fontSize: 11, color: 'var(--muted)', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                          <span className="mono">📍 {site.latitude?.toFixed(5)}, {site.longitude?.toFixed(5)}</span>
                          <span style={{ margin: '0 8px' }}>·</span>
                          <span>Created {site.created_at}</span>
                          {site.landmark && <><span style={{ margin: '0 8px' }}>·</span><span>{site.landmark}</span></>}
                          <span style={{ margin: '0 8px' }}>·</span>
                          <span>{site.surveys?.length ?? 0} survey{(site.surveys?.length ?? 0) !== 1 ? 's' : ''}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>

                <Divider style={{ borderColor: 'var(--border)', margin: '8px 0 12px' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>None of these match?</div>
                  <Button icon={<PlusOutlined />} onClick={saveNewSite} loading={saving} disabled={saving}>Create New Site Instead</Button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
