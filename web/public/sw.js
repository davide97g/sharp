// sharp service worker — web push receiver.
// Receives encrypted push payloads and shows a notification; clicking focuses
// (or opens) the app and deep-links to the channel.

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
    tag: data.tag,
    renotify: !!data.tag,
    data: {
      channel_id: data.channel_id || null,
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
