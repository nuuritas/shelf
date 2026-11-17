import { aiConfig, isAiConfigured } from './ai.ts';
import {
  APPEARANCE_COOKIE,
  APPEARANCE_MAX_AGE,
  isTextSize,
  isTheme,
  parseAppearance,
  serializeAppearance,
  type Appearance,
} from './appearance.ts';
import { Bookmarks } from './bookmarks-do.ts';
import { handleMcpRequest, mcpBackend } from './mcp.ts';
import { parseWebUrl } from './links.ts';
import { normalizeNoteInput } from './notes.ts';
import { parseLinkedInUrl } from './linkedin.ts';
import { parseYouTubeUrl } from './youtube.ts';
import {
  CSS,
  renderCalendar,
  renderLogin,
  renderNotePage,
  renderPage,
  renderSettings,
  renderSetup,
} from './render.ts';
import {
  defaultSummaryLanguage,
  normalizeSummaryLanguage,
  normalizeSummaryPrompt,
  validateSummaryPrompt,
  workspaceNameError,
  workspaceNameMessage,
} from './settings.ts';
import type {
  ArchiveResult,
  ArchiveView,
  CalendarResult,
  DeleteResult,
  Env,
  GetResult,
  LabelListResult,
  ListResult,
  ReindexResult,
  SaveResult,
  StatsResult,
  StoreTranscriptsResult,
  StoredSettings,
  SummaryLanguage,
  SummarizeResult,
  TopicListResult,
  TopicPageResult,
  TranslateAllResult,
  VideoTranscript,
} from './types.ts';
import {
  canonicalRedirectUrl,
  clampInteger,
  escapeHtml,
  htmlResponse,
  jsonResponse,
  parseCookies,
  parseSource,
  parseSourceList,
  redirect,
  sha256Hex,
} from './util.ts';
import { extractXUrl } from './x.ts';

export { Bookmarks };

const SESSION_COOKIE = 'shelf_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' https://pbs.twimg.com data:; media-src 'self' https://video.twimg.com; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

