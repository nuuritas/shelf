import type {
  Bookmark,
  BootstrapItem,
  BootstrapTopic,
  ChatCompletionResponse,
  ChatImagePart,
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

/** Any OpenAI-compatible endpoint works; these are only the last-resort defaults. */
const DEFAULT_AI_BASE = 'https://api.openai.com/v1';
const DEFAULT_AI_MODEL = 'gpt-4.1-mini';

/**
 * Default model for the Workers AI binding. No key, no signup: the free daily
 * allocation covers a personal archive.
 */
const DEFAULT_WORKERS_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** Anthropic's Messages API, which is not OpenAI-compatible. */
const ANTHROPIC_VERSION = '2023-06-01';

export type AiTransport = 'http' | 'anthropic' | 'workers' | 'none';

export interface AiConfig {
  transport: AiTransport;
  /** Preset name, or `custom` when nothing was named. */
  provider: string;
  baseUrl: string;
  model: string;
}

interface ProviderPreset {
  transport: Exclude<AiTransport, 'none'>;
  baseUrl: string;
  model: string;
}

/**
 * Named providers, so a deployment needs `AI_PROVIDER` plus a key instead of
 * remembering a base URL, a model id, and a wire format.
 */
const PROVIDERS: Record<string, ProviderPreset> = {
  opencode: {
    transport: 'http',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    model: 'deepseek-v4.1-flash',
  },
  claude: {
    transport: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
  },
  openai: {
    transport: 'http',
    baseUrl: 'https://api.openai.com/v1',
    model: DEFAULT_AI_MODEL,
  },
  cloudflare: {
    transport: 'workers',
    baseUrl: '',
    model: DEFAULT_WORKERS_MODEL,
  },
};

/**
 * The API key for the endpoint. `OPENCODE_API_KEY` is an older alias, still
 * read so existing deployments keep working after upgrade.
 */
export function aiApiKey(env: Partial<Env>): string {
  return String(env.AI_API_KEY || env.OPENCODE_API_KEY || '').trim();
}

/**
 * Resolve the transport, endpoint, and model for this deployment. An unknown
 * provider resolves to `none` instead of throwing, because this runs during
 * rendering: a typo must not 500 every page.
 */
export function aiConfig(env: Partial<Env>): AiConfig {
  const named = String(env.AI_PROVIDER || '').trim().toLowerCase();
  const preset = PROVIDERS[named];
  const baseOverride = String(env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
  const modelOverride = String(env.AI_MODEL || '').trim();

  if (preset) {
    const model =
      preset.transport === 'workers'
        ? (modelOverride.startsWith('@cf/') ? modelOverride : preset.model)
        : modelOverride || preset.model;
    return {
      transport: preset.transport,
      provider: named,
      baseUrl: baseOverride || preset.baseUrl,
      model,
    };
  }

  if (named && named !== 'custom') {
    return { transport: 'none', provider: named, baseUrl: '', model: '' };
  }

  // Nothing named: keep the selection from before presets existed.
  if (aiApiKey(env)) {
    return {
      transport: 'http',
      provider: 'custom',
      baseUrl: baseOverride || DEFAULT_AI_BASE,
      model: modelOverride || DEFAULT_AI_MODEL,
    };
  }
  if (env.AI) {
    return {
      transport: 'workers',
      provider: 'cloudflare',
      baseUrl: '',
      model: modelOverride.startsWith('@cf/') ? modelOverride : DEFAULT_WORKERS_MODEL,
    };
  }
  return { transport: 'none', provider: 'none', baseUrl: '', model: '' };
}

/** The transport only. Kept for callers that do not need the endpoint. */
export function aiProvider(env: Partial<Env>): AiTransport {
  return aiConfig(env).transport;
}

export function isAiConfigured(env: Partial<Env>): boolean {
  const config = aiConfig(env);
  if (config.transport === 'workers') return Boolean(env.AI);
  if (config.transport === 'none') return false;
  return Boolean(aiApiKey(env));
}

/** Point at the provider's endpoint, with an error that names the provider. */
function requireKey(env: Partial<Env>, config: AiConfig): string {
  const key = aiApiKey(env);
  if (!key) {
    throw new Error(
      `AI_PROVIDER=${config.provider} needs AI_API_KEY. Add it to .dev.vars and redeploy, or set it as a Worker secret.`,
    );
  }
  return key;
}

/**
 * One attempt may take 60–90 s on a cold prompt, so the old 90 s ceiling was
 * already marginal. Retries have their own budget: only answers that arrive
 * quickly (429/5xx) are retried, never the ones that exhausted this timer.
 */
const AI_TIMEOUT_MS = 180_000;
const RETRY_DELAYS_MS = [1_000, 3_000];
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** `Retry-After` wins when the gateway sends it; otherwise 1 s, then 3 s. */
function retryDelayMs(response: Response | null, attempt: number): number {
  const header = response?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 15_000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 15_000);
  }
  return RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 250);
}

