import { useState, useEffect } from 'react'
import { Button, Card, Row, Col, Alert, message, Input } from 'antd'
import {
  FolderOpenOutlined, VideoCameraOutlined,
  AppstoreOutlined, CheckCircleOutlined, EditOutlined,
} from '@ant-design/icons'
import { serverApi } from '../utils/api'

export default function HomePage({ onFolderSet, inventory, folderSet, onNav }) {
  const [loading, setLoading]       = useState(false)
  const [folderPath, setFolderPath] = useState(null)
  const [showChange, setShowChange] = useState(false)
  const [manualPath, setManualPath] = useState('')

  // Load the auto-initialised folder path on mount
  useEffect(() => {
    serverApi.getFolder().then(f => {
      if (f.path) { setFolderPath(f.path); if (!folderSet) onFolderSet() }
    }).catch(() => {})
  }, [])

  const handlePickFolder = async () => {
    setLoading(true)
    try {
      const res = await serverApi.pickFolder()
      setFolderPath(res.path)
      setShowChange(false)
      onFolderSet()
      message.success(`Inventory folder updated: ${res.name}`)
    } catch (e) {
      const detail = e?.response?.data?.detail || ''
      if (detail !== 'No folder selected') {
        message.warning('Could not open folder browser. Enter path manually below.')
        setShowChange(true)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleManualPath = async () => {
    if (!manualPath.trim()) return message.error('Enter a folder path')
    setLoading(true)
    try {
      const res = await serverApi.setFolder(manualPath.trim())
      setFolderPath(res.path)
      setShowChange(false)
      setManualPath('')
      onFolderSet()
      message.success(`Inventory folder set: ${res.name}`)
    } catch (e) {
      message.error(e?.response?.data?.detail || 'Folder not found — check the path')
    } finally {
      setLoading(false)
    }
  }

  const sites      = Object.values(inventory?.sites || {})
  const surveys    = sites.flatMap(s => s.surveys || [])
  const lastSurvey = surveys.sort((a, b) => new Date(b.survey_date) - new Date(a.survey_date))[0]

  return (
    <div className="page-wrap" style={{ maxWidth: 860 }}>
      {/* Header */}
      <div style={{ marginBottom: 36 }}>
        <div className="section-label">AdMavin OOH Platform</div>
        <h1 style={{ fontSize: 30, fontWeight: 800, color: 'var(--text)', lineHeight: 1.25, marginBottom: 10 }}>
          Site Discovery &<br />Inventory Manager
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, maxWidth: 480 }}>
          Upload weekly survey videos and GPS data, manually tag OOH sites, and
          build your inventory — all stored locally on your laptop.
        </p>
      </div>

      {/* Inventory folder — compact display with optional change */}
      <Card style={{ marginBottom: 24 }}>
        <div className="section-label" style={{ marginBottom: 10 }}>Inventory Folder</div>

        {folderPath ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <CheckCircleOutlined style={{ color: 'var(--green)', fontSize: 18, flexShrink: 0 }} />
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)',
              background: 'var(--surface2)', padding: '4px 10px', borderRadius: 6,
              border: '1px solid var(--border)', flex: 1, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {folderPath}
            </span>
            <Button
              size="small" icon={<EditOutlined />} onClick={() => setShowChange(v => !v)}
              style={{ flexShrink: 0 }}
            >
              Change
            </Button>
          </div>
        ) : (
          <Alert type="warning" showIcon message="Connecting to server…" style={{ marginBottom: 0 }} />
        )}

        {/* Change folder panel */}
        {showChange && (
          <div style={{ marginTop: 14, padding: '14px 16px', background: 'var(--surface2)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
              <Button type="primary" icon={<FolderOpenOutlined />} loading={loading} onClick={handlePickFolder}>
                Browse for folder
              </Button>
              <span style={{ fontSize: 12, color: 'var(--muted)', alignSelf: 'center' }}>
                Opens a folder browser on your computer
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
              Or enter path manually:
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input
                value={manualPath}
                onChange={e => setManualPath(e.target.value)}
                onPressEnter={handleManualPath}
                placeholder={navigator.platform?.includes('Win') ? 'D:\\Adex\\OOH_Inventory' : '~/OOH_Inventory'}
                style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
              />
              <Button onClick={handleManualPath} loading={loading}>Set</Button>
            </div>
          </div>
        )}
      </Card>

      {/* Stats */}
      <Row gutter={16} style={{ marginBottom: 20 }}>
        {[
          { title: 'Total Sites',   value: inventory?.total_sites || 0,   color: 'var(--accent)' },
          { title: 'Total Surveys', value: surveys.length,                  color: 'var(--blue)'   },
          { title: 'Last Survey',
            value: lastSurvey
              ? new Date(lastSurvey.survey_date).toLocaleDateString('en-IN')
              : '—',
            color: 'var(--green)', mono: true },
        ].map(({ title, value, color, mono }) => (
          <Col span={8} key={title}>
            <Card>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{title}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color, fontFamily: mono ? 'var(--mono)' : undefined }}>{value}</div>
            </Card>
          </Col>
        ))}
      </Row>

      {/* Quick-action cards */}
      <Row gutter={16}>
        <Col span={12}>
          <Card hoverable onClick={() => onNav('upload')}
            style={{ cursor: 'pointer', borderColor: 'rgba(13,148,136,0.35)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 46, height: 46, borderRadius: 10, background: 'rgba(13,148,136,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <VideoCameraOutlined style={{ fontSize: 22, color: 'var(--accent)' }} />
              </div>
              <div>
                <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>Start New Survey</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>Upload video + GPS CSV and tag sites</div>
              </div>
            </div>
          </Card>
        </Col>
        <Col span={12}>
          <Card hoverable onClick={() => onNav('inventory')}
            style={{ cursor: 'pointer', borderColor: 'rgba(8,145,178,0.35)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 46, height: 46, borderRadius: 10, background: 'rgba(8,145,178,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <AppstoreOutlined style={{ fontSize: 22, color: 'var(--blue)' }} />
              </div>
              <div>
                <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>View Inventory</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{inventory?.total_sites || 0} sites — browse and manage</div>
              </div>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
