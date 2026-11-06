const X_HOSTS = new Set([
  'x.com',
  'twitter.com',
  'fxtwitter.com',
  'vxtwitter.com',
  'fixupx.com',
  'twittpr.com',
]);

export class XReadError extends Error {
  constructor(message, code = 'READ_FAILED', status = 502) {
    super(message);
    this.name = 'XReadError';
    this.code = code;
    this.status = status;
  }
}

export function parseXUrl(input) {
  if (!input) return null;

  let value = String(input).trim();
  value = value.replace(/^[<("'\[]+/, '').replace(/[>)"'\],.;!?]+$/, '');

  if (!/^https?:\/\//i.test(value)) {
    if (/^(?:www\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|twittpr)\.com\//i.test(value)) {
      value = `https://${value}`;
    } else {
      return null;
    }
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const host = url.hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/^(?:mobile|m)\./, '');

  if (!X_HOSTS.has(host)) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const statusIndex = segments.findIndex(segment => segment === 'status' || segment === 'statuses');
  if (statusIndex < 1) return null;

  const tweetId = segments[statusIndex + 1];
  if (!tweetId || !/^\d{1,25}$/.test(tweetId)) return null;

  const rawUsername = segments[0];
  const username =
    rawUsername && rawUsername !== 'i' && rawUsername !== 'web' && /^[A-Za-z0-9_]{1,15}$/.test(rawUsername)
      ? rawUsername
      : null;

  return {
    tweetId,
    username,
    canonicalUrl: username
      ? `https://x.com/${username}/status/${tweetId}`
      : `https://x.com/i/status/${tweetId}`,
  };
}

export function extractXUrl(input) {
  const direct = parseXUrl(input);
  if (direct) return direct;

  const value = String(input ?? '');
  const urlMatches = value.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  for (const match of urlMatches) {
    const parsed = parseXUrl(match);
    if (parsed) return parsed;
  }

  for (const token of value.split(/\s+/)) {
    const parsed = parseXUrl(token);
    if (parsed) return parsed;
  }

  return null;
}

export async function readPost(input, env = {}) {
  const parsed = typeof input === 'string' ? extractXUrl(input) : input;
  if (!parsed?.tweetId) {
    throw new XReadError(
      'That does not look like an X post link.',
      'INVALID_URL',
      400,
    );
  }

  const requestedProvider = String(env.X_PROVIDER || 'auto').toLowerCase();
  const providers = [];

  if (requestedProvider !== 'fxtwitter') {
    if (env.X_BEARER_TOKEN) providers.push('official');
    else if (requestedProvider === 'official') {
      throw new XReadError(
        'X_PROVIDER=official is set, but X_BEARER_TOKEN is missing.',
        'NO_TOKEN',
        500,
      );
    }
  }

  if (requestedProvider !== 'official') providers.push('fxtwitter');

  const failures = [];
  for (const provider of providers) {
    try {
      if (provider === 'official') {
        return await readOfficial(parsed, env);
      }
      return await readFxTwitter(parsed, env);
    } catch (error) {
      failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const detail = failures.length ? ` (${failures.join('; ')})` : '';
  throw new XReadError(
    `Could not read this X post. It may be private, deleted, age-restricted, or temporarily unavailable.${detail}`,
    'READ_FAILED',
    502,
  );
}

async function readFxTwitter(parsed, env) {
  const base = (env.FX_API_BASE || 'https://api.fxtwitter.com').replace(/\/+$/, '');
  const payload = await fetchJson(
    `${base}/2/status/${parsed.tweetId}`,
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'XBookmarkVault/1.0',
      },
    },
    timeoutMs(env),
  );

  const status = payload?.status ?? payload?.tweet;
  if (!status) {
    throw new XReadError('The fallback reader returned no post.', 'EMPTY_RESPONSE');
  }

  return normalizeFxStatus(status, parsed.canonicalUrl);
}

async function readOfficial(parsed, env) {
  const base = (env.X_API_BASE || 'https://api.x.com').replace(/\/+$/, '');
  const endpoint = new URL(`${base}/2/tweets/${parsed.tweetId}`);
  endpoint.searchParams.set(
    'expansions',
    'author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id',
  );
  endpoint.searchParams.set(
    'tweet.fields',
    'created_at,text,note_tweet,lang,public_metrics,attachments,referenced_tweets,author_id',
  );
  endpoint.searchParams.set(
    'media.fields',
    'type,url,preview_image_url,alt_text,width,height,duration_ms,variants',
  );
  endpoint.searchParams.set('user.fields', 'name,username,profile_image_url,verified,verified_type');

  const payload = await fetchJson(
    endpoint.toString(),
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${env.X_BEARER_TOKEN}`,
        'User-Agent': 'XBookmarkVault/1.0',
      },
    },
    timeoutMs(env),
  );

  if (!payload?.data) {
    throw new XReadError('The official X API returned no post.', 'EMPTY_RESPONSE');
  }

  return normalizeOfficialResponse(payload, parsed.canonicalUrl);
}

function timeoutMs(env) {
  const value = Number(env.REQUEST_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 20_000;
}

async function fetchJson(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();

    let payload = null;
    try {
      payload = body ? JSON.parse(body) : null;
    } catch {
      throw new XReadError(`Upstream returned non-JSON (HTTP ${response.status}).`, 'BAD_UPSTREAM');
    }

    if (!response.ok) {
      const status = response.status;
      const message =
        status === 404
          ? 'Post not found.'
          : status === 401 || status === 403
            ? 'Reader rejected the request.'
            : status === 429
              ? 'Reader rate limit reached.'
              : `Reader returned HTTP ${status}.`;
      throw new XReadError(message, status === 404 ? 'NOT_FOUND' : 'UPSTREAM_ERROR', status);
    }

    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new XReadError('The reader timed out.', 'TIMEOUT', 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeFxStatus(status, fallbackUrl) {
  const author = status.author ?? null;
  const media = normalizeFxMedia(status.media);

  return {
    tweetId: String(status.id),
    url: status.url || fallbackUrl,
    text: String(status.note_tweet?.text ?? status.text ?? status.raw_text?.text ?? ''),
    createdAt: toIso(status.created_at, status.created_timestamp),
    lang: status.lang ?? null,
    isNoteTweet: Boolean(status.is_note_tweet),
    provider: 'fxtwitter',
    author: author
      ? {
          name: author.name ?? null,
          username: author.screen_name ?? null,
          avatarUrl: author.avatar_url ?? null,
          verified: Boolean(author.verification?.verified),
        }
      : null,
    metrics: {
      replies: numberOrNull(status.replies),
      reposts: numberOrNull(status.reposts),
      likes: numberOrNull(status.likes),
      quotes: numberOrNull(status.quotes),
      views: numberOrNull(status.views),
      bookmarks: numberOrNull(status.bookmarks),
    },
    media,
    article: normalizeFxArticle(status.article),
    quote:
      status.quote && status.quote.type !== 'tombstone'
        ? normalizeFxStatus(status.quote, status.quote.url || null)
        : null,
  };
}

function normalizeFxArticle(article) {
  if (!article || typeof article !== 'object') return null;

  const blocks = article.content?.blocks ?? [];
  const text = blocks
    .map(block => {
      const value = String(block?.text ?? '').trim();
      if (!value) return '';
      switch (block.type) {
        case 'header-one':
          return `# ${value}`;
        case 'header-two':
          return `## ${value}`;
        case 'header-three':
          return `### ${value}`;
        case 'unordered-list-item':
          return `- ${value}`;
        case 'ordered-list-item':
          return `1. ${value}`;
        case 'blockquote':
          return `> ${value}`;
        case 'code-block':
          return `\`\`\`\n${value}\n\`\`\``;
        default:
          return value;
      }
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 50_000);

  return {
    id: article.id ? String(article.id) : null,
    title: String(article.title ?? ''),
    previewText: String(article.preview_text ?? ''),
    createdAt: article.created_at ?? null,
    modifiedAt: article.modified_at ?? null,
    url: article.id ? `https://x.com/i/article/${article.id}` : null,
    coverUrl: article.cover_media?.media_info?.original_img_url ?? null,
    text,
  };
}

function normalizeFxMedia(media) {
  const list = media?.all ?? [
    ...(media?.photos ?? []),
    ...(media?.videos ?? []),
  ];

  return list.flatMap(item => {
    const mapped = mapFxMedia(item);
    return mapped ? [mapped] : [];
  });
}

function mapFxMedia(item) {
  if (!item || typeof item !== 'object') return null;

  let type = item.type === 'gif' ? 'gif' : item.type === 'video' ? 'video' : 'photo';
  let url = item.url ?? null;

  if (type === 'video' && !url) {
    const mp4 = [...(item.formats ?? [])]
      .filter(format => format.container === 'mp4' && format.url)
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
    url = mp4?.url ?? null;
  }

  if (!url) return null;

  return {
    type,
    url,
    posterUrl: item.thumbnail_url ?? null,
    width: numberOrNull(item.width),
    height: numberOrNull(item.height),
    altText: item.altText ?? item.alt_text ?? null,
    durationMs: item.duration ? Math.round(item.duration * 1000) : null,
    variants: Array.isArray(item.formats)
      ? item.formats.map(format => ({
          url: format.url ?? null,
          container: format.container ?? null,
          bitrate: numberOrNull(format.bitrate),
        }))
      : [],
  };
}

export function normalizeOfficialResponse(payload, fallbackUrl) {
  const users = new Map((payload.includes?.users ?? []).map(user => [String(user.id), user]));
  const media = new Map((payload.includes?.media ?? []).map(item => [item.media_key, item]));
  const tweets = new Map((payload.includes?.tweets ?? []).map(tweet => [String(tweet.id), tweet]));

  return normalizeOfficialTweet(payload.data, { users, media, tweets }, fallbackUrl);
}

function normalizeOfficialTweet(tweet, maps, fallbackUrl) {
  const author = maps.users.get(String(tweet.author_id)) ?? null;
  const keys = tweet.attachments?.media_keys ?? [];
  const quoteRef = tweet.referenced_tweets?.find(reference => reference.type === 'quoted');
  const quotedTweet = quoteRef ? maps.tweets.get(String(quoteRef.id)) : null;

  return {
    tweetId: String(tweet.id),
    url: author?.username
      ? `https://x.com/${author.username}/status/${tweet.id}`
      : fallbackUrl,
    text: String(tweet.note_tweet?.text ?? tweet.text ?? ''),
    createdAt: tweet.created_at ? new Date(tweet.created_at).toISOString() : null,
    lang: tweet.lang ?? null,
    isNoteTweet: Boolean(tweet.note_tweet),
    provider: 'official',
    author: author
      ? {
          name: author.name ?? null,
          username: author.username ?? null,
          avatarUrl: author.profile_image_url ?? null,
          verified: Boolean(author.verified || author.verified_type),
        }
      : null,
    metrics: {
      replies: numberOrNull(tweet.public_metrics?.reply_count),
      reposts: numberOrNull(tweet.public_metrics?.retweet_count),
      likes: numberOrNull(tweet.public_metrics?.like_count),
      quotes: numberOrNull(tweet.public_metrics?.quote_count),
      views: numberOrNull(tweet.public_metrics?.impression_count),
      bookmarks: numberOrNull(tweet.public_metrics?.bookmark_count),
    },
    media: keys.flatMap(key => {
      const mapped = mapOfficialMedia(maps.media.get(key));
      return mapped ? [mapped] : [];
    }),
    quote: quotedTweet ? normalizeOfficialTweet(quotedTweet, maps, quotedTweetUrl(quotedTweet)) : null,
  };
}

function quotedTweetUrl(tweet) {
  return `https://x.com/i/status/${tweet.id}`;
}

function mapOfficialMedia(item) {
  if (!item) return null;

  const type = item.type === 'animated_gif' ? 'gif' : item.type === 'video' ? 'video' : 'photo';
  let url = item.url ?? null;

  if (type !== 'photo') {
    const mp4 = [...(item.variants ?? [])]
      .filter(variant => variant.content_type === 'video/mp4' && variant.url)
      .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0];
    url = mp4?.url ?? url;
  }

  if (!url) return null;

  return {
    type,
    url,
    posterUrl: item.preview_image_url ?? null,
    width: numberOrNull(item.width),
    height: numberOrNull(item.height),
    altText: item.alt_text ?? null,
    durationMs: numberOrNull(item.duration_ms),
    variants: (item.variants ?? []).map(variant => ({
      url: variant.url ?? null,
      container: variant.content_type ?? null,
      bitrate: numberOrNull(variant.bit_rate),
    })),
  };
}

export function collectImages(post, max = 6) {
  const candidates = [];
  const seen = new Set();

  const add = (item, label) => {
    if (!item) return;
    const url = item.type === 'video' || item.type === 'gif' ? item.posterUrl : item.url;
    if (!url || seen.has(url)) return;
    if (!/^https?:\/\//i.test(url)) return;
    seen.add(url);
    candidates.push({
      url,
      altText: item.altText ?? null,
      label,
      type: item.type,
    });
  };

  for (const item of post.media ?? []) add(item, 'main post');
  if (post.article?.coverUrl) {
    add({ type: 'photo', url: post.article.coverUrl, altText: post.article.title }, 'article cover');
  }
  for (const item of post.quote?.media ?? []) add(item, 'quoted post');

  return candidates.slice(0, max);
}

function toIso(dateString, timestampSeconds) {
  if (dateString) {
    const date = new Date(dateString);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (Number.isFinite(timestampSeconds)) {
    const date = new Date(timestampSeconds * 1000);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
