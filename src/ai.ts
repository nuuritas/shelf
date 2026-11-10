import type {
  Bookmark,
  BootstrapItem,
  BootstrapTopic,
  ChatCompletionResponse,
  ChatImagePart,
  ChatMessage,
  ChatRequest,
  ChatTextPart,
  ClassifiedTopic,
  ClassifyInput,
  ClassifyResult,
  Env,
  SummaryResult,
  TopicOverviewInput,
} from './types.ts';
import { arrayBufferToBase64, isAbortError, slugify, truncate } from './util.ts';
import { collectImages } from './x.ts';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/* The gateway answers 429/5xx while a model is briefly busy. Waiting a few
   seconds is worth far more than a dead card, so those answers and fetch
   network failures are retried. An abort means the attempt already used its
   whole timeout budget, so it is reported instead of retried. */
const AI_TIMEOUT_MS = 180_000;
const AI_RETRY_DELAYS_MS = [1_000, 3_000];
const AI_RETRY_AFTER_MAX_MS = 15_000;
const AI_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export function isAiConfigured(env: Partial<Env>): boolean {
  return Boolean(env.OPENCODE_API_KEY);
}

export interface SummaryOptions {
  instruction?: string;
  previousSummary?: string;
  session?: string;
}

export async function summarizePost(
  post: Bookmark,
  env: Partial<Env>,
  options: SummaryOptions = {},
): Promise<SummaryResult> {
  if (!env.OPENCODE_API_KEY) {
    throw new Error('OPENCODE_API_KEY is not configured.');
  }

  const images = collectImages(post, MAX_IMAGES);
  const imageParts: ChatImagePart[] = [];
  const imageNotes: string[] = [];

  for (const [index, image] of images.entries()) {
    try {
      const dataUrl = await imageAsDataUrl(image.url, env);
      imageParts.push({
        type: 'image_url',
        image_url: { url: dataUrl, detail: 'high' },
      });
      imageNotes.push(`Image ${index + 1} (${image.label}): attached.`);
    } catch (error) {
      imageNotes.push(
        `Image ${index + 1} (${image.label}): could not be loaded (${errorMessage(error)}).`,
      );
    }
  }

  const model = String(env.AI_MODEL || 'deepseek-v4.1-flash').replace(/^opencode-go\//, '');
  const language = String(env.SUMMARY_LANGUAGE || 'tr').toLowerCase() === 'en' ? 'English' : 'Turkish';

  const body: ChatRequest = {
    model,
    messages: [
      {
        role: 'system',
        content:
          (options.instruction
            ? `You are writing a new version of an existing explanation because the reader asked for a different angle. The existing summary is context, not a template: do not repeat it or pad it. Answer the reader's request directly and concretely, and keep the same natural, non-robotic voice. Write in ${language}. `
            : '') +
          `You are a perceptive analyst and explainer. The user saves posts and links because they want to understand what something is, the context around it, and why it matters. Write in ${language}, like a smart colleague explaining it to them. ` +
          'Start with one or two sentences: what this is and the situation or context. Then explain the central idea or argument in natural paragraphs, using concrete details and examples from the supplied content. Briefly explain jargon instead of repeating it. ' +
          'If it is a GitHub repository, explain what the project actually does, who it is for, how it works, and its notable features or maturity. If it is an article, explain its thesis, the context it responds to, and its implications. If the post itself is just a comment on a link, connect the comment to the linked content. ' +
          'Do not use headings such as "Özet", "Ana noktalar", or "Görsellerin katkısı". Do not produce a rigid bullet list or a section-by-section recap. Write 3-5 paragraphs, roughly 250-450 words, and end with one natural takeaway sentence. ' +
          'Use only the supplied content. If some content could not be read or is incomplete, say so naturally. Do not invent facts. Return plain text, not Markdown.',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildPrompt(post, imageNotes, {
              instruction: options.instruction,
              previous: options.previousSummary,
            }),
          },
          ...imageParts,
        ],
      },
    ] satisfies ChatMessage[],
    max_tokens: 4096,
    max_completion_tokens: 4096,
    reasoning_effort: 'low',
    temperature: 0.2,
    stream: false,
  };

  try {
    const response = await fetchChat(env, 'summary', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENCODE_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'XBookmarkVault/1.0',
        'x-opencode-session': options.session || `xbv-${post.tweetId}`,
      },
      body: JSON.stringify(body),
    });

    const raw = await response.text();
    let payload: ChatCompletionResponse | null = null;
    try {
      payload = raw ? (JSON.parse(raw) as ChatCompletionResponse) : null;
    } catch {
      throw new Error(`AI endpoint returned non-JSON (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const upstreamMessage =
        payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new Error(
        `AI endpoint error (HTTP ${response.status}): ${truncate(upstreamMessage, 300)}`,
      );
    }

    const content = payload?.choices?.[0]?.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter(part => part?.type === 'text')
              .map(part => part.text)
              .join('\n')
          : '';

    if (!text.trim()) {
      const finishReason = payload?.choices?.[0]?.finish_reason;
      throw new Error(
        `AI returned an empty summary${finishReason ? ` (finish: ${finishReason})` : ''}.`,
      );
    }

    return { text: text.trim(), model, imagesUsed: imageParts.length };
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error('AI summary timed out after 180 seconds.');
    }
    throw error;
  }
}

/** Translate a finished primary summary into English, preserving its shape. */
export async function translateSummary(
  summary: string,
  env: Partial<Env>,
  options: { session?: string } = {},
): Promise<SummaryResult> {
  if (!env.OPENCODE_API_KEY) {
    throw new Error('OPENCODE_API_KEY is not configured.');
  }

  const text = await requestChat(env, {
    session: options.session || 'xbv-translate-en',
    system:
      'You translate explanations for one reader\'s private reading archive. ' +
      'Translate the supplied text into natural, idiomatic English. Keep the meaning, the paragraph order, and every concrete detail. ' +
      'Leave names, product names, handles, and URLs exactly as they are. Do not add context, do not summarize, and do not comment on the translation. ' +
      'Return plain text only, no headings, no Markdown.',
    user: [
      'Translate this explanation into English.',
      '',
      '---',
      String(summary || '').slice(0, 12_000),
      '---',
    ].join('\n'),
    maxTokens: 4096,
    temperature: 0.1,
  });

  return {
    text,
    model: String(env.AI_MODEL || 'deepseek-v4.1-flash').replace(/^opencode-go\//, ''),
    imagesUsed: 0,
  };
}

function buildPrompt(
  post: Bookmark,
  imageNotes: string[],
  options: { instruction?: string; previous?: string } = {},
): string {
  const lines = [
    'Summarize this saved X post.',
    '',
    `Author: ${post.author?.name || 'unknown'} (@${post.author?.username || 'unknown'})`,
    `Post URL: ${post.url}`,
    `Post date: ${post.createdAt || 'unknown'}`,
    '',
    'MAIN POST:',
    post.text || '[no text]',
  ];

  if (post.article) {
    lines.push(
      '',
      'LINKED X ARTICLE:',
      `Title: ${post.article.title || 'untitled'}`,
      `URL: ${post.article.url || 'unknown'}`,
      String(post.article.text || '[no article text]').slice(0, 30_000),
    );
  }

  if (post.quote) {
    lines.push(
      '',
      'QUOTED POST:',
      `Author: ${post.quote.author?.name || 'unknown'} (@${post.quote.author?.username || 'unknown'})`,
      `URL: ${post.quote.url}`,
      post.quote.text || '[no text]',
    );
  }

  if (post.links?.length) {
    lines.push('', 'LINKED WEB CONTENT:');
    for (const link of post.links) {
      lines.push(
        `--- ${link.siteName || 'website'} (${link.kind || 'web'}) ---`,
        `URL: ${link.finalUrl || link.url}`,
        `Title: ${link.title || 'untitled'}`,
        link.description ? `Description: ${link.description}` : '',
        link.error
          ? `Could not be read: ${link.error}`
          : String(link.text || '').slice(0, 20_000),
      );
    }
  }

  const transcripts = (post.transcripts ?? []).filter(
    transcript => transcript.status === 'done' && transcript.text,
  );
  if (transcripts.length) {
    lines.push('', 'VIDEO TRANSCRIPTS (what was actually said):');
    for (const transcript of transcripts) {
      const minutes = transcript.durationSec
        ? `${Math.max(1, Math.round(transcript.durationSec / 60))} min`
        : 'length unknown';
      lines.push(
        `--- ${transcript.source === 'youtube' ? 'YouTube' : 'X'} video · ${
          transcript.lang || 'unknown language'
        } · ${minutes} ---`,
        transcript.text.slice(0, 24_000),
      );
    }
  }

  if (options.previous) {
    lines.push('', 'THE EXPLANATION THE READER ALREADY HAS:', String(options.previous).slice(0, 6000));
  }

  if (options.instruction) {
    lines.push(
      '',
      "THE READER'S NEW REQUEST:",
      String(options.instruction).slice(0, 600),
      '',
      'Write a new explanation of 3-5 paragraphs (roughly 250-450 words) that answers this request using the same material. Do not restate the existing explanation, do not mention that this is a new version, and do not use headings or bullet lists.',
    );
  }

  lines.push(
    '',
    'IMAGES:',
    imageNotes.length ? imageNotes.join('\n') : 'No images attached.',
    '',
    'Now explain this to the user in natural prose. Focus on: what this is, the context, what it actually says or does, the concrete details that matter, and what the user should take away. When a video transcript is present, treat it as the record of what was said and use the post text for the author’s framing. Do not just repeat the post text. Do not use a rigid summary template.',
  );

  return lines.join('\n');
}

async function imageAsDataUrl(url: string, env: Partial<Env>): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'image/png,image/jpeg,image/webp,image/gif,image/*;q=0.8',
        Referer: 'https://x.com/',
        'User-Agent': 'XBookmarkVault/1.0',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`image HTTP ${response.status}`);
    }

    const contentType = (response.headers.get('Content-Type') || 'image/jpeg').split(';')[0].trim();
    if (!contentType.startsWith('image/')) {
      throw new Error('not an image');
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('image is too large');
    }

    return `data:${contentType};base64,${arrayBufferToBase64(buffer)}`;
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? truncate(error.message, 120) : 'unknown error';
}

/* ------------------------------------------------------------------ *
 * Knowledge layer: topics, filing, and rolling syntheses.
 * ------------------------------------------------------------------ */

export const MAX_TOPICS = 9;

export async function bootstrapTopics(
  items: BootstrapItem[],
  env: Partial<Env>,
): Promise<BootstrapTopic[]> {
  if (!items.length) return [];

  const language = summaryLanguage(env);
  const lines = items.map((item, index) =>
    [
      `#${index + 1} id=${item.id}`,
      `author: ${item.author || 'unknown'}`,
      item.date ? `date: ${item.date}` : '',
      `text: ${truncate(item.text || '', 220)}`,
      `summary: ${truncate(item.summary || '', 620)}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  const wanted = items.length < 6 ? '2-4' : items.length < 15 ? '4-7' : '5-9';
  const system =
    'You are the editor of one person\'s private reading archive. You group what they saved into durable areas of interest that will still make sense months later. ' +
    `Return strict JSON only, no prose, no Markdown. Write topic names and descriptions in ${language}.`;
  const user = [
    `Here are ${items.length} saved items from this person's archive.`,
    '',
    lines.join('\n\n'),
    '',
    `Group them into ${wanted} topics.`,
    'Rules:',
    '- A topic is a lasting area of interest (a field, a debate, a craft, a project), never a format like "articles", "videos", "AI summaries" or "misc".',
    '- Names are 1-3 words, specific enough to be useful, broad enough to keep collecting into.',
    '- Descriptions are one sentence describing what this thread means for this reader.',
    '- Every item must appear in at least one topic and at most two. Do not invent ids.',
    '- If two topics would obviously merge, merge them. If one topic would swallow everything, split it.',
    '',
    'Return exactly this shape:',
    '{"topics":[{"name":"...","description":"...","items":["id1","id2"]}]}',
  ].join('\n');

  const raw = await requestChat(env, {
    session: 'xbv-topics-bootstrap',
    system,
    user,
    maxTokens: 3000,
    temperature: 0.2,
  });

  const parsed = asRecord(parseJsonReply(raw));
  const topics = Array.isArray(parsed?.topics) ? parsed.topics : [];
  const known = new Set(items.map(item => String(item.id)));
  const used = new Set<string>();

  return topics
    .map((topic): BootstrapTopic | null => {
      const record = asRecord(topic);
      const name = truncate(String(record?.name || '').trim(), 60);
      if (!name) return null;
      const ids = (Array.isArray(record?.items) ? record.items : [])
        .map(String)
        .filter(id => known.has(id) && !used.has(id));
      ids.forEach(id => used.add(id));
      return {
        slug: slugify(name),
        name,
        description: truncate(String(record?.description || '').trim(), 240),
        itemIds: ids,
      };
    })
    .filter((topic): topic is BootstrapTopic => Boolean(topic && topic.itemIds.length))
    .slice(0, MAX_TOPICS);
}

