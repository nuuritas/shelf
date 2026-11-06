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

    return absoluteRedirect('/?notice=shared');
  } catch {
    return absoluteRedirect('/?error=Share+failed');
  }
}

function absoluteRedirect(path) {
  return Response.redirect(new URL(path, self.location.origin).toString(), 303);
}
