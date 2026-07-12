import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../api'
import { groupingIsFeasible } from '../grouping'
import { readJson, writeJson } from '../storage'
import type { ActivityView, GroupingMode } from '../types'
import { EmojiPicker } from './EmojiPicker'
import { GroupPreview } from './GroupPreview'

interface Props {
  /** Prefills the code field, e.g. when arriving at a nonexistent /CODE. */
  initialCode?: string | null
  onCreated: (activity: ActivityView) => void
  onClose: () => void
}

type FormMode = 'simple' | 'expanded'

const LAST_PROPOSAL_KEY = 'fold.last_proposal'

interface LastProposal {
  emoji?: string
  min_people?: number
  max_people?: number | null
  group_multiple?: number
  grouping_mode?: GroupingMode
  allow_guests?: boolean
  location?: string
}

function loadLastProposal(): LastProposal {
  return readJson(LAST_PROPOSAL_KEY, {})
}

function saveLastProposal(v: LastProposal) {
  writeJson(LAST_PROPOSAL_KEY, v)
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

  const [formMode, setFormMode] = useState<FormMode>('simple')
  const [emoji, setEmoji] = useState(last.emoji ?? '🎲')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState(last.location ?? '')
  const [mode, setMode] = useState<GroupingMode>(last.grouping_mode ?? 'single')
  const [minPeople, setMinPeople] = useState(last.min_people ?? 2)
  const [maxPeople, setMaxPeople] = useState<number | null>(last.max_people ?? null)
  const [groupMultiple, setGroupMultiple] = useState(last.group_multiple ?? 2)
  const [allowGuests, setAllowGuests] = useState(last.allow_guests ?? true)
  const [code, setCode] = useState(initialCode ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (initialCode) {
      setCode(initialCode)
      setFormMode('expanded')
    }
  }, [initialCode])

  // Esc closes the form, same as clicking Cancel.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

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
      min_people: minPeople,
      max_people: maxPeople,
      group_multiple: mode === 'tiling' ? groupMultiple : 1,
      grouping_mode: mode,
      allow_guests: allowGuests,
      location: location.trim() || null,
      expires_at: null,
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
        min_people: minPeople,
        max_people: maxPeople,
        group_multiple: groupMultiple,
        grouping_mode: mode,
        allow_guests: allowGuests,
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
        <h2>Add an Activity</h2>
        <div className="propose-head-actions">
          <button
            type="button"
            className="ghost sm icon-btn"
            title={formMode === 'simple' ? 'Show more fields' : 'Show fewer fields'}
            onClick={() => setFormMode((m) => (m === 'simple' ? 'expanded' : 'simple'))}
          >
            {formMode === 'simple' ? '◁' : '◀'}
          </button>
          <button type="button" className="ghost danger" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>

      <div className="title-row">
        <EmojiPicker value={emoji} onChange={setEmoji} />
        <input
          autoFocus
          maxLength={100}
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      {formMode === 'expanded' && (
        <>
          <textarea
            aria-label="Details"
            rows={2}
            maxLength={500}
            placeholder="Details (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <input
            aria-label="Location"
            maxLength={120}
            placeholder="Location (optional)"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
          <label className="check-row">
            <input type="checkbox" checked={allowGuests} onChange={(e) => setAllowGuests(e.target.checked)} />
            <span>Allow Guests</span>
          </label>
        </>
      )}

      <div className="grouping-block">
        <div className="grouping-toggle" role="group" aria-label="Grouping mode">
          <button type="button" className={mode === 'single' ? 'active' : ''} onClick={() => setMode('single')}>
            Single group
          </button>
          <button type="button" className={mode === 'tiling' ? 'active' : ''} onClick={() => setMode('tiling')}>
            Parallel groups
          </button>
        </div>

        <div className="people-row">
          <label className="num-field">
            Min
            <input
              type="number"
              min={1}
              value={minPeople}
              onChange={(e) => {
                const v = Math.max(1, Number(e.target.value) || 1)
                setMinPeople(v)
                if (maxPeople != null && maxPeople < v) setMaxPeople(v)
              }}
            />
          </label>
          <label className="num-field">
            Max
            <input
              type="number"
              min={1}
              placeholder="∞"
              value={maxPeople ?? ''}
              onChange={(e) => {
                const raw = e.target.value
                if (raw.trim() === '') {
                  setMaxPeople(null)
                  return
                }
                const v = Math.max(1, Number(raw) || 1)
                setMaxPeople(v)
                if (v < minPeople) setMinPeople(v)
              }}
            />
          </label>
          {mode === 'tiling' && (
            <label className="num-field">
              Per group
              <input
                type="number"
                min={1}
                value={groupMultiple}
                onChange={(e) => setGroupMultiple(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
          )}
        </div>

        <GroupPreview mode={mode} min={minPeople} max={maxPeople} groupMultiple={mode === 'tiling' ? groupMultiple : 1} />
      </div>

      {formMode === 'expanded' && (
        <input
          aria-label="Code"
          maxLength={4}
          placeholder="Code (optional)"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
        />
      )}

      {error && <p className="err">{error}</p>}
      <button type="submit" disabled={busy || !title.trim() || !feasible}>
        {busy ? 'Posting…' : 'Post activity'}
      </button>
    </form>
  )
}

/** Distinguishes "that code is already taken" (retry with another candidate)
 * from other 409s like a duplicate title (surface immediately instead). */
function isCodeConflict(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { conflict?: unknown }).conflict === 'code'
}

async function createWithDerivedCode(
  basePayload: Omit<Parameters<typeof api.createActivity>[0], 'code'>,
  title: string,
): Promise<ActivityView> {
  for (const candidate of deriveCodeCandidates(title)) {
    try {
      return await api.createActivity({ ...basePayload, code: candidate })
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && isCodeConflict(err.body)) continue
      throw err
    }
  }
  // All 5 derived candidates collided; let the server pick a fully random one.
  return api.createActivity({ ...basePayload, code: null })
}