/**
 * POST and read the body, retrying the answers that mean "come back later":
 * 429/5xx and network errors. A timeout is not retried, because the caller
 * already waited the full budget and another attempt only doubles the silence.
 */
async function postJson(
  url: string,
  init: RequestInit,
  timeoutMs = AI_TIMEOUT_MS,
): Promise<{ response: Response; raw: string }> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const raw = await response.text();
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= RETRY_DELAYS_MS.length) {
        return { response, raw };
      }
      const delay = retryDelayMs(response, attempt);
      console.warn(`AI endpoint answered ${response.status}; retrying in ${delay} ms.`);
      await wait(delay);
    } catch (error) {
      if (isAbortError(error) || attempt >= RETRY_DELAYS_MS.length) throw error;
      const delay = retryDelayMs(null, attempt);
      console.warn(`AI request failed (${errorMessage(error)}); retrying in ${delay} ms.`);
      await wait(delay);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface SummaryOptions {
  instruction?: string;
  previousSummary?: string;
  session?: string;
  /** The owner's prompt from Settings. Empty means the built-in default. */
  prompt?: string;
}

/**
 * The built-in summary prompt. `{{language}}` is replaced with the summary
 * language; a custom prompt without the placeholder gets a language line in
 * front, so changing the language setting still changes the output.
 */
export const DEFAULT_SUMMARY_PROMPT =
  'You are a perceptive analyst and explainer. The user saves posts and links because they want to understand what something is, the context around it, and why it matters. Write in {{language}}, like a smart colleague explaining it to them. ' +
  'Start with one or two sentences: what this is and the situation or context. Then explain the central idea or argument in natural paragraphs, using concrete details and examples from the supplied content. Briefly explain jargon instead of repeating it. ' +
  'If it is a GitHub repository, explain what the project actually does, who it is for, how it works, and its notable features or maturity. If it is an article, explain its thesis, the context it responds to, and its implications. If the post itself is just a comment on a link, connect the comment to the linked content. ' +
  'Do not use headings such as "Özet", "Ana noktalar", or "Görsellerin katkısı". Do not produce a rigid bullet list or a section-by-section recap. Write 3-5 paragraphs, roughly 250-450 words, and end with one natural takeaway sentence. ' +
  'Use only the supplied content. If some content could not be read or is incomplete, say so naturally. Do not invent facts. Return plain text, not Markdown.';

/** Build the system message from the default or the settings override. */
export function buildSummarySystemPrompt(options: {
  prompt?: string;
  language: string;
  instruction?: string;
}): string {
  const prompt = String(options.prompt || '').trim() || DEFAULT_SUMMARY_PROMPT;
  const withLanguage = prompt.includes('{{language}}')
    ? prompt.replaceAll('{{language}}', options.language)
    : `Write in ${options.language}. ${prompt}`;
  const prefix = options.instruction
    ? "You are writing a new version of an existing explanation because the reader asked for a different angle. The existing summary is context, not a template: do not repeat it or pad it. Answer the reader's request directly and concretely, and keep the same natural, non-robotic voice. "
    : '';
  return prefix + withLanguage;
}

export async function summarizePost(
  post: Bookmark,
  env: Partial<Env>,
  options: SummaryOptions = {},
): Promise<SummaryResult> {
  const config = aiConfig(env);
  if (config.transport === 'none') {
    throw new Error(
      config.provider === 'none'
        ? 'No AI configured: set AI_PROVIDER, AI_API_KEY, or bind Workers AI as AI.'
        : `Unknown AI_PROVIDER="${config.provider}". Use opencode, claude, openai, cloudflare, or custom.`,
    );
  }

  const images = collectImages(post, MAX_IMAGES);
  const attached: AttachedImage[] = [];
  const imageNotes: string[] = [];

  if (config.transport === 'workers') {
    // The binding path is text-only: it has no portable image message format.
    if (images.length) {
      imageNotes.push(
        `Image ${images.length === 1 ? '1 was' : `${images.length} were`} not attached: the Workers AI path reads text only.`,
      );
    }
  } else {
    for (const [index, image] of images.entries()) {
      try {
        const dataUrl = await imageAsDataUrl(image.url, env);
        const parsed = parseDataUrl(dataUrl);
        if (!parsed) throw new Error('unexpected image encoding');
        attached.push(parsed);
        imageNotes.push(`Image ${index + 1} (${image.label}): attached.`);
      } catch (error) {
        imageNotes.push(
          `Image ${index + 1} (${image.label}): could not be loaded (${errorMessage(error)}).`,
        );
      }
    }
  }

  const httpImageParts: ChatImagePart[] =
    config.transport === 'http'
      ? attached.map(image => ({
          type: 'image_url' as const,
          image_url: { url: `data:${image.mediaType};base64,${image.data}`, detail: 'high' as const },
        }))
      : [];
  const language = String(env.SUMMARY_LANGUAGE || 'en').toLowerCase() === 'en' ? 'English' : 'Turkish';

  const systemPrompt = buildSummarySystemPrompt({
    prompt: options.prompt,
    language,
    instruction: options.instruction,
  });

  const userText = buildPrompt(post, imageNotes, {
    instruction: options.instruction,
    previous: options.previousSummary,
  });

  const body: ChatRequest = {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: [{ type: 'text', text: userText }, ...httpImageParts] },
    ],
    max_tokens: 4096,
    max_completion_tokens: 4096,
    reasoning_effort: 'low',
    temperature: 0.2,
    stream: false,
  };

  if (config.transport === 'workers') {
    const text = await runWorkersAi(env, config.model, systemPrompt, userText, 4096, 0.2);
    return { text, model: config.model, imagesUsed: 0 };
  }

  if (config.transport === 'anthropic') {
    const text = await requestAnthropic(env, config, {
      system: systemPrompt,
      user: userText,
      images: attached,
      maxTokens: 4096,
      temperature: 0.2,
    });
    return { text, model: config.model, imagesUsed: attached.length };
  }

  const key = requireKey(env, config);
  const { response, raw } = await postJson(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Shelf/1.0',
      'x-opencode-session': options.session || `shelf-${post.tweetId}`,
    },
    body: JSON.stringify(body),
  }).catch(error => {
    if (isAbortError(error)) throw new Error('AI summary timed out after 180 seconds.');
    throw error;
  });

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

  return { text: text.trim(), model: config.model, imagesUsed: attached.length };
}

