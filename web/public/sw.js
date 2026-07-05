self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('fold activity update', {
      body: 'Open fold to see what changed.',
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: 'fold-update',
      renotify: true,
      data: { url: '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          client.focus()
          return
        }
      }
      return self.clients.openWindow(targetUrl)
    }),
  )
})
