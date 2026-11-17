import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SUMMARY_PROMPT, buildSummarySystemPrompt } from '../src/ai.ts';
import { resolveLanguage } from '../src/languages.ts';
import { renderSettings } from '../src/render.ts';
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
  assert.equal(defaultSummaryLanguage({ SUMMARY_LANGUAGE: 'pt-BR' }), 'pt-BR');
  assert.equal(defaultSummaryLanguage({ SUMMARY_LANGUAGE: 'Deutsch' }), 'de');
  // Junk, an empty value and a tag Intl cannot name all fall back to English.
  assert.equal(defaultSummaryLanguage({ SUMMARY_LANGUAGE: '' }), 'en');
  assert.equal(defaultSummaryLanguage({ SUMMARY_LANGUAGE: 'zz' }), 'en');
  assert.equal(defaultSummaryLanguage({ SUMMARY_LANGUAGE: 'notalanguage' }), 'en');
});

test('an unknown stored language falls back to the deployment default', () => {
  assert.equal(normalizeSummaryLanguage('tr', 'en'), 'tr');
  assert.equal(normalizeSummaryLanguage('en', 'tr'), 'en');
  assert.equal(normalizeSummaryLanguage('pt-BR', 'en'), 'pt-BR');
  assert.equal(normalizeSummaryLanguage('Portuguese', 'en'), 'pt');
  assert.equal(normalizeSummaryLanguage('not a language', 'tr'), 'tr');
  assert.equal(normalizeSummaryLanguage('zz', 'tr'), 'tr');
  assert.equal(normalizeSummaryLanguage(undefined, 'en'), 'en');
});

test('a language needs a name to be stored, not just a well-formed tag', () => {
  assert.equal(resolveLanguage('pt-BR'), 'pt-BR');
  assert.equal(resolveLanguage('Deutsch'), 'de');
  assert.equal(resolveLanguage('sr-Latn'), 'sr-Latn');
  assert.equal(resolveLanguage('Turkish'), 'tr');
  // `Intl.getCanonicalLocales` accepts `zz`, but `Intl.DisplayNames` only echoes
  // the tag back: it names no language, so it is refused rather than stored.
  assert.equal(resolveLanguage('zz'), null);
  assert.equal(resolveLanguage('not a language'), null);
  assert.equal(resolveLanguage(''), null);
  assert.equal(resolveLanguage(null), null);
});

test('the settings badge names the chosen summary language', () => {
  const html = renderSettings({
    settings: {
      summaryPrompt: '',
      summaryLanguage: 'pt-BR',
      workspaceName: '',
      summariesEnabled: true,
    },
    ai: { provider: 'custom', model: 'model-x', transport: 'http' },
    aiConfigured: true,
  });
  // `Intl` writes its own name lowercase, region in brackets: a badge should
  // still be the language's own name rather than a hardcoded pair.
  assert.match(html, /class="settings-badge is-on">[^<]*português[^<]*<\/span>/i);
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
