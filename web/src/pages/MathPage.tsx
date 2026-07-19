import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { BiologyRoom, type BiologySnapshot, type BioParticipant, type NodeState } from '../components/BiologyRoom'
import {
  compileAndEvaluate,
  evaluateExpression,
  highlightPolicy,
  type Effect,
  type HighlightToken,
  type JsonValue,
  type PolicyValue,
} from '../policy/engine'
import { buildHighlightedSegments } from '../policy/highlight'
import { bool, dur, envFromVars, list, num, record, str, variant } from '../policy/values'
import { LANGUAGE_DOCS_URL } from '../links'
import { readString, writeString } from '../storage'
import { useForceTheme } from '../useForceTheme'

const DEFAULT_POLICY = '#interested + #committed >= min_people => notify "critical mass: {#committed} committed"'
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

interface TerminalEntry {
  id: number
  input: string
  output: string
  error: boolean
}

export function MathPage() {
  useForceTheme('light')
  const [policySource, setPolicySource] = useState(DEFAULT_POLICY)
  const [activePolicy, setActivePolicy] = useState(DEFAULT_POLICY)
  const [tokens, setTokens] = useState<HighlightToken[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [policyStatus, setPolicyStatus] = useState('ready')
  const [snapshot, setSnapshot] = useState<BiologySnapshot>({
    now: Date.now(),
    participants: [],
    minPeople: 2,
    maxPeople: 6,
  })
  const [selfState, setSelfState] = useState<NodeState>('lurker')
  const [terminalInput, setTerminalInput] = useState('')
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([])
  const [terminalHistory, setTerminalHistory] = useState<string[]>([])
  const [leftWidth, setLeftWidth] = useState(() => Number(readString(LEFT_WIDTH_KEY) ?? '420') || 420)
  const [terminalHeight, setTerminalHeight] = useState(() => Number(readString(TERMINAL_HEIGHT_KEY) ?? '150') || 150)
  const [consoleHeight, setConsoleHeight] = useState(() => Number(readString(CONSOLE_HEIGHT_KEY) ?? '180') || 180)

  const nextLogIdRef = useRef(1)
  const nextTerminalIdRef = useRef(1)
  const terminalHistoryIndexRef = useRef(-1)
  const terminalDraftRef = useRef('')
  const terminalBodyRef = useRef<HTMLDivElement | null>(null)
  const consoleBodyRef = useRef<HTMLDivElement | null>(null)
  const prevPolicyFireRef = useRef(false)
  const effectTimersRef = useRef<number[]>([])
  const lastPolicyErrorRef = useRef<string | null>(null)

  const clearEffectTimers = useCallback(() => {
    for (const t of effectTimersRef.current) window.clearTimeout(t)
    effectTimersRef.current = []
  }, [])

  const env = useMemo(
    () => buildPolicyEnv(snapshot.now, snapshot.participants, selfState, snapshot.minPeople, snapshot.maxPeople),
    [snapshot.now, snapshot.participants, selfState, snapshot.minPeople, snapshot.maxPeople],
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
      const fired = out.fired
      const currentlyFired = fired != null && fired.op !== 'noop'
      if (currentlyFired && !prevPolicyFireRef.current) {
        clearEffectTimers()
        scheduleEffect(
          fired,
          0,
          effectTimersRef.current,
          (message) => pushLog(`notify: ${message}`, 'warn'),
          (state, etaDeltaSeconds) => {
            setSelfState(state as NodeState)
            const adjustment = etaDeltaSeconds == null
              ? ''
              : ` (${etaDeltaSeconds >= 0 ? '+' : ''}${etaDeltaSeconds}s)`
            pushLog(`self -> ${state}${adjustment}`, 'warn')
          },
        )
      } else if (!currentlyFired && prevPolicyFireRef.current) {
        clearEffectTimers()
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
  }, [activePolicy, env, pushLog, clearEffectTimers])

  useEffect(() => {
    return () => {
      clearEffectTimers()
    }
  }, [clearEffectTimers])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === '?') {
        e.preventDefault()
        window.open(LANGUAGE_DOCS_URL, '_blank', 'noopener,noreferrer')
      }
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

  useEffect(() => {
    const normalizeDockHeights = () => {
      const maxCombined = Math.max(260, window.innerHeight - 220)
      let nextTerminal = clamp(terminalHeight, 120, 420)
      let nextConsole = clamp(consoleHeight, 120, 420)
      if (nextTerminal + nextConsole > maxCombined) {
        nextConsole = maxCombined - nextTerminal
        if (nextConsole < 120) {
          nextConsole = 120
          nextTerminal = clamp(maxCombined - nextConsole, 120, 420)
        }
      }
      if (nextTerminal !== terminalHeight) setTerminalHeight(nextTerminal)
      if (nextConsole !== consoleHeight) setConsoleHeight(nextConsole)
    }
    normalizeDockHeights()
    window.addEventListener('resize', normalizeDockHeights)
    return () => window.removeEventListener('resize', normalizeDockHeights)
  }, [terminalHeight, consoleHeight])

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
      const maxCombined = Math.max(260, window.innerHeight - 220)
      const maxTerminal = Math.min(420, maxCombined - consoleHeight)
      setTerminalHeight(clamp(startHeight + delta, 120, Math.max(120, maxTerminal)))
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
      const maxCombined = Math.max(260, window.innerHeight - 220)
      const maxConsole = Math.min(420, maxCombined - terminalHeight)
      setConsoleHeight(clamp(startHeight + delta, 120, Math.max(120, maxConsole)))
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
    clearEffectTimers()
    pushLog('policy saved', 'info')
  }

  const runTerminal = async (raw: string) => {
    const input = raw.trim()
    if (!input) return
    const expr = input.startsWith('>>>') ? input.slice(3).trim() : input
    setTerminalInput('')
    terminalHistoryIndexRef.current = -1
    terminalDraftRef.current = ''
    setTerminalHistory((prev) => [...prev.slice(-79), expr])
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
      <section className="math-left" style={{ gridTemplateRows: `auto auto minmax(0, 1fr) 3px ${terminalHeight}px 3px ${consoleHeight}px` }}>
        <header className="math-head">
          <span className="math-status">{policySource === activePolicy ? policyStatus : `${policyStatus} (unsaved)`}</span>
        </header>
        <div className="math-controls">
          <button type="button" onClick={savePolicy} title="Save current policy" aria-label="Save current policy">
            <span className="noto-emoji" aria-hidden="true">💾</span>
          </button>
          <button
            type="button"
            onClick={() => window.open(LANGUAGE_DOCS_URL, '_blank', 'noopener,noreferrer')}
            title="Help"
            aria-label="Help"
          >
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
        <div className="math-horizontal-splitter" onMouseDown={beginResizeTerminal} />
        <div className="math-terminal">
          <div className="math-terminal-head">Terminal</div>
          <div className="math-terminal-body" ref={terminalBodyRef}>
            {terminalEntries.length === 0 && <div className="math-terminal-empty">Try: #interested + 1 · map (fun x -&gt; x * 2) [1, 2, 3] · eta self</div>}
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
            <input
              value={terminalInput}
              onChange={(e) => setTerminalInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') {
                  if (terminalHistory.length === 0) return
                  e.preventDefault()
                  if (terminalHistoryIndexRef.current === -1) {
                    terminalDraftRef.current = terminalInput
                    terminalHistoryIndexRef.current = terminalHistory.length - 1
                  } else if (terminalHistoryIndexRef.current > 0) {
                    terminalHistoryIndexRef.current -= 1
                  }
                  setTerminalInput(terminalHistory[terminalHistoryIndexRef.current] ?? '')
                  return
                }
                if (e.key === 'ArrowDown') {
                  if (terminalHistoryIndexRef.current === -1) return
                  e.preventDefault()
                  if (terminalHistoryIndexRef.current < terminalHistory.length - 1) {
                    terminalHistoryIndexRef.current += 1
                    setTerminalInput(terminalHistory[terminalHistoryIndexRef.current] ?? '')
                  } else {
                    terminalHistoryIndexRef.current = -1
                    setTerminalInput(terminalDraftRef.current)
                  }
                }
              }}
            />
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
            showLabels
            includeSelfNode
          />
        </div>
      </section>
      </main>
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
const GROUP_SIZE = 4
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function buildPolicyEnv(
  serverTime: number,
  participants: BioParticipant[],
  selfState: NodeState,
  minPeople: number,
  maxPeople: number,
): JsonValue {
  const others = participants.filter((p) => !p.isSelf)
  const byState = (s: NodeState) => others.filter((p) => p.state === s).map(person)
  const interested = byState('interested')
  const committed = byState('committed')
  const arrived = byState('arrived')
  const lurkers = byState('lurker')
  const now = new Date(serverTime)
  const waiting = interested.length + committed.length
  const groupsReady = Math.floor(committed.length / GROUP_SIZE)
  const spotsToNext = (GROUP_SIZE - (waiting % GROUP_SIZE)) % GROUP_SIZE
  const selfPerson = personFrom('', selfState, 0, 0)

  // Predicted time until the group is ready: once enough people have committed,
  // the group is "ready" when the last committed person arrives (max ETA).
  const committedPeers = others.filter((p) => p.state === 'committed')
  const readyIn =
    committedPeers.length >= minPeople
      ? variant('Option', 'Some', [dur(Math.max(0, ...committedPeers.map((p) => p.etaSecs)))])
      : variant('Option', 'None', [])

  const vars: Record<string, PolicyValue> = {
    self: selfPerson,
    interested: list(interested),
    committed: list(committed),
    arrived: list(arrived),
    lurkers: list(lurkers),
    today: variant('Day', DAY_NAMES[now.getDay()], []),
    now: record('Time', { hour: num(now.getHours()), minute: num(now.getMinutes()) }),
    min_people: num(minPeople),
    max_people: variant('Option', 'Some', [num(maxPeople)]),
    group_size: num(GROUP_SIZE),
    grouping_mode: variant('Grouping', 'Single', []),
    duration: dur(DURATION_SECS),
    max_commit: dur(MAX_COMMIT_SECS),
    groups_ready: num(groupsReady),
    waiting_count: num(waiting),
    spots_to_next: num(spotsToNext),
    is_ready: bool(committed.length >= minPeople),
    ready_in: readyIn,
  }
  return envFromVars(vars)
}

