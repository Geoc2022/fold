import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError, ensureSession } from '../api'
import { ActivityInfo } from '../components/ActivityInfo'
import { useTheme } from '../theme'
import { useRoom } from '../useRoom'
import type { Person } from '../types'
import { CreateRunForm } from '../components/CreateRunForm'
import { RoomCanvas, type RoomAlertInput } from '../components/RoomCanvas'
import { RoomPanel } from '../components/RoomPanel'
import { PolicyPanel } from '../components/PolicyPanel'
import { DEFAULT_VISUAL_CONFIG, type VisualConfig } from '../nodeVisual'
import { readJson, writeJson } from '../storage'
import { requestNotificationPermission } from '../notify-client'
import { enablePushNotifications } from '../push-client'
import { loadHomeRules, loadRoomRules, type PolicyRule } from '../policy/rules'
import { appendPolicySources, decodePolicySources, encodePolicySources } from '../policy/share'
import { buildActivityShareText } from '../activityShare'
import { activityPresenceBadgeModel } from '../activityPresence'
import { setDefaultFavicon, setPresenceFavicon } from '../favicon'

const VISUAL_KEY = 'fold.room_visual'
const ALERT_COOLDOWN_MS = 1000
const ALERT_VISIBLE_MS = 3600

function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

interface RoomAlert {
  message: string
  href?: string
  hrefLabel?: string
}

