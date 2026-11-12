import { DEFAULT_SUMMARY_PROMPT } from './ai.ts';
import type { Env, SummaryLanguage } from './types.ts';

/** Long enough for a detailed voice, short enough to keep a summary request sane. */
export const MAX_SUMMARY_PROMPT_LENGTH = 8_000;

/** `SUMMARY_LANGUAGE` remains the initial default for deployments without settings. */
export function defaultSummaryLanguage(env: Partial<Env>): SummaryLanguage {
  return String(env.SUMMARY_LANGUAGE || 'en').toLowerCase() === 'en' ? 'en' : 'tr';
}

export function normalizeSummaryLanguage(
  value: unknown,
  fallback: SummaryLanguage,
): SummaryLanguage {
  return value === 'en' || value === 'tr' ? value : fallback;
}

/**
 * Normalize the textarea value. Empty, and the built-in prompt itself, both
 * mean "use the default": that way saving the untouched form does not pin the
 * prompt in the database.
 */
export function normalizeSummaryPrompt(value: unknown): string {
  const text = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text || text === DEFAULT_SUMMARY_PROMPT.trim()) return '';
  return text;
}

/** Throws a message the settings form can show inline. */
export function validateSummaryPrompt(prompt: string): void {
  if (prompt.length > MAX_SUMMARY_PROMPT_LENGTH) {
    throw new Error(
      `The prompt is ${prompt.length.toLocaleString('en-US')} characters; the limit is ` +
        `${MAX_SUMMARY_PROMPT_LENGTH.toLocaleString('en-US')}.`,
    );
  }
}
