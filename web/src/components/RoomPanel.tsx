import { useEffect, useRef, useState } from 'react'
import { enablePushNotifications } from '../push-client'
import { DEFAULT_ETA_MIN, HOLD_MS, etaFromHold, etaRemaining, visualState } from '../nodeVisual'
import type { ActivityView, ParticipantView } from '../types'

interface Props {
  activity: ActivityView
  myParticipant: ParticipantView | null
  theme: 'light' | 'dark'
  onThemeToggle: () => void
  onInterested: () => Promise<void>
  onCommit: (etaMinutes: number) => Promise<void>
  onUndo: () => Promise<void>
  onInfo: () => void
  onProposeRun: () => void
  onAlert: (message: string) => void
}

const HELP_URL = 'https://github.com/CHANGE_ME/fold'

export function RoomPanel({
  activity,
  myParticipant,
  theme,
  onThemeToggle,
  onInterested,
  onCommit,
  onUndo,
  onInfo,
  onProposeRun,
  onAlert,
}: Props) {
  const [busy, setBusy] = useState(false)
  const [holdMs, setHoldMs] = useState(0)
  const [now, setNow] = useState(Date.now())
  const startRef = useRef<number | null>(null)
  const rafRef = useRef(0)

  const run = activity.current_run
  const myVisualState = myParticipant ? visualState(myParticipant, now) : 'lurker'
  const canUndo = run && myParticipant !== null

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

  async function runBusy(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      onAlert(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function interested() {
    await runBusy(onInterested)
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
    await runBusy(async () => {
      await onCommit(etaFromHold(finalHold))
      setHoldMs(0)
    })
  }

  async function share() {
    const url = `${window.location.origin}/${activity.code}`
    try {
      if (navigator.share) await navigator.share({ title: activity.title, url })
      else await navigator.clipboard.writeText(url)
      onAlert('Link copied')
    } catch (err) {
      onAlert(err instanceof Error ? err.message : String(err))
    }
  }

  async function enablePush() {
    try {
      onAlert(await enablePushNotifications())
    } catch (err) {
      onAlert(err instanceof Error ? err.message : String(err))
    }
  }

  const action = (() => {
    if (!run) {
      return <button className="room-action propose" onClick={onProposeRun}>Propose a run</button>
    }
    if (myVisualState === 'arrived') {
      return <button className="room-action arrived" disabled>arrived</button>
    }
    if (myVisualState === 'committed') {
      return <button className="room-action committed" disabled>{etaRemaining(myParticipant?.arrival_at ?? null, now)}min</button>
    }
    if (myVisualState === 'interested') {
      return (
        <button
          className="room-action commit"
          disabled={busy}
          onPointerDown={startCommit}
          onPointerUp={finishCommit}
          onPointerCancel={finishCommit}
          onPointerLeave={finishCommit}
        >
          {busy ? '...' : `${etaFromHold(holdMs)}min`}
        </button>
      )
    }
    return <button className="room-action interested" disabled={busy} onClick={interested}>{busy ? '...' : 'Interested'}</button>
  })()

  return (
    <>
      <div className="global-panel">
        <button className="panel-button icon" onClick={onThemeToggle} title="Toggle theme">
          {theme === 'light' ? '◐' : '◑'}
        </button>
        <div className="panel-separator" />
        <button className="panel-button icon" disabled={!canUndo || busy} onClick={() => runBusy(onUndo)} title={`Undo to ${undoLabel(myVisualState)}`}>
          ↩︎
        </button>
        {action}
        <div className="panel-separator" />
        <button className="panel-button icon noto-emoji" onClick={share} title="Share">🔗</button>
        <button className="panel-button icon noto-emoji" onClick={enablePush} title="Notifications">🔔</button>
        <button className="panel-button icon" onClick={onInfo} title="Room info">ℹ︎</button>
        <a className="panel-button icon" href={HELP_URL} target="_blank" rel="noopener noreferrer" title="Help">?</a>
      </div>

    </>
  )
}

function undoLabel(state: 'lurker' | 'interested' | 'committed' | 'arrived') {
  if (state === 'arrived') return `${DEFAULT_ETA_MIN}min committed`
  if (state === 'committed') return 'interested'
  if (state === 'interested') return 'lurking'
  return 'previous state'
}
