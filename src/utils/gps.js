export function getGPSAtVideoTime(points, elapsedSec) {
  if (!points?.length) return null
  const targetMs = points[0].ts + elapsedSec * 1000
  let before = points[0], after = points[points.length - 1]
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i].ts <= targetMs && points[i+1].ts >= targetMs) {
      before = points[i]; after = points[i+1]; break
    }
  }
  if (before.ts === after.ts) return { lat: before.lat, lng: before.lng, ts: targetMs }
  const ratio = (targetMs - before.ts) / (after.ts - before.ts)
  return { lat: before.lat + ratio*(after.lat-before.lat), lng: before.lng + ratio*(after.lng-before.lng), ts: targetMs }
}

export function haversineMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const φ1 = lat1*Math.PI/180, φ2 = lat2*Math.PI/180
  const Δφ = (lat2-lat1)*Math.PI/180, Δλ = (lng2-lng1)*Math.PI/180
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

export function formatVideoTime(secs) {
  const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60), s = Math.floor(secs%60)
  if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
}

// Downsample a list of {lat,lng,...} points to at most maxPoints [lat,lng] pairs,
// so we don't dump thousands of raw GPS rows into inventory.json per tagged site.
export function simplifyRoute(points, maxPoints = 300) {
  if (!points || points.length === 0) return []
  const round = p => [+p.lat.toFixed(6), +p.lng.toFixed(6)]
  if (points.length <= maxPoints) return points.map(round)
  const stride = points.length / maxPoints
  const out = []
  for (let i = 0; i < maxPoints; i++) out.push(round(points[Math.floor(i * stride)]))
  out.push(round(points[points.length - 1]))
  return out
}

export function nextSiteId(inventory) {
  const nums = Object.keys(inventory.sites||{}).map(k=>parseInt(k.replace('SITE',''),10)).filter(n=>!isNaN(n))
  const max = nums.length ? Math.max(...nums) : 0
  return `SITE${String(max+1).padStart(4,'0')}`
}
