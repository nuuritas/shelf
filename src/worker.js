import { Bookmarks } from './bookmarks-do.js';
import { CSS, renderLogin, renderPage, renderSetup } from './render.js';
import {
  clampInteger,
  escapeHtml,
  htmlResponse,
  jsonResponse,
  parseCookies,
  redirect,
  sha256Hex,
} from './util.js';
import { extractXUrl } from './x.js';

export { Bookmarks };

const SESSION_COOKIE = 'xbv_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' https://pbs.twimg.com data:; media-src 'self' https://video.twimg.com; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return secure(jsonResponse({ ok: true }));
    }

    if (url.pathname === '/style.css') {
      return secure(
        new Response(CSS, {
          headers: {
            'Content-Type': 'text/css; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
          },
        }),
      );
    }

    if (!env.APP_PASSWORD) {
      if (url.pathname.startsWith('/api/')) {
        return secure(jsonResponse({ error: 'APP_PASSWORD is not configured.' }, 503));
      }
      return secure(htmlResponse(renderSetup(), 503));
    }

    if (url.pathname === '/login') {
      if (request.method === 'GET') {
        return secure(htmlResponse(renderLogin({ next: safeNext(url.searchParams.get('next')) })));
      }
      if (request.method === 'POST') {
        return secure(await handleLogin(request, env));
      }
    }

    const authorized = await isAuthorized(request, env);
    const shareSave =
      !authorized &&
      request.method === 'POST' &&
      url.pathname === '/api/bookmarks' &&
      (await isShareTokenAuthorized(request, env));

    if (!authorized && !shareSave) {
      if (url.pathname.startsWith('/api/')) {
        return secure(jsonResponse({ error: 'Authentication required.' }, 401));
      }
      const next = `${url.pathname}${url.search}`;
      return secure(redirect(`/login?next=${encodeURIComponent(next)}`));
    }

    if (request.method === 'POST' && url.pathname === '/logout') {
      return secure(
        new Response(null, {
          status: 303,
          headers: {
            Location: '/login',
            'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
          },
        }),
      );
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return secure(await handleHome(url, env));
    }

    if (request.method === 'GET' && url.pathname.startsWith('/t/')) {
      const slug = decodeURIComponent(url.pathname.slice(3)).replace(/\/+$/, '');
      return secure(await handleTopicPage(slug, env));
    }

    if (request.method === 'POST' && (url.pathname === '/add' || url.pathname === '/share')) {
      return secure(await handleShare(request, env, url.pathname));
    }

    if (request.method === 'POST' && url.pathname === '/delete') {
      return secure(await handleDeleteForm(request, env));
    }

    if (request.method === 'POST' && url.pathname === '/summarize') {
      return secure(await handleSummarizeForm(request, env));
    }

    if (url.pathname === '/api/bookmarks') {
      if (request.method === 'GET') {
        return secure(await handleApiList(url, env));
      }
      if (request.method === 'POST') {
        return secure(await handleApiSave(request, env));
      }
    }

    const bookmarkMatch = url.pathname.match(/^\/api\/bookmarks\/(\d{1,25})$/);
    if (bookmarkMatch) {
      if (request.method === 'GET') {
        return secure(await apiGuard(() => handleApiGet(bookmarkMatch[1], env)));
      }
      if (request.method === 'DELETE') {
        return secure(await apiGuard(() => handleApiDelete(bookmarkMatch[1], env)));
      }
    }

    const summaryMatch = url.pathname.match(/^\/api\/bookmarks\/(\d{1,25})\/summarize$/);
    if (summaryMatch && request.method === 'POST') {
      return secure(await apiGuard(() => handleApiSummarize(summaryMatch[1], env)));
    }

    if (request.method === 'GET' && url.pathname === '/api/stats') {
      return secure(await apiGuard(() => handleApiStats(env)));
    }

    if (request.method === 'GET' && url.pathname === '/api/topics') {
      return secure(await apiGuard(() => handleApiTopics(env)));
    }

    if (request.method === 'POST' && url.pathname === '/api/reindex') {
      return secure(await apiGuard(() => handleApiReindex(env)));
    }

    return secure(htmlResponse('<h1>Not found</h1><p><a href="/">Go home</a></p>', 404));
  },
};

