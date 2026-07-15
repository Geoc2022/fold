import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { BiologyRoom, type BiologySnapshot } from '../components/BiologyRoom'
import { compileAndEvaluate, highlightPolicy, type HighlightToken, type JsonValue } from '../policy/engine'
import { readString, writeString } from '../storage'
import type { ActivityView, ParticipantView, RunView } from '../types'

const DEFAULT_POLICY = '#interested + #committed > 3 => notify "critical mass" in 15s'
const LEFT_WIDTH_KEY = 'fold.math.left_width'
const CONSOLE_HEIGHT_KEY = 'fold.math.console_height'

type LogLevel = 'info' | 'warn' | 'error'

interface LogEntry {
  id: number
  at: number
  level: LogLevel
  message: string
}

interface NotifyPayload {
  message: string | null
  afterSecs: number | null
}

interface TerminalEntry {
  id: number
  input: string
  output: string
  error: boolean
}

export function MathPage() {
  const [policySource, setPolicySource] = useState(DEFAULT_POLICY)
  const [activePolicy, setActivePolicy] = useState(DEFAULT_POLICY)
  const [tokens, setTokens] = useState<HighlightToken[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [policyStatus, setPolicyStatus] = useState('ready')
  const [snapshot, setSnapshot] = useState<BiologySnapshot>({ now: Date.now(), participants: [] })
  const [showHelp, setShowHelp] = useState(false)
  const [terminalInput, setTerminalInput] = useState('')
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([])
  const [leftWidth, setLeftWidth] = useState(() => Number(readString(LEFT_WIDTH_KEY) ?? '420') || 420)
  const [consoleHeight, setConsoleHeight] = useState(() => Number(readString(CONSOLE_HEIGHT_KEY) ?? '180') || 180)

  const nextLogIdRef = useRef(1)
  const nextTerminalIdRef = useRef(1)
  const prevPolicyFireRef = useRef(false)
  const policyTimerRef = useRef<number | null>(null)
  const lastPolicyErrorRef = useRef<string | null>(null)

  const activity = useMemo(
    () => buildActivity(snapshot.participants, snapshot.now),
    [snapshot.participants, snapshot.now],
  )
  const env = useMemo(
    () => buildPolicyEnv(snapshot.now, activity, snapshot.participants),
    [snapshot.now, activity, snapshot.participants],
  )
  const highlightedSegments = useMemo(
    () => buildHighlightedSegments(policySource, tokens),
    [policySource, tokens],
  )

  const onSnapshot = useCallback((next: BiologySnapshot) => {
    setSnapshot(next)
  }, [])

  const pushLog = useCallback((message: string, level: LogLevel = 'info') => {
    const entry: LogEntry = {
      id: nextLogIdRef.current,
      at: Date.now(),
      level,
      message,
    }
    nextLogIdRef.current += 1
    setLogs((prev) => [...prev.slice(-119), entry])
  }, [])

  useEffect(() => {
    let cancelled = false
    highlightPolicy(policySource)
      .then((res) => {
        if (!cancelled) setTokens(res.tokens)
      })
      .catch(() => {
        if (!cancelled) setTokens([])
      })
    return () => {
      cancelled = true
    }
  }, [policySource])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setPolicyStatus('evaluating')
      const out = await compileAndEvaluate(activePolicy, env)
      if (cancelled) return
      if (out.error) {
        setPolicyStatus(`error: ${out.error}`)
        if (lastPolicyErrorRef.current !== out.error) {
          lastPolicyErrorRef.current = out.error
          pushLog(`policy error: ${out.error}`, 'error')
        }
        return
      }
      lastPolicyErrorRef.current = null
      const notify = decodeNotify(out.fired)
      const currentlyFired = notify !== null
      if (notify && !prevPolicyFireRef.current) {
        const delayMs = Math.max(0, notify.afterSecs ?? 0) * 1000
        if (policyTimerRef.current != null) window.clearTimeout(policyTimerRef.current)
        policyTimerRef.current = window.setTimeout(() => {
          policyTimerRef.current = null
          const message = notify.message ?? 'policy notify fired'
          pushLog(`policy notify: ${message}`, 'warn')
        }, delayMs)
      } else if (!currentlyFired && policyTimerRef.current != null) {
        window.clearTimeout(policyTimerRef.current)
        policyTimerRef.current = null
      }
      prevPolicyFireRef.current = currentlyFired
      setPolicyStatus(currentlyFired ? 'fired' : 'ready')
    }

    const timer = window.setInterval(run, 1000)
    void run()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activePolicy, env, pushLog])

  useEffect(() => {
    return () => {
      if (policyTimerRef.current != null) window.clearTimeout(policyTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === '?') {
        e.preventDefault()
        setShowHelp((v) => !v)
      }
      if (e.key === 'Escape') setShowHelp(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    writeString(LEFT_WIDTH_KEY, String(leftWidth))
  }, [leftWidth])

  useEffect(() => {
    writeString(CONSOLE_HEIGHT_KEY, String(consoleHeight))
  }, [consoleHeight])

  const beginResizeLeft = (e: ReactMouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = leftWidth
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX
      const max = Math.max(360, window.innerWidth - 380)
      setLeftWidth(clamp(startWidth + delta, 300, max))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const beginResizeConsole = (e: ReactMouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = consoleHeight
    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY
      setConsoleHeight(clamp(startHeight + delta, 120, 420))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const savePolicy = () => {
    setActivePolicy(policySource)
    prevPolicyFireRef.current = false
    lastPolicyErrorRef.current = null
    if (policyTimerRef.current != null) {
      window.clearTimeout(policyTimerRef.current)
      policyTimerRef.current = null
    }
    pushLog('policy saved', 'info')
  }

  const runTerminal = (raw: string) => {
    const input = raw.trim()
    if (!input) return
    const expr = input.startsWith('>>>') ? input.slice(3).trim() : input
    const evaluated = evaluateTerminalExpression(expr)
    const entry: TerminalEntry = {
      id: nextTerminalIdRef.current,
      input: expr,
      output: evaluated.output,
      error: evaluated.error,
    }
    nextTerminalIdRef.current += 1
    setTerminalEntries((prev) => [...prev.slice(-79), entry])
    setTerminalInput('')
  }

  return (
    <>
      <main className="math-page" style={{ gridTemplateColumns: `${leftWidth}px 3px 1fr` }}>
      <section className="math-left" style={{ gridTemplateRows: `auto auto minmax(220px, 1fr) 3px 150px 3px ${consoleHeight}px` }}>
        <header className="math-head">
          <span className="math-status">{policySource === activePolicy ? policyStatus : `${policyStatus} (unsaved)`}</span>
        </header>
        <div className="math-controls">
          <button type="button" onClick={savePolicy} title="Save current policy" aria-label="Save current policy">
            <span className="noto-emoji" aria-hidden="true">💾</span>
          </button>
          <button type="button" onClick={() => setShowHelp(true)} title="Help" aria-label="Help">
            <span className="noto-emoji" aria-hidden="true">❓</span>
          </button>
        </div>
        <div className="math-editor-shell">
          <pre aria-hidden className="math-highlight-layer">
            {highlightedSegments.map((seg, idx) => (
              <span key={idx} className={seg.kind ? `token-${seg.kind}` : undefined}>
                {seg.text}
              </span>
            ))}
          </pre>
          <textarea
            className="math-editor-input"
            spellCheck={false}
            value={policySource}
            onChange={(e) => setPolicySource(e.target.value)}
          />
        </div>
        <div className="math-horizontal-splitter" onMouseDown={beginResizeConsole} />
        <div className="math-terminal">
          <div className="math-terminal-head">Terminal</div>
          <div className="math-terminal-body">
            {terminalEntries.length === 0 && <div className="math-terminal-empty">Try: 1 + 2</div>}
            {terminalEntries.map((entry) => (
              <div key={entry.id} className="math-terminal-entry">
                <div className="math-terminal-line">&gt;&gt;&gt; {entry.input}</div>
                <div className={`math-terminal-line ${entry.error ? 'error' : ''}`}>{entry.output}</div>
              </div>
            ))}
          </div>
          <form
            className="math-terminal-input-row"
            onSubmit={(e) => {
              e.preventDefault()
              runTerminal(terminalInput)
            }}
          >
            <span className="math-terminal-prompt">&gt;&gt;&gt;</span>
            <input value={terminalInput} onChange={(e) => setTerminalInput(e.target.value)} />
          </form>
        </div>
        <div className="math-horizontal-splitter" />
        <div className="math-console left-dock">
          <div className="math-console-head">Console</div>
          <div className="math-console-body">
            {logs.length === 0 && <div className="math-log-item">(no logs yet)</div>}
            {logs.map((log) => (
              <div key={log.id} className={`math-log-item ${log.level}`}>
                [{new Date(log.at).toLocaleTimeString()}] {log.message}
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="math-vertical-splitter" onMouseDown={beginResizeLeft} />

      <section className="math-right">
        <div className="math-room-wrap">
          <BiologyRoom embedded onSnapshot={onSnapshot} />
        </div>
      </section>
      </main>
      {showHelp && (
        <div className="math-help-backdrop" onClick={() => setShowHelp(false)}>
          <section className="math-help-panel" onClick={(e) => e.stopPropagation()}>
            <header className="math-help-head">
              <h2>Policy Help</h2>
              <button type="button" onClick={() => setShowHelp(false)} title="Close help" aria-label="Close help">
                <span className="noto-emoji" aria-hidden="true">✖️</span>
              </button>
            </header>
            <div className="math-help-grid">
            <div>
              <h3>Keywords</h3>
              <ul>
                <li><code>notify</code>: trigger notification action</li>
                <li><code>in</code>: short delay syntax (<code>notify in 3min</code>)</li>
                <li><code>after:</code>, <code>message:</code>: named notify args</li>
                <li><code>and</code>, <code>or</code>, <code>not</code>, <code>xor</code>: boolean logic</li>
                <li><code>true</code>, <code>false</code>: bool literals</li>
              </ul>

              <h3>Counts and fields</h3>
              <ul>
                <li><code>#interested</code>, <code>#committed</code>, <code>#people</code>: list counts</li>
                <li><code>committed.eta</code>: project a field over a list</li>
              </ul>
            </div>

            <div>
              <h3>Functions</h3>
              <ul>
                <li><code>len(list)</code></li>
                <li><code>sum(list)</code>, <code>avg(list)</code></li>
                <li><code>min(a, b)</code>, <code>max(a, b)</code></li>
                <li><code>abs(x)</code>, <code>floor(x)</code>, <code>ceil(x)</code>, <code>round(x)</code></li>
              </ul>

              <h3>Operators</h3>
              <ul>
                <li><code>+ - * / %</code></li>
                <li><code>&lt; &lt;= &gt; &gt;= == !=</code></li>
              </ul>
            </div>

            <div>
              <h3>Type Examples</h3>
              <ul>
                <li><code>Num</code>: <code>3</code>, <code>1.5</code></li>
                <li><code>Bool</code>: <code>true</code>, <code>false</code></li>
                <li><code>Dur</code>: <code>15s</code>, <code>3min</code>, <code>2h</code></li>
                <li><code>List</code>: <code>committed</code>, <code>interested</code></li>
                <li><code>Person field</code>: <code>committed.eta</code>, <code>committed.arrived</code></li>
              </ul>

              <h3>Rule Examples</h3>
              <ul>
                <li><code>#committed &gt; 3 =&gt; notify</code></li>
                <li><code>#interested + #committed &gt; 5 =&gt; notify "critical mass" in 30s</code></li>
                <li><code>avg(committed.eta) &gt; 5min =&gt; notify(message: "ETA high")</code></li>
              </ul>
            </div>
            </div>
          </section>
        </div>
      )}
    </>
  )
}

function clamp(value: number, min: number, max: number) {
  if (value < min) return min
  if (value > max) return max
  return value
}

function evaluateTerminalExpression(expr: string): { output: string; error: boolean } {
  if (!expr) return { output: '', error: false }
  if (!/^[0-9+\-*/%().\s]+$/.test(expr)) {
    return { output: 'error: only numeric arithmetic is supported', error: true }
  }
  try {
    // eslint-disable-next-line no-new-func
    const value = Function(`"use strict"; return (${expr});`)() as unknown
    if (typeof value === 'number' && Number.isFinite(value)) return { output: String(value), error: false }
    return { output: 'error: expression did not return a finite number', error: true }
  } catch (err) {
    return { output: `error: ${err instanceof Error ? err.message : String(err)}`, error: true }
  }
}

function buildRun(participants: ParticipantView[]): RunView {
  const interested = participants.filter((p) => p.state === 'interested').length
  const committed = participants.filter((p) => p.state === 'committed').length
  return {
    id: 'math-run',
    status: 'open',
    location: 'Math Sandbox',
    details: 'Policy + room simulation',
    scheduled_for: null,
    expires_at: null,
    interested_count: interested,
    committed_count: committed,
    created_at: Date.now(),
    updated_at: Date.now(),
    group: {
      complete_groups: Math.floor(committed / 2),
      group_sizes: committed >= 2 ? [Math.min(committed, 2)] : [],
      is_ready: committed >= 2,
      waiting_count: Math.max(0, committed - 2),
      spots_to_next: committed >= 2 ? 0 : 2 - committed,
      spots_remaining: null,
    },
  }
}

function buildActivity(participants: ParticipantView[], now: number): ActivityView {
  return {
    id: 'math-activity',
    code: 'MATH',
    emoji: '🧮',
    title: 'Policy Playground',
    description: 'Local room simulation for policy development',
    category: 'tabletop',
    proposer_id: 'math',
    proposer_handle: 'math',
    min_people: 2,
    max_people: null,
    group_multiple: 2,
    grouping_mode: 'single',
    allow_guests: true,
    duration_minutes: 30,
    max_commit_minutes: 30,
    times_run: 0,
    players_served: 0,
    interest_total: 0,
    commit_total: 0,
    commit_pct: null,
    last_active_at: now,
    created_at: now,
    updated_at: now,
    current_run: buildRun(participants),
    my_state: null,
  }
}

function buildPolicyEnv(serverTime: number, activity: ActivityView, participants: ParticipantView[]): JsonValue {
  const interested = participants.filter((p) => p.state === 'interested').map((p) => personValue(serverTime, p))
  const committed = participants.filter((p) => p.state === 'committed').map((p) => personValue(serverTime, p))
  const people = [...interested, ...committed]
  const now = new Date(serverTime)
  const day = now.getDay()
  const isWeekend = day === 0 || day === 6
  return {
    vars: {
      interested: list(interested),
      committed: list(committed),
      people: list(people),
      hour: num(now.getHours()),
      is_weekend: bool(isWeekend),
      min_people: num(activity.min_people),
      max_people: num(activity.max_people ?? 0),
      duration: dur(activity.duration_minutes * 60),
      max_commit: dur(activity.max_commit_minutes * 60),
    },
  }
}

function decodeNotify(value: JsonValue | null): NotifyPayload | null {
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
