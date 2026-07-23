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
    return 'Notifications are not supported here'
  }
  const cfg = await api.pushPublicKey()
  if (!cfg.enabled || !cfg.public_key) return 'Push is not configured yet'
  if (Notification.permission === 'denied') return 'Notifications are blocked in this browser'

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'Notifications were not enabled'

  const reg = await navigator.serviceWorker.register('/sw.js')
  const desiredKey = appServerKey(cfg.public_key)
  let existing = await reg.pushManager.getSubscription()
  if (existing && !keysEqual(existing.options.applicationServerKey, desiredKey)) {
    await api.pushUnsubscribe(existing.endpoint).catch(() => undefined)
    await existing.unsubscribe()
    existing = null
  }
  const sub = existing ?? await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: desiredKey,
  })
  await api.pushSubscribe(sub.toJSON())
  return existing ? 'Notifications are already enabled' : 'Notifications enabled'
}

function keysEqual(current: ArrayBuffer | null, desired: ArrayBuffer): boolean {
  if (!current || current.byteLength !== desired.byteLength) return false
  const left = new Uint8Array(current)
  const right = new Uint8Array(desired)
  return left.every((byte, index) => byte === right[index])
}

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!isRecord(event.data) || typeof event.data.type !== 'string') return

    if (event.data.type === 'fold:push-subscription-change' && isPushSubscription(event.data.subscription)) {
      void api.pushSubscribe(event.data.subscription).catch(() => {})
      return
    }

    if (event.data.type === 'fold:push-notification' && isPushNotification(event.data.notification)) {
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