async function handleHome(url, env) {
  const query = (url.searchParams.get('q') || '').trim();
  const limit = clampInteger(url.searchParams.get('limit'), 50, 1, 100);
  const params = new URLSearchParams({ limit: String(limit) });
  if (query) params.set('q', query);

  try {
    const [data, topicData] = await Promise.all([
      doJson(env, `/list?${params.toString()}`),
      doJson(env, '/topics').catch(() => ({ topics: [] })),
    ]);
    return htmlResponse(
      renderPage({
        bookmarks: data.bookmarks,
        total: data.total,
        query,
        topics: topicData.topics,
        notice: url.searchParams.get('notice'),
        error: url.searchParams.get('error'),
        aiConfigured: Boolean(env.OPENCODE_API_KEY),
      }),
    );
  } catch (error) {
    return htmlResponse(
      renderPage({
        bookmarks: [],
        total: 0,
        query,
        topics: [],
        notice: null,
        error: errorMessage(error),
        aiConfigured: Boolean(env.OPENCODE_API_KEY),
      }),
      502,
    );
  }
}

async function handleTopicPage(slug, env) {
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return htmlResponse('<h1>Topic not found</h1><p><a href="/">Go home</a></p>', 404);
  }

  try {
    const [data, topicData] = await Promise.all([
      doJson(env, `/topic?slug=${encodeURIComponent(slug)}`),
      doJson(env, '/topics').catch(() => ({ topics: [] })),
    ]);

    if (!data.topic) {
      return htmlResponse('<h1>Topic not found</h1><p><a href="/">Go home</a></p>', 404);
    }

    return htmlResponse(
      renderPage({
        bookmarks: data.bookmarks,
        total: data.total,
        query: '',
        topics: topicData.topics,
        topic: data.topic,
        notice: null,
        error: null,
        aiConfigured: Boolean(env.OPENCODE_API_KEY),
      }),
    );
  } catch (error) {
    return htmlResponse(`<h1>Could not load topic</h1><p>${escapeHtml(errorMessage(error))}</p>`, 502);
  }
}

async function handleApiTopics(env) {
  return jsonResponse(await doJson(env, '/topics'));
}

async function handleApiReindex(env) {
  const result = await doJson(env, '/reindex', { method: 'POST' });
  return jsonResponse(result, 202);
}

async function handleShare(request, env, pathname) {
  let input = '';
  try {
    if (pathname === '/share') {
      const form = await request.formData();
      input = [form.get('url'), form.get('text'), form.get('title')]
        .filter(Boolean)
        .join('\n');
    } else {
      const form = await request.formData();
      input = String(form.get('url') || '');
    }
  } catch {
    return redirect('/?error=Could+not+read+the+shared+link');
  }

  const parsed = extractXUrl(input);
  if (!parsed) {
    return redirect('/?error=That+does+not+look+like+an+X+post+link');
  }

  try {
    const result = await doJson(env, '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: parsed.canonicalUrl }),
    });
    return redirect(`/?notice=${result.created ? 'added' : 'exists'}`);
  } catch (error) {
    return redirect(`/?error=${encodeURIComponent(errorMessage(error))}`);
  }
}

