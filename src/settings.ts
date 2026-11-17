import { DEFAULT_SUMMARY_PROMPT } from './ai.ts';
import { resolveLanguage } from './languages.ts';
import type { Env, SummaryLanguage } from './types.ts';

/** Long enough for a detailed voice, short enough to keep a summary request sane. */
export const MAX_SUMMARY_PROMPT_LENGTH = 8_000;

/** `SUMMARY_LANGUAGE` remains the initial default for deployments without settings. */
export function defaultSummaryLanguage(env: Partial<Env>): SummaryLanguage {
  return resolveLanguage(env.SUMMARY_LANGUAGE) ?? 'en';
}

/** A stored or submitted tag, or the fallback when it names no language. */
export function normalizeSummaryLanguage(
  value: unknown,
  fallback: SummaryLanguage,
): SummaryLanguage {
  return resolveLanguage(String(value ?? '')) ?? fallback;
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

/**
 * The same bound the hosted service puts on a workspace name. The self-hosted
 * library has no URL slug, so the name is only a label the native apps show.
 */
export const WORKSPACE_NAME_MAX = 80;

export type WorkspaceNameError = 'workspace_empty' | 'workspace_long';

/** The rejection code for a submitted name, or null when it fits. */
export function workspaceNameError(raw: string): WorkspaceNameError | null {
  const name = raw.trim();
  if (!name) return 'workspace_empty';
  if (name.length > WORKSPACE_NAME_MAX) return 'workspace_long';
  return null;
}

/** The English rejection sentence, so the JSON route and the app agree. */
export function workspaceNameMessage(error: WorkspaceNameError): string {
  return error === 'workspace_empty'
    ? 'Enter a workspace name.'
    : `Keep the workspace name to ${WORKSPACE_NAME_MAX} characters or fewer.`;
}

/** Absent or non-text keeps the stored name; otherwise the trimmed value. */
export function normalizeWorkspaceName(value: unknown): string {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

/** A stored `'0'`/`'false'` means off; anything else keeps the fallback. */
export function normalizeSummariesEnabled(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}
