// Adaptive polling hook around GET /api/sync.
//
// Free-plan discipline: only /api/* requests count against the 100k/day budget,
// so we poll conservatively:
//   - Fast interval (6s) right after any change or user action.
//   - Back off geometrically toward 30s while nothing changes.
//   - Pause entirely when the tab is hidden; refresh immediately on re-show.
//   - On HTTP 429, back off hard and respect a cool-down.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from './api'
import type { SyncResponse } from './types'

const FAST_MS = 6_000
const SLOW_MS = 30_000
const BACKOFF = 1.5
const RATE_LIMIT_MS = 60_000

interface SyncState {
  data: SyncResponse | null
  error: string | null
  loading: boolean
}

export interface UseSync extends SyncState {
  /** Force an immediate poll and reset the interval to fast. */
  refresh: () => void
}

/** Stable signature of the parts of a sync response users care about. */
function signature(s: SyncResponse): string {
  const acts = s.activities
    .map(
      (a) =>
        `${a.id}:${a.status}:${a.updated_at}:${a.interested_count}:${a.committed_count}:${a.my_state ?? ''}`,
    )
    .join('|')
  const notifs = s.notifications.map((n) => n.id).join(',')
  return `${acts}#${notifs}`
}

export function useSync(enabled: boolean): UseSync {
  const [state, setState] = useState<SyncState>({
    data: null,
    error: null,
    loading: enabled,
  })

  const intervalRef = useRef(FAST_MS)
  const sigRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inFlightRef = useRef(false)

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  // poll() is defined as a ref-stable callback so the scheduling effect does
  // not tear down on every render.
  const poll = useCallback(async () => {
    if (inFlightRef.current) return
    if (document.hidden) return
    inFlightRef.current = true
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const data = await api.sync(ctrl.signal)
      const sig = signature(data)
      const changed = sig !== sigRef.current
      sigRef.current = sig
      // Speed up on change, otherwise decay toward SLOW_MS.
      intervalRef.current = changed
        ? FAST_MS
        : Math.min(SLOW_MS, Math.round(intervalRef.current * BACKOFF))
      setState({ data, error: null, loading: false })
    } catch (e) {
      if (ctrl.signal.aborted) {
        inFlightRef.current = false
        return
      }
      if (e instanceof ApiError && e.status === 429) {
        intervalRef.current = RATE_LIMIT_MS
      } else {
        intervalRef.current = Math.min(SLOW_MS, Math.round(intervalRef.current * BACKOFF))
      }
      setState((s) => ({
        data: s.data,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      }))
    } finally {
      inFlightRef.current = false
      schedule()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const schedule = useCallback(() => {
    clearTimer()
    if (!enabled || document.hidden) return
    timerRef.current = setTimeout(poll, intervalRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, poll])

  const refresh = useCallback(() => {
    intervalRef.current = FAST_MS
    clearTimer()
    void poll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll])

  // Kick off / tear down polling as `enabled` changes.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, poll])

  // Pause when hidden; refresh immediately when the tab becomes visible.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, poll])

  return { ...state, refresh }
}
