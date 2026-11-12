import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizePost } from '../src/ai.ts';

const post = {
  tweetId: '123',
  url: 'https://x.com/a/status/123',
  text: 'A saved post about a new database.',
  author: { name: 'A', username: 'a', avatarUrl: null, verified: false },
  createdAt: '2026-11-01T10:00:00.000Z',
  savedAt: '2026-11-01T10:00:00.000Z',
  media: [],
  quote: null,
  article: null,
  links: [],
  transcripts: [],
  metrics: {},
};

const env = {
  AI_PROVIDER: 'custom',
  AI_API_KEY: 'test-key',
  AI_BASE_URL: 'https://ai.example.test/v1',
  SUMMARY_LANGUAGE: 'en',
};

/** Stub the OpenAI-compatible endpoint and return the system message it saw. */
async function systemMessageFor(options) {
  const original = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'A short summary.' }, finish_reason: 'stop' }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const result = await summarizePost(post, env, options);
    assert.equal(result.text, 'A short summary.');
  } finally {
    globalThis.fetch = original;
  }

  return body.messages[0].content;
}

test('the stored prompt becomes the system message', async () => {
  const system = await systemMessageFor({ prompt: 'Answer in five bullets.' });
  assert.equal(system, 'Write in English. Answer in five bullets.');
});

test('without an override the built-in prompt is sent', async () => {
  const system = await systemMessageFor({});
  assert.match(system, /^You are a perceptive analyst and explainer\./);
  assert.match(system, /Write in English/);
  assert.match(system, /Return plain text, not Markdown\./);
});

test('the language setting still applies to a custom prompt', async () => {
  const original = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'Bir özet.' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    await summarizePost(
      post,
      { ...env, SUMMARY_LANGUAGE: 'tr' },
      { prompt: 'Kısa yaz.' },
    );
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(body.messages[0].content, 'Write in Turkish. Kısa yaz.');
});
