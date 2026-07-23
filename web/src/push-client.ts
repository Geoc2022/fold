import { api } from './api'

export const PUSH_NOTIFICATION_EVENT = 'fold:push-notification'

export interface PushNotificationDetail {
  id: string | null
  title: string
  body: string
  url: string
  tag: string
  created_at: number | null
}

function appServerKey(publicKey: string): ArrayBuffer {
  const padded = `${publicKey}${'='.repeat((4 - (publicKey.length % 4)) % 4)}`
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const buffer = new ArrayBuffer(raw.length)
  const out = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return buffer
}

export async function enablePushNotifications(): Promise<string> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    pushLog('unsupported')
    return 'Notifications are not supported here'
  }
  const cfg = await api.pushPublicKey()
  pushLog('configuration', { enabled: cfg.enabled, key: cfg.public_key?.slice(0, 12) ?? null })
  if (!cfg.enabled || !cfg.public_key) return 'Push is not configured yet'
  if (Notification.permission === 'denied') return 'Notifications are blocked in this browser'

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'Notifications were not enabled'

  const reg = await navigator.serviceWorker.register('/sw.js')
  const desiredKey = appServerKey(cfg.public_key)
  let existing = await reg.pushManager.getSubscription()
  const keyMatches = existing ? keysEqual(existing.options.applicationServerKey, desiredKey) : false
  pushLog('subscription_checked', {
    exists: existing !== null,
    key_matches: keyMatches,
    origin: existing ? endpointOrigin(existing.endpoint) : null,
  })
  if (existing && !keyMatches) {
    await api.pushUnsubscribe(existing.endpoint).catch(() => undefined)
    await existing.unsubscribe()
    pushLog('subscription_rotated')
    existing = null
  }
  const sub = existing ?? await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: desiredKey,
  })
  await api.pushSubscribe(sub.toJSON())
  pushLog('subscription_registered', { origin: endpointOrigin(sub.endpoint), reused: existing !== null })
  return existing ? 'Notifications are already enabled' : 'Notifications enabled'
}

export async function testPushNotifications(): Promise<string> {
  const setup = await enablePushNotifications()
  pushLog('test_setup', { result: setup })
  const before = await api.pushDiagnostics()
  pushLog('diagnostics_before_test', before)
  if (before.active_subscriptions < 1) return 'No active push subscription'

  const queued = await api.pushTest()
  pushLog('test_queued', queued)
  if (queued.deliveries_queued < 1) return 'Test notification was not queued'

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(1_000)
    const diagnostics = await api.pushDiagnostics()
    const delivery = diagnostics.recent_deliveries.find(
      (candidate) => candidate.notification_id === queued.notification_id,
    )
    if (!delivery || delivery.status === 'pending' || delivery.status === 'sending' || delivery.status === 'retry') {
      continue
    }
    pushLog('test_finished', delivery)
    if (delivery.status === 'delivered') return 'Test notification delivered'
    return `Test failed (${delivery.last_status ?? 'no status'}): ${delivery.last_error ?? 'unknown error'}`
  }
  pushLog('test_timed_out', queued)
  return 'Test notification is still pending'
}

function keysEqual(current: ArrayBuffer | null, desired: ArrayBuffer): boolean {
  if (!current || current.byteLength !== desired.byteLength) return false
  const left = new Uint8Array(current)
  const right = new Uint8Array(desired)
  return left.every((byte, index) => byte === right[index])
}

function endpointOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin
  } catch {
    return 'invalid'
  }
}

function pushLog(stage: string, details?: unknown): void {
  console.info(`[fold:push] ${stage}`, details ?? '')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds))
}

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!isRecord(event.data) || typeof event.data.type !== 'string') return

    if (event.data.type === 'fold:push-subscription-change' && isPushSubscription(event.data.subscription)) {
      pushLog('subscription_change_received')
      void api.pushSubscribe(event.data.subscription).catch(() => {})
      return
    }

    if (event.data.type === 'fold:push-notification' && isPushNotification(event.data.notification)) {
      pushLog('notification_message_received', event.data.notification)
      window.dispatchEvent(new CustomEvent<PushNotificationDetail>(PUSH_NOTIFICATION_EVENT, {
        detail: event.data.notification,
      }))
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPushSubscription(value: unknown): value is PushSubscriptionJSON {
  if (!isRecord(value) || typeof value.endpoint !== 'string' || !isRecord(value.keys)) return false
  return typeof value.keys.p256dh === 'string' && typeof value.keys.auth === 'string'
}

function isPushNotification(value: unknown): value is PushNotificationDetail {
  if (!isRecord(value)) return false
  return (typeof value.id === 'string' || value.id === null)
    && typeof value.title === 'string'
    && typeof value.body === 'string'
    && typeof value.url === 'string'
    && typeof value.tag === 'string'
    && (typeof value.created_at === 'number' || value.created_at === null)
}
