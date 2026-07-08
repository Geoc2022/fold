import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from './api'
import type { RoomResponse } from './types'

const FAST_MS = 6_000
const SLOW_MS = 30_000
const BACKOFF = 1.5
const RATE_LIMIT_MS = 60_000

interface RoomState {
  data: RoomResponse | null
  error: string | null
  notFound: boolean
  loading: boolean
}

export interface UseRoom extends RoomState {
  refresh: () => void
}

function signature(r: RoomResponse): string {
  const a = r.activity
  const participants = r.participants
    .map((p) => `${p.id}:${p.state}:${p.arrival_at ?? ''}:${p.is_me}`)
    .join('|')
  return `${a.id}:${a.status}:${a.updated_at}:${a.interested_count}:${a.committed_count}#${participants}`
}

export function useRoom(code: string | null, enabled: boolean): UseRoom {
  const [state, setState] = useState<RoomState>({
    data: null,
    error: null,
    notFound: false,
    loading: enabled,
  })
  const intervalRef = useRef(FAST_MS)
  const sigRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inFlightRef = useRef(false)

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const schedule = useCallback(() => {
    clearTimer()
    if (!enabled || !code || document.hidden) return
    timerRef.current = setTimeout(() => void poll(), intervalRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, code])

  const poll = useCallback(async () => {
    if (!enabled || !code || inFlightRef.current || document.hidden) return
    inFlightRef.current = true
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const data = await api.room(code, ctrl.signal)
      const sig = signature(data)
      const changed = sig !== sigRef.current
      sigRef.current = sig
      intervalRef.current = changed
        ? FAST_MS
        : Math.min(SLOW_MS, Math.round(intervalRef.current * BACKOFF))
      setState({ data, error: null, notFound: false, loading: false })
    } catch (err) {
      if (ctrl.signal.aborted) return
      if (err instanceof ApiError && err.status === 404) {
        setState((s) => ({ ...s, loading: false, notFound: true, error: null }))
      } else {
        intervalRef.current =
          err instanceof ApiError && err.status === 429
            ? RATE_LIMIT_MS
            : Math.min(SLOW_MS, Math.round(intervalRef.current * BACKOFF))
        setState((s) => ({
          data: s.data,
          loading: false,
          notFound: false,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    } finally {
      inFlightRef.current = false
      schedule()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, code])

  const refresh = useCallback(() => {
    intervalRef.current = FAST_MS
    clearTimer()
    void poll()
  }, [poll])

  useEffect(() => {
    if (!enabled || !code) return
    intervalRef.current = FAST_MS
    void poll()
    return () => {
      clearTimer()
      abortRef.current?.abort()
    }
  }, [enabled, code, poll])

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
