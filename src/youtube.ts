import type { Author, Env, MediaItem, XPost } from './types.ts';
import { youtubeVideoId } from './transcript.ts';

export interface ParsedYouTubeUrl {
  videoId: string;
  canonicalUrl: string;
}

const CANONICAL = 'https://www.youtube.com/watch?v=';
const USER_AGENT = 'Shelf/1.0';

export class YouTubeReadError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = 'READ_FAILED', status = 502) {
    super(message);
    this.name = 'YouTubeReadError';
    this.code = code;
    this.status = status;
  }
}

/**
 * A YouTube video URL in any of the shapes a share sheet produces:
 * watch?v=, youtu.be/<id>, shorts, live, embed. Tracking parameters such as
 * `?si=` are ignored.
 */
export function parseYouTubeUrl(input: unknown): ParsedYouTubeUrl | null {
  if (!input) return null;

  let value = String(input).trim();
  value = value.replace(/^[<("'\[]+/, '').replace(/[>)"'\],.;!?]+$/, '');

  if (!/^https?:\/\//i.test(value)) {
    if (/^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(value)) {
      value = `https://${value}`;
    } else {
      return null;
    }
  }

  const videoId = youtubeVideoId(value);
  if (!videoId) return null;

  return { videoId, canonicalUrl: `${CANONICAL}${videoId}` };
}

interface OEmbed {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}

/**
 * Read a public video the same way the LinkedIn reader reads a guest page: from
 * what YouTube serves without an account. oEmbed gives the title, channel and
 * thumbnail; the watch page adds the description and upload date. Neither is
 * guaranteed, so a private or deleted video still saves with what is available.
 */
export async function readYouTubePost(
  input: string | ParsedYouTubeUrl | null | undefined,
  _env: Partial<Env> = {},
): Promise<XPost> {
  const parsed = typeof input === 'string' ? parseYouTubeUrl(input) : input;
  if (!parsed) {
    throw new YouTubeReadError('That does not look like a YouTube video link.', 'INVALID_URL', 400);
  }

  const [oembed, page] = await Promise.all([
    fetchOEmbed(parsed.canonicalUrl),
    fetchPage(parsed.canonicalUrl),
  ]);

  const title = oembed?.title?.trim() || meta(page, 'title')?.trim() || '';
  const channel = oembed?.author_name?.trim() || null;
  const description =
    meta(page, 'og:description')?.trim() ||
    meta(page, 'description')?.trim() ||
    '';
  const createdAt = datePublished(page);
  const thumbnail =
    oembed?.thumbnail_url?.trim() || `https://i.ytimg.com/vi/${parsed.videoId}/hqdefault.jpg`;

  const author: Author | null = channel
    ? { name: channel, username: null, avatarUrl: null, verified: false }
    : null;

  const media: MediaItem[] = thumbnail
    ? [
        {
          type: 'photo',
          url: thumbnail,
          posterUrl: null,
          width: null,
          height: null,
          altText: title || null,
          durationMs: null,
          variants: [],
        },
      ]
    : [];

  return {
    tweetId: `yt${parsed.videoId}`,
    url: parsed.canonicalUrl,
    text: description || title,
    createdAt,
    lang: null,
    isNoteTweet: false,
    provider: 'youtube',
    author,
    media,
    metrics: {
      replies: null,
      reposts: null,
      likes: null,
      quotes: null,
      views: null,
      bookmarks: null,
    },
    quote: null,
    article: null,
  };
}

async function fetchOEmbed(canonicalUrl: string): Promise<OEmbed | null> {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as OEmbed;
  } catch {
    return null;
  }
}

async function fetchPage(canonicalUrl: string): Promise<string | null> {
  try {
    const response = await fetch(canonicalUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/** Content of a meta tag, matched by `property` or `name`. */
function meta(html: string | null, key: string): string | null {
  if (!html) return null;
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'i',
  );
  const tag = html.match(pattern)?.[0];
  if (!tag) return null;
  const content = tag.match(/content\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];
  if (!content) return null;
  return decodeEntities(content);
}

/** Upload date from the watch page, as an ISO string when one is present. */
function datePublished(html: string | null): string | null {
  if (!html) return null;
  const match =
    html.match(/"uploadDate"\s*:\s*"([^"]+)"/)?.[1] ||
    html.match(/<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    null;
  if (!match) return null;
  const date = new Date(match);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
