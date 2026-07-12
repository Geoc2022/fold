import { AnimatePresence } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { clearPersonId, ensureSession } from '../api'
import { useTheme } from '../theme'
import { popularityOrder, tileSizes } from '../tileLayout'
import { useSync } from '../useSync'
import type { ActivityView, Person } from '../types'
import { ActivityListItem } from '../components/ActivityListItem'
import { ActivityTile } from '../components/ActivityTile'
import { CreateTile } from '../components/CreateTile'
import { ProposeForm } from '../components/ProposeForm'
import { PushPanel } from '../components/PushPanel'
import { SortSelect, type SortKey } from '../components/SortSelect'
import { TagBar } from '../components/TagBar'
import { ViewToggle, type HomeView } from '../components/ViewToggle'

const CODE_PATTERN = /^[a-zA-Z]{4}$/
const SORT_KEYS: SortKey[] = ['newest', 'oldest', 'runs', 'served', 'commit', 'name']

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

  const activities = data?.activities ?? []
  const now = data?.server_time ?? Date.now()

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const a of activities) set.add(a.category)
    return Array.from(set).sort()
  }, [activities])

  const filtered = useMemo(
    () => (tag === 'all' ? activities : activities.filter((a) => a.category === tag)),
    [activities, tag],
  )

  const gridOrder = useMemo(() => popularityOrder(filtered), [filtered])
  const sizes = useMemo(() => tileSizes(filtered), [filtered])
  const listOrder = useMemo(() => sortActivities(filtered, sort), [filtered, sort])

  const committedTo = activities.find((a) => a.my_state === 'committed')

  if (!me) {
    return (
      <main className="shell">
        <h1>fold</h1>
        <p className="pending">{error ? `Error: ${error}` : 'Loading…'}</p>
      </main>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>fold</h1>
        </div>
        <div className="me">
          <span className="me-handle">{me.handle}</span>
          <button className="ghost sm icon-btn" onClick={toggleTheme} title="Toggle theme">
            {theme === 'light' ? '◐' : '◑'}
          </button>
          <button className="ghost sm" onClick={refresh} title="Refresh now">
            ↻
          </button>
        </div>
      </header>

      {committedTo && (
        <div className="committed-banner">
          You're committed to <strong>{committedTo.title}</strong>
          {committedTo.current_run?.status === 'scheduled'
            ? ' - scheduled.'
            : committedTo.current_run?.group.is_ready
              ? ' - group is ready!'
              : ' - waiting for the group to form.'}
        </div>
      )}

      <main className="layout">
        <section className="main-col">
          <div className="browser-controls">
            <TagBar categories={categories} active={tag} onSelect={(t) => updateUrl({ tag: t })} />
            <div className="browser-controls-right">
              {view === 'list' && <SortSelect value={sort} onChange={(s) => updateUrl({ sort: s })} />}
              <ViewToggle view={view} onChange={(v) => updateUrl({ view: v })} />
            </div>
          </div>

          {loading && activities.length === 0 && <p className="pending">Loading activities...</p>}

          {view === 'grid' ? (
            <div className="tile-grid">
              <CreateTile view={view} onClick={() => setCreating(true)} />
              <AnimatePresence mode="popLayout">
                {gridOrder.map((a) => (
                  <ActivityTile key={a.id} activity={a} now={now} size={sizes.get(a.id) ?? 1} />
                ))}
              </AnimatePresence>
            </div>
          ) : (
            <div className="list-view">
              <CreateTile view={view} onClick={() => setCreating(true)} />
              <AnimatePresence mode="popLayout">
                {listOrder.map((a) => (
                  <ActivityListItem key={a.id} activity={a} />
                ))}
              </AnimatePresence>
            </div>
          )}

          {!loading && activities.length > 0 && filtered.length === 0 && (
            <p className="empty">No activities in this category yet.</p>
          )}
        </section>

        <aside className="side-col">
          <section className="card side-card">
            <PushPanel />
          </section>
          {error && <p className="err small">Sync issue: {error}</p>}
        </aside>
      </main>

      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <ProposeForm
              initialCode={prefillCode}
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
    </div>
  )
}
