import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aiApiKey,
  aiConfig,
  aiProvider,
  extractAiText,
  isAiConfigured,
  requestAnthropic,
  runWorkersAi,
  summarizePost,
} from '../src/ai.ts';

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

test('provider presets fill in the endpoint, model, and transport', () => {
  const claude = aiConfig({ AI_PROVIDER: 'claude', AI_API_KEY: 'k' });
  assert.equal(claude.transport, 'anthropic');
  assert.equal(claude.baseUrl, 'https://api.anthropic.com');
  assert.equal(claude.model, 'claude-sonnet-4-5');

  const openai = aiConfig({ AI_PROVIDER: 'openai', AI_API_KEY: 'k' });
  assert.equal(openai.transport, 'http');
  assert.equal(openai.baseUrl, 'https://api.openai.com/v1');

  const opencode = aiConfig({ AI_PROVIDER: 'opencode', AI_API_KEY: 'k' });
  assert.equal(opencode.baseUrl, 'https://opencode.ai/inference/go/openai/v1');
  assert.equal(opencode.model, 'deepseek-v4.1-flash');
});

test('AI_MODEL and AI_BASE_URL override a preset', () => {
  const config = aiConfig({
    AI_PROVIDER: 'openai',
    AI_API_KEY: 'k',
    AI_MODEL: 'gpt-4.1',
    AI_BASE_URL: 'https://gateway.example.com/v1/',
  });
  assert.equal(config.model, 'gpt-4.1');
  assert.equal(config.baseUrl, 'https://gateway.example.com/v1');
});

test('the cloudflare preset uses the binding and ignores a non-@cf model', () => {
  const config = aiConfig({ AI_PROVIDER: 'cloudflare', AI_MODEL: 'gpt-4.1-mini', AI: fakeBinding });
  assert.equal(config.transport, 'workers');
  assert.equal(config.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');

  const chosen = aiConfig({ AI_PROVIDER: 'cloudflare', AI_MODEL: '@cf/qwen/qwen3-30b-a3b-fp8', AI: fakeBinding });
  assert.equal(chosen.model, '@cf/qwen/qwen3-30b-a3b-fp8');
});

test('custom is the escape hatch for any OpenAI-compatible endpoint', () => {
  const config = aiConfig({
    AI_PROVIDER: 'custom',
    AI_API_KEY: 'k',
    AI_BASE_URL: 'https://api.example.com/v1',
    AI_MODEL: 'some-model',
  });
  assert.equal(config.transport, 'http');
  assert.equal(config.model, 'some-model');
});

test('an unknown provider is inert rather than a crash', () => {
  const config = aiConfig({ AI_PROVIDER: 'gemini', AI_API_KEY: 'k' });
  assert.equal(config.transport, 'none');
  assert.equal(config.provider, 'gemini');
  assert.equal(isAiConfigured({ AI_PROVIDER: 'gemini', AI_API_KEY: 'k' }), false);
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

test('anthropic gets messages format, not chat completions', async t => {
  const original = globalThis.fetch;
  let seen = {};
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({
        content: [
          { type: 'text', text: '  first  ' },
          { type: 'text', text: 'second' },
        ],
        stop_reason: 'end_turn',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const config = aiConfig({ AI_PROVIDER: 'claude', AI_API_KEY: 'secret' });
  const text = await requestAnthropic({ AI_API_KEY: 'secret' }, config, {
    system: 'be brief',
    user: 'explain this',
    images: [{ mediaType: 'image/jpeg', data: 'QUJD' }],
    maxTokens: 500,
    temperature: 0.2,
  });

  assert.equal(text, 'first  \nsecond');
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.headers['x-api-key'], 'secret');
  assert.equal(seen.headers['anthropic-version'], '2023-06-01');
  assert.equal(seen.body.system, 'be brief');
  assert.equal(seen.body.max_tokens, 500);
  assert.equal(seen.body.messages[0].role, 'user');
  assert.deepEqual(seen.body.messages[0].content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' },
  });
});

test('anthropic errors surface the upstream message', async t => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  t.after(() => {
    globalThis.fetch = original;
  });

  const config = aiConfig({ AI_PROVIDER: 'claude', AI_API_KEY: 'bad' });
  await assert.rejects(
    requestAnthropic({ AI_API_KEY: 'bad' }, config, {
      system: 's',
      user: 'u',
      images: [],
      maxTokens: 10,
      temperature: 0,
    }),
    /Anthropic error \(HTTP 401\): invalid x-api-key/,
  );
});

test('a 429 is retried once and the second answer wins', async t => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'overloaded' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    }
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'fine' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const env = { AI_API_KEY: 'k' };
  const config = aiConfig({ AI_PROVIDER: 'claude', AI_API_KEY: 'k' });
  const text = await requestAnthropic(env, config, {
    system: 's',
    user: 'u',
    images: [],
    maxTokens: 10,
    temperature: 0,
  });
  assert.equal(text, 'fine');
  assert.equal(calls, 2);
});

