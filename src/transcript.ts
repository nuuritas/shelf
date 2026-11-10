/**
 * Video transcripts for the summarizer.
 *
 * X videos are downloaded from their smallest MP4 variant and transcribed with
 * Workers AI Whisper, so they need no extra key. YouTube refuses direct caption
 * requests from Worker IPs, so those links go through Supadata's native-only
 * endpoint. Nothing here throws: a missing transcript must never stop a summary.
 */

import type { Bookmark, Env, MediaItem, VideoTranscript } from './types.ts';

const SUPADATA_ENDPOINT = 'https://api.supadata.ai/v1/transcript';
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

/**
 * Piped instances used when `PIPED_API_URL` is unset, so a fresh deploy reads
 * YouTube captions with no key and no signup. They are volunteer-run and the
 * list is short on purpose: everyone shares the same few servers, and the next
 * entry only costs one request when the previous one fails.
 */
const DEFAULT_PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.ducks.party',
];

/**
 * `PIPED_API_URL` is either one instance or a comma/space separated ladder.
 * `off` turns the whole path off, which is what tests and anyone who prefers a
 * paid service want.
 */
export function pipedInstances(env: Partial<Env>): string[] {
  const raw = String(env.PIPED_API_URL ?? '').trim();
  if (!raw) return DEFAULT_PIPED_INSTANCES;
  if (/^(off|none|false|no|0|disabled)$/i.test(raw)) return [];
  return raw
    .split(/[,\s]+/)
    .map(item => item.replace(/\/+$/, ''))
    .filter(Boolean);
}
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_CHARS = 120_000;
const MAX_TARGETS = 2;
const FETCH_TIMEOUT_MS = 30_000;
const AI_TIMEOUT_MS = 180_000;

interface VideoTarget {
  url: string;
  source: 'x' | 'youtube';
  media?: MediaItem;
  durationSec: number | null;
}

interface WhisperOutput {
  text?: string;
  transcription_info?: {
    language?: string;
    duration?: number;
  };
}

/**
 * The video id in a YouTube watch, short, shorts, embed, or live URL.
 * Returns null for anything else, including lookalike hosts.
 */
export function youtubeVideoId(input: string | null | undefined): string | null {
  if (!input) return null;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const clean = (value: string | null): string | null =>
    value && /^[A-Za-z0-9_-]{6,}$/.test(value) ? value : null;

  if (host === 'youtu.be') return clean(url.pathname.slice(1).split('/')[0] || null);

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') return clean(url.searchParams.get('v'));
    const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{6,})/);
    if (match) return match[1];
  }

  return null;
}

/** Every video worth transcribing, most personal first. */
export function collectVideoTargets(bookmark: Bookmark): VideoTarget[] {
  const targets: VideoTarget[] = [];
  const seen = new Set<string>();

  const push = (target: VideoTarget): void => {
    if (seen.has(target.url)) return;
    seen.add(target.url);
    targets.push(target);
  };

  for (const media of bookmark.media ?? []) {
    if (media.type !== 'video') continue;
    push({
      url: bookmark.url,
      source: 'x',
      media,
      durationSec: media.durationMs ? media.durationMs / 1000 : null,
    });
    break;
  }

  const quote = bookmark.quote;
  if (quote) {
    const media = (quote.media ?? []).find(item => item.type === 'video');
    if (media) {
      push({
        url: quote.url || `https://x.com/i/status/${quote.tweetId}`,
        source: 'x',
        media,
        durationSec: media.durationMs ? media.durationMs / 1000 : null,
      });
    }
  }

  for (const id of collectYoutubeIds(bookmark)) {
    push({
      url: `https://www.youtube.com/watch?v=${id}`,
      source: 'youtube',
      durationSec: null,
    });
  }

  return targets.slice(0, MAX_TARGETS);
}

