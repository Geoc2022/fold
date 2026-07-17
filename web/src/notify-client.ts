import { enablePushNotifications } from './push-client'
import type { ActivityView } from './types'
import { readString, writeString } from './storage'

export const POLICY_SOUND_KEY = 'fold.policy.sound'
const emojiIconCache = new Map<string, string>()

export function isPolicySoundEnabled(): boolean {
  return readString(POLICY_SOUND_KEY) === '1'
}

export function setPolicySoundEnabled(enabled: boolean): void {
  writeString(POLICY_SOUND_KEY, enabled ? '1' : '0')
}

function emojiIconDataUrl(emoji: string): string {
  const trimmed = emoji.trim()
  if (!trimmed) return '/favicon.svg'
  const cached = emojiIconCache.get(trimmed)
  if (cached) return cached
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128
    const ctx = canvas.getContext('2d')
    if (!ctx) return '/favicon.svg'
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '96px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'
    ctx.fillText(trimmed, canvas.width / 2, canvas.height / 2)
    const dataUrl = canvas.toDataURL('image/png')
    emojiIconCache.set(trimmed, dataUrl)
    return dataUrl
  } catch {
    return '/favicon.svg'
  }
}

let audioCtx: AudioContext | null = null

export function playPolicyChime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    if (!audioCtx) audioCtx = new Ctx()
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume().catch(() => {})
    }
    const start = audioCtx.currentTime + 0.005
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(784, start)
    osc.frequency.exponentialRampToValueAtTime(1175, start + 0.14)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22)
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.start(start)
    osc.stop(start + 0.24)
  } catch {
    // Best effort.
  }
}

/** Ask the browser for notification permission (client-side delivery, used
 * while a policy is evaluated locally against polled data). Also registers
 * a Web Push subscription best-effort, so the existing server-side push
 * path (`push-client.ts`, `src/push.rs`) has a subscription ready for future
 * server-driven policy delivery. */
export async function requestNotificationPermission(): Promise<string> {
  if (!('Notification' in window)) return 'Notifications are not supported here'
  if (Notification.permission === 'denied') return 'Notifications are blocked in this browser'

  if (Notification.permission === 'granted') {
    void enablePushNotifications().catch(() => {})
    return 'Notifications already enabled'
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'Notifications were not enabled'
  void enablePushNotifications().catch(() => {})
  return 'Notifications enabled'
}

/** Show a browser notification right now (client-side; requires the tab to
 * be open and permission already granted). `tag` dedupes/replaces a prior
 * notification with the same tag. */
export async function showLocalNotification(
  title: string,
  body: string,
  url = '/',
  tag?: string,
  opts?: { emoji?: string },
): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const icon = opts?.emoji ? emojiIconDataUrl(opts.emoji) : '/favicon.svg'
  const options: NotificationOptions = {
    body,
    icon,
    badge: '/favicon.svg',
    tag: tag ?? `fold-policy-${title}`,
    data: { url },
  }
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration()
      if (reg) {
        await reg.showNotification(title, options)
        return
      }
    }
    new Notification(title, options)
  } catch {
    // Best effort; the in-app toast still covers this case.
  }
}

export async function deliverPolicyNotification(activity: ActivityView, message: string, key: string): Promise<void> {
  void showLocalNotification(activity.title, message, `/${activity.code}`, `fold-policy-${key}`, { emoji: activity.emoji })
  if (isPolicySoundEnabled()) playPolicyChime()
}
