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
  const key = env.SUPADATA_API_KEY;
  if (!key) return null;

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
