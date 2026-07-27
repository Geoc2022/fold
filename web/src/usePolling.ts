import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api'

const FAST_MS = 6_000
const SLOW_MS = 30_000
const BACKOFF = 1.5
const RATE_LIMIT_MS = 60_000
// Spread scheduled polls by ±15% so a crowd that loaded the page together
// (e.g. everyone opening a room when a run goes ready) doesn't hammer the
// Worker in lockstep every interval. Smooths server load without making any
// individual client noticeably less responsive.
const JITTER = 0.15

function withJitter(ms: number): number {
  return Math.round(ms * (1 + (Math.random() * 2 - 1) * JITTER))
}

interface PollState<T> {
  data: T | null
  error: string | null
  loading: boolean
}

interface Options<T> {
  enabled: boolean
  pollKey?: unknown
  load: (signal: AbortSignal) => Promise<T>
  signature: (data: T) => string
  onNotFound?: () => void
  onSuccess?: () => void
}

export function usePolling<T>({ enabled, pollKey, load, signature, onNotFound, onSuccess }: Options<T>) {
  const [state, setState] = useState<PollState<T>>({ data: null, error: null, loading: enabled })
  const intervalRef = useRef(FAST_MS)
  const sigRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)
  const optionsRef = useRef({ load, signature, onNotFound, onSuccess })
  optionsRef.current = { load, signature, onNotFound, onSuccess }

  const clearTimer = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const schedule = useCallback(() => {
    clearTimer()
    if (!enabled || document.hidden) return
    timerRef.current = setTimeout(() => void poll(), withJitter(intervalRef.current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  const poll = useCallback(async () => {
    if (!enabled || document.hidden) return
    const generation = ++generationRef.current
    // Abort any in-flight request rather than skipping this call -- a
    // refresh() right after a mutation (e.g. commit) must win over a
    // stale request that was already pending, or its late response would
    // overwrite the just-applied optimistic state with old data.
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const data = await optionsRef.current.load(ctrl.signal)
      const sig = optionsRef.current.signature(data)
      const changed = sig !== sigRef.current
      sigRef.current = sig
      intervalRef.current = changed ? FAST_MS : Math.min(SLOW_MS, Math.round(intervalRef.current * BACKOFF))
      optionsRef.current.onSuccess?.()
      setState({ data, error: null, loading: false })
    } catch (e) {
      if (ctrl.signal.aborted) return
      if (e instanceof ApiError && e.status === 404 && optionsRef.current.onNotFound) {
        optionsRef.current.onNotFound()
        setState((s) => ({ ...s, loading: false, error: null }))
      } else {
        intervalRef.current = e instanceof ApiError && e.status === 429
          ? RATE_LIMIT_MS
          : Math.min(SLOW_MS, Math.round(intervalRef.current * BACKOFF))
        setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }))
      }
    } finally {
      if (generationRef.current === generation) schedule()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, schedule])

  const refresh = useCallback(() => {
    intervalRef.current = FAST_MS
    clearTimer()
    void poll()
  }, [poll])

  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1
      clearTimer()
      abortRef.current?.abort()
      return
    }
    intervalRef.current = FAST_MS
    sigRef.current = null
    setState({ data: null, error: null, loading: true })
    void poll()
    return () => {
      generationRef.current += 1
      clearTimer()
      abortRef.current?.abort()
    }
  }, [enabled, poll, pollKey])

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        generationRef.current += 1
        clearTimer()
        abortRef.current?.abort()
      } else if (enabled) {
        intervalRef.current = FAST_MS
        void poll()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [enabled, poll])

  return { ...state, refresh }
}
