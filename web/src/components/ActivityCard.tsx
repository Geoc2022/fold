import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api } from '../api'
import { relativeTime, shortDateTime } from '../format'
import type { ActivityView, Person } from '../types'
import { GroupMeter } from './GroupMeter'

interface Props {
  activity: ActivityView
  me: Person
  now: number
  onChanged: () => void
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  ready: 'Ready',
  scheduled: 'Scheduled',
  closed: 'Closed',
  cancelled: 'Cancelled',
}

export function ActivityCard({ activity: a, me, now, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scheduling, setScheduling] = useState(false)
  const [when, setWhen] = useState('')
  const [where, setWhere] = useState(a.location ?? '')

  const isProposer = a.proposer_id === me.id
  const terminal = a.status === 'closed' || a.status === 'cancelled'
  const roomPath = a.code ? `/${a.code}` : null

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('You are already committed to another activity.')
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(null)
    }
  }

  async function submitSchedule(e: React.FormEvent) {
    e.preventDefault()
    const ms = when ? new Date(when).getTime() : NaN
    if (Number.isNaN(ms)) {
      setError('Pick a valid time.')
      return
    }
    await run('schedule', () => api.schedule(a.id, ms, where.trim() || undefined))
    setScheduling(false)
  }

  return (
    <article className={`card activity status-${a.status}`}>
      <header className="activity-head">
        <div>
          <h3>{a.title}</h3>
          <p className="byline">
            {isProposer ? 'You' : a.proposer_handle ?? 'Someone'} · proposed{' '}
            {relativeTime(a.created_at, now)}
          </p>
        </div>
        <span className={`badge badge-${a.status}`}>
          {STATUS_LABEL[a.status] ?? a.status}
        </span>
      </header>

      {a.description && <p className="desc">{a.description}</p>}

      <div className="meta">
        {roomPath && (
          <Link className="code-chip" to={roomPath}>
            /{a.code}
          </Link>
        )}
        <span className="mode-chip">
          {a.grouping_mode === 'tiling' ? 'Tiling' : 'Single'} · min {a.min_people}
          {a.group_multiple > 1 ? ` · step ${a.group_multiple}` : ''}
          {a.max_people != null ? ` · max ${a.max_people}` : ''}
        </span>
        {a.location && <span className="loc">📍 {a.location}</span>}
        {a.scheduled_for != null && (
          <span className="sched">🕒 {shortDateTime(a.scheduled_for)}</span>
        )}
        {a.expires_at != null && !terminal && (
          <span className="exp">expires {relativeTime(a.expires_at, now)}</span>
        )}
      </div>

      <GroupMeter activity={a} />

      <div className="counts">
        <span>{a.interested_count} interested</span>
        <span>·</span>
        <span>{a.committed_count} committed</span>
      </div>

      {error && <p className="err">{error}</p>}

      {!terminal && (
        <div className="actions">
          {a.my_state !== 'committed' && (
            <button
              className="primary"
              disabled={busy !== null}
              onClick={() => run('commit', () => api.commit(a.id))}
            >
              {busy === 'commit' ? '…' : "I'm in"}
            </button>
          )}
          {a.my_state == null && (
            <button
              className="secondary"
              disabled={busy !== null}
              onClick={() => run('interest', () => api.interest(a.id))}
            >
              {busy === 'interest' ? '…' : 'Interested'}
            </button>
          )}
          {a.my_state != null && (
            <button
              className="ghost"
              disabled={busy !== null}
              onClick={() => run('withdraw', () => api.withdraw(a.id))}
            >
              {busy === 'withdraw'
                ? '…'
                : a.my_state === 'committed'
                  ? 'Withdraw'
                  : 'Not interested'}
            </button>
          )}
          {a.my_state && (
            <span className={`my-state my-${a.my_state}`}>
              {a.my_state === 'committed' ? '✓ committed' : 'interested'}
            </span>
          )}
        </div>
      )}

      {isProposer && !terminal && (
        <div className="proposer-controls">
          {!scheduling ? (
            <>
              <button className="ghost sm" onClick={() => setScheduling(true)}>
                {a.status === 'scheduled' ? 'Reschedule' : 'Schedule'}
              </button>
              <button
                className="ghost sm"
                disabled={busy !== null}
                onClick={() => run('close', () => api.close(a.id))}
              >
                Close
              </button>
              <button
                className="ghost sm danger"
                disabled={busy !== null}
                onClick={() => run('cancel', () => api.cancel(a.id))}
              >
                Cancel
              </button>
            </>
          ) : (
            <form className="schedule-form" onSubmit={submitSchedule}>
              <input
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
              <input
                placeholder="Location"
                value={where}
                onChange={(e) => setWhere(e.target.value)}
              />
              <button type="submit" className="primary sm" disabled={busy !== null}>
                Set
              </button>
              <button
                type="button"
                className="ghost sm"
                onClick={() => setScheduling(false)}
              >
                Cancel
              </button>
            </form>
          )}
        </div>
      )}
    </article>
  )
}
