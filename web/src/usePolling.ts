import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api'

const FAST_MS = 6_000
const SLOW_MS = 30_000
const BACKOFF = 1.5
const RATE_LIMIT_MS = 60_000

interface PollState<T> {
  data: T | null
  error: string | null
  loading: boolean
}

interface Options<T> {
  enabled: boolean
  load: (signal: AbortSignal) => Promise<T>
  signature: (data: T) => string
  onNotFound?: () => void
  onSuccess?: () => void
}

export function usePolling<T>({ enabled, load, signature, onNotFound, onSuccess }: Options<T>) {
  const [state, setState] = useState<PollState<T>>({ data: null, error: null, loading: enabled })
  const intervalRef = useRef(FAST_MS)
  const sigRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const clearTimer = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const schedule = useCallback(() => {
    clearTimer()
    if (!enabled || document.hidden) return
    timerRef.current = setTimeout(() => void poll(), intervalRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  const poll = useCallback(async () => {
    if (!enabled || document.hidden) return
    // Abort any in-flight request rather than skipping this call -- a
    // refresh() right after a mutation (e.g. commit) must win over a
    // stale request that was already pending, or its late response would
    // overwrite the just-applied optimistic state with old data.
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const data = await load(ctrl.signal)
      const sig = signature(data)
      const changed = sig !== sigRef.current
      sigRef.current = sig
      intervalRef.current = changed ? FAST_MS : Math.min(SLOW_MS, Math.round(intervalRef.current * BACKOFF))
      onSuccess?.()
      setState({ data, error: null, loading: false })
    } catch (e) {
      if (ctrl.signal.aborted) return
      if (e instanceof ApiError && e.status === 404 && onNotFound) {
        onNotFound()
        setState((s) => ({ ...s, loading: false, error: null }))
      } else {
        intervalRef.current = e instanceof ApiError && e.status === 429
          ? RATE_LIMIT_MS
          : Math.min(SLOW_MS, Math.round(intervalRef.current * BACKOFF))
        setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }))
      }
    } finally {
      schedule()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, load, signature, onNotFound, onSuccess, schedule])

  const refresh = useCallback(() => {
    intervalRef.current = FAST_MS
    clearTimer()
    void poll()
  }, [poll])

  useEffect(() => {
    if (!enabled) {
      clearTimer()
      abortRef.current?.abort()
      return
    }
    intervalRef.current = FAST_MS
    void poll()
    return () => {
      clearTimer()
      abortRef.current?.abort()
    }
  }, [enabled, poll])

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
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