interface AttachedImage {
  mediaType: string;
  data: string;
}

function parseDataUrl(url: string): AttachedImage | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  error?: { message?: string };
}

/**
 * Anthropic's Messages API is not OpenAI-compatible: the system prompt is a
 * top-level field, `max_tokens` is required, images are base64 blocks, and the
 * reply is a content array. The rest of the app does not care.
 */
export async function requestAnthropic(
  env: Partial<Env>,
  config: AiConfig,
  options: {
    system: string;
    user: string;
    images: AttachedImage[];
    maxTokens: number;
    temperature: number;
  },
): Promise<string> {
  const key = requireKey(env, config);
  const endpoint = config.baseUrl.endsWith('/v1')
    ? `${config.baseUrl}/messages`
    : `${config.baseUrl}/v1/messages`;

  const content: Array<Record<string, unknown>> = [{ type: 'text', text: options.user }];
  for (const image of options.images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    });
  }

  const { response, raw } = await postJson(endpoint, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Shelf/1.0',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      system: options.system,
      messages: [{ role: 'user', content }],
    }),
  }).catch(error => {
    if (isAbortError(error)) throw new Error('Anthropic request timed out after 180 seconds.');
    throw error;
  });

  let payload: AnthropicResponse | null = null;
  try {
    payload = raw ? (JSON.parse(raw) as AnthropicResponse) : null;
  } catch {
    throw new Error(`Anthropic returned non-JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Anthropic error (HTTP ${response.status}): ${truncate(message, 300)}`);
  }

  const text = Array.isArray(payload?.content)
    ? payload.content
        .filter(part => part?.type === 'text')
        .map(part => part.text || '')
        .join('\n')
    : '';

  if (!text.trim()) {
    throw new Error(
      `Anthropic returned an empty response${payload?.stop_reason ? ` (${payload.stop_reason})` : ''}.`,
    );
  }
  return text.trim();
}

