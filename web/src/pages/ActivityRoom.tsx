import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ensureSession } from '../api'
import { useRoom } from '../useRoom'
import type { Person } from '../types'
import { RoomCanvas } from '../components/RoomCanvas'
import { RoomPanel } from '../components/RoomPanel'

type Theme = 'light' | 'dark'

const THEME_KEY = 'fold.room_theme'

function initialTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function ActivityRoom() {
  const params = useParams()
  const code = useMemo(() => {
    const raw = params.code ?? ''
    return /^[a-zA-Z]{4}$/.test(raw) ? raw.toUpperCase() : null
  }, [params.code])
  const [me, setMe] = useState<Person | null>(null)
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [alert, setAlert] = useState<string | null>(null)
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
    document.documentElement.dataset.roomTheme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* ignore */
    }
    return () => {
      delete document.documentElement.dataset.roomTheme
    }
  }, [theme])

  if (code === null) {
    return <RoomMessage title="Invalid link" message="Activity links are four letters." />
  }

  if (notFound) {
    return <RoomMessage title="Not found" message={`No activity found for ${code}.`} />
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
    await api.interest(activity.id)
    refresh()
  }

  async function commit(etaMinutes: number) {
    await api.commit(activity.id, etaMinutes)
    refresh()
  }

  return (
    <main className={`room-page room-${theme}`}>
      <RoomCanvas
        activity={activity}
        participants={data.participants}
        me={me}
        theme={theme}
      />
      <div className="room-code">/{activity.code ?? code}</div>
      {error && <div className="room-error">{error}</div>}
      {alert && <div className="room-alert">{alert}</div>}
      <RoomPanel
        activity={activity}
        myParticipant={myParticipant}
        theme={theme}
        onThemeToggle={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
        onInterested={interest}
        onCommit={commit}
        onAlert={showAlert}
      />
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
