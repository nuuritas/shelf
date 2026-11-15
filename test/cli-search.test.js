import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The CLI is a Bun script with no exported helpers, so these tests drive it the
// way a user does: run it against a stub API and read the terminal output. That
// is also the only gate over cli/ — tsconfig and the unit tests cover src/ only.

const root = fileURLToPath(new URL('..', import.meta.url));

function note(overrides = {}) {
  return {
    id: '34ab3634-21cb-403c-8603-3c4a3daf0db2',
    ref: 'dk4g3',
    tweetId: 'note-cfdcf535f26829d0',
    url: null,
    kind: 'note',
    format: 'markdown',
    title: 'Research: agent memory',
    content: '# Research: agent memory\n\nFindings.',
    sourceUrl: null,
    agent: { name: 'OpenCode', model: 'deepseek-v4', tool: 'shelf-cli' },
    savedAt: '2026-11-15T09:12:00.000Z',
    summary: 'A short abstract.',
    text: 'Research: agent memory Findings.',
    author: null,
    topics: [],
    archivedAt: null,
    ...overrides,
  };
}

function link() {
  return {
    id: '5c7c1b32-3f4a-4a0e-9d2d-0dcbb2c5d1a4',
    ref: 'k6e8z',
    tweetId: '2048834309994565832',
    url: 'https://x.com/ycombinator/status/2048834309994565832',
    kind: 'link',
    format: null,
    title: null,
    content: null,
    sourceUrl: null,
    agent: null,
    savedAt: '2026-11-13T09:12:00.000Z',
    summary: 'A post about startups.',
    text: 'post body',
    author: { name: 'Y Combinator', username: 'ycombinator' },
    topics: [],
    archivedAt: null,
  };
}

async function runSearch(bookmarks) {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/bookmarks')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ bookmarks, total: bookmarks.length, activeTotal: bookmarks.length, archivedTotal: 0 }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    // spawn, not spawnSync: a synchronous child would block this process's
    // event loop, and the stub server could never answer it.
    const child = spawn(process.env.BUN ?? 'bun', ['cli/shelf.ts', 'search', 'memory'], {
      cwd: root,
      env: { ...process.env, SHELF_URL: `http://127.0.0.1:${port}`, SHELF_PASSWORD: 'test' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk));

    const status = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    return { status, stdout, stderr };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('the CLI runs at all: a script that does not parse exits non-zero', async () => {
  const run = await runSearch([note()]);
  assert.equal(run.status, 0, run.stderr || run.stdout);
});

test('a note row names its agent and its id instead of a null url', async () => {
  const run = await runSearch([note()]);
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /null/);
  assert.match(run.stdout, /^1\. OpenCode · \d{4}-\d{2}-\d{2} · note-cfdcf535f26829d0$/m);
  assert.match(run.stdout, /id: dk4g3/);
});

test('a note with a citation points at it', async () => {
  const run = await runSearch([note({ sourceUrl: 'https://example.com/paper' })]);
  assert.doesNotMatch(run.stdout, /null/);
  assert.match(run.stdout, /^1\. OpenCode · \d{4}-\d{2}-\d{2} · https:\/\/example\.com\/paper$/m);
});

test('a note saved without an agent still has an author', async () => {
  const run = await runSearch([note({ agent: null })]);
  assert.doesNotMatch(run.stdout, /unknown author/);
  assert.match(run.stdout, /^1\. AI agent · \d{4}-\d{2}-\d{2} · note-cfdcf535f26829d0$/m);
});

test('a link row keeps its handle and its url', async () => {
  const run = await runSearch([link()]);
  assert.doesNotMatch(run.stdout, /null/);
  assert.match(
    run.stdout,
    /^1\. @ycombinator · \d{4}-\d{2}-\d{2} · https:\/\/x\.com\/ycombinator\/status\/2048834309994565832$/m,
  );
});
