import { enablePushNotifications, PUSH_NOTIFICATION_EVENT } from './push-client'
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

function policyAudioContext(): AudioContext | null {
  const Ctx = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return null
  audioCtx ??= new Ctx()
  return audioCtx
}

export function armPolicyChime(): void {
  try {
    const ctx = policyAudioContext()
    if (ctx?.state === 'suspended') void ctx.resume().catch(() => {})
  } catch {
    // Audio is best effort and may be unavailable in restricted contexts.
  }
}

export function playPolicySnap(): void {
  try {
    const ctx = policyAudioContext()
    if (!ctx) return
    const play = () => {
      const start = ctx.currentTime + 0.005
      const body = ctx.createOscillator()
      const bodyGain = ctx.createGain()
      body.type = 'triangle'
      body.frequency.setValueAtTime(200, start)
      body.frequency.exponentialRampToValueAtTime(300, start + 0.055)
      bodyGain.gain.setValueAtTime(0.0001, start)
      bodyGain.gain.exponentialRampToValueAtTime(0.16, start + 0.003)
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.07)
      body.connect(bodyGain)
      bodyGain.connect(ctx.destination)
      body.start(start)
      body.stop(start + 0.08)

      const click = ctx.createOscillator()
      const clickGain = ctx.createGain()
      click.type = 'square'
      click.frequency.setValueAtTime(510, start)
      clickGain.gain.setValueAtTime(0.0001, start)
      clickGain.gain.exponentialRampToValueAtTime(0.08, start + 0.0015)
      clickGain.gain.exponentialRampToValueAtTime(0.001, start + 0.018)
      click.connect(clickGain)
      clickGain.connect(ctx.destination)
      click.start(start)
      click.stop(start + 0.022)
    }
    if (ctx.state === 'suspended') {
      void ctx.resume().then(play).catch(() => {})
    } else {
      play()
    }
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
    void enablePushNotifications().catch((error) => {
      console.error('[fold:push] permission_setup_failed', error)
    })
    return 'Notifications already enabled'
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'Notifications were not enabled'
  void enablePushNotifications().catch((error) => {
    console.error('[fold:push] permission_setup_failed', error)
  })
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
    silent: true,
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
  if (isPolicySoundEnabled()) playPolicySnap()
}

if (typeof window !== 'undefined') {
  const arm = () => armPolicyChime()
  window.addEventListener('pointerdown', arm, { capture: true, once: true })
  window.addEventListener('keydown', arm, { capture: true, once: true })
  window.addEventListener(PUSH_NOTIFICATION_EVENT, () => playPolicySnap())
}
