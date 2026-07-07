import { useState } from 'react'
import { Table, Button, Popconfirm, message, Empty, Tag, Alert } from 'antd'
import { DeleteOutlined, UndoOutlined } from '@ant-design/icons'
import { serverApi } from '../utils/api'

export default function TrashPage({ inventory, onInventoryUpdate, folderSet }) {
  const [loading, setLoading] = useState(false)

  const trashItems = Object.values(inventory?.trash || {})

  const restoreSite = async (siteId) => {
    setLoading(true)
    try {
      const inv = await serverApi.getInventory()
      if (!inv.trash?.[siteId]) { message.error('Site not found in trash'); return }
      const site = { ...inv.trash[siteId] }
      delete site.deleted_at
      inv.sites[siteId] = site
      inv.total_sites = Object.keys(inv.sites).length
      delete inv.trash[siteId]
      await serverApi.putInventory(inv)
      onInventoryUpdate()
      message.success(`${siteId} restored to Inventory`)
    } catch {
      message.error('Restore failed')
    } finally {
      setLoading(false)
    }
  }

  const permanentDelete = async (siteId) => {
    setLoading(true)
    try {
      const inv = await serverApi.getInventory()
      delete inv.trash[siteId]
      await serverApi.putInventory(inv)
      await serverApi.deleteSiteFiles(siteId)
      onInventoryUpdate()
      message.success(`${siteId} permanently deleted`)
    } catch {
      message.error('Delete failed')
    } finally {
      setLoading(false)
    }
  }

  const columns = [
    {
      title: 'Site ID', dataIndex: 'site_id', key: 'site_id', width: 110,
      render: v => <span className="mono" style={{ fontWeight: 700, color: 'var(--danger)' }}>{v}</span>,
    },
    {
      title: 'Landmark / Area', dataIndex: 'landmark', key: 'landmark',
      render: v => v || <span style={{ color: 'var(--muted)' }}>—</span>,
    },
    {
      title: 'Surveys', key: 'surveys', width: 80,
      render: (_, r) => <Tag color="default">{r.surveys?.length || 0}</Tag>,
    },
    {
      title: 'Deleted On', dataIndex: 'deleted_at', key: 'deleted_at', width: 120,
      render: v => <span style={{ fontSize: 12, color: 'var(--muted)' }}>{v}</span>,
    },
    {
      title: '', key: 'actions', width: 220,
      render: (_, r) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <Popconfirm
            title={`Restore ${r.site_id}?`}
            description="Move back to active inventory."
            onConfirm={() => restoreSite(r.site_id)}
            okText="Restore"
          >
            <Button size="small" icon={<UndoOutlined />}>Restore</Button>
          </Popconfirm>
          <Popconfirm
            title={`Permanently delete ${r.site_id}?`}
            description="Removes all images from disk. This cannot be undone."
            onConfirm={() => permanentDelete(r.site_id)}
            okText="Delete Forever"
            okButtonProps={{ danger: true }}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>Delete Forever</Button>
          </Popconfirm>
        </div>
      ),
    },
  ]

  if (!folderSet) {
    return (
      <div className="page-wrap">
        <Alert type="warning" message="Select an inventory folder on the Home page first." showIcon />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div className="section-label" style={{ color: 'var(--danger)' }}>Trash</div>
        <div style={{ fontWeight: 800, fontSize: 18, color: 'var(--text)' }}>
          {trashItems.length} deleted site{trashItems.length !== 1 ? 's' : ''}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px' }}>
        {trashItems.length === 0 ? (
          <Empty
            description={<span style={{ color: 'var(--muted)' }}>Trash is empty.</span>}
            style={{ padding: 60 }}
          />
        ) : (
          <Table
            dataSource={trashItems}
            rowKey="site_id"
            columns={columns}
            pagination={{ pageSize: 20 }}
            size="small"
            loading={loading}
          />
        )}
      </div>
    </div>
  )
}
