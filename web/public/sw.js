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

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    console.info('[fold:push] service_worker_subscription_change')
    const oldSubscription = event.oldSubscription
    const subscription = event.newSubscription || await createReplacementSubscription(oldSubscription)
    if (!subscription) return

    const serialized = subscription.toJSON()
    const pageRelay = postToWindowClients({
      type: 'fold:push-subscription-change',
      subscription: serialized,
    })
    const endpointUpsert = fetch('/api/push/subscriptions', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serialized),
    }).then((response) => {
      if (!response.ok) throw new Error(`push subscription upsert failed: ${response.status}`)
    })

    const [, upsertResult] = await Promise.allSettled([pageRelay, endpointUpsert])
    if (upsertResult.status === 'rejected') {
      console.warn('[fold:push] service_worker_subscription_upsert_failed', upsertResult.reason)
    } else {
      console.info('[fold:push] service_worker_subscription_upserted')
    }
  })())
})

self.addEventListener('push', (event) => {
  const notification = pushNotification(event.data)
  console.info('[fold:push] service_worker_push_received', {
    id: notification.id,
    title: notification.title,
    url: notification.url,
  })
  event.waitUntil(Promise.all([
    self.registration.showNotification(notification.title, {
      body: notification.body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: notification.tag,
      renotify: true,
      data: {
        id: notification.id,
        url: notification.url,
        created_at: notification.created_at,
      },
    }).then(() => console.info('[fold:push] service_worker_notification_shown', notification.id)),
    postToWindowClients({
      type: 'fold:push-notification',
      notification,
    }, true),
  ]))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = sameOriginUrl(event.notification.data?.url)
  console.info('[fold:push] service_worker_notification_clicked', {
    id: event.notification.data?.id || null,
    url: targetUrl,
  })
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const matching = windows.find((client) => sameOriginUrl(client.url) === targetUrl)
    if (matching) {
      try {
        const navigated = await matching.navigate(targetUrl)
        return (navigated || matching).focus()
      } catch {
        return matching.focus()
      }
    }
    return self.clients.openWindow(targetUrl)
  })())
})

async function createReplacementSubscription(oldSubscription) {
  let applicationServerKey = oldSubscription?.options?.applicationServerKey
  try {
    const response = await fetch('/api/push/public-key', { cache: 'no-store' })
    if (response.ok) {
      const config = await response.json()
      if (config.enabled && typeof config.public_key === 'string') {
        applicationServerKey = decodeApplicationServerKey(config.public_key)
      }
    }
  } catch {
    // Fall back to the prior key when configuration is temporarily unavailable.
  }
  if (!applicationServerKey) return null

  return self.registration.pushManager.subscribe({
    userVisibleOnly: oldSubscription?.options?.userVisibleOnly ?? true,
    applicationServerKey,
  })
}

function decodeApplicationServerKey(publicKey) {
  const padded = `${publicKey}${'='.repeat((4 - (publicKey.length % 4)) % 4)}`
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

function pushNotification(data) {
  const fallback = {
    id: null,
    title: 'fold activity update',
    body: 'Open fold to see what changed.',
    url: sameOriginUrl('/'),
    tag: 'fold-update',
    created_at: null,
  }
  if (!data) return fallback

  try {
    const payload = data.json()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fallback
    const id = nonEmptyString(payload.id)
    return {
      id,
      title: nonEmptyString(payload.title) || fallback.title,
      body: nonEmptyString(payload.body) || fallback.body,
      url: sameOriginUrl(nonEmptyString(payload.url) || '/'),
      tag: nonEmptyString(payload.tag) || (id ? `fold-update-${id}` : fallback.tag),
      created_at: typeof payload.created_at === 'number' ? payload.created_at : null,
    }
  } catch {
    return fallback
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : null
}

function sameOriginUrl(value) {
  try {
    const url = new URL(typeof value === 'string' ? value : '/', self.location.origin)
    return url.origin === self.location.origin ? url.href : new URL('/', self.location.origin).href
  } catch {
    return new URL('/', self.location.origin).href
  }
}

async function postToWindowClients(message, visibleOnly = false) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of windows) {
    if (!visibleOnly || client.visibilityState === 'visible') client.postMessage(message)
  }
}
