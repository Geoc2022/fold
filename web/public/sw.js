self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open('fold-shell-v1')
    await cache.addAll([
      '/',
      '/index.html',
      '/manifest.webmanifest',
      '/favicon.svg',
    ])
  })())
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k.startsWith('fold-shell-') && k !== 'fold-shell-v1').map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const network = await fetch(request)
        const cache = await caches.open('fold-shell-v1')
        if (network.ok) await cache.put(request, network.clone())
        return network
      } catch {
        const cache = await caches.open('fold-shell-v1')
        return (await cache.match(request)) || (await cache.match('/index.html')) || Response.error()
      }
    })())
    return
  }

  event.respondWith((async () => {
    const cache = await caches.open('fold-shell-v1')
    const cached = await cache.match(request)
    const networkPromise = fetch(request)
      .then(async (response) => {
        if (response.ok) await cache.put(request, response.clone())
        return response
      })
      .catch(() => cached)
    return cached || networkPromise || Response.error()
  })())
})

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
