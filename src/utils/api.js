import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

export const serverApi = {
  health:        ()           => api.get('/health').then(r => r.data),
  pickFolder:    ()           => api.post('/pick-folder').then(r => r.data),
  setFolder:     (path)       => api.post('/set-folder', { path }).then(r => r.data),
  getFolder:     ()           => api.get('/folder').then(r => r.data),
  getInventory:  ()           => api.get('/inventory').then(r => r.data),
  putInventory:  (data)       => api.put('/inventory', data).then(r => r.data),

  saveGps: (name, points) =>
    api.post('/save-gps', { name, points }).then(r => r.data).catch(() => null), // best-effort, nothing reads this CSV back today

  saveImage:  (siteId, filename, dataUrl) =>
    api.post('/save-image', { site_id: siteId, filename, data: dataUrl }).then(r => r.data),

  imageUrl:   (path) => path ? `/api/image?path=${encodeURIComponent(path)}` : null,

  deleteSiteFiles: (site_id) => api.post('/delete-site-files', { site_id }).then(r => r.data),
}

export default serverApi
