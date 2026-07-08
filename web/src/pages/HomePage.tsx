import { useEffect, useMemo, useState } from 'react'
import { clearPersonId, getPersonId } from '../api'
import { useSync } from '../useSync'
import type { ActivityView, Person } from '../types'
import { Onboarding } from '../components/Onboarding'
import { ProposeForm } from '../components/ProposeForm'
import { ActivityCard } from '../components/ActivityCard'
import { NotificationFeed } from '../components/NotificationFeed'
import { PushPanel } from '../components/PushPanel'

const STATUS_ORDER: Record<string, number> = {
  ready: 0,
  scheduled: 1,
  open: 2,
  closed: 3,
  cancelled: 4,
}

function sortActivities(list: ActivityView[]): ActivityView[] {
  return [...list].sort((a, b) => {
    const s = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    if (s !== 0) return s
    return b.updated_at - a.updated_at
  })
}

export function HomePage() {
  const [hasId, setHasId] = useState(() => getPersonId() !== null)
  const { data, error, loading, refresh } = useSync(hasId)
  const [optimisticMe, setOptimisticMe] = useState<Person | null>(null)
  const me = data?.me ?? optimisticMe

  useEffect(() => {
    if (hasId && data && data.me === null) {
      clearPersonId()
      setOptimisticMe(null)
      setHasId(false)
    }
  }, [hasId, data])

  const activities = useMemo(
    () => (data ? sortActivities(data.activities) : []),
    [data],
  )
  const now = data?.server_time ?? Date.now()

  if (!hasId || !me) {
    if (!hasId) {
      return (
        <Onboarding
          onReady={(p) => {
            setOptimisticMe(p)
            setHasId(true)
          }}
        />
      )
    }
    return (
      <main className="shell">
        <h1>fold</h1>
        <p className="pending">{error ? `Error: ${error}` : 'Loading…'}</p>
      </main>
    )
  }

  const committedTo = activities.find((a) => a.my_state === 'committed')

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>fold</h1>
          <span className="tagline">spontaneous activities, coalesced</span>
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
          {committedTo.scheduled_for
            ? ' - scheduled.'
            : committedTo.group.is_ready
              ? ' - group is ready!'
              : ' - waiting for the group to form.'}
        </div>
      )}

      <main className="layout">
        <section className="main-col">
          <ProposeForm onCreated={refresh} />

          {loading && activities.length === 0 && (
            <p className="pending">Loading activities...</p>
          )}
          {!loading && activities.length === 0 && (
            <div className="card empty-state">
              <p>No activities yet.</p>
              <p className="hint">Be the first to propose something.</p>
            </div>
          )}

          <div className="activity-list">
            {activities.map((a) => (
              <ActivityCard
                key={a.id}
                activity={a}
                me={me}
                now={now}
                onChanged={refresh}
              />
            ))}
          </div>
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
    </div>
  )
}