const worker: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Read once, before any page renders: the first paint is already the
    // reader's theme and text size, and no script has to fix it afterwards.
    const look = parseAppearance(request.headers.get('cookie') ?? undefined);

    if (url.pathname === '/healthz') {
      return secure(jsonResponse({ ok: true }));
    }

    const canonical = canonicalRedirectUrl(url, env.CANONICAL_HOST, env.REDIRECT_HOSTS);
    if (canonical) {
      return secure(redirect(canonical, 308));
    }

    if (url.pathname === '/style.css') {
      return secure(
        new Response(CSS, {
          headers: {
            'Content-Type': 'text/css; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        }),
      );
    }

    if (!env.APP_PASSWORD) {
      if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') {
        return secure(jsonResponse({ error: 'APP_PASSWORD is not configured.' }, 503));
      }
      return secure(htmlResponse(renderSetup({ appearance: look }), 503));
    }

    if (url.pathname === '/login') {
      if (request.method === 'GET') {
        return secure(
          htmlResponse(
            renderLogin({
              next: safeNext(url.searchParams.get('next')),
              appearance: look,
            }),
          ),
        );
      }
      if (request.method === 'POST') {
        return secure(await handleLogin(request, env, look));
      }
    }

    const authorized = await isAuthorized(request, env);
    const shareSave =
      !authorized &&
      request.method === 'POST' &&
      url.pathname === '/api/bookmarks' &&
      (await isShareTokenAuthorized(request, env));

    if (!authorized && !shareSave) {
      if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') {
        return secure(jsonResponse({ error: 'Authentication required.' }, 401));
      }
      const next = `${url.pathname}${url.search}`;
      return secure(redirect(`/login?next=${encodeURIComponent(next)}`));
    }

    // A hosted MCP endpoint: same bearer password as the API, JSON-RPC body.
    if (url.pathname === '/mcp') {
      return secure(await handleMcpRequest(request, mcpBackend(env, url.origin)));
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
      return secure(await handleHome(url, env, look));
    }

    if (request.method === 'GET' && url.pathname === '/calendar') {
      return secure(await handleCalendarPage(url, env, look));
    }

    const notePageMatch = url.pathname.match(/^\/p\/([A-Za-z0-9_-]{1,30})(\/frame)?$/);
    if (notePageMatch && request.method === 'GET') {
      return await handleNotePage(notePageMatch[1], Boolean(notePageMatch[2]), env, look);
    }

    if (url.pathname === '/settings') {
      if (request.method === 'GET') return secure(await handleSettingsPage(url, env, look));
      if (request.method === 'POST') return secure(await handleSettingsSave(request, env));
    }

    if (request.method === 'GET' && url.pathname.startsWith('/t/')) {
      const slug = decodeURIComponent(url.pathname.slice(3)).replace(/\/+$/, '');
      return secure(await handleTopicPage(slug, env, url, look));
    }

    if (request.method === 'POST' && (url.pathname === '/add' || url.pathname === '/share')) {
      return secure(await handleShare(request, env, url.pathname));
    }

    if (request.method === 'POST' && url.pathname === '/delete') {
      return secure(await handleDeleteForm(request, env));
    }

    if (request.method === 'POST' && url.pathname === '/archive') {
      return secure(await handleArchiveForm(request, env));
    }

    if (request.method === 'POST' && url.pathname === '/labels') {
      return secure(await handleLabelsForm(request, env));
    }

    if (request.method === 'POST' && url.pathname === '/translate-missing') {
      return secure(await handleTranslateMissingForm(request, env));
    }

    if (request.method === 'POST' && url.pathname === '/summarize') {
      return secure(await handleSummarizeForm(request, env));
    }

    if (url.pathname === '/api/posts' && request.method === 'POST') {
      return secure(await handleApiCreatePost(request, env));
    }

    if (url.pathname === '/api/bookmarks') {
      if (request.method === 'GET') {
        return secure(await handleApiList(url, env));
      }
      if (request.method === 'POST') {
        return secure(await handleApiSave(request, env));
      }
    }

    // Digits are tweet ids; anything alphanumeric is a short bookmark ref.
    const archiveMatch = url.pathname.match(/^\/api\/bookmarks\/([A-Za-z0-9_-]{1,30})\/archive$/);
    if (archiveMatch && request.method === 'POST') {
      return secure(await apiGuard(() => handleApiArchive(archiveMatch[1], env, request)));
    }

    const bookmarkMatch = url.pathname.match(/^\/api\/bookmarks\/([A-Za-z0-9_-]{1,30})$/);
    if (bookmarkMatch) {
      if (request.method === 'GET') {
        return secure(await apiGuard(() => handleApiGet(bookmarkMatch[1], env)));
      }
      if (request.method === 'DELETE') {
        return secure(await apiGuard(() => handleApiDelete(bookmarkMatch[1], env)));
      }
    }

    const summaryMatch = url.pathname.match(/^\/api\/bookmarks\/([A-Za-z0-9_-]{1,30})\/summarize$/);
    if (summaryMatch && request.method === 'POST') {
      return secure(await apiGuard(() => handleApiSummarize(summaryMatch[1], env, request)));
    }

    const transcriptsMatch = url.pathname.match(
      /^\/api\/bookmarks\/([A-Za-z0-9_-]{1,30})\/transcripts$/,
    );
    if (transcriptsMatch && request.method === 'POST') {
      return secure(await apiGuard(() => handleApiTranscripts(transcriptsMatch[1], env, request)));
    }

    if (request.method === 'POST' && url.pathname === '/api/translations/en') {
      return secure(await apiGuard(() => handleApiTranslateAll(env)));
    }

    if (request.method === 'GET' && url.pathname === '/api/push/key') {
      return secure(await apiGuard(() => handleApiPushKey(env)));
    }

    if (request.method === 'GET' && url.pathname === '/api/push/state') {
      return secure(await apiGuard(() => handleApiPushState(env)));
    }

    if (request.method === 'POST' && url.pathname === '/api/push/subscribe') {
      return secure(await apiGuard(() => handleApiPushSubscribe(request, env)));
    }

    if (request.method === 'POST' && url.pathname === '/api/push/unsubscribe') {
      return secure(await apiGuard(() => handleApiPushUnsubscribe(request, env)));
    }

    if (request.method === 'GET' && url.pathname === '/api/notifications/next') {
      return secure(await apiGuard(() => handleApiNotificationNext(env)));
    }

    if (request.method === 'POST' && url.pathname === '/api/notifications/test') {
      return secure(await apiGuard(() => handleApiNotificationTest(env)));
    }

    if (request.method === 'GET' && url.pathname === '/api/stats') {
      return secure(await apiGuard(() => handleApiStats(env)));
    }

    // The native apps draw their own Settings screen, so the one aggregate read
    // the hosted service answers at `/api/settings` is answered here too. The
    // shape is the hosted one; the plan and the key are the deployment's own.
    if (request.method === 'GET' && url.pathname === '/api/settings') {
      return secure(await apiGuard(() => handleApiSettings(env)));
    }

    if (request.method === 'PUT' && url.pathname === '/api/settings/language') {
      return secure(await apiGuard(() => handleApiSetLanguage(env, request)));
    }

    if (request.method === 'PUT' && url.pathname === '/api/settings/ai-summaries') {
      return secure(await apiGuard(() => handleApiSetAiSummaries(env, request)));
    }

    if (request.method === 'GET' && url.pathname === '/api/settings/ai-key') {
      return secure(await apiGuard(() => handleApiAiKey(env)));
    }

    if (
      (request.method === 'PUT' || request.method === 'DELETE') &&
      url.pathname === '/api/settings/ai-key'
    ) {
      return secure(await apiGuard(() => handleApiWriteAiKey(request)));
    }

    if (request.method === 'PUT' && url.pathname === '/api/settings/workspace') {
      return secure(await apiGuard(() => handleApiRenameWorkspace(env, request)));
    }

    if (request.method === 'POST' && url.pathname === '/api/settings/plan/upgrade') {
      return secure(await apiGuard(() => handleApiUpgradePlan()));
    }

    if (request.method === 'GET' && url.pathname === '/api/plans') {
      return secure(jsonResponse(selfHostedPlans(env)));
    }

    if (request.method === 'GET' && url.pathname === '/api/topics') {
      return secure(await apiGuard(() => handleApiTopics(env)));
    }

    if (request.method === 'GET' && url.pathname === '/api/labels') {
      return secure(await apiGuard(() => handleApiLabels(env)));
    }

    const labelsMatch = url.pathname.match(/^\/api\/bookmarks\/([A-Za-z0-9_-]{1,30})\/labels$/);
    if (labelsMatch && request.method === 'PUT') {
      return secure(await apiGuard(() => handleApiSetLabels(labelsMatch[1], env, request)));
    }

    const labelRemoveMatch = url.pathname.match(
      /^\/api\/bookmarks\/([A-Za-z0-9_-]{1,30})\/labels\/([^/]{1,80})$/,
    );
    if (labelRemoveMatch && request.method === 'DELETE') {
      return secure(
        await apiGuard(() =>
          handleApiRemoveLabel(
            labelRemoveMatch[1],
            decodeURIComponent(labelRemoveMatch[2]),
            env,
          ),
        ),
      );
    }

    if (request.method === 'GET' && url.pathname === '/api/calendar') {
      return secure(await apiGuard(() => handleApiCalendar(url, env)));
    }

    if (request.method === 'POST' && url.pathname === '/api/reindex') {
      return secure(await apiGuard(() => handleApiReindex(env)));
    }

    return secure(htmlResponse('<h1>Not found</h1><p><a href="/">Go home</a></p>', 404));
  },
};

