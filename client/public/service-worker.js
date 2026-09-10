self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { payload = {}; }
  event.waitUntil(self.registration.showNotification(payload.title || 'Skyjo', {
    body: payload.body || 'Vous avez une nouvelle notification.',
    icon: '/app-icon-192.png',
    badge: '/app-icon-192.png',
    tag: payload.tag || 'skyjo-notification',
    data: { url: payload.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const requestedUrl = new URL(event.notification.data?.url || '/', self.location.origin);
  const targetUrl = requestedUrl.origin === self.location.origin
    ? requestedUrl.href : self.location.origin;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.navigate(targetUrl).then(() => existing.focus());
    return self.clients.openWindow(targetUrl);
  }));
});
