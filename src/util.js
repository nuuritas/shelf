export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function linkifyText(text) {
  const input = String(text ?? '');
  const urlPattern = /https?:\/\/[^\s]+/g;
  let output = '';
  let cursor = 0;

  for (const match of input.matchAll(urlPattern)) {
    output += textChunk(input.slice(cursor, match.index));
    const raw = match[0];
    const trailing = raw.match(/[),.;:!?]+$/)?.[0] ?? '';
    const href = trailing ? raw.slice(0, -trailing.length) : raw;
    const safeHref = safeHttpUrl(href);

    if (safeHref) {
      output += `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(href)}</a>`;
    } else {
      output += escapeHtml(href);
    }
    output += escapeHtml(trailing);
    cursor = match.index + raw.length;
  }

  output += textChunk(input.slice(cursor));
  return output;
}

function textChunk(value) {
  return escapeHtml(value).replaceAll('\n', '<br>');
}

export function truncate(value, maxLength) {
  const input = String(value ?? '').trim();
  if (input.length <= maxLength) return input;
  return `${input.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return dateFormatter.format(date);
}

const compactFormatter = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return compactFormatter.format(value);
}

export function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export function htmlResponse(html, status = 200, headers = {}) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export function redirect(location, status = 303) {
  return new Response(null, { status, headers: { Location: location } });
}

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const cookies = new Map();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies.set(key, value);
  }
  return cookies;
}

export function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function arrayBufferToBase64(buffer) {
  return bytesToBase64(new Uint8Array(buffer));
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const ASCII_FOLD = {
  ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i', ö: 'o', Ö: 'o',
  ş: 's', Ş: 's', ü: 'u', Ü: 'u', â: 'a', î: 'i', û: 'u',
};

export function slugify(value) {
  const folded = String(value || '')
    .split('')
    .map(char => ASCII_FOLD[char] ?? char)
    .join('')
    .toLowerCase();
  const slug = folded
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'topic';
}

export function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
