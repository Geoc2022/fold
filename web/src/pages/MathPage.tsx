import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { BiologyRoom, type BiologySnapshot, type BioParticipant, type NodeState } from '../components/BiologyRoom'
import { compileAndEvaluate, evaluateExpression, highlightPolicy, type HighlightToken, type JsonValue } from '../policy/engine'
import { readString, writeString } from '../storage'

const DEFAULT_POLICY = '#interested + #committed > 3 => notify "critical mass" in 15s'
const LEFT_WIDTH_KEY = 'fold.math.left_width'
const TERMINAL_HEIGHT_KEY = 'fold.math.terminal_height'
const CONSOLE_HEIGHT_KEY = 'fold.math.console_height'

type LogLevel = 'info' | 'warn' | 'error'

interface LogEntry {
  id: number
  at: number
  level: LogLevel
  message: string
}

type FiredAction =
  | { kind: 'notify'; message: string | null; afterSecs: number | null }
  | { kind: 'commit' }
  | { kind: 'interest' }
  | { kind: 'lurk' }

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
  const [roomRunning, setRoomRunning] = useState(true)
  const [selfState, setSelfState] = useState<NodeState>('lurker')
  const [showHelp, setShowHelp] = useState(false)
  const [terminalInput, setTerminalInput] = useState('')
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([])
  const [leftWidth, setLeftWidth] = useState(() => Number(readString(LEFT_WIDTH_KEY) ?? '420') || 420)
  const [terminalHeight, setTerminalHeight] = useState(() => Number(readString(TERMINAL_HEIGHT_KEY) ?? '150') || 150)
  const [consoleHeight, setConsoleHeight] = useState(() => Number(readString(CONSOLE_HEIGHT_KEY) ?? '180') || 180)

  const nextLogIdRef = useRef(1)
  const nextTerminalIdRef = useRef(1)
  const terminalBodyRef = useRef<HTMLDivElement | null>(null)
  const consoleBodyRef = useRef<HTMLDivElement | null>(null)
  const prevPolicyFireRef = useRef(false)
  const policyTimerRef = useRef<number | null>(null)
  const lastPolicyErrorRef = useRef<string | null>(null)

  const env = useMemo(
    () => buildPolicyEnv(snapshot.now, snapshot.participants),
    [snapshot.now, snapshot.participants],
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
      const fired = decodeFired(out.fired)
      const currentlyFired = fired !== null
      if (fired && !prevPolicyFireRef.current) {
        if (fired.kind === 'notify') {
          const delayMs = Math.max(0, fired.afterSecs ?? 0) * 1000
          if (policyTimerRef.current != null) window.clearTimeout(policyTimerRef.current)
          policyTimerRef.current = window.setTimeout(() => {
            policyTimerRef.current = null
            pushLog(`policy notify: ${fired.message ?? 'policy notify fired'}`, 'warn')
          }, delayMs)
        } else {
          const nextState: NodeState = fired.kind === 'commit' ? 'committed' : fired.kind === 'interest' ? 'interested' : 'lurker'
          setSelfState(nextState)
          pushLog(`policy action: self -> ${nextState}`, 'warn')
        }
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
    const el = terminalBodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [terminalEntries])

  useEffect(() => {
    const el = consoleBodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  useEffect(() => {
    writeString(LEFT_WIDTH_KEY, String(leftWidth))
  }, [leftWidth])

  useEffect(() => {
    writeString(TERMINAL_HEIGHT_KEY, String(terminalHeight))
  }, [terminalHeight])

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

  const beginResizeTerminal = (e: ReactMouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = terminalHeight
    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY
      setTerminalHeight(clamp(startHeight + delta, 120, 420))
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

  const runTerminal = async (raw: string) => {
    const input = raw.trim()
    if (!input) return
    const expr = input.startsWith('>>>') ? input.slice(3).trim() : input
    setTerminalInput('')
    const res = await evaluateExpression(expr, env)
    const output = res.error
      ? `error: ${res.error}`
      : res.ty
        ? `${res.output ?? ''} : ${res.ty}`
        : res.output ?? ''
    const entry: TerminalEntry = {
      id: nextTerminalIdRef.current,
      input: expr,
      output,
      error: res.error != null,
    }
    nextTerminalIdRef.current += 1
    setTerminalEntries((prev) => [...prev.slice(-79), entry])
  }

  return (
    <>
      <main className="math-page" style={{ gridTemplateColumns: `${leftWidth}px 3px 1fr` }}>
      <section className="math-left" style={{ gridTemplateRows: `auto auto minmax(220px, 1fr) 3px ${terminalHeight}px 3px ${consoleHeight}px` }}>
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
          <button
            type="button"
            onClick={() => setRoomRunning((v) => !v)}
            title={roomRunning ? 'Pause simulation' : 'Play simulation'}
            aria-label={roomRunning ? 'Pause simulation' : 'Play simulation'}
          >
            <span className="noto-emoji" aria-hidden="true">{roomRunning ? '⏸️' : '▶️'}</span>
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
        <div className="math-horizontal-splitter" onMouseDown={beginResizeTerminal} />
        <div className="math-terminal">
          <div className="math-terminal-head">Terminal</div>
          <div className="math-terminal-body" ref={terminalBodyRef}>
            {terminalEntries.length === 0 && <div className="math-terminal-empty">Try: #interested + 1 · avg(proj(committed).1) · (fun x -&gt; x * 2) 4</div>}
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
              void runTerminal(terminalInput)
            }}
          >
            <span className="math-terminal-prompt">&gt;&gt;&gt;</span>
            <input value={terminalInput} onChange={(e) => setTerminalInput(e.target.value)} />
          </form>
        </div>
        <div className="math-horizontal-splitter" onMouseDown={beginResizeConsole} />
        <div className="math-console left-dock">
          <div className="math-console-head">Console</div>
          <div className="math-console-body" ref={consoleBodyRef}>
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
          <BiologyRoom
            embedded
            onSnapshot={onSnapshot}
            selfState={selfState}
            running={roomRunning}
            showPlayToggle={false}
          />
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
                <li><code>fun x -&gt; ...</code>: lambda (ML/OCaml)</li>
                <li><code>match</code>: strict pattern match (needs <code>_</code>)</li>
                <li><code>type</code>: declare a record or enum</li>
                <li><code>a = expr</code>: bind a variable (put on its own line)</li>
                <li><code>and</code>, <code>or</code>, <code>not</code>, <code>xor</code>: boolean logic</li>
                <li><code>true</code>, <code>false</code>: bool literals</li>
              </ul>

              <h3>Actions</h3>
              <ul>
                <li><code>notify</code> (<code>in 3min</code>, <code>message:</code>, <code>after:</code>)</li>
                <li><code>commit</code>, <code>interest</code>, <code>lurk</code>: set the self node</li>
              </ul>

              <h3>Counts</h3>
              <ul>
                <li><code>#interested</code>, <code>#committed</code>, <code>#arrived</code>, <code>#lurkers</code></li>
              </ul>
            </div>

            <div>
              <h3>Functions</h3>
              <ul>
                <li><code>len(list)</code>, <code>sum(list)</code>, <code>avg(list)</code></li>
                <li><code>min(a, b)</code>, <code>max(a, b)</code></li>
                <li><code>abs/floor/ceil/round(x)</code></li>
                <li><code>map(f, xs)</code>, <code>filter(f, xs)</code></li>
                <li><code>any(f, xs)</code>, <code>all(f, xs)</code></li>
                <li><code>proj(xs)</code>: split <code>List&lt;(Str,Dur)&gt;</code> into <code>(List&lt;Str&gt;, List&lt;Dur&gt;)</code></li>
              </ul>

              <h3>Operators</h3>
              <ul>
                <li><code>+ - * / %</code></li>
                <li><code>&lt; &lt;= &gt; &gt;= == !=</code></li>
              </ul>
            </div>

            <div>
              <h3>Types</h3>
              <ul>
                <li><code>Num</code> <code>3</code>, <code>Bool</code> <code>true</code></li>
                <li><code>Dur</code> <code>15s</code>, <code>1m2s</code>, <code>2h</code></li>
                <li><code>Str</code> <code>"A"</code></li>
                <li><code>interested/lurkers : List&lt;Str&gt;</code></li>
                <li><code>committed/arrived : List&lt;(Str, Dur)&gt;</code></li>
              </ul>

              <h3>Records &amp; enums (OCaml)</h3>
              <ul>
                <li><code>type user = &#123; id : int; name : string &#125;</code></li>
                <li><code>u = &#123; id = 1; name = "A" &#125;</code></li>
                <li><code>u.name</code> · <code>&#123; id; _ &#125; = u</code></li>
                <li><code>type color = Red | Green | Blue</code></li>
              </ul>

              <h3>Examples</h3>
              <ul>
                <li><code>#committed &gt; 3 =&gt; notify</code></li>
                <li><code>avg(proj(committed).1) &gt; 5min =&gt; notify "ETA high"</code></li>
                <li><code>any(fun c -&gt; c &gt; 2min, proj(committed).1) =&gt; commit</code></li>
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

// Room durations (minutes) mirrored from the activity defaults.
const DURATION_SECS = 30 * 60
const MAX_COMMIT_SECS = 30 * 60
const MIN_PEOPLE = 2

function buildPolicyEnv(serverTime: number, participants: BioParticipant[]): JsonValue {
  const others = participants.filter((p) => !p.isSelf)
  const interested = others.filter((p) => p.state === 'interested').map((p) => str(p.label))
  const lurkers = others.filter((p) => p.state === 'lurker').map((p) => str(p.label))
  const committed = others
    .filter((p) => p.state === 'committed')
    .map((p) => tuple([str(p.label), dur(p.etaSecs)]))
  const arrived = others
    .filter((p) => p.state === 'arrived')
    .map((p) => tuple([str(p.label), dur(p.waitedSecs)]))
  const people = others.map((p) => str(p.label))
  const now = new Date(serverTime)
  const day = now.getDay()
  const isWeekend = day === 0 || day === 6
  return {
    vars: {
      interested: list(interested),
      lurkers: list(lurkers),
      committed: list(committed),
      arrived: list(arrived),
      people: list(people),
      hour: num(now.getHours()),
      is_weekend: bool(isWeekend),
      min_people: num(MIN_PEOPLE),
      max_people: num(0),
      duration: dur(DURATION_SECS),
      max_commit: dur(MAX_COMMIT_SECS),
    },
  }
}

function decodeFired(value: JsonValue | null): FiredAction | null {
  if (value == null) return null
  // Unit variants (Commit/Interest/Lurk) serialize as a bare string.
  if (typeof value === 'string') {
    if (value === 'Commit') return { kind: 'commit' }
    if (value === 'Interest') return { kind: 'interest' }
    if (value === 'Lurk') return { kind: 'lurk' }
    return null
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const notify = (value as Record<string, JsonValue>).Notify
  if (!notify || typeof notify !== 'object' || Array.isArray(notify)) return null
  const payload = notify as Record<string, JsonValue>
  return {
    kind: 'notify',
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

function num(v: number): JsonValue {
  return { Num: v }
}

function bool(v: boolean): JsonValue {
  return { Bool: v }
}

function str(v: string): JsonValue {
  return { Str: v }
}

function dur(secs: number): JsonValue {
  return { DurSecs: secs }
}

function list(values: JsonValue[]): JsonValue {
  return { List: values }
}

function tuple(values: JsonValue[]): JsonValue {
  return { Tuple: values }
}