/** Video ids in the saved links and in the post text, newest first. */
export function collectYoutubeIds(bookmark: Bookmark): string[] {
  const urls = [
    ...(bookmark.links ?? []).map(link => link.finalUrl || link.url),
    ...(String(bookmark.text || '').match(/https?:\/\/[^\s<>"']+/g) ?? []),
  ];
  const ids = new Set<string>();

  for (const url of urls) {
    const id = youtubeVideoId(url);
    if (id) ids.add(id);
  }

  return [...ids];
}

/** Read transcripts for every target, one at a time to keep memory bounded. */
export async function readTranscripts(
  bookmark: Bookmark,
  env: Partial<Env>,
): Promise<VideoTranscript[]> {
  const transcripts: VideoTranscript[] = [];

  for (const target of collectVideoTargets(bookmark)) {
    try {
      const transcript =
        target.source === 'youtube'
          ? await transcribeYouTube(target, env)
          : await transcribeX(target, env);
      if (transcript) transcripts.push(transcript);
    } catch (error) {
      transcripts.push(failure(target, error));
    }
  }

  return transcripts;
}

async function transcribeX(target: VideoTarget, env: Partial<Env>): Promise<VideoTranscript> {
  if (!env.AI) throw new Error('The Workers AI binding is not configured.');

  const mediaUrl = pickMp4(target.media);
  if (!mediaUrl) throw new Error('This video has no MP4 stream to read.');

  const host = new URL(mediaUrl).hostname.toLowerCase();
  if (host !== 'video.twimg.com' && !host.endsWith('.twimg.com')) {
    throw new Error('The video is not hosted on X.');
  }

  const response = await fetchWithTimeout(mediaUrl, {
    headers: { 'User-Agent': 'XBookmarkVault/1.0', Accept: 'video/mp4,video/*;q=0.8' },
  });
  if (!response.ok) throw new Error(`The video returned HTTP ${response.status}.`);

  const declared = Number(response.headers.get('Content-Length') || 0);
  if (declared > MAX_BYTES) {
    throw new Error(`The video is ${formatMegabytes(declared)} MB; the limit is ${formatMegabytes(MAX_BYTES)} MB.`);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(`The video is ${formatMegabytes(buffer.byteLength)} MB; the limit is ${formatMegabytes(MAX_BYTES)} MB.`);
  }

  const result = (await withTimeout(
    env.AI.run(WHISPER_MODEL, {
      audio: toBase64(buffer),
      task: 'transcribe',
      vad_filter: true,
    }),
    AI_TIMEOUT_MS,
    'Transcription timed out.',
  )) as WhisperOutput;

  const text = String(result?.text || '').trim();
  if (!text) throw new Error('No speech was detected in this video.');

  return {
    url: target.url,
    source: 'x',
    provider: 'workers-ai',
    lang: result?.transcription_info?.language || null,
    text: text.slice(0, MAX_CHARS),
    durationSec: target.durationSec ?? result?.transcription_info?.duration ?? null,
    bytes: buffer.byteLength,
    status: 'done',
    error: null,
    at: new Date().toISOString(),
  };
}

async function transcribeYouTube(
  target: VideoTarget,
  env: Partial<Env>,
): Promise<VideoTranscript | null> {
  const custom = await transcribeCustomProvider(target, env);
  if (custom) return custom;

  // Free and keyless, so it runs first: a fresh deploy reads YouTube captions
  // without signing up for anything. A Piped failure is not fatal, because
  // Supadata (when configured) is still there.
  const piped = await transcribePiped(target, env);
  if (piped?.status === 'done') return piped;

  const key = env.SUPADATA_API_KEY;
  if (!key) return piped;

  const params = new URLSearchParams({
    url: target.url,
    text: 'true',
    mode: 'native',
  });

  let response = await fetchWithTimeout(`${SUPADATA_ENDPOINT}?${params.toString()}`, {
    headers: { 'x-api-key': key },
  });

  if (response.status === 202) {
    const job = (await response.json()) as { jobId?: string };
    if (!job.jobId) throw new Error('Supadata did not return a transcript job id.');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await sleep(1000);
      response = await fetchWithTimeout(`${SUPADATA_ENDPOINT}/${encodeURIComponent(job.jobId)}`, {
        headers: { 'x-api-key': key },
      });
      if (response.status !== 202) break;
    }

    if (response.status === 202) {
      return unavailable(target, 'YouTube is still preparing the captions. Try again later.');
    }
  }

  if (response.status === 206) {
    return unavailable(target, 'No captions are available for this YouTube video.');
  }

  if (!response.ok) {
    // Out of credits is expected on the free tier; Piped already had its turn,
    // and its failure must not take down the summary.
    if (response.status === 429 && piped) return piped;
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`Supadata returned HTTP ${response.status}${detail ? `: ${detail}` : ''}.`);
  }

  const data = (await response.json()) as {
    status?: string;
    content?: string | Array<{ text?: string }>;
    lang?: string;
    error?: string;
  };

  if (data.status === 'queued' || data.status === 'active') {
    return unavailable(target, 'YouTube is still preparing the captions. Try again later.');
  }
  if (data.status === 'failed') {
    throw new Error(data.error || 'Supadata could not read the captions.');
  }

  const text = Array.isArray(data.content)
    ? data.content.map(part => String(part?.text || '')).join(' ')
    : String(data.content || '');
  const clean = text.replace(/\s+/g, ' ').trim();

  if (!clean) return unavailable(target, 'No captions are available for this YouTube video.');

  return {
    url: target.url,
    source: 'youtube',
    provider: 'supadata',
    lang: data.lang || null,
    text: clean.slice(0, MAX_CHARS),
    durationSec: target.durationSec,
    bytes: null,
    status: 'done',
    error: null,
    at: new Date().toISOString(),
  };
}

function pickMp4(media: MediaItem | undefined): string | null {
  if (!media) return null;

  const candidates = (media.variants ?? []).filter(
    variant =>
      Boolean(variant.url) &&
      (variant.container === 'mp4' || /\.mp4(\?|$)/i.test(String(variant.url))),
  );

  const ranked = candidates
    .filter(variant => (variant.bitrate ?? 0) > 0)
    .sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0));

  const picked = ranked[0] || candidates[0];
  if (picked?.url) return picked.url;
  if (media.url && /\.mp4(\?|$)/i.test(media.url)) return media.url;
  return null;
}

