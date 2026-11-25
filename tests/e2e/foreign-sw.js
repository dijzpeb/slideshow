// Test-only Service Worker used by tests/e2e/11-security.test.mjs: another worker of the same origin that is
// NOT the app's sw.js (like another project on the same github.io origin). Registered with the scope
// /tests/e2e/, so it never controls the app page, but a worker can still message every same-origin window.
// On {type: 'probe', force} from a page it sends the app's 'need-creds' request to every window client and
// reports, per client, whether anything came back.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'probe' || !event.ports || !event.ports[0]) return;
  const reply = event.ports[0];
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const answers = await Promise.all(
        windows.map(
          (client) =>
            new Promise((resolve) => {
              const ch = new MessageChannel();
              const timer = setTimeout(() => resolve({ url: client.url, answered: false }), data.waitMs || 1500);
              ch.port1.onmessage = (e) => {
                clearTimeout(timer);
                resolve({ url: client.url, answered: true, creds: (e.data && e.data.creds) || null });
              };
              client.postMessage({ type: 'need-creds', force: !!data.force, failedToken: null }, [ch.port2]);
            }),
        ),
      );
      reply.postMessage(answers);
    })(),
  );
});
