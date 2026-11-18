import type { XPost } from './types.ts';
import { htmlToText } from './links.ts';

export class InstagramReadError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = 'READ_FAILED', status = 502) {
    super(message);
    this.name = 'InstagramReadError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Instagram answers a browser with a login shell and a link-preview crawler
 * with the post itself, so the reader has to look like the crawler.
 */
const USER_AGENT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const POST_TYPES = new Set(['p', 'reel', 'tv']);

export interface ParsedInstagramUrl {
  id: string;
  username: string | null;
  canonicalUrl: string;
}

export function parseInstagramUrl(input: string): ParsedInstagramUrl | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'instagram.com') return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const kind = segments.findIndex(segment => POST_TYPES.has(segment.toLowerCase()));
  const code = segments[kind + 1] ?? '';
  if (kind === -1 || !/^[A-Za-z0-9_-]+$/.test(code)) return null;

  const account = kind > 0 ? segments[0].replace(/^@/, '') : '';
  return {
    id: `ig${code}`,
    username: account && !POST_TYPES.has(account.toLowerCase()) ? account : null,
    canonicalUrl: `https://www.instagram.com/p/${code}/`,
  };
}

export async function readInstagramPost(input: string): Promise<XPost> {
  const parsed = parseInstagramUrl(input);
  if (!parsed) {
    throw new InstagramReadError('That does not look like an Instagram post link.', 'INVALID_URL', 400);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(parsed.canonicalUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
    });
    if (!response.ok) return emptyPost(parsed);

    const html = (await response.text()).slice(0, 2_000_000);
    const loginWall =
      /\/(accounts\/(login|signup)|challenge)\b/i.test(response.url) ||
      /<title[^>]*>\s*(?:log ?in|sign ?up)\b/i.test(html);
    if (loginWall) return emptyPost(parsed);

    const title = metaContent(html, 'og:title');
    if (!title) return emptyPost(parsed);

    const parsedTitle = splitTitle(title);
    const username =
      parsed.username ||
      parsedTitle.username ||
      accountFromUrl(metaContent(html, 'og:url'));
    if (!parsedTitle.name && !parsedTitle.caption && !username) return emptyPost(parsed);

    const name = parsedTitle.name || username || '';
    return {
      ...emptyPost(parsed),
      text: parsedTitle.caption,
      author: name ? { name, username, avatarUrl: null, verified: false } : null,
    };
  } catch {
    return emptyPost(parsed);
  } finally {
    clearTimeout(timer);
  }
}

function emptyPost(parsed: ParsedInstagramUrl): XPost {
  return {
    tweetId: parsed.id, url: parsed.canonicalUrl, text: '', createdAt: null, lang: null,
    isNoteTweet: false, provider: 'instagram', author: null, media: [],
    metrics: { replies: null, reposts: null, likes: null, quotes: null, views: null, bookmarks: null },
    quote: null, article: null,
  };
}

/**
 * `og:title` reads `<author> on Instagram: "<caption>"`; a post with no caption
 * drops the colon and the quotes, and `<name> (@handle)` lifts out the handle.
 */
function splitTitle(title: string): { name: string; username: string | null; caption: string } {
  const match = title.match(/^(.*?)\s+on Instagram\s*:\s*([\s\S]*)$/i);
  if (!match) {
    const bare = title.match(/^(.*?)\s+on Instagram\s*$/i);
    return { name: bare?.[1].trim() ?? '', username: null, caption: '' };
  }
  const handle = match[1].match(/\(@([^)]+)\)\s*$/)?.[1] ?? null;
  const name = match[1].replace(/\s*\(@[^)]*\)\s*$/, '').trim();
  const caption = match[2].trim().replace(/^["“]/, '').replace(/["”]$/, '').trim();
  return { name, username: handle, caption };
}

/** The account Instagram put in `og:url`, which may be `/p/<code>/` instead. */
function accountFromUrl(value: string): string | null {
  if (!value) return null;
  try {
    const account = new URL(value).pathname.split('/').filter(Boolean)[0] ?? '';
    return account && !POST_TYPES.has(account.toLowerCase()) && account !== 'accounts'
      ? account
      : null;
  } catch {
    return null;
  }
}

function metaContent(html: string, name: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag.match(/(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (key?.toLowerCase() !== name.toLowerCase()) continue;
    const content = tag.match(/content\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];
    if (content) return htmlToText(content);
  }
  return '';
}
