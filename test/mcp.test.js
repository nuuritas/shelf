import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMcpRequest, mcpBackend } from '../src/mcp.ts';

function request(body, init = {}) {
  return new Request('https://shelf.example/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

function backend(overrides = {}) {
  return {
    search: async () => 'search text',
    get: async () => 'bookmark text',
    listTopics: async () => 'topics text',
    getTopic: async () => 'topic text',
    createPost: async () => 'save text',
    guide: () => 'guide text',
    ...overrides,
  };
}

async function post(body, overrides) {
  const response = await handleMcpRequest(request(body), backend(overrides));
  return { response, payload: await response.json() };
}

test('initialize answers the protocol version and advertises tools', async () => {
  const { response, payload } = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(payload.id, 1);
  assert.equal(payload.result.protocolVersion, '2025-06-18');
  assert.equal(payload.result.serverInfo.name, 'shelf');
  assert.match(payload.result.instructions, /search_bookmarks/);
});

test('tools/list exposes the CLI tool set', async () => {
  const { payload } = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = payload.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'search_bookmarks',
    'get_bookmark',
    'list_topics',
    'get_topic',
    'create_post',
    'get_authoring_guide',
  ]);
  const create = payload.result.tools.find((tool) => tool.name === 'create_post');
  assert.deepEqual(create.inputSchema.required, ['format', 'content', 'agent']);
  assert.deepEqual(create.inputSchema.properties.agent.required, ['name']);
});

