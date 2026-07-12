import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { api, ensureSession } from '../api'
import { useTheme } from '../theme'
import { useRoom } from '../useRoom'
import type { Person } from '../types'
import { CreateRunForm } from '../components/CreateRunForm'
import { RoomCanvas } from '../components/RoomCanvas'
import { RoomPanel } from '../components/RoomPanel'

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

  const activity = data.activity
  const myParticipant = data.participants.find((p) => p.is_me) ?? null

  function showAlert(message: string) {
    setAlert(message)
    window.setTimeout(() => setAlert((current) => (current === message ? null : current)), 3600)
  }

  async function interest() {
    if (!activity.current_run) return
    await api.interest(activity.current_run.id)
    refresh()
  }

  async function commit(etaMinutes: number) {
    if (!activity.current_run) return
    await api.commit(activity.current_run.id, etaMinutes)
    refresh()
  }

  return (
    <main className={`room-page room-${theme}`}>
      <RoomCanvas activity={activity} participants={data.participants} me={me} theme={theme} />
      <div className="room-code">/{activity.code}</div>
      {error && <div className="room-error">{error}</div>}
      {alert && <div className="room-alert">{alert}</div>}
      <RoomPanel
        activity={activity}
        myParticipant={myParticipant}
        me={me}
        onMeChanged={setMe}
        theme={theme}
        onThemeToggle={toggleTheme}
        onInterested={interest}
        onCommit={commit}
        onProposeRun={() => setProposingRun(true)}
        onAlert={showAlert}
      />
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

function RoomMessage({ title, message }: { title: string; message: string }) {
  return (
    <main className="room-message">
      <h1>{title}</h1>
      <p>{message}</p>
      <Link to="/">Back home</Link>
    </main>
  )
}
