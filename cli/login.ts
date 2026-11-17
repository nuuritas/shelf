/**
 * `shelf login` — one command, one browser tab.
 *
 * The CLI never asks a person for their account password. It starts a listener
 * on a random loopback port, opens the instance's approval page, and the page
 * redirects back with a one-time code that the CLI trades for a device token.
 * The token is what `~/.config/shelf/config.json` holds from then on.
 *
 * A self-hosted Worker has no accounts to sign in to: it is protected by one
 * `APP_PASSWORD`. `login` still works there, it just asks for that password
 * with the terminal echo off and checks it before writing the file.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

type Flags = Record<string, string | boolean>;

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export function configPath(): string {
  return process.env.SHELF_CONFIG || join(homedir(), '.config', 'shelf', 'config.json');
}

function writeConfig(url: string, password: string): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ url, password }, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function flag(args: Flags, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** Read one line, without echoing it when it is a secret. */
async function ask(question: string, secret = false): Promise<string> {
  if (!process.stdin.isTTY) {
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) {
      rl.close();
      return line.trim();
    }
    return '';
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (!secret) {
    const answer = await rl.question(question);
    rl.close();
    return answer.trim();
  }
  const muted = Bun.spawnSync(['stty', '-echo'], { stdin: 'inherit', stdout: 'ignore' });
  try {
    const answer = await rl.question(question);
    process.stdout.write('\n');
    return answer.trim();
  } finally {
    if (muted.exitCode === 0) Bun.spawnSync(['stty', 'echo'], { stdin: 'inherit', stdout: 'ignore' });
    rl.close();
  }
}

function openBrowser(target: string): void {
  const command =
    process.platform === 'darwin'
      ? ['open', target]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', target]
        : ['xdg-open', target];
  try {
    Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' }).unref();
  } catch {
    // A headless machine still has the printed URL.
  }
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: any }> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...((init.headers as Record<string, string>) ?? {}) },
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}

/** The account-aware instance serves `/api/auth/providers`; a Worker does not. */
async function isHosted(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/api/auth/providers`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as Record<string, unknown>;
    return typeof body === 'object' && body !== null && 'google' in body;
  } catch {
    throw new Error(`Could not reach ${base}. Check the URL and try again.`);
  }
}

export async function commandLogin(args: Flags): Promise<void> {
  const candidates = [flag(args, 'url'), process.env.SHELF_URL, 'https://shelfcloud.io'];
  let base = normalizeUrl(candidates.find(value => value && value.trim()) ?? '');
  if (!base) {
    base = normalizeUrl(await ask('Shelf URL: '));
  }
  if (!base) throw new Error('A URL is required, for example https://shelfcloud.io');

  if (await isHosted(base)) {
    await loginHosted(base);
    return;
  }
  await loginWorker(base, flag(args, 'password'));
}

async function loginHosted(base: string): Promise<void> {
  const state = randomBytes(18).toString('base64url');
  let settle: (value: { code: string; state: string }) => void = () => {};
  const callback = new Promise<{ code: string; state: string }>(resolve => {
    settle = resolve;
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/callback') {
        return new Response('Not found', { status: 404 });
      }
      settle({
        code: url.searchParams.get('code') ?? '',
        state: url.searchParams.get('state') ?? '',
      });
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
          '<body style="font:16px system-ui;padding:3rem;text-align:center">' +
          '<h1>Signed in to Shelf</h1><p>You can close this tab and return to the terminal.</p>' +
          '</body>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    },
  });

  const port = server.port;
  const target = `${base}/cli/login?port=${port}&state=${encodeURIComponent(state)}`;
  console.log(`\nOpening ${base} to approve this terminal…`);
  console.log(`If the browser did not open, visit:\n  ${target}\n`);
  openBrowser(target);

  const timer = setTimeout(() => settle({ code: '', state: '' }), CALLBACK_TIMEOUT_MS);
  let result: { code: string; state: string };
  try {
    result = await callback;
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }

  if (!result.code) {
    throw new Error('Login timed out. Run `shelf login` again when you are ready.');
  }
  if (result.state !== state) {
    throw new Error('The approval came back with a different state. Run `shelf login` again.');
  }

  const exchanged = await fetchJson(`${base}/api/auth/cli`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: result.code, name: `shelf-cli ${hostname()}` }),
  });

  if (!exchanged.ok || !exchanged.body?.token) {
    throw new Error(
      exchanged.status === 400
        ? 'That approval expired before the terminal could use it. Run `shelf login` again.'
        : `The token exchange failed (HTTP ${exchanged.status}).`,
    );
  }

  const path = writeConfig(base, exchanged.body.token);
  const who = exchanged.body.email ? ` as ${exchanged.body.email}` : '';
  console.log(`Signed in to ${base}${who}.`);
  console.log(`Saved ${path}`);
}

async function loginWorker(base: string, fromFlag: string): Promise<void> {
  const password = fromFlag || (await ask('App password (APP_PASSWORD): ', true));
  if (!password) throw new Error('No password entered.');

  const check = await fetchJson(`${base}/api/bookmarks?limit=1`, {
    headers: { Authorization: `Bearer ${password}` },
  });
  if (check.status === 401) throw new Error('That password was not accepted.');
  if (!check.ok) throw new Error(`Could not verify the password (HTTP ${check.status}).`);

  const path = writeConfig(base, password);
  console.log(`Signed in to ${base}.`);
  console.log(`Saved ${path}`);
}

export function commandLogout(): void {
  const path = configPath();
  if (!existsSync(path)) {
    console.log(`Already signed out (no ${path}).`);
    return;
  }
  rmSync(path, { force: true });
  console.log(`Signed out. Removed ${path}.`);
  if (process.env.SHELF_PASSWORD) {
    console.log('Note: SHELF_PASSWORD is set in this shell and still wins over the file.');
  }
}
