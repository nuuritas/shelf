import type { Bookmark, PushNotification, PushSubscriptionRecord } from './types.ts';

/** The contact URI VAPID puts in the JWT; override with `PUSH_CONTACT`. */
const DEFAULT_CONTACT = 'https://github.com/nuuritas/shelf';
const PUSH_TTL_SECONDS = 24 * 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;
const MAX_NOTIFICATION_BODY = 160;

/** A VAPID key pair, ready to store as text in the Durable Object. */
export interface VapidKeys {
  /** base64url of the raw uncompressed P-256 public point. */
  publicKey: string;
  /** ECDSA P-256 JWK, including the private `d` member. */
  privateKey: JsonWebKey;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Google, Mozilla, Apple, and self-hosted push services all get one pair. */
export async function createVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const publicRaw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  );
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return { publicKey: base64UrlEncode(publicRaw), privateKey: privateJwk };
}

/** Only HTTPS endpoints on the public internet; the server POSTs there. */
export function pushEndpoint(value: unknown): URL | null {
  let url: URL;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.hostname.length > 253) return null;
  if (isPrivateHost(url.hostname)) return null;
  return url;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (
    host.includes(':') &&
    (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))
  ) {
    return true;
  }
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  return false;
}

/**
 * VAPID's `Authorization` value. The JWT is ES256 over the endpoint origin;
 * the signature Web Crypto returns for ECDSA is already the raw `r || s`
 * pair JWT expects.
 */
export async function vapidAuthorization(
  endpoint: URL,
  keys: VapidKeys,
  contact = DEFAULT_CONTACT,
): Promise<string> {
  const encoder = new TextEncoder();
  const header = base64UrlEncode(
    encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })),
  );
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        aud: endpoint.origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: contact,
      }),
    ),
  );
  const unsigned = `${header}.${payload}`;
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    keys.privateKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoder.encode(unsigned),
  );
  return `vapid t=${unsigned}.${base64UrlEncode(new Uint8Array(signature))}, k=${keys.publicKey}`;
}

export function parsePushSubscription(input: {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown } | null;
}): PushSubscriptionRecord | null {
  const endpoint = pushEndpoint(input.endpoint);
  if (!endpoint) return null;
  return {
    endpoint: endpoint.toString(),
    p256dh: String(input.keys?.p256dh ?? '').slice(0, 200),
    auth: String(input.keys?.auth ?? '').slice(0, 64),
  };
}

/**
 * A payload-less push only wakes the service worker, which fetches the text
 * from the Worker. That keeps the notification content out of the push
 * service and avoids implementing RFC 8291 encryption.
 */
export async function sendPush(
  subscription: PushSubscriptionRecord,
  keys: VapidKeys,
  contact = DEFAULT_CONTACT,
): Promise<'sent' | 'gone' | 'failed'> {
  const endpoint = pushEndpoint(subscription.endpoint);
  if (!endpoint) return 'gone';

  try {
    const response = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthorization(endpoint, keys, contact),
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: 'normal',
      },
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 410) return 'gone';
    if (response.ok) return 'sent';
    console.warn(`Push endpoint answered ${response.status}.`);
    return 'failed';
  } catch (error) {
    console.warn('Push send failed', error);
    return 'failed';
  }
}

/** The text the service worker and the Android job show for a finished summary. */
export function summaryNotification(
  bookmark: Pick<Bookmark, 'tweetId' | 'text' | 'summary' | 'author'>,
): PushNotification {
  const handle = bookmark.author?.username
    ? `@${bookmark.author.username}`
    : bookmark.author?.name || 'Shelf';
  const raw = String(bookmark.summary || bookmark.text || 'A saved post is ready.').replace(/\s+/g, ' ').trim();
  const body =
    raw.length > MAX_NOTIFICATION_BODY ? `${raw.slice(0, MAX_NOTIFICATION_BODY - 1).trimEnd()}…` : raw;
  return {
    title: `New summary from ${handle}`,
    body,
    url: `/?layout=saves#bookmark-${encodeURIComponent(bookmark.tweetId)}`,
  };
}
