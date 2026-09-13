// Push notification service worker for rota list changes.
// Scoped narrowly: handles `push` and `notificationclick` only.
// Do not add offline / app-shell caching here.

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Rota update", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "Rota update";
  const options = {
    body: payload.body || "",
    tag: payload.tag,
    data: { url: payload.url || "/coordinator/rota" },
    icon: "/app-icon-192.png",
    badge: "/app-icon-192.png",
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        try {
          const url = new URL(client.url);
          if (url.origin === self.location.origin) {
            await client.focus();
            await client.navigate(targetUrl);
            return;
          }
        } catch {
          // ignore malformed client urls
        }
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
