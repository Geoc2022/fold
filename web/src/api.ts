// Typed fetch client for the fold Worker API.
//
// Identity is an anonymous, HttpOnly same-origin session cookie. There are no
// passwords; handles are not unique.

import type {
  ActivityView,
  CreateActivityInput,
  CreateRunInput,
  Person,
  RoomResponse,
  SyncResponse,
  UpdateActivityInput,
} from './types'
export async function ensureSession(): Promise<Person> {
  try {
    return await api.getSession()
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error
  }
  return api.createSession('')
}

export async function resetSession(): Promise<void> {
  await api.deleteSession()
}

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export interface ServerPolicyRule {
  id: string
  position: number
  source: string
  source_hash: string
  time_dependent: boolean
  enabled: boolean
  version: number
  created_at: number
  updated_at: number
}

export interface ServerPolicySet {
  id: string
  scope: 'home' | 'room'
  activity_id: string | null
  timezone: string
  revision: number
  created_at: number
  updated_at: number
  rules: ServerPolicyRule[]
}

export interface ReplacePolicySetInput {
  scope: 'home' | 'room'
  activity_id?: string
  timezone: string
  revision: number
  rules: Array<{ id?: string; source: string; enabled: boolean }>
}

export interface PushDeliveryDiagnostic {
  notification_id: string
  status: 'pending' | 'sending' | 'delivered' | 'retry' | 'failed'
  attempts: number
  last_status: number | null
  last_error: string | null
  created_at: number
  updated_at: number
}

export interface PushDiagnostics {
  vapid_enabled: boolean
  active_subscriptions: number
  recent_deliveries: PushDeliveryDiagnostic[]
}

interface RequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
  cache?: RequestCache
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, cache } = opts
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const init: RequestInit = {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    signal,
  }
  if (cache) init.cache = cache
  const res = await fetch(path, init)

  const text = await res.text()
  const parsed: unknown = text ? safeJson(text) : null

  if (!res.ok) {
    const message =
      (isRecord(parsed) && typeof parsed.error === 'string' && parsed.error) ||
      `HTTP ${res.status}`
    throw new ApiError(res.status, message, parsed)
  }
  return parsed as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// ---- endpoints -------------------------------------------------------------

export const api = {
  createSession(handle: string, color?: string): Promise<Person> {
    return request<Person>('/api/session', {
      method: 'POST',
      body: { handle, color },
    })
  },

  getSession(): Promise<Person> {
    return request<Person>('/api/session')
  },

  updateSession(patch: { handle?: string; color?: string }): Promise<Person> {
    return request<Person>('/api/session', { method: 'PATCH', body: patch })
  },

  deleteSession(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/session', { method: 'DELETE' })
  },

  policySets(activityId?: string): Promise<{ sets: ServerPolicySet[] }> {
    const query = activityId ? `?activity_id=${encodeURIComponent(activityId)}` : ''
    return request<{ sets: ServerPolicySet[] }>(`/api/policies${query}`)
  },

  replacePolicySet(input: ReplacePolicySetInput): Promise<ServerPolicySet> {
    return request<ServerPolicySet>('/api/policies', { method: 'PUT', body: input })
  },

  pushDiagnostics(): Promise<PushDiagnostics> {
    return request<PushDiagnostics>('/api/push/diagnostics')
  },

  pushTest(): Promise<{ notification_id: string; deliveries_queued: number }> {
    return request<{ notification_id: string; deliveries_queued: number }>('/api/push/test', {
      method: 'POST',
    })
  },

  sync(signal?: AbortSignal): Promise<SyncResponse> {
    return request<SyncResponse>('/api/sync', { signal })
  },

  createActivity(input: CreateActivityInput): Promise<ActivityView> {
    return request<ActivityView>('/api/activities', {
      method: 'POST',
      body: input,
    })
  },

  updateActivity(id: string, input: UpdateActivityInput): Promise<ActivityView> {
    return request<ActivityView>(`/api/activities/${id}`, {
      method: 'PATCH',
      body: input,
    })
  },

  deleteActivity(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/activities/${id}`, {
      method: 'DELETE',
    })
  },

  getActivity(id: string): Promise<ActivityView> {
    return request<ActivityView>(`/api/activities/${id}`)
  },

  /** Launch a new run on an activity whose room is currently empty. */
  createRun(activityId: string, input: CreateRunInput): Promise<ActivityView> {
    return request<ActivityView>(`/api/activities/${activityId}/runs`, {
      method: 'POST',
      body: input,
    })
  },

  room(code: string, signal?: AbortSignal): Promise<RoomResponse> {
    return request<RoomResponse>(`/api/rooms/${code}`, { signal })
  },

  interest(runId: string): Promise<ActivityView> {
    return request<ActivityView>(`/api/runs/${runId}/interest`, {
      method: 'POST',
    })
  },

  commit(runId: string, eta_seconds?: number): Promise<ActivityView> {
    return request<ActivityView>(`/api/runs/${runId}/commit`, {
      method: 'POST',
      body: eta_seconds == null ? undefined : { eta_seconds },
    })
  },

  withdraw(runId: string): Promise<ActivityView> {
    return request<ActivityView>(`/api/runs/${runId}/participation`, {
      method: 'DELETE',
    })
  },

  schedule(
    runId: string,
    scheduled_for: number,
    location?: string,
  ): Promise<ActivityView> {
    return request<ActivityView>(`/api/runs/${runId}/schedule`, {
      method: 'POST',
      body: { scheduled_for, location },
    })
  },

  close(runId: string): Promise<ActivityView> {
    return request<ActivityView>(`/api/runs/${runId}/close`, {
      method: 'POST',
    })
  },

  cancel(runId: string): Promise<ActivityView> {
    return request<ActivityView>(`/api/runs/${runId}/cancel`, {
      method: 'POST',
    })
  },

  pushPublicKey(): Promise<{ enabled: boolean; public_key: string | null }> {
    return request('/api/push/public-key', { cache: 'no-store' })
  },

  pushSubscribe(subscription: PushSubscriptionJSON): Promise<unknown> {
    return request('/api/push/subscriptions', {
      method: 'POST',
      body: subscription,
    })
  },

  pushUnsubscribe(endpoint: string): Promise<unknown> {
    return request('/api/push/subscriptions', {
      method: 'DELETE',
      body: { endpoint },
    })
  },
}
