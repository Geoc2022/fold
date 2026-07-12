import { api } from './api'

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
  const existing = await reg.pushManager.getSubscription()
  if (existing) return 'Notifications are already enabled'

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: appServerKey(cfg.public_key),
  })
  await api.pushSubscribe(sub.toJSON())
  return 'Notifications enabled'
}
