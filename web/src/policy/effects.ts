import type { Effect } from './engine'

export interface EffectHandlers {
  onNotify?: (message: string) => void | Promise<void>
  onState?: (state: string, etaDeltaSeconds: number | null) => void | Promise<void>
}

export type EffectSleep = (ms: number, signal: AbortSignal) => Promise<boolean>

export interface EffectRunOptions {
  sleep?: EffectSleep
  signal?: AbortSignal
}

export interface EffectRun {
  cancel: () => void
  done: Promise<void>
}

export interface TimelineEvent {
  afterMs: number
  effect: Extract<Effect, { op: 'notify' | 'state' }>
}

export function collectEffectTimeline(effect: Effect, offsetMs = 0, out: TimelineEvent[] = []): number {
  switch (effect.op) {
    case 'notify':
      out.push({ afterMs: offsetMs, effect })
      return offsetMs
    case 'state':
      out.push({ afterMs: offsetMs, effect })
      return offsetMs
    case 'sleep':
      return offsetMs + Math.max(0, effect.secs) * 1000
    case 'seq': {
      let current = offsetMs
      for (const step of effect.steps) current = collectEffectTimeline(step, current, out)
      return current
    }
    case 'noop':
    default:
      return offsetMs
  }
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (ms <= 0) return !signal.aborted
  if (signal.aborted) return false
  return await new Promise<boolean>((resolve) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(!signal.aborted)
    }, ms)
    const onAbort = () => {
      globalThis.clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function executeEffect(
  effect: Effect,
  handlers: EffectHandlers,
  sleep: EffectSleep,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return
  switch (effect.op) {
    case 'notify':
      await handlers.onNotify?.(effect.message)
      return
    case 'state':
      await handlers.onState?.(effect.state, effect.eta_delta_secs ?? null)
      return
    case 'sleep': {
      const keepGoing = await sleep(Math.max(0, effect.secs) * 1000, signal)
      if (!keepGoing || signal.aborted) return
      return
    }
    case 'seq':
      for (const step of effect.steps) {
        await executeEffect(step, handlers, sleep, signal)
        if (signal.aborted) return
      }
      return
    case 'noop':
    default:
      return
  }
}

export function runEffect(effect: Effect, handlers: EffectHandlers, opts: EffectRunOptions = {}): EffectRun {
  const controller = new AbortController()
  const sleep = opts.sleep ?? defaultSleep
  const externalSignal = opts.signal
  const onExternalAbort = () => controller.abort()

  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  const done = executeEffect(effect, handlers, sleep, controller.signal)
    .catch(() => {})
    .finally(() => {
      externalSignal?.removeEventListener('abort', onExternalAbort)
    })

  return {
    cancel: () => controller.abort(),
    done,
  }
}