export async function classifyPost(
  { post, summary, topics }: ClassifyInput,
  env: Partial<Env>,
): Promise<ClassifyResult> {
  const language = summaryLanguage(env);
  const existing = topics.length
    ? topics.map(topic => `- ${topic.slug}: ${topic.name} — ${topic.description || ''}`).join('\n')
    : '(the archive has no topics yet)';

  const system =
    'You file one saved item into an existing personal topic taxonomy. ' +
    `Return strict JSON only, no prose, no Markdown. Names and descriptions must be in ${language}.`;
  const user = [
    'EXISTING TOPICS:',
    existing,
    '',
    'ITEM:',
    `author: ${post.author?.name || 'unknown'} (@${post.author?.username || 'unknown'})`,
    `text: ${truncate(post.text || '', 600)}`,
    `summary: ${truncate(summary || '', 1400)}`,
    post.links?.length ? `links: ${post.links.map(link => link.finalUrl || link.url).join(', ')}` : '',
    '',
    'File this item.',
    'Rules:',
    '- Choose 1-3 existing topic slugs. Prefer existing topics strongly.',
    '- Propose a new_topic only when nothing existing is a reasonable home, and never for a format or a one-off.',
    '- A new topic needs a short name and a one-sentence description.',
    '- confidence is 0-1: how clearly the item belongs where you put it.',
    '',
    'Return exactly this shape:',
    '{"slugs":["existing-slug"],"new_topic":null,"confidence":0.8}',
    'or',
    '{"slugs":[],"new_topic":{"name":"...","description":"..."},"confidence":0.7}',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await requestChat(env, {
    session: `xbv-file-${post.tweetId}`,
    system,
    user,
    maxTokens: 1200,
    temperature: 0.1,
  });

  const parsed = asRecord(parseJsonReply(raw));
  const valid = new Set(topics.map(topic => topic.slug));
  const slugs = (Array.isArray(parsed?.slugs) ? parsed.slugs : [])
    .map(slug => slugify(String(slug)))
    .filter(slug => valid.has(slug));

  let created: ClassifiedTopic | null = null;
  const newTopic = asRecord(parsed?.new_topic);
  const name = truncate(String(newTopic?.name || '').trim(), 60);
  if (!slugs.length && name) {
    created = {
      slug: slugify(name),
      name,
      description: truncate(String(newTopic?.description || '').trim(), 240),
    };
  }

  const confidence = Number(parsed?.confidence);
  return {
    slugs: created ? [created.slug] : [...new Set(slugs)].slice(0, 3),
    created,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.7,
  };
}

export async function writeTopicOverview(
  { topic, items, previous }: TopicOverviewInput,
  env: Partial<Env>,
): Promise<string> {
  if (!items.length) return '';

  const language = summaryLanguage(env);
  const system =
    'You are the reader\'s own memory for one topic in their personal archive. You are not writing a list of items; you are writing what the archive has taught them so far. ' +
    `Write in ${language}, in natural prose. Return plain text only, no Markdown, no headings.`;
  const user = [
    `TOPIC: ${topic.name}`,
    `WHAT IT MEANS: ${topic.description || ''}`,
    '',
    previous ? 'YOUR PREVIOUS SYNTHESIS (rewrite it; do not simply append to it):' : '',
    previous || '',
    '',
    `ITEMS IN THIS TOPIC, oldest first (${items.length} shown):`,
    ...items.map(item =>
      [
        `--- ${item.date || 'undated'} · @${item.author || 'unknown'} ---`,
        truncate(item.summary || item.text || '', 900),
      ].join('\n'),
    ),
    '',
    'Write 3-4 paragraphs, about 220-320 words.',
    'Explain what this thread is actually about for this reader now: the recurring concerns, how the later items change or sharpen the earlier ones, disagreements or tensions between them, and what remains open. ' +
      'Make connections explicit in plain language ("the same bet shows up in...", "this walks back the earlier claim that..."). Do not summarize items one by one and do not use bullet points. ' +
      'End with one sentence naming what to watch next. Use only the supplied material.',
  ]
    .filter(line => line !== '')
    .join('\n');

  const raw = await requestChat(env, {
    session: `xbv-topic-${topic.slug}`,
    system,
    user,
    maxTokens: 2500,
    temperature: 0.4,
  });

  return raw.trim();
}

interface RequestChatOptions {
  session: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

async function requestChat(
  env: Partial<Env>,
  { session, system, user, maxTokens = 2000, temperature = 0.2 }: RequestChatOptions,
): Promise<string> {
  if (!env.OPENCODE_API_KEY) {
    throw new Error('OPENCODE_API_KEY is not configured.');
  }

  const model = String(env.AI_MODEL || 'deepseek-v4.1-flash').replace(/^opencode-go\//, '');

  try {
    const response = await fetchChat(env, 'request', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENCODE_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'XBookmarkVault/1.0',
        'x-opencode-session': session,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        max_completion_tokens: maxTokens,
        reasoning_effort: 'low',
        temperature,
        stream: false,
      }),
    });

    const raw = await response.text();
    let payload: ChatCompletionResponse | null = null;
    try {
      payload = raw ? (JSON.parse(raw) as ChatCompletionResponse) : null;
    } catch {
      throw new Error(`AI endpoint returned non-JSON (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const upstreamMessage =
        payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new Error(
        `AI endpoint error (HTTP ${response.status}): ${truncate(upstreamMessage, 300)}`,
      );
    }

    const content = payload?.choices?.[0]?.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter(part => part?.type === 'text')
              .map(part => part.text)
              .join('\n')
          : '';

    if (!text.trim()) {
      const finishReason = payload?.choices?.[0]?.finish_reason;
      throw new Error(`AI returned an empty response${finishReason ? ` (finish: ${finishReason})` : ''}.`);
    }

    return text.trim();
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error('AI request timed out after 180 seconds.');
    }
    throw error;
  }
}

/**
 * The chat endpoint with the shared per-attempt timeout and retry policy.
 * Returns the response for the caller to read; only transient answers and
 * connection failures are retried before that.
 */
async function fetchChat(
  env: Partial<Env>,
  label: string,
  init: Omit<RequestInit, 'signal'>,
): Promise<Response> {
  const base = (env.AI_BASE_URL || 'https://opencode.ai/inference/go/openai/v1').replace(/\/+$/, '');
  const endpoint = `${base}/chat/completions`;

  for (let attempt = 0; ; attempt += 1) {
    const canRetry = attempt < AI_RETRY_DELAYS_MS.length;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    let retryDelay: number | null = null;

    try {
      const response = await fetch(endpoint, { ...init, signal: controller.signal });
      if (canRetry && AI_RETRY_STATUSES.has(response.status)) {
        retryDelay = retryDelayMs(attempt, response.headers.get('retry-after'));
      }
      if (retryDelay === null) return response;
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`AI ${label} timed out after ${AI_TIMEOUT_MS / 1000} seconds.`);
      }
      // fetch() reports connection failures as TypeError; those are transient.
      if (!canRetry || !(error instanceof TypeError)) throw error;
      retryDelay = retryDelayMs(attempt, null);
    } finally {
      clearTimeout(timer);
    }

    await sleep(retryDelay ?? 0);
  }
}

/** `Retry-After` is delta-seconds or an HTTP date; cap either at 15 seconds. */
function retryAfterMs(header: string | null): number | null {
  const value = String(header || '').trim();
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), AI_RETRY_AFTER_MAX_MS);
  }

  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - Date.now(), 0), AI_RETRY_AFTER_MAX_MS);
}

/** 1 s, then 3 s, each with a little jitter so retries do not line up. */
function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const hinted = retryAfterMs(retryAfter);
  if (hinted !== null) return hinted;

  const base = AI_RETRY_DELAYS_MS[Math.min(attempt, AI_RETRY_DELAYS_MS.length - 1)];
  return base + Math.round(base * 0.25 * Math.random());
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function parseJsonReply(raw: unknown): unknown {
  const text = String(raw || '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function summaryLanguage(env: Partial<Env>): string {
  return String(env.SUMMARY_LANGUAGE || 'tr').toLowerCase() === 'en' ? 'English' : 'Turkish';
}
