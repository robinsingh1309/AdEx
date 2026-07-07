const SZ = 64

function loadImg(src) {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = rej
    img.src = src
  })
}

function imgData(img) {
  const c = document.createElement('canvas')
  c.width = c.height = SZ
  c.getContext('2d').drawImage(img, 0, 0, SZ, SZ)
  return c.getContext('2d').getImageData(0, 0, SZ, SZ).data
}

function histogram(d) {
  const h = { r: new Array(64).fill(0), g: new Array(64).fill(0), b: new Array(64).fill(0) }
  for (let i = 0; i < d.length; i += 4) {
    h.r[Math.floor(d[i]/4)]++
    h.g[Math.floor(d[i+1]/4)]++
    h.b[Math.floor(d[i+2]/4)]++
  }
  return h
}

function histSim(h1, h2) {
  let s = 0, t = 0
  for (const ch of ['r','g','b']) for (let i = 0; i < 64; i++) { s += Math.min(h1[ch][i], h2[ch][i]); t += Math.max(h1[ch][i], h2[ch][i]) }
  return t ? s/t : 0
}

function structSim(d1, d2) {
  let diff = 0
  for (let i = 0; i < d1.length; i += 4)
    diff += (Math.abs(d1[i]-d2[i]) + Math.abs(d1[i+1]-d2[i+1]) + Math.abs(d1[i+2]-d2[i+2])) / (255*3)
  return 1 - diff / (d1.length/4)
}

export async function compareImages(src1, src2, onProgress) {
  onProgress?.(10)
  const [i1, i2] = await Promise.all([loadImg(src1), loadImg(src2)])
  onProgress?.(50)
  const d1 = imgData(i1), d2 = imgData(i2)
  const score = (histSim(histogram(d1), histogram(d2)) * 0.5 + structSim(d1, d2) * 0.5) * 100
  const r1 = i1.naturalWidth / (i1.naturalHeight || 1)
  const r2 = i2.naturalWidth / (i2.naturalHeight || 1)
  const dimMatch = Math.round(Math.min(r1, r2) / Math.max(r1, r2) * 100)
  onProgress?.(100)
  return {
    score: Math.round(Math.min(100, Math.max(0, score))),
    capturedRatio: i1.naturalWidth / (i1.naturalHeight || 1),
    inventoryRatio: i2.naturalWidth / (i2.naturalHeight || 1),
  }
}

// crop: optional {x,y,w,h} as fractions (0-1) of the native video frame.
// When provided, only that sub-region is drawn/captured (used to crop in on a billboard).
export function captureFrame(videoEl, quality = 0.92, crop = null) {
  const vw = videoEl.videoWidth || 1280
  const vh = videoEl.videoHeight || 720
  const c = document.createElement('canvas')

  if (crop) {
    const sx = Math.round(crop.x * vw), sy = Math.round(crop.y * vh)
    const sw = Math.max(1, Math.round(crop.w * vw)), sh = Math.max(1, Math.round(crop.h * vh))
    c.width = sw; c.height = sh
    c.getContext('2d').drawImage(videoEl, sx, sy, sw, sh, 0, 0, sw, sh)
  } else {
    c.width = vw; c.height = vh
    c.getContext('2d').drawImage(videoEl, 0, 0, vw, vh)
  }
  return c.toDataURL('image/jpeg', quality)
}

// Maps the actual rendered (letterboxed) video rectangle within its container,
// given object-fit: contain. Returns {x, y, width, height} in container-relative px.
export function getVideoRenderRect(videoEl) {
  const cw = videoEl.clientWidth, ch = videoEl.clientHeight
  const vw = videoEl.videoWidth || 16, vh = videoEl.videoHeight || 9
  const containerRatio = cw / ch
  const videoRatio = vw / vh
  let width, height, x, y
  if (videoRatio > containerRatio) {
    width = cw; height = cw / videoRatio
    x = 0; y = (ch - height) / 2
  } else {
    height = ch; width = ch * videoRatio
    y = 0; x = (cw - width) / 2
  }
  return { x, y, width, height }
}