export default worker;

async function handleHome(url: URL, env: Env, look: Appearance): Promise<Response> {
  const query = (url.searchParams.get('q') || '').trim();
  const day = parseDay(url.searchParams.get('day'));
  const labels = url.searchParams
    .getAll('label')
    .map(value => value.trim().slice(0, 40))
    .filter(Boolean);
  const label = labels[0] || '';
  const view = parseView(url.searchParams.get('view'));
  const settings = await readSettings(env);
  const lang = parseLang(url.searchParams.get('lang'), settings.summaryLanguage);
  const layout = parseLayout(url.searchParams.get('layout'));
  const sources = parseSourceList(url.searchParams.getAll('source'));
  const source = sources[0] ?? 'all';
  const limit = clampInteger(url.searchParams.get('limit'), 50, 1, 100);
  const params = new URLSearchParams({ limit: String(limit), view });
  if (query) params.set('q', query);
  if (day) params.set('day', day);
  for (const value of labels) params.append('label', value);
  for (const value of sources) params.append('source', value);

  try {
    const [data, topicData, labelData] = await Promise.all([
      doJson<ListResult>(env, `/list?${params.toString()}`),
      doJson<TopicListResult>(env, '/topics').catch((): TopicListResult => ({ topics: [] })),
      doJson<LabelListResult>(env, '/labels').catch((): LabelListResult => ({ labels: [] })),
    ]);
    return htmlResponse(
      renderPage({
        bookmarks: data.bookmarks,
        total: data.total,
        query,
        day,
        topics: topicData.topics,
        labels: labelData.labels,
        label,
        view,
        lang,
        layout,
        source,
        activeTotal: data.activeTotal,
        archivedTotal: data.archivedTotal,
        missingEnglish: data.missingEnglish,
        bilingual: settings.summaryLanguage === 'tr' && isAiConfigured(env),
        notice: url.searchParams.get('notice'),
        error: url.searchParams.get('error'),
        aiConfigured: isAiConfigured(env),
        appearance: look,
      }),
    );
  } catch (error) {
    return htmlResponse(
      renderPage({
        bookmarks: [],
        total: 0,
        query,
        day,
        topics: [],
        labels: [],
        label,
        view,
        lang,
        layout,
        source,
        activeTotal: 0,
        archivedTotal: 0,
        bilingual: settings.summaryLanguage === 'tr' && isAiConfigured(env),
        notice: null,
        error: errorMessage(error),
        aiConfigured: isAiConfigured(env),
        appearance: look,
      }),
      502,
    );
  }
}

