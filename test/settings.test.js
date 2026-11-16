import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SUMMARY_PROMPT, buildSummarySystemPrompt } from '../src/ai.ts';
import {
  MAX_SUMMARY_PROMPT_LENGTH,
  WORKSPACE_NAME_MAX,
  defaultSummaryLanguage,
  normalizeSummariesEnabled,
  normalizeSummaryLanguage,
  normalizeSummaryPrompt,
  normalizeWorkspaceName,
  validateSummaryPrompt,
  workspaceNameError,
} from '../src/settings.ts';

test('the env language is the initial default, and English wins when unset', () => {
  assert.equal(defaultSummaryLanguage({}), 'en');
  assert.equal(defaultSummaryLanguage({ SUMMARY_LANGUAGE: 'en' }), 'en');
  assert.equal(defaultSummaryLanguage({ SUMMARY_LANGUAGE: 'tr' }), 'tr');
  assert.equal(defaultSummaryLanguage({ SUMMARY_LANGUAGE: 'TR' }), 'tr');
});

test('an unknown stored language falls back to the deployment default', () => {
  assert.equal(normalizeSummaryLanguage('tr', 'en'), 'tr');
  assert.equal(normalizeSummaryLanguage('en', 'tr'), 'en');
  assert.equal(normalizeSummaryLanguage('de', 'tr'), 'tr');
  assert.equal(normalizeSummaryLanguage(undefined, 'en'), 'en');
});

test('an empty or untouched prompt means the built-in default', () => {
  assert.equal(normalizeSummaryPrompt(''), '');
  assert.equal(normalizeSummaryPrompt('   '), '');
  assert.equal(normalizeSummaryPrompt(DEFAULT_SUMMARY_PROMPT), '');
  assert.equal(normalizeSummaryPrompt(`${DEFAULT_SUMMARY_PROMPT}\n`), '');
  assert.equal(normalizeSummaryPrompt('  Summarize in haiku.  '), 'Summarize in haiku.');
  assert.equal(normalizeSummaryPrompt('one\r\ntwo'), 'one\ntwo');
});

test('the length limit is enforced with a readable error', () => {
  const atLimit = 'a'.repeat(MAX_SUMMARY_PROMPT_LENGTH);
  assert.doesNotThrow(() => validateSummaryPrompt(atLimit));
  assert.throws(
    () => validateSummaryPrompt(`${atLimit}a`),
    /8,001 characters; the limit is 8,000/,
  );
});

test('the default prompt gets the chosen language', () => {
  const english = buildSummarySystemPrompt({ language: 'English' });
  assert.match(english, /Write in English/);
  assert.doesNotMatch(english, /\{\{language\}\}/);
  assert.match(english, /Return plain text, not Markdown\./);

  const turkish = buildSummarySystemPrompt({ language: 'Turkish' });
  assert.match(turkish, /Write in Turkish/);
});

test('a custom prompt without a placeholder still gets a language line', () => {
  const prompt = buildSummarySystemPrompt({ prompt: 'Answer in three bullets.', language: 'Turkish' });
  assert.equal(prompt, 'Write in Turkish. Answer in three bullets.');
});

test('a custom prompt can place the language itself', () => {
  const prompt = buildSummarySystemPrompt({
    prompt: 'Be terse. Write in {{language}}.',
    language: 'English',
  });
  assert.equal(prompt, 'Be terse. Write in English.');
  assert.doesNotMatch(prompt, /^Write in English\. Be terse/);
});

test('a new version keeps its angle wrapper in front of the custom prompt', () => {
  const prompt = buildSummarySystemPrompt({
    prompt: 'Use short paragraphs.',
    language: 'English',
    instruction: 'Focus on the security angle.',
  });
  assert.match(prompt, /^You are writing a new version of an existing explanation/);
  assert.match(prompt, /Write in English\. Use short paragraphs\.$/);
});

test('the workspace name is trimmed and bounded like the hosted one', () => {
  assert.equal(normalizeWorkspaceName('  My shelf  '), 'My shelf');
  assert.equal(normalizeWorkspaceName('one\r\ntwo'), 'one\ntwo');
  assert.equal(normalizeWorkspaceName(undefined), '');

  assert.equal(workspaceNameError(''), 'workspace_empty');
  assert.equal(workspaceNameError('   '), 'workspace_empty');
  assert.equal(workspaceNameError('a'.repeat(WORKSPACE_NAME_MAX)), null);
  assert.equal(workspaceNameError('a'.repeat(WORKSPACE_NAME_MAX + 1)), 'workspace_long');
});

test('the summaries toggle understands the stored string and the JSON boolean', () => {
  assert.equal(normalizeSummariesEnabled(true, false), true);
  assert.equal(normalizeSummariesEnabled(false, true), false);
  assert.equal(normalizeSummariesEnabled('1', false), true);
  assert.equal(normalizeSummariesEnabled('0', true), false);
  assert.equal(normalizeSummariesEnabled('true', false), true);
  assert.equal(normalizeSummariesEnabled('false', true), false);
  // A row that was never written keeps the default instead of reading as off.
  assert.equal(normalizeSummariesEnabled(undefined, true), true);
  assert.equal(normalizeSummariesEnabled('', true), true);
});
