import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { api, ensureSession } from '../api'
import { ActivityInfo } from '../components/ActivityInfo'
import { useTheme } from '../theme'
import { useRoom } from '../useRoom'
import type { Person } from '../types'
import { CreateRunForm } from '../components/CreateRunForm'
import { RoomCanvas } from '../components/RoomCanvas'
import { RoomPanel } from '../components/RoomPanel'
import { DEFAULT_VISUAL_CONFIG, type VisualConfig } from '../nodeVisual'
import { readJson, writeJson } from '../storage'

const VISUAL_KEY = 'fold.room_visual'

export function ActivityRoom() {
  const params = useParams()
  const navigate = useNavigate()
  const rawParam = params.code ?? ''
  // Any letters-only link of 4+ characters resolves against its first four
  // letters (e.g. /boardgames -> BOAR), so an existing code's link can be
  // typed/shared in a longer, friendlier form and still shorten correctly.
  const code = useMemo(() => {
    return /^[a-zA-Z]{4,}$/.test(rawParam) ? rawParam.slice(0, 4).toUpperCase() : null
  }, [rawParam])
  const [me, setMe] = useState<Person | null>(null)
  const { theme, toggleTheme } = useTheme()
  const [alert, setAlert] = useState<string | null>(null)
  const [proposingRun, setProposingRun] = useState(true)
  const [showInfo, setShowInfo] = useState(false)
  const [showVisual, setShowVisual] = useState(false)
  const [namePrompt, setNamePrompt] = useState(false)
  const [handleInput, setHandleInput] = useState('')
  const [visual, setVisual] = useState<VisualConfig>(() => readJson(VISUAL_KEY, DEFAULT_VISUAL_CONFIG))
  const alertCooldownRef = useRef(0)
  const { data, error, loading, notFound, refresh } = useRoom(code, me !== null && code !== null)

  useEffect(() => {
    let cancelled = false
    ensureSession()
      .then((p) => {
        if (!cancelled) setMe(p)
      })
      .catch(() => {
        if (!cancelled) setMe(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    writeJson(VISUAL_KEY, visual)
  }, [visual])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() === 'v' && !isTypingTarget(e.target)) setShowVisual((v) => !v)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // Re-open the propose-run prompt any time the room becomes freshly empty.
  useEffect(() => {
    if (data && data.activity.current_run == null) setProposingRun(true)
  }, [data])

  // A longer link that resolved to a real code shortens itself in the
  // address bar, e.g. /boardgames -> /BOAR, once we know BOAR is real.
  useEffect(() => {
    if (code && data && !notFound && rawParam.toUpperCase() !== code) {
      navigate(`/${code}`, { replace: true })
    }
  }, [code, data, notFound, rawParam, navigate])

  if (code === null) {
    return <RoomMessage title="Invalid link" message="Activity links are letters only." />
  }

  // A nonexistent code prompts creating a brand-new activity with that code
  // pre-filled, rather than a dead end.
  if (notFound) {
    return <Navigate to={`/?code=${code}`} replace />
  }

  if (!me || loading || !data) {
    return <RoomMessage title="fold" message={error ?? 'Loading activity...'} />
  }

  const person = me
  const activity = data.activity
  function showAlert(message: string) {
    const now = Date.now()
    if (alert === message && now - alertCooldownRef.current < 1000) return
    alertCooldownRef.current = now
    setAlert(message)
    window.setTimeout(() => setAlert((current) => (current === message ? null : current)), 3600)
  }

  async function copyRoomLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/${activity.code}`)
      showAlert('Link copied')
    } catch (err) {
      showAlert(err instanceof Error ? err.message : String(err))
    }
  }

  async function interest() {
    if (!activity.current_run) return
    if (person.handle.trim().toLowerCase() === 'guest') {
      if (activity.allow_guests) {
        const updated = await api.updateSession({ handle: guestHandle(person.id) })
        setMe(updated)
        await api.interest(activity.current_run.id)
        refresh()
        return
      }
      setHandleInput('')
      setNamePrompt(true)
      return
    }
    await api.interest(activity.current_run.id)
    refresh()
  }

  async function confirmName(e: React.FormEvent) {
    e.preventDefault()
    const handle = handleInput.trim()
    if (!handle || !activity.current_run) return
    const updated = await api.updateSession({ handle })
    setMe(updated)
    setNamePrompt(false)
    await api.interest(activity.current_run.id)
    refresh()
  }

  async function commit(etaMinutes: number) {
    if (!activity.current_run) return
    await api.commit(activity.current_run.id, etaMinutes)
    refresh()
  }

  async function withdraw() {
    if (!activity.current_run) return
    await api.withdraw(activity.current_run.id)
    refresh()
  }

  return (
    <main className={`room-page room-${theme}`}>
      <RoomCanvas
        activity={activity}
        participants={data.participants}
        me={me}
        visual={visual}
        onInterested={interest}
        onCommit={commit}
        onWithdraw={withdraw}
        onAlert={showAlert}
        alreadyCommittedElsewhere={data.already_committed_elsewhere}
      />
      <button type="button" className="room-code" onClick={copyRoomLink}>/{activity.code}</button>
      {error && <div className="room-error">{error}</div>}
      {alert && <div className="room-alert">{alert}</div>}
      {showVisual && <VisualPanel visual={visual} onChange={setVisual} />}
      <RoomPanel
        activity={activity}
        theme={theme}
        onThemeToggle={toggleTheme}
        onInfo={() => setShowInfo(true)}
        onProposeRun={() => setProposingRun(true)}
        onAlert={showAlert}
      />
      {showInfo && (
        <div className="modal-backdrop" onClick={() => setShowInfo(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <section className="card room-info-card">
              <ActivityInfo
                activity={activity}
                now={data.server_time}
                cta={<button className="activity-launch ghost" onClick={() => setShowInfo(false)}>Cancel</button>}
              />
            </section>
          </div>
        </div>
      )}
      {namePrompt && (
        <div className="modal-backdrop centered" onClick={() => setNamePrompt(false)}>
          <form className="card name-prompt" onClick={(e) => e.stopPropagation()} onSubmit={confirmName}>
            <input
              autoFocus
              maxLength={40}
              placeholder="Name"
              value={handleInput}
              onChange={(e) => setHandleInput(e.target.value)}
            />
            <div className="row">
              <button type="button" className="ghost danger" onClick={() => setNamePrompt(false)}>Cancel</button>
              <button type="submit" className="primary" disabled={!handleInput.trim()}>Submit</button>
            </div>
          </form>
        </div>
      )}
      {!activity.current_run && proposingRun && (
        <div className="modal-backdrop" onClick={() => setProposingRun(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <CreateRunForm
              activity={activity}
              onCreated={() => {
                setProposingRun(false)
                refresh()
              }}
              onCancel={() => setProposingRun(false)}
            />
          </div>
        </div>
      )}
    </main>
  )
}

function VisualPanel({ visual, onChange }: { visual: VisualConfig; onChange: (v: VisualConfig) => void }) {
  const patch = (p: Partial<VisualConfig>) => onChange({ ...visual, ...p })
  return (
    <div className="room-visual-panel physics-help bio-help">
      <div className="bio-section-title">Visual</div>
      <div className="bio-sliders">
        <Slider label="node size" min={6} max={50} step={1} value={visual.nodeRadius} fmt={(v) => `${v}px`} onChange={(v) => patch({ nodeRadius: v })} />
        <Slider label="outline" min={0} max={12} step={0.5} value={visual.outlineWidth} fmt={(v) => `${v}px`} onChange={(v) => patch({ outlineWidth: v })} />
        <Slider label="tightness" min={0} max={3} step={0.1} value={visual.clusterTightness} fmt={(v) => v.toFixed(1)} onChange={(v) => patch({ clusterTightness: v })} />
      </div>
      <span className="bio-hint">Press v to hide · tap your node for interest · hold to commit · drag committed to set ETA</span>
    </div>
  )
}

function Slider({ label, min, max, step, value, fmt, onChange }: {
  label: string
  min: number
  max: number
  step: number
  value: number
  fmt: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <label className="bio-slider-row">
      <span className="bio-slider-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="bio-slider-val">{fmt(value)}</span>
    </label>
  )
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

function guestHandle(id: string) {
  let n = 0
  for (let i = 0; i < id.length; i += 1) n = (n * 31 + id.charCodeAt(i)) % 10000
  return `guest#${String(n).padStart(4, '0')}`
}

function RoomMessage({ title, message }: { title: string; message: string }) {
  return (
    <main className="room-message">
      <h1>{title}</h1>
      <p>{message}</p>
      <Link to="/">Back home</Link>
    </main>
  )
}