test('a named provider without a key says which secret is missing', async () => {
  const config = aiConfig({ AI_PROVIDER: 'claude' });
  assert.equal(config.transport, 'anthropic');
  await assert.rejects(
    requestAnthropic({}, config, { system: 's', user: 'u', images: [], maxTokens: 10, temperature: 0 }),
    /AI_PROVIDER=claude needs AI_API_KEY/,
  );
});

const picturePost = {
  tweetId: '255',
  url: 'https://x.com/someone/status/255',
  text: 'A screenshot of a list',
  createdAt: '2026-11-20T00:00:00.000Z',
  author: { name: 'Someone', username: 'someone' },
  media: [
    {
      type: 'photo',
      url: 'https://img.example.com/list.png',
      posterUrl: null,
      altText: 'a list',
    },
  ],
  links: [],
  transcripts: [],
};

const textOnlyEnv = { AI_PROVIDER: 'openai', AI_API_KEY: 'k', AI_MODEL: 'text-only-model' };

function stubSummary(answers) {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const bodies = [];
  const warnings = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === picturePost.media[0].url) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    bodies.push(JSON.parse(String(init.body)));
    const answer = answers[Math.min(bodies.length - 1, answers.length - 1)];
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json', ...answer.headers },
    });
  };
  console.warn = message => warnings.push(String(message));
  return {
    bodies,
    warnings,
    restore() {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    },
  };
}

test('a text-only model refuses the images and still returns a summary', async t => {
  const stub = stubSummary([
    { status: 400, body: { error: { message: 'image_url is not supported' } } },
    { status: 200, body: { choices: [{ message: { content: '  summary from text  ' } }] } },
  ]);
  t.after(stub.restore);

  const result = await summarizePost(picturePost, textOnlyEnv);

  assert.equal(result.text, 'summary from text');
  assert.equal(result.imagesUsed, 0);
  assert.equal(stub.bodies.length, 2);
  assert.equal(stub.bodies[0].messages[1].content[1].type, 'image_url');
  const retryContent = stub.bodies[1].messages[1].content;
  assert.equal(typeof retryContent, 'string');
  assert.doesNotMatch(retryContent, /image_url/);
  assert.match(retryContent, /not attached: the provider's model reads text only/);
  assert.equal(stub.warnings.length, 1);
  assert.match(stub.warnings[0], /HTTP 400/);
  assert.match(stub.warnings[0], /text-only-model/);
});

test('415 and 422 are treated as image refusals too', async t => {
  for (const status of [415, 422]) {
    const stub = stubSummary([
      { status, body: { error: { message: 'unsupported' } } },
      { status: 200, body: { choices: [{ message: { content: 'text summary' } }] } },
    ]);
    try {
      const result = await summarizePost(picturePost, textOnlyEnv);
      assert.equal(result.imagesUsed, 0);
      assert.equal(stub.bodies.length, 2);
      assert.equal(typeof stub.bodies[1].messages[1].content, 'string');
    } finally {
      stub.restore();
    }
  }
});

test('a provider that accepts the picture gets one request and counts it', async t => {
  const stub = stubSummary([
    { status: 200, body: { choices: [{ message: { content: 'a summary' } }] } },
  ]);
  t.after(stub.restore);

  const result = await summarizePost(picturePost, textOnlyEnv);

  assert.equal(result.imagesUsed, 1);
  assert.equal(stub.bodies.length, 1);
  assert.equal(stub.bodies[0].messages[1].content[1].type, 'image_url');
  assert.equal(stub.warnings.length, 0);
});

test('a 429 is retried with the pictures and is not read as a refusal', async t => {
  const stub = stubSummary([
    { status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '0' } },
    { status: 200, body: { choices: [{ message: { content: 'a summary' } }] } },
  ]);
  t.after(stub.restore);

  const result = await summarizePost(picturePost, textOnlyEnv);

  assert.equal(result.imagesUsed, 1);
  assert.equal(stub.bodies.length, 2);
  assert.equal(stub.bodies[1].messages[1].content[1].type, 'image_url');
});
