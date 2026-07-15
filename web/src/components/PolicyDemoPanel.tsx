import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ActivityView, ParticipantView } from '../types'
import { readJson, readString, writeJson, writeString } from '../storage'
import { compileAndEvaluate, highlightPolicy, type HighlightToken, type JsonValue } from '../policy/engine'

const POLICY_LIVE_KEY = 'fold.policy.demo.live'
const DEFAULT_SOURCE = '#interested > 3 => notify "enough interest" in 3min'

interface PolicyRule {
  id: string
  source: string
  enabled: boolean
}

interface Props {
  serverTime: number
  activity: ActivityView
  participants: ParticipantView[]
  onAlert: (message: string) => void
}

export function PolicyDemoPanel({ serverTime, activity, participants, onAlert }: Props) {
  const policyKey = `fold.policy.demo.rules.${activity.code}`
  const [rules, setRules] = useState<PolicyRule[]>(() => readJson(policyKey, [newRule(DEFAULT_SOURCE)]))
  const [selectedId, setSelectedId] = useState<string>(() => readJson(policyKey, [newRule(DEFAULT_SOURCE)])[0]?.id ?? '')
  const [live, setLive] = useState(() => readString(POLICY_LIVE_KEY) === '1')
  const [result, setResult] = useState<string>('Evaluating...')
  const [tokens, setTokens] = useState<HighlightToken[]>([])
  const [busy, setBusy] = useState(false)
  const prevFireRef = useRef(new Map<string, boolean>())
  const timerRef = useRef(new Map<string, number>())
  const codeRef = useRef(activity.code)
  const highlightRef = useRef<HTMLPreElement | null>(null)
  const env = useMemo(() => buildPolicyEnv(serverTime, activity, participants), [serverTime, activity, participants])
  const selected = useMemo(() => rules.find((r) => r.id === selectedId) ?? rules[0] ?? null, [rules, selectedId])
  const highlightedSegments = useMemo(
    () => buildHighlightedSegments(selected?.source ?? '', tokens),
    [selected?.source, tokens],
  )

  useEffect(() => {
    if (codeRef.current !== activity.code) {
      codeRef.current = activity.code
      const loaded = readJson<PolicyRule[]>(`fold.policy.demo.rules.${activity.code}`, [newRule(DEFAULT_SOURCE)])
      setRules(loaded.length > 0 ? loaded : [newRule(DEFAULT_SOURCE)])
      setSelectedId(loaded[0]?.id ?? '')
    }
  }, [activity.code])

  useEffect(() => {
    writeJson(policyKey, rules)
  }, [policyKey, rules])

  useEffect(() => {
    if (!live) {
      prevFireRef.current.clear()
      clearAllTimers(timerRef)
    }
    writeString(POLICY_LIVE_KEY, live ? '1' : '0')
  }, [live])

  useEffect(() => {
    let cancelled = false
    const source = selected?.source ?? ''
    highlightPolicy(source)
      .then((out) => {
        if (!cancelled) setTokens(out.tokens)
      })
      .catch(() => {
        if (!cancelled) setTokens([])
      })
    return () => {
      cancelled = true
    }
  }, [selected?.source])

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    const active = rules.filter((r) => r.enabled)
    Promise.all(active.map(async (rule) => ({ rule, out: await compileAndEvaluate(rule.source, env) })))
      .then((rows) => {
        if (cancelled) return
        const activeIds = new Set(active.map((r) => r.id))
        for (const [id] of timerRef.current) {
          if (!activeIds.has(id)) {
            clearTimer(timerRef, id)
            prevFireRef.current.delete(id)
          }
        }

        const lines: string[] = []
        for (const { rule, out } of rows) {
          const fired = decodeNotify(out.fired)
          const currentlyFired = fired !== null
          const wasFired = prevFireRef.current.get(rule.id) ?? false
          if (live && fired && !wasFired) {
            clearTimer(timerRef, rule.id)
            const message = fired.message ?? `Policy ${shortId(rule.id)} triggered`
            const delayMs = Math.max(0, fired.afterSecs ?? 0) * 1000
            const timer = window.setTimeout(() => {
              onAlert(`Policy: ${message}`)
              timerRef.current.delete(rule.id)
            }, delayMs)
            timerRef.current.set(rule.id, timer)
          } else if (!currentlyFired) {
            clearTimer(timerRef, rule.id)
          }
          prevFireRef.current.set(rule.id, currentlyFired)

          if (out.error) lines.push(`${shortId(rule.id)} error: ${out.error}`)
          else lines.push(`${shortId(rule.id)} => ${JSON.stringify(out.fired)}`)
        }
        setResult(lines.join('\n') || 'No enabled rules')
      })
      .catch((err) => {
        if (!cancelled) setResult(`Error: ${String(err)}`)
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [rules, env, live, onAlert])

  useEffect(() => {
    return () => clearAllTimers(timerRef)
  }, [])

  return (
    <section className="policy-demo-panel physics-help bio-help">
      <div className="bio-section-title">Policy demo ({activity.code})</div>
      <p className="policy-demo-hint">Rules run in this room. Delays with <code>in 3min</code> are now live.</p>

      <div className="policy-rule-list">
        {rules.map((rule) => (
          <div key={rule.id} className={`policy-rule-item ${rule.id === selected?.id ? 'active' : ''}`}>
            <button type="button" className="policy-rule-select" onClick={() => setSelectedId(rule.id)}>
              {shortId(rule.id)}
            </button>
            <label className="policy-rule-enabled">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => patchRule(rule.id, { enabled: e.target.checked }, setRules)}
              />
              on
            </label>
            <button type="button" className="panel-button" onClick={() => removeRule(rule.id, rules, setRules, setSelectedId)}>
              remove
            </button>
          </div>
        ))}
      </div>

      <div className="policy-demo-row">
        <label className="policy-demo-live">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          live room alert
        </label>
        <button type="button" className="panel-button" onClick={() => addRule(setRules, setSelectedId)}>
          add rule
        </button>
        <button
          type="button"
          className="panel-button"
          onClick={() => selected && patchRule(selected.id, { source: '#committed > 3 => notify' }, setRules)}
        >
          Example 1
        </button>
        <button
          type="button"
          className="panel-button"
          onClick={() =>
            selected &&
            patchRule(selected.id, { source: '#interested + #committed > 5 => notify "critical mass" in 2min' }, setRules)
          }
        >
          Example 2
        </button>
      </div>

      <div className="policy-editor-shell">
        <pre ref={highlightRef} aria-hidden className="policy-highlight-layer">
          {highlightedSegments.map((seg, idx) => (
            <span key={idx} className={seg.kind ? `token-${seg.kind}` : undefined}>
              {seg.text}
            </span>
          ))}
        </pre>
        <textarea
          className="policy-demo-input policy-overlay-input"
          value={selected?.source ?? ''}
          rows={4}
          spellCheck={false}
          onScroll={(e) => {
            if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop
          }}
          onChange={(e) => {
            if (!selected) return
            patchRule(selected.id, { source: e.target.value }, setRules)
          }}
        />
      </div>

      <pre className="policy-demo-output">{busy ? 'Evaluating...' : result}</pre>
    </section>
  )
}

