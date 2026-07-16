import { enablePushNotifications } from './push-client'

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
export async function showLocalNotification(title: string, body: string, url = '/', tag?: string): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const options: NotificationOptions = {
    body,
    icon: '/favicon.svg',
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
