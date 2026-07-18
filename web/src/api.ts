// Typed fetch client for the fold Worker API.
//
// Identity is a lightweight person_id (UUID) persisted in localStorage and sent
// as the `X-Person-Id` header. There are no passwords; handles are not unique.

import type {
  ActivityView,
  CreateActivityInput,
  CreateRunInput,
  Person,
  RoomResponse,
  SyncResponse,
  UpdateActivityInput,
} from './types'
import { readString, removeItem, writeString } from './storage'

const PERSON_KEY = 'fold.person_id'

function getPersonId(): string | null {
  return readString(PERSON_KEY)
}

function setPersonId(id: string): void {
  writeString(PERSON_KEY, id)
}

export function clearPersonId(): void {
  removeItem(PERSON_KEY)
}

export async function ensureSession(): Promise<Person> {
  const existing = getPersonId()
  if (existing) {
    try {
      return await api.getSession()
    } catch {
      clearPersonId()
    }
  }
  const person = await api.createSession('')
  setPersonId(person.id)
  return person
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

interface RequestOptions {
  method?: string
  body?: unknown
  /** Attach the X-Person-Id header when available. Default: true. */
  auth?: boolean
  signal?: AbortSignal
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, signal } = opts
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (auth) {
    const pid = getPersonId()
    if (pid) headers['X-Person-Id'] = pid
  }

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })

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
      auth: false,
      body: { handle, color },
    })
  },

  getSession(): Promise<Person> {
    return request<Person>('/api/session')
  },

  updateSession(patch: { handle?: string; color?: string }): Promise<Person> {
    return request<Person>('/api/session', { method: 'PATCH', body: patch })
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
    return request('/api/push/public-key', { auth: false })
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
