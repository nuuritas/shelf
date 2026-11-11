import type { Env, LinkRead, ParsedGitHubUrl } from './types.ts';
import { isAbortError } from './util.ts';

const SKIP_HOSTS = new Set([
  'x.com',
  'twitter.com',
  'pbs.twimg.com',
  'video.twimg.com',
  'pic.x.com',
  'abs.twimg.com',
]);

const MAX_LINKS = 2;
const MAX_TEXT = 25_000;
const MAX_HTML = 2_000_000;

/** The parts of a post this module reads links out of. */
interface LinkPost {
  text?: string | null;
  quote?: { text?: string | null } | null;
}

interface GitHubRepoMeta {
  full_name?: string | null;
  description?: string | null;
  topics?: string[] | null;
  language?: string | null;
  stargazers_count?: number;
  license?: { spdx_id?: string | null } | null;
  created_at?: string | null;
}

export function extractExternalUrls(post: LinkPost | null): string[] {
  const text = [post?.text, post?.quote?.text].filter(Boolean).join('\n');
  const matches = text.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const value = match.replace(/[),.;:!?]+$/, '');
    let host: string;
    try {
      host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      continue;
    }

    if (SKIP_HOSTS.has(host)) continue;
    if (host === 't.co') {
      // Resolved later; keep it out of normal deduplication.
    }

    if (seen.has(value)) continue;
    seen.add(value);
    urls.push(value);
    if (urls.length >= MAX_LINKS) break;
  }

  return urls;
}

export async function readExternalLinks(
  post: LinkPost,
  env: Partial<Env> = {},
): Promise<LinkRead[]> {
  const urls = extractExternalUrls(post);
  if (!urls.length) return [];

  const results = await Promise.all(
    urls.map(async (url): Promise<LinkRead | null> => {
      try {
        return await readLink(url, env);
      } catch (error) {
        return {
          url,
          finalUrl: url,
          kind: 'web',
          title: hostnameOf(url),
          siteName: hostnameOf(url),
          description: '',
          text: '',
          error: error instanceof Error ? error.message.slice(0, 240) : 'Could not read this link.',
        };
      }
    }),
  );

  return results.filter((result): result is LinkRead => Boolean(result));
}

async function readLink(url: string, env: Partial<Env>): Promise<LinkRead | null> {
  let target = url;

  if (hostnameOf(target) === 't.co') {
    const resolved = await resolveTco(target, env);
    if (!resolved) {
      return {
        url,
        finalUrl: url,
        kind: 'web',
        title: 't.co link',
        siteName: 't.co',
        description: '',
        text: '',
        error: 'Could not resolve the shortened link.',
      };
    }
    target = resolved;
    if (SKIP_HOSTS.has(hostnameOf(target))) return null;
  }

  if (isBlockedHost(hostnameOf(target))) {
    throw new Error('This host is not allowed.');
  }

  const github = parseGitHubUrl(target);
  if (github) return readGitHub(github, target, env);

  try {
    return await readWebPage(target, env);
  } catch (error) {
    // Keep the resolved target: a t.co link that points at YouTube still has
    // to be recognisable as YouTube after the page read fails.
    return {
      url,
      finalUrl: target,
      kind: 'web',
      title: hostnameOf(target),
      siteName: hostnameOf(target),
      description: '',
      text: '',
      error: error instanceof Error ? error.message.slice(0, 240) : 'Could not read this link.',
    };
  }
}

export function parseGitHubUrl(input: string): ParsedGitHubUrl | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'github.com') return null;

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  if (['features', 'topics', 'marketplace', 'login', 'signup', 'sponsors'].includes(segments[0])) {
    return null;
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;

  return {
    owner,
    repo,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
    apiUrl: `https://api.github.com/repos/${owner}/${repo}`,
  };
}

