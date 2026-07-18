// sharp service worker — app shell cache + web push receiver.
// Keep this file hand-rolled (no workbox): push handlers must stay simple and
// the installability fetch handler is intentionally minimal.

const CACHE = 'sharp-shell-v1'
const PRECACHE = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

// Network-first for navigations; cache-first for same-origin static assets.
// API / WS / docs sync are never cached.
self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put('/', copy)).catch(() => {})
          return res
        })
        .catch(() => caches.match('/') || caches.match(req)),
    )
    return
  }

  // Precached shell + hashed build assets under /assets/
  const isAsset =
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest'

  if (!isAsset) return

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {})
          }
          return res
        })
        .catch(() => cached)
      return cached || network
    }),
  )
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (e) {
    data = {}
  }
  const title = data.title || 'sharp'
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-32.png',
    tag: data.tag,
    renotify: !!data.tag,
    timestamp: data.timestamp || Date.now(),
    data: {
      channel_id: data.channel_id || null,
      message_id: data.message_id || null,
      notification_id: data.notification_id || null,
      path: data.path || null,
    },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const d = event.notification.data || {}
  const path = d.path || (d.channel_id ? `/c/${d.channel_id}` : '/')
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) => {
        for (const client of list) {
          if ('focus' in client) {
            client.focus()
            if ('navigate' in client) {
              try {
                client.navigate(path)
              } catch (e) {
                /* ignore cross-origin navigate errors */
              }
            }
            return
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(path)
      }),
  )
})
