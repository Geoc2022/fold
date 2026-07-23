import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { enablePushNotifications, testPushNotifications } from './push-client'

vi.mock('./api', () => ({
  api: {
    pushPublicKey: vi.fn(),
    pushSubscribe: vi.fn(),
    pushUnsubscribe: vi.fn(),
    pushDiagnostics: vi.fn(),
    pushTest: vi.fn(),
  },
}))

const serialized: PushSubscriptionJSON = {
  endpoint: 'https://push.example/subscription',
  expirationTime: null,
  keys: { p256dh: 'p256dh', auth: 'auth' },
}

function installBrowser(subscription: PushSubscription | null): PushManager {
  const notification = {
    permission: 'granted',
    requestPermission: vi.fn().mockResolvedValue('granted'),
  }
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(subscription),
    subscribe: vi.fn().mockResolvedValue({ toJSON: () => serialized }),
  } as unknown as PushManager
  vi.stubGlobal('window', { PushManager: class {}, Notification: notification })
  vi.stubGlobal('navigator', {
    serviceWorker: {
      register: vi.fn().mockResolvedValue({ pushManager }),
    },
  })
  vi.stubGlobal('Notification', notification)
  return pushManager
}

describe('enablePushNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.pushPublicKey).mockResolvedValue({ enabled: true, public_key: 'AQAB' })
    vi.mocked(api.pushSubscribe).mockResolvedValue({ ok: true })
    vi.mocked(api.pushUnsubscribe).mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('upserts an existing browser subscription', async () => {
    const existing = {
      endpoint: serialized.endpoint,
      options: { applicationServerKey: new Uint8Array([1, 0, 1]).buffer },
      toJSON: () => serialized,
    } as unknown as PushSubscription
    const pushManager = installBrowser(existing)

    await expect(enablePushNotifications()).resolves.toBe('Notifications are already enabled')
    expect(pushManager.subscribe).not.toHaveBeenCalled()
    expect(api.pushSubscribe).toHaveBeenCalledWith(serialized)
  })

  it('replaces a subscription created with an old VAPID key', async () => {
    const existing = {
      endpoint: serialized.endpoint,
      options: { applicationServerKey: new Uint8Array([9]).buffer },
      unsubscribe: vi.fn().mockResolvedValue(true),
      toJSON: () => serialized,
    } as unknown as PushSubscription
    const pushManager = installBrowser(existing)

    await expect(enablePushNotifications()).resolves.toBe('Notifications enabled')
    expect(api.pushUnsubscribe).toHaveBeenCalledWith(serialized.endpoint)
    expect(existing.unsubscribe).toHaveBeenCalledOnce()
    expect(pushManager.subscribe).toHaveBeenCalledOnce()
  })

  it('creates and upserts a missing browser subscription', async () => {
    const pushManager = installBrowser(null)

    await expect(enablePushNotifications()).resolves.toBe('Notifications enabled')
    expect(pushManager.subscribe).toHaveBeenCalledOnce()
    expect(api.pushSubscribe).toHaveBeenCalledWith(serialized)
  })

  it('queues and observes a delivered test notification', async () => {
    vi.useFakeTimers()
    installBrowser(null)
    vi.mocked(api.pushDiagnostics)
      .mockResolvedValueOnce({
        vapid_enabled: true,
        active_subscriptions: 1,
        recent_deliveries: [],
      })
      .mockResolvedValueOnce({
        vapid_enabled: true,
        active_subscriptions: 1,
        recent_deliveries: [{
          notification_id: 'notification-1',
          status: 'delivered',
          attempts: 1,
          last_status: 201,
          last_error: null,
          created_at: 1,
          updated_at: 2,
        }],
      })
    vi.mocked(api.pushTest).mockResolvedValue({
      notification_id: 'notification-1',
      deliveries_queued: 1,
    })

    const result = testPushNotifications()
    await vi.runAllTimersAsync()
    await expect(result).resolves.toBe('Test notification delivered')
    vi.useRealTimers()
  })

  it('reports the push service rejection details', async () => {
    vi.useFakeTimers()
    installBrowser(null)
    vi.mocked(api.pushDiagnostics)
      .mockResolvedValueOnce({
        vapid_enabled: true,
        active_subscriptions: 1,
        recent_deliveries: [],
      })
      .mockResolvedValueOnce({
        vapid_enabled: true,
        active_subscriptions: 1,
        recent_deliveries: [{
          notification_id: 'notification-2',
          status: 'failed',
          attempts: 1,
          last_status: 401,
          last_error: 'VAPID public key mismatch',
          created_at: 1,
          updated_at: 2,
        }],
      })
    vi.mocked(api.pushTest).mockResolvedValue({
      notification_id: 'notification-2',
      deliveries_queued: 1,
    })

    const result = testPushNotifications()
    await vi.runAllTimersAsync()
    await expect(result).resolves.toBe('Test failed (401): VAPID public key mismatch')
    vi.useRealTimers()
  })
})
