import { AnimatePresence } from 'framer-motion'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api, clearPersonId, ensureSession } from '../api'
import { useTheme } from '../theme'
import { popularityOrder, tileSizes } from '../tileLayout'
import { useSync } from '../useSync'
import type { ActivityView, Person } from '../types'
import { ActivityListItem } from '../components/ActivityListItem'
import { ActivityTile } from '../components/ActivityTile'
import { CreateTile } from '../components/CreateTile'
import { PolicyPanel } from '../components/PolicyPanel'
import { ProposeForm } from '../components/ProposeForm'
import { SortSelect, type SortKey } from '../components/SortSelect'
import { TagBar } from '../components/TagBar'
import { ViewToggle, type HomeView } from '../components/ViewToggle'
import { requestNotificationPermission, showLocalNotification } from '../notify-client'
import { compileAndEvaluate, type Effect } from '../policy/engine'
import { buildHomePolicyEnv } from '../policy/homeEnv'
import { newPolicyRule, type PolicyRule } from '../policy/rules'
import { readJson, writeJson } from '../storage'

const CODE_PATTERN = /^[a-zA-Z]{4}$/
const SORT_KEYS: SortKey[] = ['newest', 'oldest', 'runs', 'served', 'commit', 'name']
const EMPTY_ACTIVITIES: ActivityView[] = []
const CATEGORY_PRESETS = [
  { value: 'board game', label: 'Board Game' },
  { value: 'video game', label: 'Video Game' },
  { value: 'tabletop', label: 'Tabletop' },
  { value: 'outside', label: 'Outside' },
]

const POLICY_RULES_KEY = 'fold.policy.home.rules'
const DEFAULT_POLICY = 'is_ready => notify "{title} is ready"'
const TOAST_VISIBLE_MS = 4000

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  bytes.forEach((b) => {
    binary += String.fromCharCode(b)
  })
  return btoa(binary)
}

