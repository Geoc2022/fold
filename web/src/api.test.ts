import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, ensureSession, resetSession } from './api'
import type { Person } from './types'

const person: Person = {
  id: 'person-1',
  handle: '',
  color: '#123456',
  created_at: 1,
  last_seen_at: 1,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function expectCookieRequest(init: RequestInit | undefined): void {
  expect(init?.credentials).toBe('same-origin')
  const headerNames = Object.keys(init?.headers ?? {}).map((name) => name.toLowerCase())
  expect(headerNames).not.toContain('x-person-id')
}

describe('cookie session client', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('gets the existing session before attempting creation', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(person))

    await expect(ensureSession()).resolves.toEqual(person)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('/api/session', {
      method: 'GET',
      headers: {},
      body: undefined,
      credentials: 'same-origin',
      signal: undefined,
    })
    expectCookieRequest(fetchMock.mock.calls[0][1])
  })

  it('creates a session only after a 401 response', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse(person))

    await expect(ensureSession()).resolves.toEqual(person)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/session')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/session')
    expect(fetchMock.mock.calls[1][1]).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: '' }),
      credentials: 'same-origin',
      signal: undefined,
    })
    fetchMock.mock.calls.forEach(([, init]) => expectCookieRequest(init))
  })

  it('does not create a session after a server error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Unavailable' }, 500))

    await expect(ensureSession()).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      message: 'Unavailable',
    } satisfies Partial<ApiError>)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not create a session after a network error', async () => {
    const networkError = new TypeError('fetch failed')
    fetchMock.mockRejectedValueOnce(networkError)

    await expect(ensureSession()).rejects.toBe(networkError)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('deletes the cookie session when reset', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))

    await expect(resetSession()).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('/api/session', {
      method: 'DELETE',
      headers: {},
      body: undefined,
      credentials: 'same-origin',
      signal: undefined,
    })
    expectCookieRequest(fetchMock.mock.calls[0][1])
  })

  it('loads and revision-saves personal policy sets', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ sets: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'set-1', revision: 1, rules: [] }))

    await api.policySets('activity/1')
    await api.replacePolicySet({
      scope: 'room',
      activity_id: 'activity/1',
      timezone: 'UTC',
      revision: 0,
      rules: [],
    })

    expect(fetchMock.mock.calls[0][0]).toBe('/api/policies?activity_id=activity%2F1')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/policies')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'PUT',
      credentials: 'same-origin',
      body: JSON.stringify({
        scope: 'room',
        activity_id: 'activity/1',
        timezone: 'UTC',
        revision: 0,
        rules: [],
      }),
    })
  })
})
