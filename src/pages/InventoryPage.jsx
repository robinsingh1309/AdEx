import { useState, useEffect } from 'react'
import { Table, Button, Modal, Form, Input, InputNumber, Upload, message, Tag, Descriptions, Image, Divider, Empty, Popconfirm, Row, Col, Card, Alert } from 'antd'
import { PlusOutlined, EnvironmentOutlined, HistoryOutlined, EditOutlined, DeleteOutlined, InboxOutlined } from '@ant-design/icons'
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { serverApi } from '../utils/api'
import { nextSiteId } from '../utils/gps'

function makeIcon(color = '#f0883e') {
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>`,
    iconSize: [14, 14], iconAnchor: [7, 7],
  })
}

function PinPicker({ onPick }) {
  useMapEvents({ click: (e) => onPick(e.latlng) })
  return null
}

export default function InventoryPage({ inventory, onInventoryUpdate, folderSet }) {
  const [selectedSite, setSelectedSite]   = useState(null)
  const [showDetail, setShowDetail]       = useState(false)
  const [showAddModal, setShowAddModal]   = useState(false)
  const [addForm] = Form.useForm()
  const [addImage, setAddImage]           = useState(null) // base64
  const [saving, setSaving]               = useState(false)
  const [pinLatLng, setPinLatLng]         = useState(null)
  const [siteImages, setSiteImages]       = useState({}) // siteId -> [urls]
  const [mapCenter, setMapCenter]         = useState([20.5937, 78.9629])

  const sites = Object.values(inventory?.sites || {})

  if (!folderSet) {
    return (
      <div className="page-wrap">
        <Alert type="warning" message="Select an inventory folder on the Home page before managing inventory." showIcon />
      </div>
    )
  }

  useEffect(() => {
    if (sites.length > 0) setMapCenter([sites[0].latitude, sites[0].longitude])
  }, [inventory])

  // Load images for a site
  const loadSiteImages = async (site) => {
    const urls = []
    for (const survey of site.surveys || []) {
      const url = serverApi.imageUrl(survey.image)
      if (url) urls.push({ url, date: survey.survey_date, time: survey.real_world_time, video: survey.video_file, videoTime: survey.timestamp_in_video })
    }
    setSiteImages(prev => ({ ...prev, [site.site_id]: urls }))
  }

  const openDetail = (site) => {
    setSelectedSite(site)
    setShowDetail(true)
    loadSiteImages(site)
  }

  // ── Delete site (soft-delete → trash) ────────────────────────────────────
  const deleteSite = async (siteId) => {
    const inv = await serverApi.getInventory()
    if (!inv.trash) inv.trash = {}
    inv.trash[siteId] = { ...inv.sites[siteId], deleted_at: new Date().toISOString().slice(0, 10) }
    delete inv.sites[siteId]
    inv.total_sites = Object.keys(inv.sites).length
    await serverApi.putInventory(inv)
    onInventoryUpdate()
    setShowDetail(false)
    message.success(`${siteId} moved to Trash`)
  }

  // ── Add site manually ────────────────────────────────────────────────────
  const handleAddSite = async () => {
    const vals = await addForm.validateFields()
    setSaving(true)
    try {
      const inv    = await serverApi.getInventory()
      const siteId = nextSiteId(inv)
      const today  = new Date().toISOString().slice(0, 10)
      let masterImagePath = null

      if (addImage) {
        await serverApi.saveImage(siteId, 'site_master.jpg', addImage)
        masterImagePath = `Sites/${siteId}/site_master.jpg`
      }

      inv.sites[siteId] = {
        site_id:      siteId,
        latitude:     vals.lat  || pinLatLng?.lat  || 0,
        longitude:    vals.lng  || pinLatLng?.lng  || 0,
        landmark:     vals.landmark || '',
        created_at:   today,
        master_image: masterImagePath,
        surveys: [],
      }
      inv.total_sites = Object.keys(inv.sites).length
      await serverApi.putInventory(inv)
      onInventoryUpdate()
      setShowAddModal(false)
      addForm.resetFields()
      setAddImage(null)
      setPinLatLng(null)
      message.success(`${siteId} added to inventory`)
    } catch (e) {
      message.error('Failed to save site')
    } finally {
      setSaving(false)
    }
  }

  // ── Table columns ────────────────────────────────────────────────────────
  const columns = [
    {
      title: 'Site ID', dataIndex: 'site_id', key: 'site_id',
      render: v => <span className="mono" style={{ fontWeight: 700, color: 'var(--accent)' }}>{v}</span>,
      width: 110,
    },
    {
      title: 'Landmark / Area', dataIndex: 'landmark', key: 'landmark',
      render: v => v || <span style={{ color: 'var(--muted)' }}>—</span>,
    },
    {
      title: 'Coordinates', key: 'coords',
      render: (_, r) => <span className="mono" style={{ fontSize: 11 }}>{r.latitude.toFixed(5)}, {r.longitude.toFixed(5)}</span>,
    },
    {
      title: 'Surveys', key: 'surveys',
      render: (_, r) => <Tag color="blue">{r.surveys?.length || 0}</Tag>,
      width: 80,
    },
    {
      title: 'First Seen', dataIndex: 'created_at', key: 'created_at',
      render: v => <span style={{ fontSize: 12, color: 'var(--muted)' }}>{v}</span>,
      width: 110,
    },
    {
      title: '', key: 'action',
      render: (_, r) => <Button size="small" onClick={() => openDetail(r)}>View</Button>,
      width: 70,
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div>
          <div className="section-label">Inventory</div>
          <div style={{ fontWeight: 800, fontSize: 18, color: 'var(--text)' }}>{sites.length} site{sites.length !== 1 ? 's' : ''}</div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowAddModal(true)}>Add Site Manually</Button>
      </div>

      {/* Split: Table + Map */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', overflow: 'hidden' }}>

        {/* Table */}
        <div style={{ overflow: 'auto', borderRight: '1px solid var(--border)' }}>
          {sites.length === 0 ? (
            <Empty description={<span style={{ color: 'var(--muted)' }}>No sites yet. Run a survey or add one manually.</span>} style={{ padding: 60 }} />
          ) : (
            <Table
              dataSource={sites}
              rowKey="site_id"
              columns={columns}
              pagination={{ pageSize: 20, showTotal: t => `${t} sites` }}
              onRow={r => ({ onClick: () => openDetail(r), style: { cursor: 'pointer' } })}
              size="small"
            />
          )}
        </div>

        {/* Map */}
        <div style={{ overflow: 'hidden' }}>
          <MapContainer center={mapCenter} zoom={12} style={{ width: '100%', height: '100%' }}>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

            {/* Saved route(s) for the selected site, if any survey recorded one */}
            {selectedSite?.surveys?.filter(sv => sv.route?.length > 1).map((sv, i) => (
              <Polyline key={i} positions={sv.route} pathOptions={{ color: '#0891b2', weight: 3, opacity: 0.7 }} />
            ))}

            {sites.map(s => (
              <Marker key={s.site_id} position={[s.latitude, s.longitude]} icon={makeIcon(selectedSite?.site_id === s.site_id ? '#0d9488' : '#94a3b8')} eventHandlers={{ click: () => openDetail(s) }}>
                <Popup>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                    <strong style={{ color: 'var(--accent)' }}>{s.site_id}</strong>
                    {s.landmark && <div style={{ color: 'var(--muted)', fontSize: 11 }}>{s.landmark}</div>}
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{s.surveys?.length || 0} survey{(s.surveys?.length || 0) !== 1 ? 's' : ''}</div>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      </div>

      {/* ── Site Detail Modal ── */}
      <Modal
        open={showDetail}
        onCancel={() => setShowDetail(false)}
        title={<span className="mono" style={{ color: 'var(--accent)', fontSize: 16 }}>{selectedSite?.site_id}</span>}
        footer={null}
        width={700}
      >
        {selectedSite && (
          <div>
            {/* Master image */}
            {selectedSite.master_image && (
              <img
                src={serverApi.imageUrl(selectedSite.master_image)}
                alt="master"
                style={{ width: '100%', maxHeight: 220, objectFit: 'cover', borderRadius: 8, marginBottom: 16, border: '1px solid var(--border)' }}
              />
            )}

            <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Latitude">
                <span className="mono" style={{ color: 'var(--text)' }}>{selectedSite.latitude?.toFixed(6)}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Longitude">
                <span className="mono" style={{ color: 'var(--text)' }}>{selectedSite.longitude?.toFixed(6)}</span>
              </Descriptions.Item>
              {selectedSite.landmark && (
                <Descriptions.Item label="Landmark" span={2}>
                  <span style={{ color: 'var(--text)' }}>{selectedSite.landmark}</span>
                </Descriptions.Item>
              )}
              <Descriptions.Item label="First seen">
                <span style={{ color: 'var(--text)' }}>{selectedSite.created_at}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Total surveys">
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>{selectedSite.surveys?.length || 0}</span>
              </Descriptions.Item>
            </Descriptions>

            {/* Survey history */}
            {selectedSite.surveys?.length > 0 && (
              <>
                <Divider style={{ borderColor: 'var(--border)', margin: '12px 0' }}>
                  <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Survey History</span>
                </Divider>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {(siteImages[selectedSite.site_id] || []).map((item, i) => (
                    <div key={i} style={{ display: 'flex', gap: 12, padding: '10px', background: 'var(--surface2)', borderRadius: 8, border: '1px solid var(--border)' }}>
                      <img
                        src={item.url}
                        alt={`survey ${i+1}`}
                        style={{ width: 100, height: 70, objectFit: 'cover', borderRadius: 6, flexShrink: 0, border: '1px solid var(--border)', cursor: 'zoom-in' }}
                        onClick={() => window.open(item.url)}
                      />
                      <div style={{ fontSize: 12 }}>
                        <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Survey {i + 1}</div>
                        <div style={{ color: 'var(--muted)' }}>Date: <span className="mono" style={{ color: 'var(--text)' }}>{item.date}</span></div>
                        <div style={{ color: 'var(--muted)' }}>Time: <span className="mono" style={{ color: 'var(--accent)' }}>{item.time} IST</span></div>
                        <div style={{ color: 'var(--muted)' }}>Video: <span className="mono" style={{ color: 'var(--text)', fontSize: 11 }}>{item.videoTime}</span></div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
              <Popconfirm
                title={`Move ${selectedSite.site_id} to Trash?`}
                description="This moves it to Trash. You can restore it or permanently delete from the Trash tab."
                onConfirm={() => deleteSite(selectedSite.site_id)}
                okText="Move to Trash" cancelText="Cancel"
                okButtonProps={{ danger: true }}
              >
                <Button danger icon={<DeleteOutlined />}>Remove from Inventory</Button>
              </Popconfirm>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Add Site Manually Modal ── */}
      <Modal
        open={showAddModal}
        onCancel={() => { setShowAddModal(false); addForm.resetFields(); setPinLatLng(null); setAddImage(null) }}
        title={<span style={{ color: 'var(--text)' }}>Add Site Manually</span>}
        onOk={handleAddSite}
        okText="Save Site"
        confirmLoading={saving}
        width={660}
      >
        <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--muted)' }}>
          Drop a pin on the map or enter coordinates manually.
        </div>

        {/* Mini map for pin drop */}
        <div style={{ height: 220, borderRadius: 8, overflow: 'hidden', marginBottom: 16, border: '1px solid var(--border)' }}>
          <MapContainer center={mapCenter} zoom={12} style={{ width: '100%', height: '100%' }}>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <PinPicker onPick={(latlng) => {
              setPinLatLng(latlng)
              addForm.setFieldsValue({ lat: +latlng.lat.toFixed(6), lng: +latlng.lng.toFixed(6) })
            }} />
            {pinLatLng && (
              <Marker position={pinLatLng} icon={makeIcon('#3fb950')}>
                <Popup>New site location</Popup>
              </Marker>
            )}
          </MapContainer>
        </div>

        <Form form={addForm} layout="vertical" size="small">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="lat" label="Latitude" rules={[{ required: true, message: 'Required' }]}>
                <InputNumber style={{ width: '100%' }} step={0.0001} precision={6} placeholder="19.076123" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="lng" label="Longitude" rules={[{ required: true, message: 'Required' }]}>
                <InputNumber style={{ width: '100%' }} step={0.0001} precision={6} placeholder="72.877456" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="landmark" label="Landmark / Area (optional)">
            <Input placeholder="e.g. Andheri West, near station" />
          </Form.Item>
          <Form.Item label="Site Image (optional)">
            <Upload
              beforeUpload={(file) => {
                const reader = new FileReader()
                reader.onload = e => setAddImage(e.target.result)
                reader.readAsDataURL(file)
                return false
              }}
              showUploadList={false}
              accept="image/*"
            >
              <Button icon={<InboxOutlined />}>Choose image</Button>
            </Upload>
            {addImage && <img src={addImage} alt="preview" style={{ width: 120, height: 80, objectFit: 'cover', borderRadius: 6, marginTop: 8, border: '1px solid var(--border)' }} />}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