async function handleDeleteForm(request, env) {
  const form = await request.formData();
  const id = String(form.get('id') || '');
  if (!/^\d{1,25}$/.test(id)) return redirect('/?error=Invalid+bookmark');
  try {
    await doJson(env, '/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    return redirect('/?notice=deleted');
  } catch (error) {
    return redirect(`/?error=${encodeURIComponent(errorMessage(error))}`);
  }
}

async function handleSummarizeForm(request, env) {
  const form = await request.formData();
  const id = String(form.get('id') || '');
  if (!/^\d{1,25}$/.test(id)) return redirect('/?error=Invalid+bookmark');
  try {
    await doJson(env, '/resummarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    return redirect('/?notice=queued');
  } catch (error) {
    return redirect(`/?error=${encodeURIComponent(errorMessage(error))}`);
  }
}

async function handleApiList(url, env) {
  const params = new URLSearchParams();
  const q = (url.searchParams.get('q') || '').trim();
  if (q) params.set('q', q);
  params.set('limit', String(clampInteger(url.searchParams.get('limit'), 50, 1, 100)));
  params.set('offset', String(clampInteger(url.searchParams.get('offset'), 0, 0, 10_000)));
  return jsonResponse(await doJson(env, `/list?${params.toString()}`));
}

async function handleApiSave(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON.' }, 400);
  }

  const input = [body?.url, body?.text].filter(Boolean).join('\n');
  const parsed = extractXUrl(input);
  if (!parsed) return jsonResponse({ error: 'That does not look like an X post link.' }, 400);

  try {
    const result = await doJson(env, '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: parsed.canonicalUrl }),
    });
    return jsonResponse(result, result.created ? 201 : 200);
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, error?.status || 502);
  }
}

async function handleApiGet(id, env) {
  const result = await doJson(env, `/get?id=${encodeURIComponent(id)}`);
  return jsonResponse(result);
}

async function handleApiDelete(id, env) {
  const result = await doJson(env, '/delete', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return jsonResponse(result);
}

async function handleApiSummarize(id, env) {
  const result = await doJson(env, '/resummarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return jsonResponse(result, 202);
}

async function handleApiStats(env) {
  return jsonResponse(await doJson(env, '/stats'));
}

async function apiGuard(handler) {
  try {
    return await handler();
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, error?.status || 500);
  }
}

async function doJson(env, path, init) {
  const stub = env.BOOKMARKS.get(env.BOOKMARKS.idFromName('library'));
  const response = await stub.fetch(`https://bookmarks.internal${path}`, init);
  const text = await response.text();

  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Storage returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const error = new Error(payload?.error || `Storage returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  return payload;
}

async function handleLogin(request, env) {
  const form = await request.formData();
  const password = String(form.get('password') || '');
  const next = safeNext(String(form.get('next') || '/'));

  if (!(await passwordMatches(password, env.APP_PASSWORD))) {
    return htmlResponse(renderLogin({ error: 'Wrong password.', next }), 401);
  }

  const token = await createSession(env);
  const cookie = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_SECONDS}`,
    new URL(request.url).protocol === 'https:' ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');

  return new Response(null, {
    status: 303,
    headers: {
      Location: next,
      'Set-Cookie': cookie,
    },
  });
}

async function isAuthorized(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (await passwordMatches(token, env.APP_PASSWORD)) return true;
  }

  const token = parseCookies(request).get(SESSION_COOKIE);
  return verifySession(token, env);
}

async function isShareTokenAuthorized(request, env) {
  if (!env.SHARE_TOKEN) return false;
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return false;
  return passwordMatches(header.slice(7).trim(), env.SHARE_TOKEN);
}

async function passwordMatches(input, expected) {
  const [left, right] = await Promise.all([sha256Hex(input), sha256Hex(expected)]);
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}

function sessionSecret(env) {
  return env.APP_SECRET || env.APP_PASSWORD;
}

async function createSession(env) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = `v1.${expires}`;
  const signature = await hmac(payload, sessionSecret(env));
  return `${payload}.${signature}`;
}

async function verifySession(token, env) {
  if (!token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;

  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;

  const expected = await hmac(`v1.${expires}`, sessionSecret(env));
  return timingSafeEqual(parts[2], expected);
}

async function hmac(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64Url(signature);
}

function base64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}

function safeNext(value) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function secure(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'Unexpected error.';
}