test('create_post refuses to credit Shelf MCP as the writer', async () => {
  await assert.rejects(
    () => mcpBackend({}).createPost({ format: 'markdown', content: 'Body.' }),
    /agent\.name` is required/,
  );
});

test('tools/call searches with the label slug and the clamped limit', async () => {
  const calls = [];
  const { payload } = await post(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'search_bookmarks', arguments: { query: 'claude code', label: 'My Reading', limit: 999 } },
    },
    {
      search: async (query, label, limit) => {
        calls.push({ query, label, limit });
        return 'two cards';
      },
    },
  );

  assert.deepEqual(calls, [{ query: 'claude code', label: 'My Reading', limit: 50 }]);
  assert.equal(payload.result.content[0].text, 'two cards');
  assert.equal(payload.result.isError, undefined);
});

test('get_bookmark turns an x.com status URL into the post id', async () => {
  const calls = [];
  await post(
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_bookmark', arguments: { id: 'https://x.com/someone/status/1985100000000000000' } },
    },
    {
      get: async (id) => {
        calls.push(id);
        return 'one bookmark';
      },
    },
  );

  assert.deepEqual(calls, ['1985100000000000000']);
});

test('a tool error is a result with isError, not a broken transport', async () => {
  const { response, payload } = await post({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'search_bookmarks', arguments: { query: '' } },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.result.isError, true);
  assert.match(payload.result.content[0].text, /`query` is required/);
});

test('an unknown tool and an unknown method both answer in JSON', async () => {
  const tool = await post({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'delete_everything', arguments: {} },
  });
  assert.equal(tool.payload.result.isError, true);
  assert.match(tool.payload.result.content[0].text, /Unknown tool/);

  const method = await post({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
  assert.equal(method.payload.error.code, -32601);
});

test('notifications are accepted with an empty 202 and unparseable bodies are 32700', async () => {
  const notification = await handleMcpRequest(
    request({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    backend(),
  );
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), '');

  const broken = await post('{not json');
  assert.equal(broken.payload.error.code, -32700);
});

test('GET has no stream and DELETE ends the stateless session', async () => {
  const get = await handleMcpRequest(
    new Request('https://shelf.example/mcp', { method: 'GET' }),
    backend(),
  );
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');

  const remove = await handleMcpRequest(
    new Request('https://shelf.example/mcp', { method: 'DELETE' }),
    backend(),
  );
  assert.equal(remove.status, 204);
});

test('the backend reads the archive through the Durable Object', async () => {
  const seen = [];
  const card = {
    ref: 'k7f3',
    tweetId: '1985100000000000000',
    url: 'https://x.com/someone/status/1985100000000000000',
    text: 'A post about agents.',
    kind: 'link',
    format: 'text',
    title: null,
    content: null,
    agent: null,
    sourceUrl: null,
    createdAt: '2026-11-15T09:00:00.000Z',
    savedAt: '2026-11-15T09:12:00.000Z',
    author: { name: 'Someone', username: 'someone' },
    topics: [{ slug: 'agents', name: 'Agents' }],
    labels: [{ name: 'Reading', slug: 'reading' }],
    summary: 'An AI summary.',
    summaryStatus: 'done',
    summaryEn: null,
    archivedAt: null,
    links: [],
    media: [],
    transcripts: [],
    versions: [],
  };
  const env = {
    BOOKMARKS: {
      idFromName: () => 'library',
      get: () => ({
        fetch: async (url) => {
          seen.push(String(url));
          return new Response(JSON.stringify({ bookmarks: [card], total: 1 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      }),
    },
  };

  const text = await mcpBackend(env).search('agents', 'Reading', 10);

  assert.equal(seen.length, 1);
  const url = new URL(seen[0]);
  assert.equal(url.pathname, '/list');
  assert.equal(url.searchParams.get('q'), 'agents');
  assert.equal(url.searchParams.get('label'), 'reading');
  assert.equal(url.searchParams.get('view'), 'all');
  assert.match(text, /1 match for “agents”/);
  assert.match(text, /@someone/);
  assert.match(text, /topics: Agents/);
  assert.match(text, /labels: Reading/);
  assert.match(text, /id: k7f3/);
});

test('the backend writes a note through the Durable Object', async () => {
  const seen = [];
  const env = {
    BOOKMARKS: {
      idFromName: () => 'library',
      get: () => ({
        fetch: async (url, init) => {
          seen.push({ url: String(url), body: JSON.parse(init.body) });
          return new Response(
            JSON.stringify({
              created: true,
              bookmark: {
                ref: 'k7f3',
                tweetId: '1985100000000000001',
                format: 'markdown',
                title: 'Daily notes',
              },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        },
      }),
    },
  };

  const text = await mcpBackend(env, 'https://shelf.example').createPost({
    format: 'markdown',
    content: '## Daily notes\n\n- one finding',
    title: 'Daily notes',
    summary: 'A short abstract.',
    clientId: 'daily-2026-11-16',
    agent: { name: 'Claude Code', model: 'claude-sonnet-4.5', tool: 'claude-code' },
  });

  assert.equal(seen.length, 1);
  const url = new URL(seen[0].url);
  assert.equal(url.pathname, '/notes');
  assert.equal(seen[0].body.content, '## Daily notes\n\n- one finding');
  assert.equal(seen[0].body.clientId, 'daily-2026-11-16');
  assert.equal(seen[0].body.agent.tool, 'claude-code');
  assert.match(text, /^Saved note #k7f3 \(markdown\)/);
  assert.match(text, /Read it at https:\/\/shelf\.example\/p\/k7f3/);
});

test('a legacy note reads as AI agent in a card and in show, never Shelf CLI', async () => {
  const bookmark = {
    ref: 'n0te1',
    tweetId: 'note-0011223344556677',
    url: null,
    kind: 'note',
    format: 'markdown',
    title: 'How agent memory works',
    content: '## Memory\n\nBody.',
    text: 'Memory\n\nBody.',
    agent: { name: 'Shelf CLI', model: 'deepseek-v4.1-flash', tool: 'shelf-cli' },
    sourceUrl: null,
    createdAt: '2026-11-19T09:00:00.000Z',
    savedAt: '2026-11-19T09:12:00.000Z',
    topics: [],
    labels: [],
    summary: null,
    archivedAt: null,
  };
  const env = {
    BOOKMARKS: {
      idFromName: () => 'library',
      get: () => ({
        fetch: async (url) => {
          const path = new URL(String(url)).pathname;
          const body = path === '/list' ? { bookmarks: [bookmark], total: 1 } : { bookmark };
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      }),
    },
  };

  const card = await mcpBackend(env).search('memory', '', 10);
  assert.match(card, /AI agent/);
  assert.doesNotMatch(card, /Shelf CLI/);

  const shown = await mcpBackend(env).get('n0te1');
  assert.match(shown, /Written by AI agent · deepseek-v4\.1-flash/);
  assert.doesNotMatch(shown, /Shelf CLI/);
});
