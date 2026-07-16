import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../api'
import { groupingIsFeasible } from '../grouping'
import { readJson, writeJson } from '../storage'
import type { ActivityView, GroupingMode } from '../types'
import { EmojiPicker } from './EmojiPicker'
import { GroupPreview } from './GroupPreview'

interface CategoryOption {
  value: string
  label: string
  count: number
}

interface Props {
  /** Prefills the code field, e.g. when arriving at a nonexistent /CODE. */
  initialCode?: string | null
  /** When set, the form edits an existing activity instead of creating one. */
  activity?: ActivityView | null
  categoryOptions: CategoryOption[]
  onCreated: (activity: ActivityView) => void
  onDeleted?: (activityId: string) => void
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
  private_by_link?: boolean
  location?: string
  duration_minutes?: number
  max_commit_minutes?: number
  category?: string
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

export function ProposeForm({ initialCode, activity, categoryOptions, onCreated, onDeleted, onClose }: Props) {
  const navigate = useNavigate()
  const [last] = useState(loadLastProposal)
  const isEdit = activity != null

  const [formMode, setFormMode] = useState<FormMode>(isEdit ? 'expanded' : 'simple')
  const [emoji, setEmoji] = useState(activity?.emoji ?? last.emoji ?? '🎲')
  const [title, setTitle] = useState(activity?.title ?? '')
  const [description, setDescription] = useState(activity?.description ?? '')
  const [location, setLocation] = useState(last.location ?? '')
  const [mode, setMode] = useState<GroupingMode>(activity?.grouping_mode ?? last.grouping_mode ?? 'single')
  const [minPeople, setMinPeople] = useState(activity?.min_people ?? last.min_people ?? 2)
  const [maxPeople, setMaxPeople] = useState<number | null>(activity?.max_people ?? last.max_people ?? null)
  const [groupMultiple, setGroupMultiple] = useState(activity?.group_multiple ?? last.group_multiple ?? 2)
  const [allowGuests, setAllowGuests] = useState(activity?.allow_guests ?? last.allow_guests ?? true)
  const [privateByLink, setPrivateByLink] = useState(activity?.private_by_link ?? last.private_by_link ?? false)
  const [category, setCategory] = useState(activity?.category ?? last.category ?? categoryOptions[0]?.value ?? 'board game')
  const [durationMinutes, setDurationMinutes] = useState(activity?.duration_minutes ?? last.duration_minutes ?? 30)
  const [maxCommitMinutes, setMaxCommitMinutes] = useState(activity?.max_commit_minutes ?? last.max_commit_minutes ?? 30)
  const [durationInput, setDurationInput] = useState(() => minutesToHuman(activity?.duration_minutes ?? last.duration_minutes ?? 30))
  const [maxCommitInput, setMaxCommitInput] = useState(() => minutesToHuman(activity?.max_commit_minutes ?? last.max_commit_minutes ?? 30))
  const [code, setCode] = useState(initialCode ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (initialCode) {
      setCode(initialCode)
      setFormMode('expanded')
    }
  }, [initialCode])

  useEffect(() => {
    if (!activity) return
    setFormMode('expanded')
    setEmoji(activity.emoji)
    setTitle(activity.title)
    setDescription(activity.description ?? '')
    setMode(activity.grouping_mode)
    setMinPeople(activity.min_people)
    setMaxPeople(activity.max_people)
    setGroupMultiple(activity.group_multiple)
    setAllowGuests(activity.allow_guests)
    setPrivateByLink(activity.private_by_link)
    setCategory(activity.category)
    setDurationMinutes(activity.duration_minutes)
    setMaxCommitMinutes(activity.max_commit_minutes)
    setDurationInput(minutesToHuman(activity.duration_minutes))
    setMaxCommitInput(minutesToHuman(activity.max_commit_minutes))
  }, [activity])

  // Esc closes the form, same as clicking Cancel.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const feasible = groupingIsFeasible(mode, minPeople, maxPeople, groupMultiple)

  useEffect(() => {
    if (categoryOptions.length === 0) return
    if (!categoryOptions.some((opt) => opt.value === category)) {
      setCategory(categoryOptions[0].value)
    }
  }, [categoryOptions, category])

  function handleDurationChange(value: string) {
    setDurationInput(value)
    const parsed = parseDuration(value)
    if (parsed !== null) setDurationMinutes(clampMinutes(parsed, 0, 24 * 60))
  }

