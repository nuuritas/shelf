const SHARE_PATH = '/share';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === SHARE_PATH) {
    event.respondWith(handleShare(event.request));
  }
});

async function handleShare(request) {
  try {
    const form = await request.formData();
    const text = [form.get('url'), form.get('text'), form.get('title')]
      .filter(Boolean)
      .join('\n');

    const response = await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      credentials: 'same-origin',
    });

    if (response.status === 401) {
      return absoluteRedirect('/login?next=/');
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      return absoluteRedirect(
        `/?error=${encodeURIComponent(payload.error || 'Could not save this link.')}`,
      );
    }

    return absoluteRedirect('/?layout=saves&notice=shared');
  } catch {
    return absoluteRedirect('/?error=Share+failed');
  }
}

function absoluteRedirect(path) {
  return Response.redirect(new URL(path, self.location.origin).toString(), 303);
}

// A payload-less push wakes this worker; the text comes from the signed-in
// Worker, so notification content never goes through the push service.
self.addEventListener('push', event => {
  event.waitUntil(showPendingNotification());
});

async function showPendingNotification() {
  let notification = null;

  try {
    const response = await fetch('/api/notifications/next', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return;
    const payload = await response.json();
    notification = payload && payload.notification;
  } catch {
    return;
  }

  if (!notification) return;

  try {
    await self.registration.showNotification(notification.title || 'Shelf', {
      body: notification.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'shelf-summary',
      data: { url: notification.url || '/' },
    });
  } catch {
    // The permission may have been revoked after subscribing.
  }
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(openNotification(url));
});

async function openNotification(path) {
  const url = new URL(path, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  for (const client of windows) {
    if ('focus' in client) {
      try {
        if ('navigate' in client) await client.navigate(url);
      } catch {
        // A client can disappear between matchAll and navigate; fall through.
      }
      return client.focus();
    }
  }

  return self.clients.openWindow(url);
}