export function ActivityRoom() {
  const params = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const rawParam = params.code ?? ''
  // Any letters-only link of 4+ characters resolves against its first four
  // letters (e.g. /boardgames -> BOAR), so an existing code's link can be
  // typed/shared in a longer, friendlier form and still shorten correctly.
  const code = useMemo(() => {
    return /^[a-zA-Z]{4,}$/.test(rawParam) ? rawParam.slice(0, 4).toUpperCase() : null
  }, [rawParam])
  const [me, setMe] = useState<Person | null>(null)
  const { theme, toggleTheme } = useTheme()
  const [alert, setAlert] = useState<RoomAlert | null>(null)
  const [proposingRun, setProposingRun] = useState(true)
  const [showInfo, setShowInfo] = useState(false)
  const [showVisual, setShowVisual] = useState(false)
  const [showPolicyPanel, setShowPolicyPanel] = useState(false)
  const [namePrompt, setNamePrompt] = useState(false)
  const [handleInput, setHandleInput] = useState('')
  const [visual, setVisual] = useState<VisualConfig>(() => readJson(VISUAL_KEY, DEFAULT_VISUAL_CONFIG))
  const [notifyStatus, setNotifyStatus] = useState('')
  const [homeRules, setHomeRules] = useState<PolicyRule[]>(loadHomeRules)
  const [roomRules, setRoomRules] = useState<PolicyRule[] | null>(() => (code ? loadRoomRules(code) : null))
  const [policiesReady, setPoliciesReady] = useState(false)
  const roomPolicyRevisionsRef = useRef(new Map<string, number>())
  const roomPolicyServerIdsRef = useRef(new Map<string, Map<string, string>>())
  const roomPolicySaveRef = useRef<Promise<void>>(Promise.resolve())
  const alertTimerRef = useRef<number | null>(null)
  const alertLastShownRef = useRef(new Map<string, number>())
  const alertQueueRef = useRef<RoomAlert[]>([])
  const currentAlertRef = useRef<RoomAlert | null>(null)
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
    if (me && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      void enablePushNotifications().catch(() => undefined)
    }
  }, [me])

  useEffect(() => {
    writeJson(VISUAL_KEY, visual)
  }, [visual])

  useEffect(() => {
    if (!code) return
    setRoomRules(loadRoomRules(code))
    setPoliciesReady(false)
  }, [code])

  useEffect(() => {
    currentAlertRef.current = alert
  }, [alert])

  useEffect(() => {
    return () => {
      if (alertTimerRef.current != null) {
        window.clearTimeout(alertTimerRef.current)
        alertTimerRef.current = null
      }
    }
  }, [])

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

  const showNextAlert = () => {
    if (alertTimerRef.current != null) return
    const next = alertQueueRef.current.shift()
    if (!next) return
    currentAlertRef.current = next
    setAlert(next)
    alertTimerRef.current = window.setTimeout(() => {
      alertTimerRef.current = null
      currentAlertRef.current = null
      setAlert(null)
      showNextAlert()
    }, ALERT_VISIBLE_MS)
  }

  function showAlert(nextAlert: string | RoomAlertInput) {
    const normalized: RoomAlert =
      typeof nextAlert === 'string'
        ? { message: nextAlert }
        : {
            message: nextAlert.message,
            href: nextAlert.href,
            hrefLabel: nextAlert.hrefLabel,
          }
    const key = `${normalized.message}|${normalized.href ?? ''}|${normalized.hrefLabel ?? ''}`
    const now = Date.now()
    const last = alertLastShownRef.current.get(key) ?? 0
    if (now - last < ALERT_COOLDOWN_MS) return
    alertLastShownRef.current.set(key, now)

    if (currentAlertRef.current == null && alertTimerRef.current == null) {
      currentAlertRef.current = normalized
      setAlert(normalized)
      alertTimerRef.current = window.setTimeout(() => {
        alertTimerRef.current = null
        currentAlertRef.current = null
        setAlert(null)
        showNextAlert()
      }, ALERT_VISIBLE_MS)
      return
    }

    const queue = alertQueueRef.current
    const lastQueued = queue[queue.length - 1]
    if (
      !lastQueued
      || lastQueued.message !== normalized.message
      || lastQueued.href !== normalized.href
      || lastQueued.hrefLabel !== normalized.hrefLabel
    ) {
      queue.push(normalized)
    }
  }

  const policyRules = roomRules ?? homeRules
  const policyActivityId = data?.activity.id

  useEffect(() => {
    if (!code || !me || !policyActivityId) return
    const activityId = policyActivityId
    const roomCode = code
    let cancelled = false
    async function loadPolicies() {
      const response = await api.policySets(activityId)
      let home = response.sets.find((set) => set.scope === 'home')
      if (!home) {
        const localHome = loadHomeRules()
        home = await api.replacePolicySet({
          scope: 'home',
          timezone: browserTimezone(),
          revision: 0,
          rules: localHome.map(({ source, enabled }) => ({ source, enabled })),
        })
      }
      let room = response.sets.find((set) => set.scope === 'room')
      const localRoom = loadRoomRules(roomCode)
      if (!room && localRoom) {
        room = await api.replacePolicySet({
          scope: 'room',
          activity_id: activityId,
          timezone: browserTimezone(),
          revision: 0,
          rules: localRoom.map(({ source, enabled }) => ({ source, enabled })),
        })
      }
      if (cancelled) return
      setHomeRules(home.rules.map(({ id, source, enabled }) => ({ id, source, enabled })))
      setRoomRules(room ? room.rules.map(({ id, source, enabled }) => ({ id, source, enabled })) : null)
      roomPolicyRevisionsRef.current.set(activityId, room?.revision ?? 0)
      roomPolicyServerIdsRef.current.set(
        activityId,
        new Map((room?.rules ?? []).map((rule) => [rule.id, rule.id])),
      )
      setPoliciesReady(true)
    }
    void loadPolicies().catch((error) => {
      if (!cancelled) setNotifyStatus(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [code, me, policyActivityId])

  const saveRoomRules = useCallback((nextRules: PolicyRule[]) => {
    if (!policyActivityId) return
    const activityId = policyActivityId
    setRoomRules(nextRules)
    roomPolicySaveRef.current = roomPolicySaveRef.current
      .catch(() => undefined)
      .then(async () => {
        const serverIds = roomPolicyServerIdsRef.current.get(activityId) ?? new Map<string, string>()
        const save = () => api.replacePolicySet({
          scope: 'room' as const,
          activity_id: activityId,
          timezone: browserTimezone(),
          revision: roomPolicyRevisionsRef.current.get(activityId) ?? 0,
          rules: nextRules.map(({ id, source, enabled }) => ({
            id: serverIds.get(id),
            source,
            enabled,
          })),
        })
        let saved
        try {
          saved = await save()
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error
          const current = (await api.policySets(activityId)).sets.find((set) => set.scope === 'room')
          roomPolicyRevisionsRef.current.set(activityId, current?.revision ?? 0)
          current?.rules.forEach((rule, index) => {
            const localId = nextRules[index]?.id
            if (localId) serverIds.set(localId, rule.id)
          })
          saved = await save()
        }
        roomPolicyRevisionsRef.current.set(activityId, saved.revision)
        saved.rules.forEach((rule, index) => {
          const localId = nextRules[index]?.id
          if (localId) serverIds.set(localId, rule.id)
        })
        roomPolicyServerIdsRef.current.set(activityId, serverIds)
        setNotifyStatus('Policy saved')
      })
      .catch((error) => {
        setNotifyStatus(error instanceof Error ? error.message : String(error))
        throw error
      })
  }, [policyActivityId])

  useEffect(() => {
    const policyParam = searchParams.get('policy')
    if (!policyParam || !code || !policiesReady) return
    try {
      const sources = decodePolicySources(policyParam)
      if (sources.length > 0) {
        saveRoomRules(appendPolicySources(policyRules, sources))
        setShowPolicyPanel(true)
      }
    } catch {
      // Ignore malformed shared policy links.
    }
    setSearchParams((current) => {
      current.delete('policy')
      return current
    }, { replace: true })
  }, [code, policiesReady, policyRules, saveRoomRules, searchParams, setSearchParams])

  const presenceBadge = useMemo(
    () => (data ? activityPresenceBadgeModel(data.activity, data.server_time, data.participants) : null),
    [data],
  )

  useEffect(() => {
    if (code == null || notFound) {
      setDefaultFavicon()
      return
    }
    setPresenceFavicon(presenceBadge)
    return () => setDefaultFavicon()
  }, [code, notFound, presenceBadge])

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
  const participants = data.participants
  const serverTime = data.server_time

  async function enableNotifications() {
    setNotifyStatus(await requestNotificationPermission())
  }

  function sharePolicy() {
    const url = `${window.location.origin}/${activity.code}?policy=${encodeURIComponent(encodePolicySources(policyRules))}`
    navigator.clipboard.writeText(url).then(
      () => showAlert('Policy link copied'),
      () => showAlert('Could not copy policy link'),
    )
  }

  async function copyRoomLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/${activity.code}`)
      showAlert('Link copied')
    } catch (err) {
      showAlert(err instanceof Error ? err.message : String(err))
    }
  }

  async function shareActivity() {
    const url = `${window.location.origin}/${activity.code}`
    try {
      await navigator.clipboard.writeText(buildActivityShareText(activity, participants, serverTime, url))
      showAlert('Activity copied')
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

  async function commit(etaSeconds: number) {
    if (!activity.current_run) return
    await api.commit(activity.current_run.id, etaSeconds)
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
        otherCommittedRoomCode={data.other_committed_room_code}
      />
      <button type="button" className="room-code" onClick={copyRoomLink}>/{activity.code}</button>
      {error && <div className="room-error">{error}</div>}
      {alert && (
        <div className="room-alert">
          {alert.href && alert.message.includes('{link}') ? (
            <>
              {alert.message.split('{link}')[0]}
              <Link className="room-alert-link" to={alert.href}>
                {alert.hrefLabel ?? alert.href}
              </Link>
              {alert.message.split('{link}')[1]}
            </>
          ) : alert.href && alert.hrefLabel === alert.message ? (
            <Link className="room-alert-link" to={alert.href}>
              {alert.message}
            </Link>
          ) : (
            <>
              {alert.message}
              {alert.href && (
                <>
                  {' '}
                  <Link className="room-alert-link" to={alert.href}>
                    {alert.hrefLabel ?? alert.href}
                  </Link>
                </>
              )}
            </>
          )}
        </div>
      )}
      {showVisual && <VisualPanel visual={visual} onChange={setVisual} />}
      <RoomPanel
        activity={activity}
        theme={theme}
        onThemeToggle={toggleTheme}
        onInfo={() => setShowInfo(true)}
        onProposeRun={() => setProposingRun(true)}
        onOpenPolicy={() => setShowPolicyPanel(true)}
        onShare={shareActivity}
      />
      {showPolicyPanel && policiesReady && (
        <PolicyPanel
          rules={policyRules}
          onRulesChange={saveRoomRules}
          onClose={() => setShowPolicyPanel(false)}
          hint="Rules run against this room while you're here."
          notifyStatus={notifyStatus}
          onRequestNotifications={enableNotifications}
          onShare={sharePolicy}
        />
      )}
      {showInfo && (
        <div className="modal-backdrop" onClick={() => setShowInfo(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <section className="card room-info-card">
              <ActivityInfo
                activity={activity}
                now={data.server_time}
                participants={participants}
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
