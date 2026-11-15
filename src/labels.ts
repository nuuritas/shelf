import type { LabelName } from './types.ts';

/**
 * Labels are the reader's own tags: free text, many per post, and a filter row
 * of their own. They are not topics — the AI filing step never writes one, a
 * label exists because somebody typed it, and it is looked up by the word it
 * was given.
 *
 * This module is deliberately free of Durable Object imports so the parsing
 * rules can be unit-tested on Node.
 */
export const LABEL_LIMITS = {
  /** Longest label name stored; longer input is truncated, not rejected. */
  name: 40,
  /** Longest slug; a label's URL form. */
  slug: 40,
  /** Labels one bookmark may carry. */
  perBookmark: 12,
  /** Labels the library filter row lists before it stops. */
  menu: 24,
} as const;

/** The URL-safe form of a label name. Lookups and filter links use this. */
export function labelSlug(name: string): string {
  return String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LABEL_LIMITS.slug)
    .replace(/-+$/g, '');
}

/**
 * Read a label set out of the shapes a caller can send: an array (JSON API) or
 * one comma-separated line (a form field). Duplicates that differ only in case
 * or spacing collapse into the first spelling, because they are one label once
 * `labelSlug` has run.
 */
export function parseLabelNames(raw: unknown): LabelName[] {
  const parts: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];

  const bySlug = new Map<string, LabelName>();
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const name = part.trim().replace(/\s+/g, ' ').slice(0, LABEL_LIMITS.name).trim();
    const slug = labelSlug(name);
    if (!slug || bySlug.has(slug)) continue;
    bySlug.set(slug, { name, slug });
    if (bySlug.size >= LABEL_LIMITS.perBookmark) break;
  }
  return [...bySlug.values()];
}
