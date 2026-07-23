import { AnimatePresence } from 'framer-motion'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api, ApiError, ensureSession, resetSession } from '../api'
import { useTheme } from '../theme'
import { popularityOrder, tileSizes } from '../tileLayout'
import { useSync } from '../useSync'
import type { ActivityView, Person } from '../types'
import { ActivityListItem } from '../components/ActivityListItem'
import { ActivityTile } from '../components/ActivityTile'
import { CreateTile } from '../components/CreateTile'
import { HomeShell } from '../components/HomeShell'
import { FoldTitleFX } from '../components/FoldTitleFX'
import { PolicyPanel } from '../components/PolicyPanel'
import { ProposeForm } from '../components/ProposeForm'
import type { SortKey } from '../components/SortSelect'
import type { HomeView } from '../components/ViewToggle'
import { requestNotificationPermission } from '../notify-client'
import { enablePushNotifications } from '../push-client'
import { loadHomeRules, type PolicyRule } from '../policy/rules'
import { appendPolicySources, decodePolicySources, encodePolicySources } from '../policy/share'

const CODE_PATTERN = /^[a-zA-Z]{4}$/
const SORT_KEYS: SortKey[] = ['newest', 'oldest', 'runs', 'served', 'commit', 'name']
const EMPTY_ACTIVITIES: ActivityView[] = []
const CATEGORY_PRESETS = [
  { value: 'board game', label: 'Board Game' },
  { value: 'video game', label: 'Video Game' },
  { value: 'tabletop', label: 'Tabletop' },
  { value: 'outside', label: 'Outside' },
]

const TOAST_VISIBLE_MS = 4000

function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
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

  useEffect(() => {
    if (me && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      void enablePushNotifications().catch(() => undefined)
    }
  }, [me])

  const { data, error, loading, refresh } = useSync(me !== null)

  useEffect(() => {
    if (me && data && data.me === null) {
      setMe(null)
      void resetSession().finally(() => setSessionEpoch((e) => e + 1))
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
  const [rules, setRules] = useState<PolicyRule[]>(loadHomeRules)
  const [policiesReady, setPoliciesReady] = useState(false)
  const policyRevisionRef = useRef(0)
  const policyServerIdsRef = useRef(new Map<string, string>())
  const policySaveRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (!me) return
    let cancelled = false
    async function loadPolicies() {
      const response = await api.policySets()
      let home = response.sets.find((set) => set.scope === 'home')
      if (!home) {
        const local = loadHomeRules()
        home = await api.replacePolicySet({
          scope: 'home',
          timezone: browserTimezone(),
          revision: 0,
          rules: local.map(({ source, enabled }) => ({ source, enabled })),
        })
      }
      if (cancelled) return
      policyRevisionRef.current = home.revision
      policyServerIdsRef.current = new Map(home.rules.map((rule) => [rule.id, rule.id]))
      setRules(home.rules.map(({ id, source, enabled }) => ({ id, source, enabled })))
      setPoliciesReady(true)
    }
    void loadPolicies().catch((error) => {
      if (!cancelled) setNotifyStatus(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [me])

  const saveHomeRules = useCallback((nextRules: PolicyRule[]) => {
    setRules(nextRules)
    policySaveRef.current = policySaveRef.current
      .catch(() => undefined)
      .then(async () => {
        const save = () => api.replacePolicySet({
          scope: 'home' as const,
          timezone: browserTimezone(),
          revision: policyRevisionRef.current,
          rules: nextRules.map(({ id, source, enabled }) => ({
            id: policyServerIdsRef.current.get(id),
            source,
            enabled,
          })),
        })
        let saved
        try {
          saved = await save()
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error
          const current = (await api.policySets()).sets.find((set) => set.scope === 'home')
          policyRevisionRef.current = current?.revision ?? 0
          current?.rules.forEach((rule, index) => {
            const localId = nextRules[index]?.id
            if (localId) policyServerIdsRef.current.set(localId, rule.id)
          })
          saved = await save()
        }
        policyRevisionRef.current = saved.revision
        saved.rules.forEach((rule, index) => {
          const localId = nextRules[index]?.id
          if (localId) policyServerIdsRef.current.set(localId, rule.id)
        })
        setNotifyStatus('Policy saved')
      })
      .catch((error) => {
        setNotifyStatus(error instanceof Error ? error.message : String(error))
        throw error
      })
  }, [])

  // A shared policy link (?policy=<base64 of source[]>) appends those rules
  // and opens the panel, mirroring the ?code= propose-form flow above.
  useEffect(() => {
    const policyParam = searchParams.get('policy')
    if (policyParam && policiesReady) {
      try {
        const sources = decodePolicySources(policyParam)
        if (sources.length > 0) {
          saveHomeRules(appendPolicySources(rules, sources))
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
  }, [policiesReady, rules, saveHomeRules, searchParams, setSearchParams])

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null
      setToast(null)
    }, TOAST_VISIBLE_MS)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current)
    }
  }, [])

  async function enableNotifications() {
    setNotifyStatus(await requestNotificationPermission())
  }

  function sharePolicy() {
    const encoded = encodePolicySources(rules)
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
    <>
      <HomeShell
      brandSlot={<FoldTitleFX />}
      handleSlot={editingHandle ? (
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
      theme={theme}
      onThemeToggle={toggleTheme}
      onOpenPolicy={() => setShowPolicyPanel(true)}
      onRefresh={refresh}
      onHelp={() => navigate('/fold')}
      error={error}
      toast={toast}
      categories={categories}
      activeTag={tag}
      onTagSelect={(t) => updateUrl({ tag: t })}
      view={view}
      sort={sort}
      onSortChange={(s) => updateUrl({ sort: s })}
      onViewChange={(v) => updateUrl({ view: v })}
    >
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
      </HomeShell>

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

      {showPolicyPanel && policiesReady && (
        <PolicyPanel
          rules={rules}
          onRulesChange={saveHomeRules}
          onClose={() => setShowPolicyPanel(false)}
          hint="Rules run against activities you've joined."
          notifyStatus={notifyStatus}
          onRequestNotifications={enableNotifications}
          onShare={sharePolicy}
        />
      )}
    </>
  )
}