async function handleTopicPage(
  slug: string,
  env: Env,
  url: URL,
  look: Appearance,
): Promise<Response> {
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return htmlResponse('<h1>Topic not found</h1><p><a href="/">Go home</a></p>', 404);
  }

  const view = parseView(url.searchParams.get('view'));
  const source = parseSource(url.searchParams.get('source'));
  const settings = await readSettings(env);
  const lang = parseLang(url.searchParams.get('lang'), settings.summaryLanguage);

  try {
    const [data, topicData] = await Promise.all([
      doJson<TopicPageResult>(
        env,
        `/topic?slug=${encodeURIComponent(slug)}&view=${encodeURIComponent(view)}&source=${encodeURIComponent(source)}`,
      ),
      doJson<TopicListResult>(env, '/topics').catch((): TopicListResult => ({ topics: [] })),
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
        view,
        lang,
        source,
        bilingual: settings.summaryLanguage === 'tr' && isAiConfigured(env),
        notice: url.searchParams.get('notice'),
        error: url.searchParams.get('error'),
        aiConfigured: isAiConfigured(env),
        appearance: look,
      }),
    );
  } catch (error) {
    return htmlResponse(`<h1>Could not load topic</h1><p>${escapeHtml(errorMessage(error))}</p>`, 502);
  }
}

async function handleApiTopics(env: Env): Promise<Response> {
  return jsonResponse(await doJson<TopicListResult>(env, '/topics'));
}

async function handleApiLabels(env: Env): Promise<Response> {
  return jsonResponse(await doJson<LabelListResult>(env, '/labels'));
}

/** Replace a post's label set; `labels: []` clears it. */
async function handleApiSetLabels(id: string, env: Env, request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON.' }, 400);
  }
  const raw = isRecord(body) ? body.labels : undefined;
  if (!Array.isArray(raw) && typeof raw !== 'string') {
    return jsonResponse(
      { error: 'A "labels" array or a comma-separated string is required.' },
      400,
    );
  }
  const result = await doJson<GetResult>(env, '/labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, labels: raw }),
  });
  return jsonResponse(result);
}

/** Drop one label from one post. */
async function handleApiRemoveLabel(id: string, slug: string, env: Env): Promise<Response> {
  if (!/^[\p{L}\p{N}-]{1,40}$/u.test(slug)) {
    return jsonResponse({ error: 'Not a label slug.' }, 400);
  }
  const result = await doJson<GetResult>(env, '/labels/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, slug }),
  });
  return jsonResponse(result);
}

async function handleCalendarPage(url: URL, env: Env, look: Appearance): Promise<Response> {
  const month = (url.searchParams.get('month') || '').trim();
  const settings = await readSettings(env);
  const lang = parseLang(url.searchParams.get('lang'), settings.summaryLanguage);

  try {
    const query = month ? `?month=${encodeURIComponent(month)}` : '';
    const calendar = await doJson<CalendarResult>(env, `/calendar${query}`);
    return htmlResponse(
      renderCalendar({
        calendar,
        lang,
        error: url.searchParams.get('error'),
        appearance: look,
      }),
    );
  } catch (error) {
    return htmlResponse(
      renderCalendar({
        calendar: { month: new Date().toISOString().slice(0, 7), days: [], total: 0 },
        lang,
        error: errorMessage(error),
        appearance: look,
      }),
      502,
    );
  }
}

async function handleSettingsPage(url: URL, env: Env, look: Appearance): Promise<Response> {
  const settings = await readSettings(env);
  const push = await readPushState(env);
  return htmlResponse(
    renderSettings({
      settings,
      ai: aiConfig(env),
      aiConfigured: isAiConfigured(env),
      pushSubscriptions: push.subscriptions,
      notice: url.searchParams.get('notice'),
      error: url.searchParams.get('error'),
      appearance: look,
    }),
  );
}

async function handleSettingsSave(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const action = String(form.get('action') || 'save');
  const reset = action === 'reset';
  const current = await readSettings(env);
  const language = normalizeSummaryLanguage(
    String(form.get('summary_language') || ''),
    current.summaryLanguage,
  );
  const rawPrompt = reset ? '' : String(form.get('summary_prompt') ?? '');

  // The appearance lives in a cookie, not in the settings table: it belongs to
  // the screen in front of the reader. Anything missing or unknown keeps what
  // the browser already had instead of snapping back to the default.
  const currentLook = parseAppearance(request.headers.get('cookie') ?? undefined);
  const theme = String(form.get('theme') || '');
  const size = String(form.get('size') || '');
  const look: Appearance = {
    theme: isTheme(theme) ? theme : currentLook.theme,
    size: isTextSize(size) ? size : currentLook.size,
  };

  const renderError = (message: string, status = 400) =>
    htmlResponse(
      renderSettings({
        settings: {
          ...current,
          summaryPrompt: reset ? current.summaryPrompt : rawPrompt,
          summaryLanguage: language,
        },
        ai: aiConfig(env),
        aiConfigured: isAiConfigured(env),
        error: message,
        appearance: currentLook,
      }),
      status,
    );

  let prompt: string;
  try {
    prompt = normalizeSummaryPrompt(rawPrompt);
    validateSummaryPrompt(prompt);
  } catch (error) {
    return renderError(errorMessage(error));
  }

  try {
    await doJson<StoredSettings>(env, '/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summaryPrompt: prompt, summaryLanguage: language }),
    });
    return new Response(null, {
      status: 303,
      headers: {
        Location: `/settings?notice=${reset ? 'reset' : 'saved'}`,
        // Not HttpOnly: the native clients read this cookie out of their own
        // store to paint the chrome. Not Secure either: `bun run dev` is http.
        'Set-Cookie': `${APPEARANCE_COOKIE}=${serializeAppearance(look)}; Path=/; Max-Age=${APPEARANCE_MAX_AGE}; SameSite=Lax`,
      },
    });
  } catch (error) {
    return renderError(errorMessage(error), 502);
  }
}