function failure(target: VideoTarget, error: unknown): VideoTranscript {
  return {
    url: target.url,
    source: target.source,
    provider: null,
    lang: null,
    text: '',
    durationSec: target.durationSec,
    bytes: null,
    status: 'failed',
    error: error instanceof Error ? error.message.slice(0, 500) : 'Could not read this video.',
    at: new Date().toISOString(),
  };
}

interface PipedTrack {
  url?: string;
  code?: string;
  name?: string;
  autoGenerated?: boolean;
}

interface PipedAttempt {
  transcript: VideoTranscript;
  /** Another instance may still answer; a definitive "no captions" means it will not. */
  retryNext: boolean;
}

/**
 * Keyless captions through one Piped instance: ask for the stream, then fetch
 * the caption track it points at as WebVTT. Public instances are volunteer-run
 * and come and go, so nothing here throws: a dead instance should only cost the
 * transcript, and the next instance in `pipedInstances` gets a turn.
 */
async function transcribePipedFrom(
  base: string,
  videoId: string,
  target: VideoTarget,
): Promise<PipedAttempt> {
  try {
    const streams = await fetchWithTimeout(`${base}/streams/${encodeURIComponent(videoId)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!streams.ok) {
      return {
        transcript: unavailable(target, `The Piped instance answered HTTP ${streams.status}.`),
        retryNext: true,
      };
    }

    const data = (await streams.json()) as { subtitles?: PipedTrack[] };
    const tracks = Array.isArray(data.subtitles) ? data.subtitles : [];
    if (!tracks.length) {
      return {
        transcript: unavailable(target, 'No captions are available for this YouTube video.'),
        retryNext: false,
      };
    }

    const track = tracks.find(item => item.code === 'en' && !item.autoGenerated) ?? tracks[0];
    if (!track.url) {
      return {
        transcript: unavailable(target, 'The Piped instance returned no caption URL.'),
        retryNext: false,
      };
    }

    const captions = await fetchWithTimeout(track.url.replace('fmt=ttml', 'fmt=vtt'), {
      headers: { Accept: 'text/vtt, text/plain' },
    });
    if (!captions.ok) {
      return {
        transcript: unavailable(target, `The caption proxy answered HTTP ${captions.status}.`),
        retryNext: true,
      };
    }

    const text = cleanTranscriptText(await captions.text());
    if (!text || text === 'WEBVTT') {
      return {
        transcript: unavailable(target, 'The Piped instance returned an empty caption track.'),
        retryNext: true,
      };
    }

    return {
      transcript: {
        url: target.url,
        source: 'youtube',
        provider: 'piped',
        lang: track.code || null,
        text: text.slice(0, MAX_CHARS),
        durationSec: target.durationSec,
        bytes: null,
        status: 'done',
        error: null,
        at: new Date().toISOString(),
      },
      retryNext: false,
    };
  } catch (error) {
    return {
      transcript: unavailable(target, `The Piped instance failed (${errorMessage(error)}).`),
      retryNext: true,
    };
  }
}

/** Walk the instance ladder and stop at the first real answer. */
async function transcribePiped(
  target: VideoTarget,
  env: Partial<Env>,
): Promise<VideoTranscript | null> {
  if (target.source !== 'youtube') return null;

  const videoId = youtubeVideoId(target.url);
  if (!videoId) return null;

  let last: VideoTranscript | null = null;
  for (const base of pipedInstances(env)) {
    const attempt = await transcribePipedFrom(base, videoId, target);
    if (attempt.transcript.status === 'done' || !attempt.retryNext) return attempt.transcript;
    last = attempt.transcript;
  }

  return last;
}

/**
 * Any user-supplied transcript service, tried before Supadata. The contract is
 * deliberately loose so a shim around a paid API, a self-hosted instance, or a
 * proxy works: the endpoint may reply with JSON (`text`, `transcript`, or
 * `content`), WebVTT, SRT, or plain text.
 */
async function transcribeCustomProvider(
  target: VideoTarget,
  env: Partial<Env>,
): Promise<VideoTranscript | null> {
  const template = String(env.TRANSCRIPT_API_URL || '').trim();
  if (!template || target.source !== 'youtube') return null;

  const videoId = youtubeVideoId(target.url) || '';
  const endpoint = template
    .replaceAll('{videoId}', encodeURIComponent(videoId))
    .replaceAll('{url}', encodeURIComponent(target.url));

  const headers: Record<string, string> = {
    Accept: 'application/json, text/vtt, text/plain',
  };
  const key = String(env.TRANSCRIPT_API_KEY || '').trim();
  const header = String(env.TRANSCRIPT_API_HEADER || '').trim();
  if (key) {
    if (header) headers[header] = key;
    else headers.Authorization = `Bearer ${key}`;
  }

  const response = await fetchWithTimeout(endpoint, { headers });
  if (response.status === 204 || response.status === 404) {
    return unavailable(target, 'The transcript service has no captions for this video.');
  }
  if (!response.ok) {
    // A spent monthly quota is expected, not a bug: hand over to Supadata when
    // it is configured, so two free tiers stack.
    if (response.status === 429 && env.SUPADATA_API_KEY) return null;
    if (response.status === 429) {
      return unavailable(
        target,
        'The transcript service is out of quota for this month. Add a second provider or use xbv youtube.',
      );
    }
    throw new Error(`Transcript service returned HTTP ${response.status}.`);
  }

  const raw = await response.text();
  const { text, lang } = parseTranscriptBody(raw);
  if (!text) {
    return unavailable(target, 'The transcript service returned an empty transcript.');
  }

  return {
    url: target.url,
    source: 'youtube',
    provider: 'custom',
    lang,
    text: text.slice(0, MAX_CHARS),
    durationSec: target.durationSec,
    bytes: null,
    status: 'done',
    error: null,
    at: new Date().toISOString(),
  };
}

/** JSON, VTT, SRT, or plain text into one clean line-per-cue paragraph. */
export function parseTranscriptBody(raw: string): { text: string; lang: string | null } {
  const body = raw.trim();
  if (!body) return { text: '', lang: null };

  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      const data = JSON.parse(body) as unknown;
      const lang =
        data && typeof data === 'object'
          ? String((data as Record<string, unknown>).lang || (data as Record<string, unknown>).language || '') || null
          : null;
      const text = pickJsonText(data);
      if (text) return { text: cleanTranscriptText(text), lang };
    } catch {
      // Not JSON after all; fall through to the text formats.
    }
  }

  return { text: cleanTranscriptText(body), lang: null };
}

function pickJsonText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';

  const record = data as Record<string, unknown>;
  for (const key of ['text', 'transcript', 'content', 'captions']) {
    const value = record[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const joined = value
        .map(part =>
          typeof part === 'string'
            ? part
            : String((part as { text?: string } | null)?.text || ''),
        )
        .join(' ');
      if (joined.trim()) return joined;
    }
  }
  return '';
}

/** Strip cue numbers, timestamps, and inline tags from VTT/SRT, keep the words. */
function cleanTranscriptText(raw: string): string {
  const lines = raw.replace(/\r/g, '').split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    const value = line.trim();
    if (!value) continue;
    if (/^WEBVTT/i.test(value)) continue;
    if (/^(Kind|Language|NOTE)\b/i.test(value)) continue;
    if (/^\d+$/.test(value)) continue;
    if (value.includes('-->')) continue;
    const stripped = value.replace(/<[^>]+>/g, '').trim();
    if (!stripped) continue;
    if (kept[kept.length - 1] === stripped) continue;
    kept.push(stripped);
  }

  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailable(target: VideoTarget, message: string): VideoTranscript {
  return {
    url: target.url,
    source: target.source,
    provider: null,
    lang: null,
    text: '',
    durationSec: target.durationSec,
    bytes: null,
    status: 'unavailable',
    error: message,
    at: new Date().toISOString(),
  };
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x2000;

  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }

  return btoa(binary);
}

async function fetchWithTimeout(input: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
