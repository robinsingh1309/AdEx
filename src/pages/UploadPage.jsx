import { useState, useRef } from 'react'
import { Button, Card, Alert, Table, Spin, message, Progress } from 'antd'
import { CheckCircleOutlined, VideoCameraOutlined,
         FolderOpenOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { serverApi } from '../utils/api'

export default function UploadPage({ onStartReview }) {
  const [step, setStep]                 = useState(0)
  const [pickedName, setPickedName]     = useState(null)   // video file name, known as soon as it's picked
  const [videoInfo, setVideoInfo]       = useState(null)   // { name, serverPath } — set once upload finishes
  const [uploading, setUploading]       = useState(false)
  const [uploadPct, setUploadPct]       = useState(0)
  const [extracting, setExtracting]     = useState(false)
  const [extractError, setExtractError] = useState(null)
  const [gpsPoints, setGpsPoints]       = useState(null)
  const [gpsPreview, setGpsPreview]     = useState([])

  const fileInputRef = useRef(null)

  // ── Step 0: Video → upload to server, then extract GPS from GoPro telemetry ──
  //
  // Unlike a local-picker setup, the server can't inspect the file until the
  // bytes have actually arrived over the network, so GPS extraction now runs
  // *after* upload rather than before it. If no GPS telemetry is found, the
  // uploaded file is removed from the server so failed attempts don't pile up
  // in the inventory folder.

  const handleFileChosen = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return

    setExtractError(null)
    setPickedName(file.name)
    setVideoInfo(null)
    setGpsPoints(null)
    setGpsPreview([])

    let uploadedPath = null
    try {
      setUploading(true)
      setUploadPct(0)
      const uploaded = await serverApi.uploadVideo(file, (evt) => {
        if (evt.total) setUploadPct(Math.round((evt.loaded / evt.total) * 100))
      })
      uploadedPath = uploaded.path
      setUploading(false)
      setVideoInfo({ name: uploaded.filename, serverPath: uploaded.path })

      setExtracting(true)
      const gpsRes = await serverApi.extractGps(uploaded.path)
      setExtracting(false)
      setGpsPoints(gpsRes.points)
      setGpsPreview(gpsRes.points.slice(0, 5).map((p, i) => ({
        key:  i,
        time: new Date(p.ts).toLocaleTimeString('en-IN', { hour12: false }),
        lat:  p.lat.toFixed(6),
        lng:  p.lng.toFixed(6),
      })))
      message.success(`GPS extracted from video — ${gpsRes.points.length} points`)
      setStep(1)
    } catch (e) {
      const detail = e?.response?.data?.detail ?? e.message
      if (e?.response?.status === 422) {
        setExtractError(detail)
        // GPS wasn't found — clean up the uploaded file rather than leaving
        // an unusable video sitting in the inventory folder.
        if (uploadedPath) {
          serverApi.deleteUploadedVideo(uploadedPath).catch(() => {})
        }
        setVideoInfo(null)
      } else {
        message.error('Could not process video: ' + detail)
      }
    } finally {
      setUploading(false)
      setExtracting(false)
    }
  }

  // ── Step 1: Start review ────────────────────────────────────────────────

  const handleUploadAndStart = () => {
    if (!videoInfo || !gpsPoints) return
    onStartReview({
      videoName: videoInfo.name,
      videoPath: videoInfo.serverPath,
      gpsPoints,
    })
  }

  const previewCols = [
    { title: 'Time',      dataIndex: 'time', key: 'time', render: v => <span className="mono">{v}</span> },
    { title: 'Latitude',  dataIndex: 'lat',  key: 'lat',  render: v => <span className="mono">{v}</span> },
    { title: 'Longitude', dataIndex: 'lng',  key: 'lng',  render: v => <span className="mono">{v}</span> },
  ]

  return (
    <div className="page-wrap" style={{ maxWidth: 760 }}>
      <div style={{ marginBottom: 28 }}>
        <div className="section-label">New Survey</div>
        <h2 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', marginBottom: 6 }}>Upload Survey Video</h2>
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>
          Upload your GoPro survey video — GPS is read automatically from the video's embedded telemetry (GPS must have been enabled while recording).
        </p>
      </div>

      {/* Custom Horizontal Stepper */}
      {(() => {
        const steps = [
          { title: 'Video & GPS', desc: 'Recording + telemetry', icon: <VideoCameraOutlined /> },
          { title: 'Review',      desc: 'Tag & save sites',       icon: <PlayCircleOutlined />  },
        ]
        return (
          <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 36 }}>
            {steps.map((s, i) => {
              const done   = step > i
              const active = step === i
              const clr    = (done || active) ? 'var(--accent)' : '#9ca3af'
              const bg     = (done || active) ? 'rgba(13,148,136,0.12)' : 'rgba(156,163,175,0.1)'
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
                  {i > 0 && (
                    <div style={{ position: 'absolute', top: 20, right: '50%', width: '50%', height: 2, background: step > i - 1 ? 'var(--accent)' : '#e5e7eb' }} />
                  )}
                  {i < steps.length - 1 && (
                    <div style={{ position: 'absolute', top: 20, left: '50%', width: '50%', height: 2, background: step > i ? 'var(--accent)' : '#e5e7eb' }} />
                  )}
                  <div style={{
                    width: 40, height: 40, borderRadius: '50%', background: bg,
                    border: `2px solid ${clr}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 18, color: clr, zIndex: 1, position: 'relative',
                    boxShadow: active ? '0 0 0 4px rgba(13,148,136,0.18)' : 'none',
                    transition: 'all 0.2s',
                  }}>
                    {s.icon}
                  </div>
                  <div style={{ marginTop: 8, textAlign: 'center' }}>
                    <div style={{ fontSize: 12, fontWeight: active ? 700 : 600, color: active ? 'var(--accent)' : (done ? 'var(--text)' : 'var(--muted)') }}>
                      {s.title}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{s.desc}</div>
                  </div>
                </div>
              )
            })}
          </div>
        )
      })()}

      {/* ── Video + GPS card ── */}
      <Card
        style={{ marginBottom: 16 }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 22, height: 22, borderRadius: '50%',
              background: step >= 0 ? 'var(--accent)' : 'var(--border)',
              color: '#fff', fontSize: 11, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>1</div>
            <span style={{ color: 'var(--text)' }}>Survey Video</span>
          </div>
        }
      >
        {gpsPoints ? (
          <>
            <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'rgba(5,150,105,0.08)', border: '1px solid rgba(5,150,105,0.25)', borderRadius: 8 }}>
              <CheckCircleOutlined style={{ color: 'var(--green)', fontSize: 20, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pickedName}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {gpsPoints.length.toLocaleString()} GPS points extracted · starts {new Date(gpsPoints[0].ts).toLocaleTimeString('en-IN', { hour12: false })}
                </div>
              </div>
              <Button size="small" onClick={() => { setPickedName(null); setVideoInfo(null); setGpsPoints(null); setGpsPreview([]); setStep(0) }}>Change</Button>
            </div>
            {gpsPreview.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>GPS preview — first 5 points</div>
                <Table dataSource={gpsPreview} columns={previewCols} pagination={false} size="small" />
              </div>
            )}
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '32px 20px' }}>
            <VideoCameraOutlined style={{ fontSize: 30, color: 'var(--accent)', display: 'block', marginBottom: 12 }} />

            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,.mp4,.mov,.avi,.mkv"
              style={{ display: 'none' }}
              onChange={handleFileChosen}
            />

            <Button
              size="large"
              icon={<FolderOpenOutlined />}
              loading={uploading || extracting}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? `Uploading… ${uploadPct}%` : extracting ? 'Extracting GPS…' : 'Browse Video File'}
            </Button>

            {uploading && (
              <Progress
                percent={uploadPct}
                size="small"
                strokeColor="var(--accent)"
                trailColor="var(--border)"
                style={{ maxWidth: 320, margin: '12px auto 0' }}
              />
            )}
            {(uploading || extracting) && (
              <Spin size="small" style={{ display: 'block', marginTop: 10 }} />
            )}

            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
              The file uploads first, then GPS telemetry is checked — large files take longer proportional to file size and your connection speed
            </div>
            {extractError && (
              <Alert
                type="error"
                showIcon
                message="No GPS Found"
                description={extractError}
                style={{ marginTop: 16, textAlign: 'left' }}
              />
            )}
          </div>
        )}
      </Card>

      {/* Start button */}
      <Button
        type="primary" size="large" block
        disabled={!videoInfo || !gpsPoints}
        onClick={handleUploadAndStart}
        icon={<PlayCircleOutlined />}
      >
        Start Video Review
      </Button>
    </div>
  )
}