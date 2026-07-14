import { useCallback, useState } from 'react'
import { api } from './api'
import type { RoomResponse } from './types'
import { usePolling } from './usePolling'

interface RoomState {
  data: RoomResponse | null
  error: string | null
  notFound: boolean
  loading: boolean
}

interface UseRoom extends RoomState {
  refresh: () => void
}

function signature(r: RoomResponse): string {
  const a = r.activity
  const run = a.current_run
  const participants = r.participants
    .map((p) => `${p.id}:${p.state}:${p.arrival_at ?? ''}:${p.is_me}`)
    .join('|')
  return `${a.id}:${a.updated_at}:${run?.id ?? ''}:${run?.status ?? ''}:${run?.interested_count ?? 0}:${run?.committed_count ?? 0}:${r.already_committed_elsewhere ? 1 : 0}#${participants}`
}

export function useRoom(code: string | null, enabled: boolean): UseRoom {
  const [notFound, setNotFound] = useState(false)
  const load = useCallback((signal: AbortSignal) => api.room(code!, signal), [code])
  const state = usePolling({
    enabled: enabled && code !== null,
    load,
    signature,
    onNotFound: () => setNotFound(true),
    onSuccess: () => setNotFound(false),
  })
  return { ...state, notFound }
}
