import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../api'
import { localInputToMs } from '../format'
import { groupingIsFeasible } from '../grouping'
import type { ActivityView, GroupingMode } from '../types'
import { GroupPreview } from './GroupPreview'
import { RangeSlider } from './RangeSlider'

interface Props {
  /** Prefills the code field, e.g. when arriving at a nonexistent /CODE. */
  initialCode?: string | null
  onCreated: (activity: ActivityView) => void
  onClose: () => void
}

const LAST_PROPOSAL_KEY = 'fold.last_proposal'
const EMOJI_SUGGESTIONS = ['🎲', '🏸', '⚽️', '🎮', '☕️', '🧩', '🃏', '🍜', '📖', '🎵', '🏓', '🎯']

interface LastProposal {
  emoji?: string
  category?: string
  min_people?: number
  max_people?: number | null
  group_multiple?: number
  grouping_mode?: GroupingMode
  location?: string
}

function loadLastProposal(): LastProposal {
  try {
    const raw = localStorage.getItem(LAST_PROPOSAL_KEY)
    return raw ? (JSON.parse(raw) as LastProposal) : {}
  } catch {
    return {}
  }
}

function saveLastProposal(v: LastProposal) {
  try {
    localStorage.setItem(LAST_PROPOSAL_KEY, JSON.stringify(v))
  } catch {
    /* ignore storage failures (private mode) */
  }
}

function randomCode(): string {
  let out = ''
  for (let i = 0; i < 4; i += 1) out += String.fromCharCode(65 + Math.floor(Math.random() * 26))
  return out
}

/** If not already set: first choice is the title's first 4 letters (if it
 * has that many); otherwise 4 random letters drawn from the title. Try 5
 * candidates before falling back to a fully random code. */
function deriveCodeCandidates(title: string): string[] {
  const letters = title.toUpperCase().replace(/[^A-Z]/g, '')
  const candidates: string[] = []
  if (letters.length >= 4) candidates.push(letters.slice(0, 4))

  const pool = letters.length > 0 ? letters : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let attempts = 0
  while (candidates.length < 5 && attempts < 50) {
    attempts += 1
    let pick = ''
    for (let i = 0; i < 4; i += 1) pick += pool[Math.floor(Math.random() * pool.length)]
    if (!candidates.includes(pick)) candidates.push(pick)
  }
  while (candidates.length < 5) candidates.push(randomCode())
  return candidates
}

export function ProposeForm({ initialCode, onCreated, onClose }: Props) {
  const navigate = useNavigate()
  const [last] = useState(loadLastProposal)

  const [emoji, setEmoji] = useState(last.emoji ?? '🎲')
  const [category, setCategory] = useState(last.category ?? 'general')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState(last.location ?? '')
  const [mode, setMode] = useState<GroupingMode>(last.grouping_mode ?? 'single')
  const [minPeople, setMinPeople] = useState(last.min_people ?? 2)
  const [maxPeople, setMaxPeople] = useState<number | null>(last.max_people ?? null)
  const [groupMultiple, setGroupMultiple] = useState(last.group_multiple ?? 2)
  const [code, setCode] = useState(initialCode ?? '')
  const [expires, setExpires] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (initialCode) setCode(initialCode)
  }, [initialCode])

  const feasible = groupingIsFeasible(mode, minPeople, maxPeople, groupMultiple)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t || !feasible) return
    setBusy(true)
    setError(null)

    const basePayload = {
      emoji: emoji.trim() || null,
      title: t,
      description: description.trim() || null,
      category: category.trim() || null,
      min_people: minPeople,
      max_people: maxPeople,
      group_multiple: mode === 'tiling' ? groupMultiple : 1,
      grouping_mode: mode,
      location: location.trim() || null,
      expires_at: localInputToMs(expires),
    }

    try {
      let activity: ActivityView
      const explicitCode = code.trim()
      if (explicitCode) {
        activity = await api.createActivity({ ...basePayload, code: explicitCode })
      } else {
        activity = await createWithDerivedCode(basePayload, t)
      }
      saveLastProposal({
        emoji: activity.emoji,
        category: activity.category,
        min_people: minPeople,
        max_people: maxPeople,
        group_multiple: groupMultiple,
        grouping_mode: mode,
        location: location.trim() || undefined,
      })
      onCreated(activity)
      navigate(`/${activity.code}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card propose-form" onSubmit={submit}>
      <div className="propose-head">
        <h2>Propose an activity</h2>
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>

      <div className="row emoji-row">
        <label>
          Emoji or symbol
          <input maxLength={8} value={emoji} onChange={(e) => setEmoji(e.target.value)} />
        </label>
        <label>
          Category
          <input
            maxLength={40}
            placeholder="Board Games, Sports…"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </label>
      </div>
      <div className="emoji-suggestions">
        {EMOJI_SUGGESTIONS.map((em) => (
          <button
            type="button"
            key={em}
            className={`emoji-pick ${emoji === em ? 'active' : ''}`}
            onClick={() => setEmoji(em)}
          >
            {em}
          </button>
        ))}
      </div>

      <label>
        Title
        <input
          autoFocus
          maxLength={100}
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

      <label>
        Location <span className="opt">(optional)</span>
        <input
          maxLength={120}
          placeholder="Courtyard, Room 3…"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
      </label>

      <div className="grouping-block">
        <span className="grouping-label">Grouping</span>
        <div className="grouping-toggle" role="group" aria-label="Grouping mode">
          <button type="button" className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}>
            Single group
          </button>
          <button type="button" className={mode === 'tiling' ? 'active' : ''} onClick={() => setMode('tiling')}>
            Parallel groups
          </button>
        </div>

        <RangeSlider
          floor={2}
          ceilingPlus={15}
          valueMin={minPeople}
          valueMax={maxPeople}
          onChange={(mn, mx) => {
            setMinPeople(mn)
            setMaxPeople(mx)
          }}
        />

        {mode === 'tiling' && (
          <label className="per-group">
            Per group
            <input
              type="number"
              min={1}
              value={groupMultiple}
              onChange={(e) => setGroupMultiple(Math.max(1, Number(e.target.value) || 1))}
            />
          </label>
        )}

        <GroupPreview mode={mode} min={minPeople} max={maxPeople} groupMultiple={mode === 'tiling' ? groupMultiple : 1} />

        <p className="hint">
          {mode === 'single'
            ? 'One elastic group grows as people commit.'
            : 'People auto-fill into parallel groups of the size above (e.g. courts of 2).'}
        </p>
      </div>

      <label>
        Code <span className="opt">(optional, 4 letters)</span>
        <input
          maxLength={4}
          placeholder="auto, from the title"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
        />
      </label>

      <label>
        Auto-expire <span className="opt">(optional)</span>
        <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </label>

      {error && <p className="err">{error}</p>}
      <button type="submit" disabled={busy || !title.trim() || !feasible}>
        {busy ? 'Posting…' : 'Post activity'}
      </button>
    </form>
  )
}

async function createWithDerivedCode(
  basePayload: Omit<Parameters<typeof api.createActivity>[0], 'code'>,
  title: string,
): Promise<ActivityView> {
  for (const candidate of deriveCodeCandidates(title)) {
    try {
      return await api.createActivity({ ...basePayload, code: candidate })
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) continue
      throw err
    }
  }
  // All 5 derived candidates collided; let the server pick a fully random one.
  return api.createActivity({ ...basePayload, code: null })
}