async function handleApiCalendar(url: URL, env: Env): Promise<Response> {
  const month = (url.searchParams.get('month') || '').trim();
  const query = month ? `?month=${encodeURIComponent(month)}` : '';
  return jsonResponse(await doJson<CalendarResult>(env, `/calendar${query}`));
}

async function handleApiReindex(env: Env): Promise<Response> {
  const result = await doJson<ReindexResult>(env, '/reindex', { method: 'POST' });
  return jsonResponse(result, 202);
}

async function handleShare(request: Request, env: Env, pathname: string): Promise<Response> {
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

  const parsed =
    extractXUrl(input) ?? parseLinkedInUrl(input) ?? parseYouTubeUrl(input) ?? parseWebUrl(input);
  if (!parsed) {
    return redirect(
      `/?error=${encodeURIComponent('That does not look like an X, LinkedIn, YouTube or web page link.')}`,
    );
  }

  try {
    const result = await doJson<SaveResult>(env, '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: parsed.canonicalUrl }),
    });
    return redirect(`/?notice=${result.created ? 'added' : 'exists'}`);
  } catch (error) {
    return redirect(`/?error=${encodeURIComponent(errorMessage(error))}`);
  }
}

async function handleDeleteForm(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const id = String(form.get('id') || '');
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(id)) return redirect('/?error=Invalid+bookmark');
  const back = safeReturn(form.get('returnTo'), '/');
  try {
    await doJson<DeleteResult>(env, '/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    return redirect(withNotice(back, 'deleted'));
  } catch (error) {
    return redirect(`/?error=${encodeURIComponent(errorMessage(error))}`);
  }
}

async function handleArchiveForm(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const id = String(form.get('id') || '');
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(id)) return redirect('/?error=Invalid+bookmark');

  const archived = String(form.get('archived') || '') === '1';
  const back = safeReturn(form.get('returnTo'), '/');

  try {
    await doJson<ArchiveResult>(env, '/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, archived }),
    });
    return redirect(withNotice(back, archived ? 'archived' : 'unarchived'));
  } catch (error) {
    return redirect(`/?error=${encodeURIComponent(errorMessage(error))}`);
  }
}

async function handleLabelsForm(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const id = String(form.get('id') || '');
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(id)) return redirect('/?error=Invalid+bookmark');
  const back = safeReturn(form.get('returnTo'), '/');

  // The tick list posts every box it offers and the name chip adds one more to
  // the same set. The values are label names, not slugs: `parseLabelNames`
  // derives the slug itself, and the per-post cap drops a 13th silently.
  const labels = form.getAll('label').map(value => String(value));
  const typed = String(form.get('newLabel') || '').trim();
  if (typed) labels.push(typed);

  try {
    await doJson<GetResult>(env, '/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, labels }),
    });
    return redirect(withNotice(back, 'labeled'));
  } catch (error) {
    return redirect(`/?error=${encodeURIComponent(errorMessage(error))}`);
  }
}

async function handleTranslateMissingForm(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const back = safeReturn(form.get('returnTo'), '/?lang=en');

  try {
    const result = await doJson<TranslateAllResult>(env, '/translate-all', { method: 'POST' });
    return redirect(withNotice(back, result.queued ? 'translating' : 'translated-none'));
  } catch (error) {
    return redirect(`/?error=${encodeURIComponent(errorMessage(error))}`);
  }
}

async function handleSummarizeForm(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const id = String(form.get('id') || '');
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(id)) return redirect('/?error=Invalid+bookmark');

  const requested = String(form.get('mode') || '');
  const mode = requested === 'version' ? 'version' : requested === 'translate' ? 'translate' : 'default';
  const instruction = String(form.get('instruction') || '').slice(0, 500);

  try {
    await doJson<SummarizeResult>(env, '/resummarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, mode, instruction }),
    });
    const target = safeReturn(form.get('returnTo'), '/');
    const notice = mode === 'version' ? 'version' : mode === 'translate' ? 'translated' : 'queued';
    return redirect(withNotice(target, notice));
  } catch (error) {
    return redirect(`/?error=${encodeURIComponent(errorMessage(error))}`);
  }
}