/**
 * Run one chat completion on the Workers AI binding. The binding is already
 * used for Whisper, so this needs no extra credential: a fresh deployment gets
 * summaries from the free daily allocation.
 */
export async function runWorkersAi(
  env: Partial<Env>,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const ai = env.AI;
  if (!ai) throw new Error('The Workers AI binding (AI) is not configured.');

  let result: unknown;
  try {
    result = await ai.run(model, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature,
    });
  } catch (error) {
    const message = errorMessage(error);
    if (/neuron|quota|rate.?limit|429|capacity|busy|overload/i.test(message)) {
      throw new Error(
        `Workers AI could not serve this request (${truncate(message, 200)}). ` +
          'The free allocation is 10,000 neurons per day and resets at 00:00 UTC.',
      );
    }
    throw error;
  }

  const text = extractAiText(result);
  if (!text) throw new Error('Workers AI returned an empty response.');
  return text;
}

/** Workers AI models answer as `{ response }` or in the OpenAI `choices` shape. */
export function extractAiText(result: unknown): string {
  if (typeof result === 'string') return result.trim();
  if (!result || typeof result !== 'object') return '';
  const record = result as Record<string, unknown>;

  if (typeof record.response === 'string') return record.response.trim();
  const choices = record.choices as Array<{ message?: { content?: unknown } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  const nested = record.result as Record<string, unknown> | undefined;
  if (nested && typeof nested.response === 'string') return nested.response.trim();
  return '';
}

/** Translate a finished primary summary into English, preserving its shape. */
export async function translateSummary(
  summary: string,
  env: Partial<Env>,
  options: { session?: string } = {},
): Promise<SummaryResult> {
  if (!isAiConfigured(env)) {
    throw new Error('AI_API_KEY is not configured.');
  }

  const text = await requestChat(env, {
    session: options.session || 'shelf-translate-en',
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
    model: String(env.AI_MODEL || DEFAULT_AI_MODEL).replace(/^opencode-go\//, ''),
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
        'User-Agent': 'Shelf/1.0',
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
    session: 'shelf-topics-bootstrap',
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
    session: `shelf-file-${post.tweetId}`,
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
    session: `shelf-topic-${topic.slug}`,
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
  const config = aiConfig(env);
  if (config.transport === 'none') {
    throw new Error(
      config.provider === 'none'
        ? 'No AI configured: set AI_PROVIDER, AI_API_KEY, or bind Workers AI as AI.'
        : `Unknown AI_PROVIDER="${config.provider}". Use opencode, claude, openai, cloudflare, or custom.`,
    );
  }

  if (config.transport === 'workers') {
    return runWorkersAi(env, config.model, system, user, maxTokens, temperature);
  }

  if (config.transport === 'anthropic') {
    return requestAnthropic(env, config, { system, user, images: [], maxTokens, temperature });
  }

  const key = requireKey(env, config);
  const base = config.baseUrl;

  const { response, raw } = await postJson(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Shelf/1.0',
      'x-opencode-session': session,
    },
    body: JSON.stringify({
      model: config.model,
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
  }).catch(error => {
    if (isAbortError(error)) throw new Error('AI request timed out after 180 seconds.');
    throw error;
  });

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
  return String(env.SUMMARY_LANGUAGE || 'en').toLowerCase() === 'en' ? 'English' : 'Turkish';
}
