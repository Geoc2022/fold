import { useCallback } from 'react'
import { api } from './api'
import type { SyncResponse } from './types'
import { usePolling } from './usePolling'

interface SyncState {
  data: SyncResponse | null
  error: string | null
  loading: boolean
}

interface UseSync extends SyncState {
  refresh: () => void
}

function signature(s: SyncResponse): string {
  const acts = s.activities
    .map((a) => {
      const r = a.current_run
      return `${a.id}:${a.updated_at}:${r?.id ?? ''}:${r?.status ?? ''}:${r?.interested_count ?? 0}:${r?.committed_count ?? 0}:${a.my_state ?? ''}`
    })
    .join('|')
  const notifs = s.notifications.map((n) => n.id).join(',')
  return `${acts}#${notifs}`
}

export function useSync(enabled: boolean): UseSync {
  const load = useCallback((signal: AbortSignal) => api.sync(signal), [])
  return usePolling({ enabled, load, signature })
}
