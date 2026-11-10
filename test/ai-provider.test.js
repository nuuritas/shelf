import assert from 'node:assert/strict';
import test from 'node:test';
import { aiApiKey, aiProvider, extractAiText, isAiConfigured, runWorkersAi } from '../src/ai.ts';

const fakeBinding = { run: async () => ({ response: 'x' }) };

test('a deployment with no key falls back to the Workers AI binding', () => {
  const env = { AI: fakeBinding };
  assert.equal(aiProvider(env), 'workers');
  assert.equal(isAiConfigured(env), true);
});

test('an explicit key wins over the binding', () => {
  const env = { AI: fakeBinding, AI_API_KEY: ' key ' };
  assert.equal(aiProvider(env), 'http');
  assert.equal(aiApiKey(env), 'key');
});

test('OPENCODE_API_KEY is still read as an alias', () => {
  assert.equal(aiProvider({ OPENCODE_API_KEY: 'legacy' }), 'http');
  assert.equal(aiApiKey({ OPENCODE_API_KEY: 'legacy' }), 'legacy');
});

test('no key and no binding means AI is off', () => {
  assert.equal(aiProvider({}), 'none');
  assert.equal(isAiConfigured({}), false);
});

test('Workers AI text is read from every response shape', () => {
  assert.equal(extractAiText({ response: ' hello ' }), 'hello');
  assert.equal(extractAiText({ choices: [{ message: { content: 'choice' } }] }), 'choice');
  assert.equal(extractAiText({ result: { response: 'nested' } }), 'nested');
  assert.equal(extractAiText('plain'), 'plain');
  assert.equal(extractAiText({}), '');
  assert.equal(extractAiText(null), '');
});

test('the binding receives a system and user pair and returns text', async () => {
  let seen = {};
  const env = {
    AI: {
      run: async (model, input) => {
        seen = { model, input };
        return { response: '  a summary  ' };
      },
    },
  };

  const text = await runWorkersAi(env, '@cf/meta/test', 'be brief', 'summarize this', 4096, 0.2);

  assert.equal(text, 'a summary');
  assert.equal(seen.model, '@cf/meta/test');
  assert.deepEqual(seen.input?.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'summarize this' },
  ]);
  assert.equal(seen.input?.max_tokens, 4096);
});

test('quota failures explain the free daily allocation', async () => {
  const env = {
    AI: {
      run: async () => {
        throw new Error('429: you have used all your free neurons for today');
      },
    },
  };

  await assert.rejects(
    runWorkersAi(env, '@cf/meta/test', 's', 'u', 100, 0.2),
    /10,000 neurons per day/,
  );
});

test('an empty binding response is an error, not an empty summary', async () => {
  const env = { AI: { run: async () => ({}) } };
  await assert.rejects(runWorkersAi(env, '@cf/meta/test', 's', 'u', 100, 0.2), /empty response/);
});
