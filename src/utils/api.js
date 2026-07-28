import axios from 'axios'
const api = axios.create({ baseURL: '/api' })

export const serverApi = {
  health:        ()           => api.get('/health').then(r => r.data),
  getFolder:     ()           => api.get('/folder').then(r => r.data),
  getInventory:  ()           => api.get('/inventory').then(r => r.data),
  putInventory:  (data)       => api.put('/inventory', data).then(r => r.data),

  uploadVideo: (file, onUploadProgress) => {
    const form = new FormData()
    form.append('file', file)
    return api.post('/upload/video', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress,
    }).then(r => r.data)
  },

  extractGps: (videoPath) => api.post('/extract-gps', { video_path: videoPath }).then(r => r.data),

  // Used to clean up an uploaded video that turned out to have no GPS telemetry
  deleteUploadedVideo: (videoPath) => api.post('/delete-video', { video_path: videoPath }).then(r => r.data),

  saveImage:  (siteId, filename, dataUrl) =>
    api.post('/save-image', { site_id: siteId, filename, data: dataUrl }).then(r => r.data),

  imageUrl:   (path) => path ? `/api/image?path=${encodeURIComponent(path)}` : null,
  videoUrl:   (path) => path ? `/api/video?path=${encodeURIComponent(path)}` : null,

  deleteSiteFiles: (site_id) => api.post('/delete-site-files', { site_id }).then(r => r.data),
}

export default serverApi