async function handleApiList(url: URL, env: Env): Promise<Response> {
  const params = new URLSearchParams();
  const q = (url.searchParams.get('q') || '').trim();
  if (q) params.set('q', q);
  for (const value of url.searchParams.getAll('topic')) {
    const topic = value.trim();
    if (topic) params.append('topic', topic);
  }
  for (const value of url.searchParams.getAll('label')) {
    const label = value.trim().slice(0, 40);
    if (label) params.append('label', label);
  }
  const day = parseDay(url.searchParams.get('day'));
  if (day) params.set('day', day);
  params.set('view', parseListView(url.searchParams.get('view')));
  for (const source of parseSourceList(url.searchParams.getAll('source'))) {
    params.append('source', source);
  }
  params.set('limit', String(clampInteger(url.searchParams.get('limit'), 50, 1, 100)));
  params.set('offset', String(clampInteger(url.searchParams.get('offset'), 0, 0, 10_000)));
  return jsonResponse(await doJson<ListResult>(env, `/list?${params.toString()}`));
}

async function handleApiSave(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON.' }, 400);
  }

  const record = isRecord(body) ? body : {};
  const input = [record.url, record.text].filter(Boolean).join('\n');
  const parsed =
    extractXUrl(input) ?? parseLinkedInUrl(input) ?? parseYouTubeUrl(input) ?? parseWebUrl(input);
  if (!parsed) {
    return jsonResponse(
      { error: 'That does not look like an X, LinkedIn, YouTube or web page link.' },
      400,
    );
  }

  try {
    const result = await doJson<SaveResult>(env, '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: parsed.canonicalUrl }),
    });
    return jsonResponse(result, result.created ? 201 : 200);
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, errorStatus(error, 502));
  }
}

const NOTE_FRAME_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
};

/** `/p/:ref` is the note reading page; `/p/:ref/frame` is its sandboxed HTML. */
async function handleNotePage(
  ref: string,
  frame: boolean,
  env: Env,
  look: Appearance,
): Promise<Response> {
  const result = await doJson<GetResult>(env, `/get?id=${encodeURIComponent(ref)}`).catch(
    (): GetResult | null => null,
  );
  const bookmark = result?.bookmark;
  if (!bookmark || bookmark.kind !== 'note') {
    return secure(htmlResponse('<h1>Note not found</h1><p><a href="/">Go home</a></p>', 404));
  }

  if (frame) {
    // Deliberately not passed through secure(): X-Frame-Options: DENY would
    // block the same-origin iframe that renders this document.
    if (bookmark.format !== 'html') {
      return new Response('Not an HTML note.', { status: 404, headers: NOTE_FRAME_HEADERS });
    }
    return new Response(bookmark.content || '', { status: 200, headers: NOTE_FRAME_HEADERS });
  }

  return secure(htmlResponse(renderNotePage({ bookmark, appearance: look })));
}

async function handleApiCreatePost(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON.' }, 400);
  }

  try {
    const note = normalizeNoteInput(body);
    const result = await doJson<SaveResult>(env, '/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note),
    });
    return jsonResponse(result, result.created ? 201 : 200);
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, errorStatus(error, 502));
  }
}

async function handleApiGet(id: string, env: Env): Promise<Response> {
  const result = await doJson<GetResult>(env, `/get?id=${encodeURIComponent(id)}`);
  return jsonResponse(result);
}

async function handleApiDelete(id: string, env: Env): Promise<Response> {
  const result = await doJson<DeleteResult>(env, '/delete', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return jsonResponse(result);
}

async function handleApiArchive(id: string, env: Env, request: Request): Promise<Response> {
  let body: { archived?: boolean } = {};
  try {
    body = (await request.json()) as { archived?: boolean };
  } catch {
    body = {};
  }

  const result = await doJson<ArchiveResult>(env, '/archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, archived: Boolean(body?.archived) }),
  });
  return jsonResponse(result);
}

async function handleApiTranslateAll(env: Env): Promise<Response> {
  const result = await doJson<TranslateAllResult>(env, '/translate-all', { method: 'POST' });
  return jsonResponse(result, 202);
}

async function handleApiTranscripts(
  id: string,
  env: Env,
  request: Request,
): Promise<Response> {
  let body: { transcripts?: VideoTranscript[] } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const transcripts = Array.isArray(body.transcripts) ? body.transcripts : [];
  const result = await doJson<StoreTranscriptsResult>(env, '/transcripts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, transcripts }),
  });

  return jsonResponse(result, 202);
}

async function handleApiSummarize(
  id: string,
  env: Env,
  request: Request,
): Promise<Response> {
  let body: { mode?: string; instruction?: string } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const requested = String(body?.mode || '');
  const mode = requested === 'version' ? 'version' : requested === 'translate' ? 'translate' : 'default';
  const instruction = String(body?.instruction || '').slice(0, 500);

  const result = await doJson<SummarizeResult>(env, '/resummarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, mode, instruction }),
  });
  return jsonResponse(result, 202);
}

async function handleApiPushKey(env: Env): Promise<Response> {
  return jsonResponse(await doJson<{ publicKey: string }>(env, '/push/key'));
}

async function handleApiPushState(env: Env): Promise<Response> {
  return jsonResponse(await doJson<{ subscriptions: number }>(env, '/push/state'));
}

