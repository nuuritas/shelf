import type { MediaItem, XPost } from './types.ts';
import { htmlToText } from './links.ts';
import { safeHttpUrl } from './util.ts';

export class LinkedInReadError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = 'READ_FAILED', status = 502) {
    super(message);
    this.name = 'LinkedInReadError';
    this.code = code;
    this.status = status;
  }
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface ParsedLinkedInUrl {
  id: string;
  activityId: string;
  canonicalUrl: string;
}

export function parseLinkedInUrl(input: string): ParsedLinkedInUrl | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'linkedin.com') return null;

  const activityId =
    url.pathname.match(/\/feed\/update\/urn:li:activity:(\d+)/i)?.[1] ??
    url.pathname.match(/(?:^|[-/])activity-(\d+)(?:-[^/]+)?\/?$/i)?.[1];
  if (!activityId) return null;

  return {
    id: `li${activityId}`,
    activityId,
    canonicalUrl: `https://www.linkedin.com${url.pathname.replace(/\/+$/, '')}`,
  };
}

export async function readLinkedInPost(input: string): Promise<XPost> {
  const parsed = parseLinkedInUrl(input);
  if (!parsed) {
    throw new LinkedInReadError('That does not look like a LinkedIn post link.', 'INVALID_URL', 400);
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
      /\/(authwall|checkpoint|login)\b/i.test(response.url) ||
      /<title[^>]*>[^<]*\b(log ?in|sign ?up)\b/i.test(html);
    if (loginWall) return emptyPost(parsed);

    const text = postText(html);
    if (!text) return emptyPost(parsed);

    const title = metaContent(html, 'og:title');
    const name = metaContent(html, 'author') || title.match(/^(.+?)\s+on LinkedIn\b/i)?.[1]?.trim();
    const image = safeHttpUrl(metaContent(html, 'og:image'));
    const media: MediaItem[] = image
      ? [{ type: 'photo', url: image, posterUrl: null, width: null, height: null, altText: null, durationMs: null, variants: [] }]
      : [];
    return {
      ...emptyPost(parsed),
      url: canonicalFromPage(html) || parsed.canonicalUrl,
      text,
      author: name ? { name, username: null, avatarUrl: null, verified: false } : null,
      media,
    };
  } catch {
    return emptyPost(parsed);
  } finally {
    clearTimeout(timer);
  }
}

function emptyPost(parsed: ParsedLinkedInUrl): XPost {
  return {
    tweetId: parsed.id, url: parsed.canonicalUrl, text: '', createdAt: null, lang: null,
    isNoteTweet: false, provider: 'linkedin', author: null, media: [],
    metrics: { replies: null, reposts: null, likes: null, quotes: null, views: null, bookmarks: null },
    quote: null, article: null,
  };
}

function postText(html: string): string {
  const container =
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  const text = container ? htmlToText(container) : '';
  return text || metaContent(html, 'og:description') || metaContent(html, 'description');
}

function metaContent(html: string, name: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag.match(/(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (key?.toLowerCase() !== name.toLowerCase()) continue;
    const content = tag.match(/content\s*=\s*["']([\s\S]*?)["']/i)?.[1];
    if (content) return htmlToText(content);
  }
  return '';
}

function canonicalFromPage(html: string): string {
  const link = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0];
  const href = link?.match(/href=["']([^"']+)["']/i)?.[1];
  return safeHttpUrl(metaContent(html, 'og:url')) || safeHttpUrl(href || '') || '';
}
