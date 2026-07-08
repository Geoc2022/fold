import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { localInputToMs } from '../format'
import type { GroupingMode } from '../types'

interface Props {
  onCreated: () => void
}

export function ProposeForm({ onCreated }: Props) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [minPeople, setMinPeople] = useState(2)
  const [maxPeople, setMaxPeople] = useState('')
  const [groupMultiple, setGroupMultiple] = useState(1)
  const [mode, setMode] = useState<GroupingMode>('single')
  const [location, setLocation] = useState('')
  const [expires, setExpires] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setTitle('')
    setCode('')
    setDescription('')
    setMinPeople(2)
    setMaxPeople('')
    setGroupMultiple(1)
    setMode('single')
    setLocation('')
    setExpires('')
    setError(null)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    setBusy(true)
    setError(null)
    try {
      const activity = await api.createActivity({
        code: code.trim() || null,
        title: t,
        description: description.trim() || null,
        min_people: minPeople,
        max_people: maxPeople ? Number(maxPeople) : null,
        group_multiple: groupMultiple,
        grouping_mode: mode,
        location: location.trim() || null,
        expires_at: localInputToMs(expires),
      })
      reset()
      setOpen(false)
      onCreated()
      if (activity.code) navigate(`/${activity.code}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button className="propose-fab" onClick={() => setOpen(true)}>
        + Propose an activity
      </button>
    )
  }

  return (
    <form className="card propose-form" onSubmit={submit}>
      <div className="propose-head">
        <h2>Propose an activity</h2>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setOpen(false)
            setError(null)
          }}
        >
          Cancel
        </button>
      </div>

      <label>
        Code <span className="opt">(optional, 4 letters)</span>
        <input
          maxLength={4}
          placeholder="ABCD"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
        />
      </label>

      <label>
        Title
        <input
          autoFocus
          maxLength={120}
          placeholder="Badminton, coffee run, board games…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <label>
        Details <span className="opt">(optional)</span>
        <textarea
          rows={2}
          maxLength={500}
          placeholder="Where, vibe, anything useful"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <div className="row">
        <label className="grouping">
          Grouping
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as GroupingMode)}
          >
            <option value="single">Single group (one crew)</option>
            <option value="tiling">Tiling (parallel groups)</option>
          </select>
        </label>
        <label>
          Min people
          <input
            type="number"
            min={1}
            value={minPeople}
            onChange={(e) => setMinPeople(Math.max(1, Number(e.target.value)))}
          />
        </label>
      </div>

      <div className="row">
        <label>
          Group size step <span className="opt">(multiple)</span>
          <input
            type="number"
            min={1}
            value={groupMultiple}
            onChange={(e) =>
              setGroupMultiple(Math.max(1, Number(e.target.value)))
            }
          />
        </label>
        <label>
          Max people <span className="opt">(optional)</span>
          <input
            type="number"
            min={1}
            placeholder="∞"
            value={maxPeople}
            onChange={(e) => setMaxPeople(e.target.value)}
          />
        </label>
      </div>

      <div className="row">
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
          Expires <span className="opt">(optional)</span>
          <input
            type="datetime-local"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </label>
      </div>

      <p className="hint">
        {mode === 'single'
          ? 'One elastic group grows as people commit.'
          : 'People auto-fill into parallel groups of the step size (e.g. courts of 2).'}
      </p>

      {error && <p className="err">{error}</p>}
      <button type="submit" disabled={busy || !title.trim()}>
        {busy ? 'Posting…' : 'Post activity'}
      </button>
    </form>
  )
}