async function handleApiPushSubscribe(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Body must be JSON.' }, 400);
  }
  const result = await doJson<{ subscriptions: number }>(env, '/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return jsonResponse(result);
}

async function handleApiPushUnsubscribe(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const result = await doJson<{ subscriptions: number }>(env, '/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return jsonResponse(result);
}

async function handleApiNotificationNext(env: Env): Promise<Response> {
  return jsonResponse(
    await doJson<{ notification: unknown }>(env, '/notifications/next'),
  );
}

async function handleApiNotificationTest(env: Env): Promise<Response> {
  return jsonResponse(
    await doJson<{ queued: boolean; subscriptions: number }>(env, '/notifications/test', {
      method: 'POST',
    }),
  );
}

async function handleApiStats(env: Env): Promise<Response> {
  return jsonResponse(await doJson<StatsResult>(env, '/stats'));
}

// ---------------------------------------------------------------------------
// Native settings API
//
// The apps in `nuuritas/shelf-cloud` draw Settings themselves and read one
// aggregate object. The hosted service answers it from Postgres; here the
// deployment's stored preferences and env are the whole truth: one library,
// no tenant, no plan.
// ---------------------------------------------------------------------------

const SELF_PLAN = {
  id: 'self',
  name: 'Self-hosted',
  bookmarkLimit: 0,
  aiMonthly: 0,
  priceCents: 0,
  availability: 'available',
};

/** The catalogue the plan card reads; there is nothing to buy on your own Worker. */
function selfHostedPlans(env: Env) {
  return {
    plans: [
      {
        ...SELF_PLAN,
        managedAi: isAiConfigured(env),
      },
    ],
    billing: {
      status: 'self_hosted',
      message: 'This server is self-hosted: there is no plan to buy and no limit to reach.',
    },
  };
}

function languageNative(tag: SummaryLanguage): string {
  return tag === 'tr' ? 'Türkçe' : 'English';
}

function currentPeriodStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function envCredential(env: Env) {
  if (!isAiConfigured(env)) return null;
  const config = aiConfig(env);
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    hint: 'server key',
    // The key is a Worker secret, not a per-user row: the app shows it and
    // hides the form instead of offering a save that would go nowhere.
    readOnly: true,
  };
}

async function handleApiSettings(env: Env): Promise<Response> {
  const [settings, stats] = await Promise.all([
    readSettings(env),
    doJson<StatsResult>(env, '/stats').catch(() => null),
  ]);
  const configured = isAiConfigured(env);
  return jsonResponse({
    tenant: {
      id: 'self',
      name: settings.workspaceName || 'Your library',
      slug: '',
      planId: SELF_PLAN.id,
    },
    plan: { ...SELF_PLAN, managedAi: configured },
    usage: {
      periodStart: currentPeriodStart(),
      aiSummaries: stats?.summarizedThisMonth ?? 0,
      aiMonthly: 0,
      ingestCalls: stats?.total ?? 0,
    },
    aiSummaries: { enabled: configured && settings.summariesEnabled },
    credential: envCredential(env),
    language: {
      tag: settings.summaryLanguage,
      native: languageNative(settings.summaryLanguage),
    },
  });
}

/** The deployment writes English or Turkish summaries; anything else is a 400. */
function resolveSummaryLanguage(value: unknown): SummaryLanguage | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'en' || text === 'english') return 'en';
  if (text === 'tr' || text === 'turkish' || text === 'türkçe' || text === 'turkce') return 'tr';
  return null;
}

async function handleApiSetLanguage(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { language?: unknown };
  const tag = resolveSummaryLanguage(body.language);
  if (!tag) {
    return jsonResponse(
      {
        error: 'This server writes summaries in English or Turkish.',
        code: 'language_unknown',
      },
      400,
    );
  }
  const settings = await doJson<StoredSettings>(env, '/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summaryLanguage: tag }),
  });
  return jsonResponse({
    language: {
      tag: settings.summaryLanguage,
      native: languageNative(settings.summaryLanguage),
    },
  });
}

async function handleApiSetAiSummaries(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== 'boolean') {
    return jsonResponse({ error: '"enabled" must be a boolean' }, 400);
  }
  const settings = await doJson<StoredSettings>(env, '/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summariesEnabled: body.enabled }),
  });
  return jsonResponse({ enabled: isAiConfigured(env) && settings.summariesEnabled });
}

async function handleApiAiKey(env: Env): Promise<Response> {
  return jsonResponse({ credential: envCredential(env) });
}

async function handleApiWriteAiKey(request: Request): Promise<Response> {
  const method = request.method === 'DELETE' ? 'remove' : 'save';
  return jsonResponse(
    {
      error:
        `This server's AI key is the AI_API_KEY secret in its environment. ` +
        `To ${method} it, change the secret and redeploy; the app only displays it.`,
      code: 'ai_key_managed',
    },
    409,
  );
}

