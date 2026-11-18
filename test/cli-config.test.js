import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// `shelf login` used to write the one credential slot, so signing in to a second
// instance silently dropped the first. These tests run the CLI the way a person
// does — with SHELF_CONFIG on a throwaway file — and read the file back.

const root = fileURLToPath(new URL('..', import.meta.url));

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'shelf-config-'));
  return {
    path: join(dir, 'config.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function read(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function write(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function run(args, configPath) {
  const child = spawn(process.env.BUN ?? 'bun', ['cli/shelf.ts', ...args], {
    cwd: root,
    env: {
      ...process.env,
      SHELF_CONFIG: configPath,
      // Keep the real browser closed; the printed URL is still in the output.
      SHELF_NO_BROWSER: '1',
      SHELF_URL: '',
      SHELF_PASSWORD: '',
      XBV_URL: '',
      XBV_PASSWORD: '',
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk));
  const code = await new Promise(resolve => child.on('close', resolve));
  return { code, stdout, stderr };
}

/** The hosted flow: providers, a device pair, then a token on the first poll. */
async function hostedStub() {
  const server = createServer((req, res) => {
    if (req.url === '/api/auth/providers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ google: { enabled: false }, apple: { enabled: false }, appSchemes: [] }));
      return;
    }
    if (req.url === '/api/auth/cli/pending') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        device_code: 'device-1',
        user_code: 'BCDF-GHJK',
        verification_url: 'https://shelf.example/cli?code=BCDF-GHJK',
        interval: 1,
        expires_in: 600,
      }));
      return;
    }
    if (req.url === '/api/auth/cli') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'cloud-token', email: 'me@example.com' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** A self-hosted Worker: no providers route, one bearer password. */
async function workerStub(password) {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/bookmarks') && req.headers.authorization === `Bearer ${password}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ bookmarks: [], total: 0, activeTotal: 0, archivedTotal: 0 }));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('a login keeps the instance that was already signed in', async () => {
  const { path, cleanup } = scratch();
  const hosted = await hostedStub();
  const worker = await workerStub('worker-pw');
  // The pre-accounts shape: one URL and one password at the top level.
  write(path, { url: worker.url, password: 'worker-pw' });

  try {
    const result = await run(['login', '--url', hosted.url], path);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Signed in to http:\/\/127\.0\.0\.1:\d+ as me@example\.com/);

    const saved = read(path);
    assert.equal(saved.url, hosted.url);
    assert.equal(saved.password, 'cloud-token');
    assert.deepEqual(Object.keys(saved.accounts).sort(), [worker.url, hosted.url].sort());
    assert.equal(saved.accounts[worker.url].password, 'worker-pw', 'the Worker password survived');
    assert.equal(saved.accounts[hosted.url].email, 'me@example.com');
  } finally {
    hosted.server.close();
    worker.server.close();
    cleanup();
  }
});

test('shelf use switches back without signing in again', async () => {
  const { path, cleanup } = scratch();
  write(path, {
    url: 'https://shelfcloud.io',
    password: 'cloud-token',
    accounts: {
      'https://shelfcloud.io': { password: 'cloud-token', email: 'me@example.com' },
      'https://worker.example': { password: 'worker-pw' },
    },
  });

  try {
    const result = await run(['use', 'worker.example'], path);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Now using https:\/\/worker\.example\./);

    const saved = read(path);
    assert.equal(saved.url, 'https://worker.example');
    assert.equal(saved.password, 'worker-pw');
    assert.deepEqual(Object.keys(saved.accounts).sort(), ['https://shelfcloud.io', 'https://worker.example']);
  } finally {
    cleanup();
  }
});

test('shelf use without a target lists the accounts and marks the active one', async () => {
  const { path, cleanup } = scratch();
  write(path, {
    url: 'https://shelfcloud.io',
    password: 'cloud-token',
    accounts: {
      'https://shelfcloud.io': { password: 'cloud-token', email: 'me@example.com' },
      'https://worker.example': { password: 'worker-pw' },
    },
  });

  try {
    const result = await run(['use'], path);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\* https:\/\/shelfcloud\.io\s+\(me@example\.com\)/);
    assert.match(result.stdout, / {2}https:\/\/worker\.example/);
    assert.match(result.stdout, /shelf use <url\|email>/);
  } finally {
    cleanup();
  }
});

test('logout forgets the active account, and --all empties the file', async () => {
  const { path, cleanup } = scratch();
  write(path, {
    url: 'https://shelfcloud.io',
    password: 'cloud-token',
    accounts: {
      'https://shelfcloud.io': { password: 'cloud-token', email: 'me@example.com', signedInAt: '2026-11-18T00:00:00.000Z' },
      'https://worker.example': { password: 'worker-pw', signedInAt: '2026-11-17T00:00:00.000Z' },
    },
  });

  try {
    const first = await run(['logout'], path);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /Signed out of https:\/\/shelfcloud\.io\./);
    assert.match(first.stdout, /Now using https:\/\/worker\.example\./);
    assert.equal(read(path).url, 'https://worker.example');

    const second = await run(['logout', '--all'], path);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout.includes('Signed out of every saved account.'), true);
    assert.throws(() => read(path), /ENOENT/);
  } finally {
    cleanup();
  }
});

test('a Worker login keeps the hosted account too', async () => {
  const { path, cleanup } = scratch();
  const worker = await workerStub('worker-pw');
  write(path, {
    url: 'https://shelfcloud.io',
    password: 'cloud-token',
    accounts: { 'https://shelfcloud.io': { password: 'cloud-token', email: 'me@example.com' } },
  });

  try {
    const result = await run(['login', '--url', worker.url, '--password', 'worker-pw'], path);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Signed in to http:\/\/127\.0\.0\.1:\d+\./);

    const saved = read(path);
    assert.equal(saved.url, worker.url);
    assert.equal(saved.accounts['https://shelfcloud.io'].password, 'cloud-token');
  } finally {
    worker.server.close();
    cleanup();
  }
});