  function handleMaxEtaChange(value: string) {
    setMaxCommitInput(value)
    const parsed = parseDuration(value)
    if (parsed !== null) setMaxCommitMinutes(clampMinutes(parsed, 0, 24 * 60))
  }

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
      private_by_link: privateByLink,
      category,
      duration_minutes: durationMinutes,
      max_commit_minutes: maxCommitMinutes,
      location: location.trim() || null,
      expires_at: null,
    }

    try {
      let saved: ActivityView
      const explicitCode = code.trim()
      if (isEdit && activity) {
        saved = await api.updateActivity(activity.id, {
          emoji: emoji.trim() || null,
          title: t,
          description: description.trim() || null,
          min_people: minPeople,
          max_people: maxPeople,
          group_multiple: mode === 'tiling' ? groupMultiple : 1,
          grouping_mode: mode,
          allow_guests: allowGuests,
          private_by_link: privateByLink,
          category,
          duration_minutes: durationMinutes,
          max_commit_minutes: maxCommitMinutes,
        })
      } else if (explicitCode) {
        saved = await api.createActivity({ ...basePayload, code: explicitCode })
      } else {
        saved = await createWithDerivedCode(basePayload, t)
      }
      saveLastProposal({
        emoji: saved.emoji,
        min_people: minPeople,
        max_people: maxPeople,
        group_multiple: groupMultiple,
        grouping_mode: mode,
        allow_guests: allowGuests,
        private_by_link: privateByLink,
        location: location.trim() || undefined,
        duration_minutes: durationMinutes,
        max_commit_minutes: maxCommitMinutes,
        category,
      })
      onCreated(saved)
      if (!isEdit) navigate(`/${saved.code}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!activity) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteActivity(activity.id)
      onDeleted?.(activity.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <form className="card propose-form" onSubmit={submit}>
      <div className="propose-head">
        <h2>{isEdit ? 'Edit an Activity' : 'Add an Activity'}</h2>
        <div className="propose-head-actions">
          <button
            type="button"
            className="ghost sm icon-btn"
            title={formMode === 'simple' ? 'Show more fields' : 'Show fewer fields'}
            onClick={() => setFormMode((m) => (m === 'simple' ? 'expanded' : 'simple'))}
          >
            {formMode === 'simple' ? '◀' : '▼'}
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
          maxLength={14}
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
            maxLength={125}
            placeholder="Details (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          {!isEdit && (
            <input
              aria-label="Location"
              maxLength={120}
              placeholder="Location (optional)"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          )}
          <div className="check-row-group">
            <label className="check-row">
              <input type="checkbox" checked={allowGuests} onChange={(e) => setAllowGuests(e.target.checked)} />
              <span>Allow Guests</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={privateByLink}
                onChange={(e) => setPrivateByLink(e.target.checked)}
              />
              <span>Private by link</span>
            </label>
          </div>
          <label>
            Category
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {categoryOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} ({opt.count})
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <label>
              Arrived Window
              <input
                type="text"
                placeholder="10m 30s"
                value={durationInput}
                onChange={(e) => handleDurationChange(e.target.value)}
                onBlur={() => setDurationInput(minutesToHuman(durationMinutes))}
              />
              <span className="hint">How long someone stays in the arrived state</span>
            </label>
            <label>
              Max Arrival ETA
              <input
                type="text"
                placeholder="30m"
                value={maxCommitInput}
                onChange={(e) => handleMaxEtaChange(e.target.value)}
                onBlur={() => setMaxCommitInput(minutesToHuman(maxCommitMinutes))}
              />
              <span className="hint">Largest ETA someone can choose when committing</span>
            </label>
          </div>
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

      {formMode === 'expanded' && !isEdit && (
        <input
          aria-label="Code"
          maxLength={4}
          placeholder="Code (optional)"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
        />
      )}

      {error && <p className="err">{error}</p>}
      <div className={`row propose-actions${isEdit ? '' : ' solo'}`}>
        {isEdit && (
          <button type="button" className="danger" onClick={handleDelete} disabled={busy}>
            Delete activity
          </button>
        )}
        <button type="submit" disabled={busy || !title.trim() || !feasible}>
          {busy ? (isEdit ? 'Saving…' : 'Posting…') : (isEdit ? 'Edit Activity' : 'Post activity')}
        </button>
      </div>
    </form>
  )
}

function minutesToHuman(total: number) {
  const clamped = Math.max(0, total)
  const hours = Math.floor(clamped / 60)
  const minutes = clamped % 60
  if (hours > 0) return `${hours}h ${minutes}m`.trim()
  return `${minutes}m`
}

function parseDuration(text: string): number | null {
  const trimmed = text.trim().toLowerCase()
  if (!trimmed) return null
  const tokens = trimmed.split(/\s+/)
  let seconds = 0
  let matched = false
  for (const token of tokens) {
    if (!token) continue
    const match = token.match(/^(?<val>\d+)(?<unit>h|hr|hrs|m|min|s|sec|seconds)?$/i)
    if (match) {
      const val = Number(match.groups?.val || 0)
      const unit = (match.groups?.unit || 'm').toLowerCase()
      if (unit.startsWith('h')) seconds += val * 3600
      else if (unit.startsWith('s')) seconds += val
      else seconds += val * 60
      matched = true
      continue
    }
    if (token.includes(':')) {
      const parts = token.split(':').map((p) => (p === '' ? 0 : Number(p)))
      if (parts.every((p) => Number.isNaN(p))) continue
      if (parts.length === 2) {
        const [mm = 0, ss = 0] = parts
        seconds += (Number.isNaN(mm) ? 0 : mm) * 60 + (Number.isNaN(ss) ? 0 : ss)
        matched = true
        continue
      }
      if (parts.length === 3) {
        const [hh = 0, mm = 0, ss = 0] = parts
        seconds += (Number.isNaN(hh) ? 0 : hh) * 3600 + (Number.isNaN(mm) ? 0 : mm) * 60 + (Number.isNaN(ss) ? 0 : ss)
        matched = true
        continue
      }
    }
    const plain = Number(token)
    if (!Number.isNaN(plain)) {
      seconds += plain * 60
      matched = true
    }
  }
  if (!matched) return null
  return Math.max(0, Math.round(seconds / 60))
}

function clampMinutes(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min
  return Math.max(min, Math.min(max, value))
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