function person(p: BioParticipant): PolicyValue {
  return personFrom(p.label, p.state, p.etaSecs, p.waitedSecs)
}

function personFrom(name: string, state: NodeState, etaSecs: number, waitedSecs: number): PolicyValue {
  let st: PolicyValue
  switch (state) {
    case 'committed':
      st = variant('State', 'Committed', [dur(etaSecs)])
      break
    case 'arrived':
      st = variant('State', 'Arrived', [dur(waitedSecs)])
      break
    case 'interested':
      st = variant('State', 'Interested', [])
      break
    default:
      st = variant('State', 'Lurker', [])
  }
  return record('Person', { name: str(name), state: st })
}

/** Schedule a policy effect tree, accumulating delays from `sleep`. Returns
 * the final time offset (ms). */
function scheduleEffect(
  effect: Effect,
  offsetMs: number,
  timers: number[],
  onNotify: (message: string) => void,
  onState: (state: string, etaDeltaSeconds: number | null) => void,
): number {
  switch (effect.op) {
    case 'notify':
      timers.push(window.setTimeout(() => onNotify(effect.message), offsetMs))
      return offsetMs
    case 'state':
      timers.push(window.setTimeout(() => onState(effect.state, effect.eta_delta_secs ?? null), offsetMs))
      return offsetMs
    case 'sleep':
      return offsetMs + Math.max(0, effect.secs) * 1000
    case 'seq': {
      let o = offsetMs
      for (const step of effect.steps) o = scheduleEffect(step, o, timers, onNotify, onState)
      return o
    }
    case 'noop':
    default:
      return offsetMs
  }
}