function newRule(source: string): PolicyRule {
  return { id: crypto.randomUUID(), source, enabled: true }
}

function addRule(
  setRules: Dispatch<SetStateAction<PolicyRule[]>>,
  setSelectedId: Dispatch<SetStateAction<string>>,
) {
  const rule = newRule(DEFAULT_SOURCE)
  setRules((prev) => [...prev, rule])
  setSelectedId(rule.id)
}

function removeRule(
  id: string,
  rules: PolicyRule[],
  setRules: Dispatch<SetStateAction<PolicyRule[]>>,
  setSelectedId: Dispatch<SetStateAction<string>>,
) {
  const next = rules.filter((r) => r.id !== id)
  if (next.length === 0) {
    const fallback = newRule(DEFAULT_SOURCE)
    setRules([fallback])
    setSelectedId(fallback.id)
    return
  }
  setRules(next)
  if (!next.some((r) => r.id === id)) setSelectedId(next[0].id)
}

function patchRule(
  id: string,
  patch: Partial<PolicyRule>,
  setRules: Dispatch<SetStateAction<PolicyRule[]>>,
) {
  setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
}

function shortId(id: string) {
  return id.slice(0, 4)
}

function clearTimer(ref: MutableRefObject<Map<string, number>>, id: string) {
  const timer = ref.current.get(id)
  if (timer != null) {
    window.clearTimeout(timer)
    ref.current.delete(id)
  }
}

function clearAllTimers(ref: MutableRefObject<Map<string, number>>) {
  for (const [id, timer] of ref.current) {
    window.clearTimeout(timer)
    ref.current.delete(id)
  }
}

function decodeNotify(value: JsonValue | null): { message: string | null; afterSecs: number | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const notify = (value as Record<string, JsonValue>).Notify
  if (!notify || typeof notify !== 'object' || Array.isArray(notify)) return null
  const payload = notify as Record<string, JsonValue>
  return {
    message: typeof payload.message === 'string' ? payload.message : null,
    afterSecs: typeof payload.after_secs === 'number' ? payload.after_secs : null,
  }
}

function buildHighlightedSegments(source: string, tokens: HighlightToken[]) {
  const out: Array<{ text: string; kind: string | null }> = []
  let cursor = 0
  for (const token of tokens) {
    if (token.start > cursor) out.push({ text: source.slice(cursor, token.start), kind: null })
    out.push({ text: source.slice(token.start, token.end), kind: token.kind })
    cursor = token.end
  }
  if (cursor < source.length) out.push({ text: source.slice(cursor), kind: null })
  if (out.length === 0) out.push({ text: source || ' ', kind: null })
  return out
}

function buildPolicyEnv(serverTime: number, activity: ActivityView, participants: ParticipantView[]): JsonValue {
  const interested = participants.filter((p) => p.state === 'interested').map((p) => personValue(serverTime, p))
  const committed = participants.filter((p) => p.state === 'committed').map((p) => personValue(serverTime, p))
  const people = [...interested, ...committed]
  const now = new Date(serverTime)
  const hour = now.getHours()
  const day = now.getDay()
  const isWeekend = day === 0 || day === 6
  return {
    vars: {
      interested: list(interested),
      committed: list(committed),
      people: list(people),
      hour: num(hour),
      is_weekend: bool(isWeekend),
      min_people: num(activity.min_people),
      max_people: num(activity.max_people ?? 0),
      duration: dur(activity.duration_minutes * 60),
      max_commit: dur(activity.max_commit_minutes * 60),
    },
  }
}

function personValue(serverTime: number, p: ParticipantView): JsonValue {
  const eta = p.arrival_at == null ? 0 : Math.max(0, Math.ceil((p.arrival_at - serverTime) / 1000))
  const arrived = p.arrival_at != null && p.arrival_at <= serverTime
  return {
    Person: {
      eta: dur(eta),
      arrived: bool(arrived),
      waited: dur(0),
    },
  }
}

function num(v: number): JsonValue {
  return { Num: v }
}

function bool(v: boolean): JsonValue {
  return { Bool: v }
}

function dur(secs: number): JsonValue {
  return { DurSecs: secs }
}

function list(values: JsonValue[]): JsonValue {
  return { List: values }
}