async function handleApiRenameWorkspace(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  const raw = typeof body.name === 'string' ? body.name : '';
  const invalid = workspaceNameError(raw);
  if (invalid) {
    return jsonResponse({ error: workspaceNameMessage(invalid), code: 'workspace_name' }, 400);
  }
  const stored = await doJson<StoredSettings>(env, '/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceName: raw.trim() }),
  });
  return jsonResponse({
    tenant: {
      id: 'self',
      name: stored.workspaceName,
      slug: '',
      planId: SELF_PLAN.id,
    },
  });
}

async function handleApiUpgradePlan(): Promise<Response> {
  return jsonResponse(
    { error: 'This server is self-hosted: there is no plan to upgrade.', code: 'self_hosted' },
    409,
  );
}

async function apiGuard(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, errorStatus(error, 500));
  }
}

/** Subscription count for the settings page; zero if the DO cannot answer. */
async function readPushState(env: Env): Promise<{ subscriptions: number }> {
  try {
    return await doJson<{ subscriptions: number }>(env, '/push/state');
  } catch {
    return { subscriptions: 0 };
  }
}

/** Settings, with the env defaults when the Durable Object cannot answer. */
async function readSettings(env: Env): Promise<StoredSettings> {
  try {
    return await doJson<StoredSettings>(env, '/settings');
  } catch {
    return {
      summaryPrompt: '',
      summaryLanguage: defaultSummaryLanguage(env),
      workspaceName: '',
      summariesEnabled: true,
    };
  }
}

async function doJson<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const stub = env.BOOKMARKS.get(env.BOOKMARKS.idFromName('library'));
  const response = await stub.fetch(`https://bookmarks.internal${path}`, init);
  const text = await response.text();

  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Storage returned invalid JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const record = isRecord(payload) ? payload : null;
    const message =
      record && record.error
        ? String(record.error)
        : `Storage returned HTTP ${response.status}.`;
    const error: StatusError = new Error(message);
    error.status = response.status;
    throw error;
  }

  return payload as T;
}

async function handleLogin(request: Request, env: Env, look: Appearance): Promise<Response> {
  const form = await request.formData();
  const password = String(form.get('password') || '');
  const next = safeNext(String(form.get('next') || '/'));

  if (!(await passwordMatches(password, env.APP_PASSWORD))) {
    return htmlResponse(renderLogin({ error: 'Wrong password.', next, appearance: look }), 401);
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

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('Authorization') || '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (await passwordMatches(token, env.APP_PASSWORD)) return true;
  }

  const token = parseCookies(request).get(SESSION_COOKIE);
  return verifySession(token, env);
}

async function isShareTokenAuthorized(request: Request, env: Env): Promise<boolean> {
  if (!env.SHARE_TOKEN) return false;
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return false;
  return passwordMatches(header.slice(7).trim(), env.SHARE_TOKEN);
}

async function passwordMatches(input: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256Hex(input), sha256Hex(expected)]);
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}

function sessionSecret(env: Env): string {
  return env.APP_SECRET || env.APP_PASSWORD;
}

async function createSession(env: Env): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = `v1.${expires}`;
  const signature = await hmac(payload, sessionSecret(env));
  return `${payload}.${signature}`;
}

async function verifySession(token: string | null | undefined, env: Env): Promise<boolean> {
  if (!token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;

  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;

  const expected = await hmac(`v1.${expires}`, sessionSecret(env));
  return timingSafeEqual(parts[2], expected);
}

async function hmac(payload: string, secret: string): Promise<string> {
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

function base64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function timingSafeEqual(a: unknown, b: unknown): boolean {
  const left = String(a);
  const right = String(b);
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}

function safeNext(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

/** A local path from a form field, never an absolute redirect. */
function safeReturn(value: unknown, fallback = '/'): string {
  const text = String(value ?? '');
  return text.startsWith('/') && !text.startsWith('//') ? text : fallback;
}

function withNotice(path: string, notice: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}notice=${encodeURIComponent(notice)}`;
}

function parseView(value: string | null): 'active' | 'archived' {
  return value === 'archived' ? 'archived' : 'active';
}

/** Home is the flat latest-first list; `layout=folders` opens the topic grid. */
function parseLayout(value: string | null): 'folders' | 'saves' {
  return value === 'folders' ? 'folders' : 'saves';
}

/** `YYYY-MM-DD`, or null for anything that is not a real day. */
function parseDay(value: string | null): string | null {
  const day = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === day ? day : null;
}

function parseListView(value: string | null): ArchiveView {
  return value === 'archived' || value === 'all' ? value : 'active';
}

function parseLang(value: string | null, fallback: SummaryLanguage = 'tr'): SummaryLanguage {
  if (value === 'en' || value === 'tr') return value;
  return fallback;
}

function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error.';
}

/** An Error carrying the HTTP status of a failed Durable Object call. */
interface StatusError extends Error {
  status?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorStatus(error: unknown, fallback: number): number {
  if (isRecord(error)) {
    const status = error.status;
    if (typeof status === 'number' && status > 0) return status;
  }
  return fallback;
}
