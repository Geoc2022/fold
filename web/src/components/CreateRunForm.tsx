import { useState } from 'react'
import { api } from '../api'
import { localInputToMs } from '../format'
import { readJson, writeJson } from '../storage'
import type { ActivityView } from '../types'

interface Props {
  activity: ActivityView
  onCreated: () => void
  onCancel: () => void
}

interface LastRun {
  location?: string
  details?: string
}

function storageKey(activityId: string): string {
  return `fold.last_run.${activityId}`
}

function loadLastRun(activityId: string): LastRun {
  return readJson(storageKey(activityId), {})
}

function saveLastRun(activityId: string, v: LastRun) {
  writeJson(storageKey(activityId), v)
}

/** Light "propose a run" form shown when an activity's room is empty.
 * Grouping/code/emoji are inherited from the activity; only time/location/
 * details need filling in, defaulted from the last run of this activity. */
export function CreateRunForm({ activity, onCreated, onCancel }: Props) {
  const last = loadLastRun(activity.id)
  const [location, setLocation] = useState(last.location ?? '')
  const [details, setDetails] = useState(last.details ?? '')
  const [scheduledFor, setScheduledFor] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.createRun(activity.id, {
        location: location.trim() || null,
        details: details.trim() || null,
        scheduled_for: localInputToMs(scheduledFor),
      })
      saveLastRun(activity.id, {
        location: location.trim() || undefined,
        details: details.trim() || undefined,
      })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card create-run-form" onSubmit={submit}>
      <h2>
        {activity.emoji} Propose a run of &ldquo;{activity.title}&rdquo;
      </h2>
      <p className="hint">The room is empty right now — kick off a new gathering.</p>

      <label>
        Location <span className="opt">(optional)</span>
        <input
          maxLength={120}
          placeholder="Courtyard, Room 3…"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
      </label>
      <label>
        Details <span className="opt">(optional)</span>
        <textarea
          rows={2}
          maxLength={500}
          placeholder="Anything useful for this run"
          value={details}
          onChange={(e) => setDetails(e.target.value)}
        />
      </label>
      <label>
        When <span className="opt">(optional)</span>
        <input type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
      </label>

      {error && <p className="err">{error}</p>}
      <div className="row">
        <button type="button" className="ghost" onClick={onCancel}>
          Not now
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Posting…' : 'Propose run'}
        </button>
      </div>
    </form>
  )
}
