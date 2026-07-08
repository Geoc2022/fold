import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { ActivityView, ParticipantView } from '../types'

interface Props {
  activity: ActivityView
  myParticipant: ParticipantView | null
  theme: 'light' | 'dark'
  onThemeToggle: () => void
  onInterested: () => Promise<void>
  onCommit: (etaMinutes: number) => Promise<void>
  onAlert: (message: string) => void
}

const HOLD_MS = 5_000
const MIN_ETA = 5
const MAX_ETA = 30
const HELP_URL = 'https://github.com/CHANGE_ME/fold'

export function RoomPanel({
  activity,
  myParticipant,
  theme,
  onThemeToggle,
  onInterested,
  onCommit,
  onAlert,
}: Props) {
  const [busy, setBusy] = useState(false)
  const [holdMs, setHoldMs] = useState(0)
  const [now, setNow] = useState(Date.now())
  const startRef = useRef<number | null>(null)
  const rafRef = useRef(0)

  const eta = etaFromHold(holdMs)

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      window.clearInterval(id)
      cancelAnimationFrame(rafRef.current)
    }
  }, [])

  function tick() {
    if (startRef.current == null) return
    setHoldMs(Math.min(HOLD_MS, performance.now() - startRef.current))
    rafRef.current = requestAnimationFrame(tick)
  }

  async function interested() {
    setBusy(true)
    try {
      await onInterested()
    } catch (err) {
      onAlert(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function startCommit() {
    if (busy) return
    startRef.current = performance.now()
    setHoldMs(0)
    rafRef.current = requestAnimationFrame(tick)
  }

  async function finishCommit() {
    if (startRef.current == null) return
    const finalHold = Math.min(HOLD_MS, performance.now() - startRef.current)
    cancelAnimationFrame(rafRef.current)
    startRef.current = null
    setHoldMs(finalHold)
    const finalEta = etaFromHold(finalHold)
    setBusy(true)
    try {
      await onCommit(finalEta)
      setHoldMs(0)
    } catch (err) {
      onAlert(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function share() {
    const url = `${window.location.origin}/${activity.code ?? activity.id}`
    try {
      if (navigator.share) {
        await navigator.share({ title: activity.title, url })
      } else {
        await navigator.clipboard.writeText(url)
      }
    } catch (err) {
      onAlert(err instanceof Error ? err.message : String(err))
    }
  }

  async function enablePush() {
    try {
      if (!('Notification' in window)) {
        onAlert('Notifications are not supported here')
        return
      }
      const cfg = await api.pushPublicKey()
      if (!cfg.enabled || !cfg.public_key) {
        onAlert('Push is not configured yet')
        return
      }
      onAlert('Use the homepage notification panel to enable push for now')
    } catch (err) {
      onAlert(err instanceof Error ? err.message : String(err))
    }
  }

  const action = (() => {
    if (activity.my_state === 'committed') {
      const remaining = etaRemaining(myParticipant?.arrival_at ?? null, now)
      return (
        <button className="room-action committed" disabled>
          {remaining}min
        </button>
      )
    }
    if (activity.my_state === 'interested') {
      return (
        <button
          className="room-action commit"
          disabled={busy}
          onPointerDown={startCommit}
          onPointerUp={finishCommit}
          onPointerCancel={finishCommit}
          onPointerLeave={finishCommit}
        >
          {busy ? '...' : `${eta}min`}
        </button>
      )
    }
    return (
      <button className="room-action interested" disabled={busy} onClick={interested}>
        {busy ? '...' : 'Interested'}
      </button>
    )
  })()

  return (
    <div className="global-panel">
      <button className="panel-button icon" onClick={onThemeToggle} title="Toggle theme">
        {theme === 'light' ? '◐' : '◑'}
      </button>
      <div className="panel-separator" />
      {action}
      <div className="panel-separator" />
      <button className="panel-button icon" onClick={share} title="Share">
        <ShareIcon />
      </button>
      <button className="panel-button icon" onClick={enablePush} title="Notifications">
        <BellIcon />
      </button>
      <a
        className="panel-button icon"
        href={HELP_URL}
        target="_blank"
        rel="noopener noreferrer"
        title="Help"
      >
        ?
      </a>
    </div>
  )
}

function etaFromHold(holdMs: number) {
  const t = Math.min(1, Math.max(0, holdMs / HOLD_MS))
  const eased = t * t
  return Math.max(MIN_ETA, Math.min(MAX_ETA, Math.round(MAX_ETA - 25 * eased)))
}

function etaRemaining(arrivalAt: number | null, now: number) {
  if (arrivalAt == null) return 0
  return Math.max(0, Math.ceil((arrivalAt - now) / 60000))
}

function ShareIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 12h8M13 7l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 12a8 8 0 0 1 8-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 21h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