async function readGitHub(
  repo: ParsedGitHubUrl,
  originalUrl: string,
  env: Partial<Env>,
): Promise<LinkRead> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Shelf/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  let meta: GitHubRepoMeta | null = null;
  try {
    meta = await fetchJson<GitHubRepoMeta>(repo.apiUrl, { headers }, env);
  } catch {
    // The API can be rate-limited from shared Cloudflare egress.
  }

  let readme = '';
  try {
    const response = await request(
      `${repo.apiUrl}/readme`,
      {
        headers: {
          ...headers,
          Accept: 'application/vnd.github.raw',
        },
      },
      timeout(env),
    );
    if (response.ok) readme = await response.text();
  } catch {
    // Fall through to raw.githubusercontent.com.
  }

  if (!readme) {
    try {
      const response = await request(
        `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/README.md`,
        { headers: { 'User-Agent': 'Shelf/1.0' } },
        timeout(env),
      );
      if (response.ok) readme = await response.text();
    } catch {
      // The summary can still use metadata.
    }
  }

  if (!meta && !readme) {
    return readWebPage(originalUrl, env);
  }

  const title = meta?.full_name || `${repo.owner}/${repo.repo}`;
  const description = meta?.description || '';
  const topics = Array.isArray(meta?.topics) ? meta.topics.slice(0, 8).join(', ') : '';
  const facts = [
    `Repository: ${title}`,
    description ? `Description: ${description}` : '',
    meta?.language ? `Primary language: ${meta.language}` : '',
    typeof meta?.stargazers_count === 'number' ? `Stars: ${meta.stargazers_count}` : '',
    meta?.license?.spdx_id ? `License: ${meta.license.spdx_id}` : '',
    topics ? `Topics: ${topics}` : '',
    typeof meta?.created_at === 'string' ? `Created: ${meta.created_at.slice(0, 10)}` : '',
  ].filter(Boolean);

  return {
    url: originalUrl,
    finalUrl: repo.canonicalUrl,
    kind: 'github',
    title,
    siteName: 'GitHub',
    description,
    text: `${facts.join('\n')}\n\nREADME:\n${readme.slice(0, MAX_TEXT)}`.slice(0, MAX_TEXT + 1000),
    publishedAt: meta?.created_at ?? null,
  };
}

async function readWebPage(url: string, env: Partial<Env>): Promise<LinkRead> {
  const response = await request(
    url,
    {
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
        'User-Agent': 'Shelf/1.0 (+link reader)',
      },
    },
    timeout(env),
  );

  if (!response.ok) {
    throw new Error(`Page returned HTTP ${response.status}.`);
  }

  const finalUrl = response.url || url;
  if (isBlockedHost(hostnameOf(finalUrl))) {
    throw new Error('This host is not allowed.');
  }

  const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
    throw new Error('This link is not an HTML page.');
  }

  const raw = await response.text();
  if (contentType.includes('text/plain')) {
    return {
      url,
      finalUrl,
      kind: 'web',
      title: new URL(finalUrl).hostname,
      siteName: new URL(finalUrl).hostname,
      description: '',
      text: raw.slice(0, MAX_TEXT),
    };
  }

  const html = raw.slice(0, MAX_HTML);
  const title = metaContent(html, 'og:title') || titleTag(html) || hostnameOf(finalUrl);
  const description =
    metaContent(html, 'og:description') ||
    metaContent(html, 'description') ||
    metaContent(html, 'twitter:description');
  const siteName = metaContent(html, 'og:site_name') || hostnameOf(finalUrl);
  const publishedAt =
    metaContent(html, 'article:published_time') || metaContent(html, 'datePublished') || null;
  const articleHtml = extractMainHtml(html);
  const text = htmlToText(articleHtml).slice(0, MAX_TEXT);

  if (!text && !description) {
    throw new Error('Could not extract readable text from this page.');
  }

  return {
    url,
    finalUrl,
    kind: 'web',
    title: cleanTitle(title),
    siteName,
    description: description.slice(0, 500),
    text: text.length >= 200 ? text : description.slice(0, MAX_TEXT),
    publishedAt,
  };
}

async function resolveTco(url: string, env: Partial<Env>): Promise<string | null> {
  try {
    const getResponse = await request(
      url,
      {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'Shelf/1.0' },
      },
      Math.min(timeout(env), 10_000),
    );
    if (getResponse.url && !getResponse.url.includes('t.co/')) return getResponse.url;
  } catch {
    // Ignore and return null below.
  }
  return null;
}

function extractMainHtml(html: string): string {
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map(match => match[1]);
  if (articles.length) {
    return articles.sort((a, b) => b.length - a.length)[0];
  }

  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (main) return main;

  return html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html;
}

export function htmlToText(html: unknown): string {
  let value = String(html ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, ' ')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|blockquote|tr|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  value = decodeHtmlEntities(value)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return value;
}

function titleTag(html: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
}

function metaContent(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tags = html.match(new RegExp(`<meta\\b[^>]*>`, 'gi')) ?? [];
  for (const tag of tags) {
    const key = tag.match(/(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (key?.toLowerCase() !== name.toLowerCase()) continue;
    const content = tag.match(/content\s*=\s*["']([\s\S]*?)["']/i)?.[1];
    if (content) return decodeHtmlEntities(content).replace(/\s+/g, ' ').trim();
  }
  return '';
}

function cleanTitle(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/\s*[|–—]\s*[^|–—]{1,40}$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function decodeHtmlEntities(value: unknown): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    copy: '©',
    reg: '®',
  };

  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => safeCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isBlockedHost(host: string): boolean {
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.local') || host === '0.0.0.0') return true;
  if (host === '::1' || host === '[::1]') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

async function fetchJson<T>(url: string, options: RequestInit, env: Partial<Env>): Promise<T> {
  const response = await request(url, options, timeout(env));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function request(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (isAbortError(error)) throw new Error('The link timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function timeout(env: Partial<Env>): number {
  const value = Number(env.LINK_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 12_000;
}