function fromBase64Url(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function firstNotifyMessage(effect: Effect | null): string | null {
  if (!effect) return null
  if (effect.op === 'notify') return effect.message
  if (effect.op === 'seq') {
    for (const step of effect.steps) {
      const msg = firstNotifyMessage(step)
      if (msg) return msg
    }
  }
  return null
}

function sortActivities(list: ActivityView[], key: SortKey): ActivityView[] {
  const arr = [...list]
  switch (key) {
    case 'oldest':
      return arr.sort((a, b) => a.created_at - b.created_at)
    case 'newest':
      return arr.sort((a, b) => b.created_at - a.created_at)
    case 'runs':
      return arr.sort((a, b) => b.times_run - a.times_run)
    case 'served':
      return arr.sort((a, b) => b.players_served - a.players_served)
    case 'commit':
      return arr.sort((a, b) => (b.commit_pct ?? -1) - (a.commit_pct ?? -1))
    case 'name':
      return arr.sort((a, b) => a.title.localeCompare(b.title))
  }
}

function normalizeCategory(value: string) {
  return value.trim().toLowerCase()
}

export function HomePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { theme, toggleTheme } = useTheme()

  // No name-gated onboarding: mint an anonymous guest session immediately,
  // matching the room's entry flow. People are only asked for a handle when
  // they express interest in a room.
  const [me, setMe] = useState<Person | null>(null)
  const [sessionEpoch, setSessionEpoch] = useState(0)
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
  }, [sessionEpoch])

  const { data, error, loading, refresh } = useSync(me !== null)

  useEffect(() => {
    if (me && data && data.me === null) {
      clearPersonId()
      setMe(null)
      setSessionEpoch((e) => e + 1)
    }
  }, [me, data])

  // View/tag/sort live entirely in the URL, matching stackexchange.com/sites
  // (?view=list, ?tag=..., #oldest) -- no separate local persistence.
  const view: HomeView = searchParams.get('view') === 'list' ? 'list' : 'grid'
  const tag = searchParams.get('tag') ?? 'all'
  const hashSort = location.hash.replace('#', '')
  const sort: SortKey = (SORT_KEYS as string[]).includes(hashSort) ? (hashSort as SortKey) : 'oldest'

  function updateUrl(patch: { view?: HomeView; tag?: string; sort?: SortKey }) {
    const params = new URLSearchParams(searchParams)
    params.delete('code')
    const nextView = patch.view ?? view
    if (nextView === 'grid') params.delete('view')
    else params.set('view', 'list')
    const nextTag = patch.tag ?? tag
    if (nextTag === 'all') params.delete('tag')
    else params.set('tag', nextTag)
    const nextSort = patch.sort ?? sort
    const qs = params.toString()
    const hash = nextView === 'list' ? `#${nextSort}` : ''
    navigate(`${location.pathname}${qs ? `?${qs}` : ''}${hash}`, { replace: true })
  }

  const [creating, setCreating] = useState(false)
  const [editingActivity, setEditingActivity] = useState<ActivityView | null>(null)
  const [prefillCode, setPrefillCode] = useState<string | null>(null)

  // Arriving at /?code=TEST (redirected from a nonexistent /TEST room) opens
  // the propose form with that code pre-filled.
  useEffect(() => {
    const codeParam = searchParams.get('code')
    if (codeParam && CODE_PATTERN.test(codeParam)) {
      setPrefillCode(codeParam.toUpperCase())
      setCreating(true)
      setSearchParams(
        (p) => {
          p.delete('code')
          return p
        },
        { replace: true },
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const [showPolicyPanel, setShowPolicyPanel] = useState(false)
  const [notifyStatus, setNotifyStatus] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const [rules, setRules] = useState<PolicyRule[]>(() => readJson(POLICY_RULES_KEY, [newPolicyRule(DEFAULT_POLICY)]))
  const policyFireRef = useRef(new Map<string, boolean>())

  useEffect(() => {
    writeJson(POLICY_RULES_KEY, rules)
  }, [rules])

  // A shared policy link (?policy=<base64 of source[]>) loads those rules
  // and opens the panel, mirroring the ?code= propose-form flow above.
  useEffect(() => {
    const policyParam = searchParams.get('policy')
    if (policyParam) {
      try {
        const sources = JSON.parse(fromBase64Url(policyParam)) as unknown
        if (Array.isArray(sources) && sources.length > 0) {
          setRules(sources.filter((s) => typeof s === 'string').map((s) => newPolicyRule(s)))
          setShowPolicyPanel(true)
        }
      } catch {
        // Malformed/garbled policy link; ignore rather than crash the page.
      }
      setSearchParams(
        (p) => {
          p.delete('policy')
          return p
        },
        { replace: true },
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  function showToast(message: string) {
    setToast(message)
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null
      setToast(null)
    }, TOAST_VISIBLE_MS)
  }

  useEffect(() => {
    return () => {
      if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current)
    }
  }, [])

  async function enableNotifications() {
    setNotifyStatus(await requestNotificationPermission())
  }

  function sharePolicy() {
    const sources = rules.map((r) => r.source)
    const encoded = toBase64Url(JSON.stringify(sources))
    const params = new URLSearchParams(searchParams)
    params.set('policy', encoded)
    const url = `${window.location.origin}${location.pathname}?${params.toString()}`
    navigator.clipboard
      .writeText(url)
      .then(() => showToast('Policy link copied'))
      .catch(() => showToast('Could not copy link'))
  }

  const activities = data?.activities ?? EMPTY_ACTIVITIES
  const now = data?.server_time ?? Date.now()

  // Run enabled policy rules against activities the user has joined
  // (my_state != null) every time fresh sync data arrives, firing a
  // notification + toast on the rising edge of a `notify` action.
  useEffect(() => {
    if (!data) return
    let cancelled = false
    const joined = activities.filter((a) => a.my_state != null)
    const activeIds = new Set<string>()
    ;(async () => {
      for (const activity of joined) {
        const env = buildHomePolicyEnv(activity, now)
        for (const rule of rules) {
          if (!rule.enabled || !rule.source.trim()) continue
          const key = `${activity.id}:${rule.id}`
          activeIds.add(key)
          const out = await compileAndEvaluate(rule.source, env)
          if (cancelled) return
          const message = firstNotifyMessage(out.fired)
          const isFired = out.fired != null && out.fired.op !== 'noop'
          const wasFired = policyFireRef.current.get(key) ?? false
          if (message && !wasFired) {
            showToast(message)
            void showLocalNotification(activity.title, message, `/${activity.code}`, `fold-policy-${key}`)
          }
          policyFireRef.current.set(key, isFired)
        }
      }
      for (const key of policyFireRef.current.keys()) {
        if (!activeIds.has(key)) policyFireRef.current.delete(key)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, rules])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const a of activities) set.add(a.category)
    return Array.from(set).sort()
  }, [activities])

  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const preset of CATEGORY_PRESETS) counts.set(preset.value, 0)
    for (const a of activities) {
      const key = normalizeCategory(a.category)
      if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...CATEGORY_PRESETS]
      .map((preset) => ({ ...preset, count: counts.get(preset.value) ?? 0 }))
      .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label))
  }, [activities])

  const filtered = useMemo(
    () => (tag === 'all' ? activities : activities.filter((a) => a.category === tag)),
    [activities, tag],
  )

  const gridOrder = useMemo(() => popularityOrder(filtered), [filtered])
  const sizes = useMemo(() => tileSizes(filtered), [filtered])
  const listOrder = useMemo(() => sortActivities(filtered, sort), [filtered, sort])

  // Only one tile can be expanded at a time; clicking off any tile collapses it.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  useEffect(() => {
    if (!expandedId) return
    function onDocClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (target.closest('.activity-badge')) return // the tile's own click handles this
      if (target.closest('.tile.expanded')) return // click inside the expanded panel
      setExpandedId(null)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [expandedId])

  const [editingHandle, setEditingHandle] = useState(false)
  const [handleInput, setHandleInput] = useState('')
  const [handleWidth, setHandleWidth] = useState(24)
  const handleMeasureRef = useRef<HTMLSpanElement>(null)

  // Auto-grow the input to fit what's typed (measured via a hidden mirror
  // span) so the right edge stays put instead of the box being a fixed,
  // oversized text field.
  useLayoutEffect(() => {
    if (editingHandle && handleMeasureRef.current) {
      setHandleWidth(Math.max(16, handleMeasureRef.current.scrollWidth + 8))
    }
  }, [handleInput, editingHandle])

  function startEditHandle() {
    if (!me) return
    setHandleInput(me.handle)
    setEditingHandle(true)
  }

  async function commitHandle() {
    setEditingHandle(false)
    const trimmed = handleInput.trim()
    if (!me || !trimmed || trimmed === me.handle) return
    try {
      const updated = await api.updateSession({ handle: trimmed })
      setMe(updated)
    } catch {
      /* best effort; keep the previous handle displayed */
    }
  }

  if (!me) {
    return (
      <main className="shell">
        <h1>Fold</h1>
        <p className="pending">{error ? `Error: ${error}` : 'Loading…'}</p>
      </main>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Fold</h1>
        </div>
        <div className="me">
          {editingHandle ? (
            <>
              <span ref={handleMeasureRef} className="handle-measure" aria-hidden="true">
                {handleInput || ' '}
              </span>
              <input
                className="handle-edit"
                autoFocus
                maxLength={40}
                style={{ width: handleWidth }}
                value={handleInput}
                onChange={(e) => setHandleInput(e.target.value)}
                onBlur={commitHandle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitHandle()
                  if (e.key === 'Escape') setEditingHandle(false)
                }}
              />
            </>
          ) : (
            <button type="button" className="me-handle" onClick={startEditHandle} title="Click to rename">
              {me.handle}
            </button>
          )}
          <button className="icon-btn" onClick={toggleTheme} title="Toggle theme">
            {theme === 'light' ? '◐' : '◑'}
          </button>
          <button
            className="icon-btn noto-emoji"
            onClick={() => setShowPolicyPanel(true)}
            title="Notification policy"
            aria-label="Notification policy"
          >
            🔔
          </button>
          <button className="icon-btn" onClick={refresh} title="Refresh">
            ↻
          </button>
        </div>
      </header>

      <main className="layout">
        {error && <p className="err small">Sync issue: {error}</p>}
        {toast && <div className="home-toast">{toast}</div>}

        <div className="browser-controls">
          <TagBar categories={categories} active={tag} onSelect={(t) => updateUrl({ tag: t })} />
          <div className="browser-controls-right">
            {view === 'list' && <SortSelect value={sort} onChange={(s) => updateUrl({ sort: s })} />}
            <ViewToggle view={view} onChange={(v) => updateUrl({ view: v })} />
          </div>
        </div>

        {loading && activities.length === 0 && <p className="pending">Loading activities...</p>}

        {view === 'grid' ? (
          // key="grid"/"list" below forces a full remount on view switch
          // (instead of React reusing the same div/CreateTile DOM node with
          // updated props) so framer-motion's `layout` FLIP has no previous
          // position to glide from -- switching views is an instant swap,
          // not an animated morph. Reordering/filtering within a view is
          // unaffected since the key stays put there.
          <div className="tile-grid" key="grid">
            <CreateTile view={view} onClick={() => setCreating(true)} />
            <AnimatePresence mode="popLayout">
              {gridOrder.map((a) => (
                <ActivityTile
                  key={a.id}
                  activity={a}
                  now={now}
                  size={sizes.get(a.id) ?? 1}
                  expanded={expandedId === a.id}
                  onToggle={() => setExpandedId((cur) => (cur === a.id ? null : a.id))}
                  cta={
                    a.proposer_id === me.id
                      ? (
                        <div className="activity-actions">
                          <Link className="activity-launch primary" to={`/${a.code}`}>
                            Join activity
                          </Link>
                          <button className="activity-launch ghost" type="button" onClick={() => setEditingActivity(a)}>
                            Edit
                          </button>
                        </div>
                        )
                      : undefined
                  }
                />
              ))}
            </AnimatePresence>
          </div>
        ) : (
          <div className="list-view" key="list">
            <CreateTile view={view} onClick={() => setCreating(true)} />
            <AnimatePresence mode="popLayout">
              {listOrder.map((a) => (
                <ActivityListItem
                  key={a.id}
                  activity={a}
                  now={now}
                  canEdit={a.proposer_id === me.id}
                  onEdit={() => setEditingActivity(a)}
                />
              ))}
            </AnimatePresence>
          </div>
        )}

        {!loading && activities.length > 0 && filtered.length === 0 && (
          <p className="empty">No activities in this category yet.</p>
        )}
      </main>

      {creating && (
        <div className="modal-backdrop modal-backdrop-lower" onClick={() => setCreating(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <ProposeForm
              initialCode={prefillCode}
              categoryOptions={categoryOptions}
              onCreated={() => {
                setCreating(false)
                setPrefillCode(null)
                refresh()
              }}
              onClose={() => {
                setCreating(false)
                setPrefillCode(null)
              }}
            />
          </div>
        </div>
      )}

      {editingActivity && (
        <div className="modal-backdrop" onClick={() => setEditingActivity(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <ProposeForm
              activity={editingActivity}
              categoryOptions={categoryOptions}
              onCreated={() => {
                setEditingActivity(null)
                refresh()
              }}
              onDeleted={() => {
                setExpandedId((prev) => (prev === editingActivity.id ? null : prev))
                setEditingActivity(null)
                refresh()
              }}
              onClose={() => setEditingActivity(null)}
            />
          </div>
        </div>
      )}

      {showPolicyPanel && (
        <PolicyPanel
          rules={rules}
          onRulesChange={setRules}
          onClose={() => setShowPolicyPanel(false)}
          notifyStatus={notifyStatus}
          onRequestNotifications={enableNotifications}
          onShare={sharePolicy}
        />
      )}
    </div>
  )
}
