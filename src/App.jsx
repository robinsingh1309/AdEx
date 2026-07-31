import { useState, useEffect } from 'react'
import { Layout, Menu, message } from 'antd'
import { HomeOutlined, PlusCircleOutlined, AppstoreOutlined, VideoCameraOutlined, DeleteOutlined } from '@ant-design/icons'
import HomePage from './pages/HomePage'
import UploadPage from './pages/UploadPage'
import ReviewPage from './pages/ReviewPage'
import InventoryPage from './pages/InventoryPage'
import TrashPage from './pages/TrashPage'
import { serverApi } from './utils/api'

const { Sider, Content } = Layout

export default function App() {
  const [page, setPage]           = useState('home')
  const [inventory, setInventory] = useState({ total_sites: 0, sites: {} })
  const [surveyData, setSurveyData] = useState(null)
  const [folderSet, setFolderSet] = useState(false)

  useEffect(() => {
    serverApi.getFolder().then(f => {
      if (f.path) { setFolderSet(true); refreshInventory() }
    }).catch(() => {})
  }, [])

  const refreshInventory = async () => {
    try { const inv = await serverApi.getInventory(); setInventory(inv) } catch {}
  }

  const onFolderSet = () => { setFolderSet(true); refreshInventory() }

  const startReview = (data) => {
    if (surveyData?.videoPath?.startsWith('blob:')) URL.revokeObjectURL(surveyData.videoPath)
    setSurveyData(data)
    setPage('review')
  }

  const finishReview = () => {
    if (surveyData?.videoPath?.startsWith('blob:')) URL.revokeObjectURL(surveyData.videoPath)
    setSurveyData(null)
    refreshInventory()
    setPage('inventory')
    message.success('Survey complete — inventory updated')
  }

  const nav = (key) => {
    if (key === 'review' && !surveyData) return
    setPage(key)
  }

  const menuItems = [
    { key: 'home',      label: 'Home',       icon: <HomeOutlined /> },
    { key: 'upload',    label: 'New Survey',  icon: <PlusCircleOutlined /> },
    { key: 'inventory', label: 'Inventory',   icon: <AppstoreOutlined /> },
    { key: 'trash',     label: 'Trash',       icon: <DeleteOutlined /> },
    ...(surveyData ? [{ key: 'review', label: 'Active Review', icon: <VideoCameraOutlined /> }] : []),
  ]

  const siteCount = inventory?.total_sites || 0

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={210} style={{ position: 'fixed', left: 0, top: 0, bottom: 0, zIndex: 100, display: 'flex', flexDirection: 'column' }}>
        {/* Logo */}
        <div style={{ padding: '20px 16px 14px', borderBottom: '1px solid var(--border)', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: 'linear-gradient(135deg,var(--accent),#0e7490)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 11, color: '#fff', flexShrink: 0, letterSpacing: '-0.02em' }}>OOH</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)', lineHeight: 1.2 }}>Survey Platform</div>
              <div style={{ fontSize: 10, color: 'var(--muted)' }}>AdMavin · Local</div>
            </div>
          </div>
        </div>

        <Menu mode="inline" selectedKeys={[page]} items={menuItems} onClick={({ key }) => nav(key)} style={{ flex: 1, padding: '0 4px' }} />

        {/* Active survey pill */}
        {surveyData && (
          <div onClick={() => setPage('review')} style={{ margin: '8px 12px', padding: '9px 12px', background: 'rgba(13,148,136,0.08)', border: '1px solid rgba(13,148,136,0.25)', borderRadius: 8, cursor: 'pointer' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', marginBottom: 2, letterSpacing: '0.08em' }}>● SURVEY IN PROGRESS</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{surveyData.videoFile?.name}</div>
          </div>
        )}

        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--muted)' }}>
          {folderSet ? `${siteCount} site${siteCount !== 1 ? 's' : ''} in inventory` : 'No folder selected'}
        </div>
      </Sider>

      <Content style={{ marginLeft: 210, minHeight: '100vh', overflow: 'auto' }}>
        {/* ReviewPage stays mounted while a survey is in progress to preserve video position and blob URL */}
        {surveyData && (
          <div style={{ display: page === 'review' ? 'block' : 'none', height: '100%' }}>
            <ReviewPage surveyData={surveyData} inventory={inventory} onFinish={finishReview} onPause={() => setPage('inventory')} onInventoryUpdate={refreshInventory} />
          </div>
        )}
        {page === 'review'    && !surveyData && <div style={{ padding: 48, textAlign: 'center', color: 'var(--muted)' }}>No active survey. <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => setPage('upload')}>Upload one first →</span></div>}
        {page === 'home'      && <HomePage onFolderSet={onFolderSet} inventory={inventory} folderSet={folderSet} onNav={setPage} />}
        {page === 'upload'    && <UploadPage onStartReview={startReview} />}
        {page === 'inventory' && <InventoryPage inventory={inventory} onInventoryUpdate={refreshInventory} folderSet={folderSet} />}
        {page === 'trash'     && <TrashPage inventory={inventory} onInventoryUpdate={refreshInventory} folderSet={folderSet} />}
      </Content>
    </Layout>
  )
}
