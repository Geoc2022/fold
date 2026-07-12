import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { clearPersonId, ensureSession } from '../api'
import { useSync } from '../useSync'
import type { ActivityView, Person } from '../types'
import { ActivityListItem } from '../components/ActivityListItem'
import { ActivityTile } from '../components/ActivityTile'
import { CreateTile } from '../components/CreateTile'
import { NotificationFeed } from '../components/NotificationFeed'
import { ProposeForm } from '../components/ProposeForm'
import { PushPanel } from '../components/PushPanel'
import { SortSelect, type SortKey } from '../components/SortSelect'
import { TagBar } from '../components/TagBar'
import { ViewToggle, type HomeView } from '../components/ViewToggle'

const VIEW_KEY = 'fold.home_view'
const SORT_KEY = 'fold.home_sort'
const CODE_PATTERN = /^[a-zA-Z]{4}$/

function initialView(): HomeView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

function initialSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_KEY)
    return v === 'oldest' || v === 'runs' || v === 'served' || v === 'commit' || v === 'name' ? v : 'newest'
  } catch {
    return 'newest'
  }
}

function sortActivities(list: ActivityView[], key: SortKey | 'active'): ActivityView[] {
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
    case 'active':
    default:
      return arr.sort((a, b) => b.last_active_at - a.last_active_at)
  }
}

export function HomePage() {
  const [searchParams, setSearchParams] = useSearchParams()

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

  const [tag, setTag] = useState('all')
  const [view, setView] = useState<HomeView>(initialView)
  const [sort, setSort] = useState<SortKey>(initialSort)
  const [creating, setCreating] = useState(false)
  const [prefillCode, setPrefillCode] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view)
  }, [view])
  useEffect(() => {
    localStorage.setItem(SORT_KEY, sort)
  }, [sort])

  // Arriving at /?code=TEST (redirected from a nonexistent /TEST room) opens
  // the propose form with that code pre-filled.
  useEffect(() => {
    const codeParam = searchParams.get('code')
    if (codeParam && CODE_PATTERN.test(codeParam)) {
      setPrefillCode(codeParam.toUpperCase())
      setCreating(true)
      setSearchParams((p) => {
        p.delete('code')
        return p
      }, { replace: true })
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
  const sorted = useMemo(
    () => sortActivities(filtered, view === 'list' ? sort : 'active'),
    [filtered, view, sort],
  )

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
          <span className="me-dot" style={{ background: me.color }} />
          <span className="me-handle">{me.handle}</span>
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
            <TagBar categories={categories} active={tag} onSelect={setTag} />
            <div className="browser-controls-right">
              {view === 'list' && <SortSelect value={sort} onChange={setSort} />}
              <ViewToggle view={view} onChange={setView} />
            </div>
          </div>

          {loading && activities.length === 0 && <p className="pending">Loading activities...</p>}

          <div className={view === 'grid' ? 'tile-grid' : 'list-view'}>
            <CreateTile view={view} onClick={() => setCreating(true)} />
            {sorted.map((a) =>
              view === 'grid' ? (
                <ActivityTile key={a.id} activity={a} now={now} />
              ) : (
                <ActivityListItem key={a.id} activity={a} />
              ),
            )}
          </div>

          {!loading && activities.length > 0 && sorted.length === 0 && (
            <p className="empty">No activities in this category yet.</p>
          )}
        </section>

        <aside className="side-col">
          <section className="card side-card">
            <PushPanel />
          </section>
          <NotificationFeed
            notifications={data?.notifications ?? []}
            now={now}
            onRead={refresh}
          />
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

