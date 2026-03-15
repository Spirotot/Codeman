/**
 * @fileoverview Service worker for Web Push notifications and offline app shell caching.
 *
 * Two responsibilities:
 * 1. Push notifications — receives push events from the Codeman server (via web-push)
 *    and displays OS-level notifications with deep linking.
 * 2. App shell caching — caches HTML, CSS, JS, and icons on install so the UI loads
 *    instantly on repeat visits and survives flaky connections. API/SSE requests are
 *    always network-only (never cached).
 *
 * Cache strategy: stale-while-revalidate for static assets, network-only for API/SSE.
 * Cache is versioned — old caches are pruned on activate.
 *
 * Lifecycle: skipWaiting on install, claim clients on activate — ensures the latest
 * service worker takes control immediately without waiting for tab refresh.
 *
 * @dependency None (runs in ServiceWorkerGlobalScope, isolated from page scripts)
 * @see src/push-store.ts — server-side VAPID key management and subscription CRUD
 */

const CACHE_NAME = 'codeman-shell-v1';

// App shell resources to precache on install.
// These are the minimum needed to render the UI skeleton.
const SHELL_ASSETS = [
  '/',
  '/styles.css',
  '/mobile.css',
  '/constants.js',
  '/mobile-handlers.js',
  '/voice-input.js',
  '/notification-manager.js',
  '/keyboard-accessory.js',
  '/app.js',
  '/ralph-wizard.js',
  '/api-client.js',
  '/subagent-windows.js',
  '/conversation-view.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-180.png',
];

// ─── Lifecycle ───────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use addAll with individual catches — don't let one missing asset
      // block the entire install (e.g., hashed filenames may differ).
      return Promise.allSettled(
        SHELL_ASSETS.map((url) => cache.add(url).catch(() => {
          console.warn(`[SW] Failed to precache: ${url}`);
        }))
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Prune old cache versions
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch — stale-while-revalidate for shell, network-only for API ─────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-only: API requests, SSE event streams, auth routes, WebSocket upgrades
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/q/') ||
    event.request.headers.get('accept')?.includes('text/event-stream') ||
    event.request.headers.get('upgrade') === 'websocket'
  ) {
    return; // Let the browser handle normally (network-only)
  }

  // For navigation and static assets: stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((response) => {
        // Only cache successful same-origin responses
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Network failed — return cached version if available
        return cached;
      });

      // Return cached immediately if available, update in background
      return cached || fetchPromise;
    })
  );
});

// ─── Push Notifications ─────────────────────────────────────────

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }

  const { title, body, tag, sessionId, urgency, actions } = payload;

  const options = {
    body: body || '',
    tag: tag || 'codeman-default',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { sessionId, url: sessionId ? `/?session=${sessionId}` : '/' },
    renotify: true,
    requireInteraction: urgency === 'critical',
  };

  if (actions && actions.length > 0) {
    options.actions = actions;
  }

  event.waitUntil(
    self.registration.showNotification(title || 'Codeman', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const { sessionId, url } = event.notification.data || {};
  const targetUrl = url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Try to find an existing Codeman tab
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.postMessage({
            type: 'notification-click',
            sessionId,
            action: event.action || null,
          });
          return client.focus();
        }
      }
      // No existing tab — open a new one
      return self.clients.openWindow(targetUrl);
    })
  );
});
