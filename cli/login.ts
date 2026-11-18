/**
 * `shelf login` — one command, one browser tab.
 *
 * The CLI never asks a person for their account password, and it does not listen
 * on a port either: a public page is no longer allowed to reach `127.0.0.1`, so
 * the loopback handoff lands as a click that does nothing. This is the device
 * grant from RFC 8628 instead, which is what GitHub and Google use for a
 * terminal. Ask for a pair of codes, print the short one, open the page that has
 * it filled in, and poll until the person approves it. Nothing crosses the local
 * network, so it works over SSH and inside a container too.
 *
 * A self-hosted Worker has no accounts to sign in to: it is protected by one
 * `APP_PASSWORD`. `login` still works there, it just asks for that password
 * with the terminal echo off and checks it before writing the file.
 */

import { hostname } from 'node:os';

import { configPath, forgetAccount, normalizeUrl, saveAccount } from './config.ts';

type Flags = Record<string, string | boolean>;

/** The terminal gives up a little after the service's own window closes. */
const CALLBACK_TIMEOUT_MS = 11 * 60 * 1000;
const DEFAULT_INTERVAL_SECONDS = 5;

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
  // A test or a headless shell can keep the printed URL and skip the tab.
  if (process.env.SHELF_NO_BROWSER) return;
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

/**
 * Ask for a device pair, show the code, and poll. A person who is already signed
 * in only presses Authorize; one who is not gets the ordinary login page first
 * and lands back on `/cli` with the code still filled in.
 */
async function loginHosted(base: string): Promise<void> {
  const started = await fetchJson(`${base}/api/auth/cli/pending`, { method: 'POST' });
  if (!started.ok || !started.body?.device_code || !started.body?.user_code) {
    throw new Error(
      started.status === 404
        ? `${base} does not offer terminal sign-in yet. Run \`shelf config\` with a token from the web settings instead.`
        : `Could not start the sign-in (HTTP ${started.status}). Try again in a moment.`,
    );
  }

  const deviceCode: string = started.body.device_code;
  const userCode: string = started.body.user_code;
  const target: string =
    started.body.verification_url || `${base}/cli?code=${encodeURIComponent(userCode)}`;
  const interval = Math.max(
    1,
    Number(started.body.interval) || DEFAULT_INTERVAL_SECONDS,
  );

  console.log(`\nConfirm code ${userCode} in your browser to finish signing in.`);
  console.log(`If it did not open, visit:\n  ${target}\n`);
  console.log('Waiting for approval… (Ctrl-C to cancel)');
  openBrowser(target);

  const deadline = Date.now() + CALLBACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const polled = await fetchJson(`${base}/api/auth/cli`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode, name: `shelf-cli ${hostname()}` }),
    });

    if (polled.ok && polled.body?.token) {
      const saved = saveAccount(base, polled.body.token, {
        email: polled.body.email || undefined,
      });
      const who = polled.body.email ? ` as ${polled.body.email}` : '';
      console.log(`\nSigned in to ${saved.url}${who}.`);
      console.log(`Saved ${saved.path}`);
      return;
    }

    const reason = polled.body?.error;
    if (reason === 'authorization_pending') continue;
    if (reason === 'expired_token') {
      throw new Error('That code expired. Run `shelf login` again to get a new one.');
    }
    throw new Error(`The sign-in failed (HTTP ${polled.status}).`);
  }

  throw new Error('Login timed out. Run `shelf login` again when you are ready.');
}

async function loginWorker(base: string, fromFlag: string): Promise<void> {
  const password = fromFlag || (await ask('App password (APP_PASSWORD): ', true));
  if (!password) throw new Error('No password entered.');

  const check = await fetchJson(`${base}/api/bookmarks?limit=1`, {
    headers: { Authorization: `Bearer ${password}` },
  });
  if (check.status === 401) throw new Error('That password was not accepted.');
  if (!check.ok) throw new Error(`Could not verify the password (HTTP ${check.status}).`);

  const saved = saveAccount(base, password);
  console.log(`Signed in to ${saved.url}.`);
  console.log(`Saved ${saved.path}`);
}

export function commandLogout(args: Flags = {}): void {
  const all = args.all === true || args.all === 'true';
  const { removed, next } = forgetAccount(all);

  if (!removed && !all) {
    console.log('Already signed out.');
    return;
  }
  if (all) {
    console.log('Signed out of every saved account.');
  } else if (removed) {
    console.log(`Signed out of ${removed}.`);
  }

  if (next) {
    console.log(`Now using ${next.url}. \`shelf logout --all\` forgets that one too.`);
  } else {
    console.log(`Removed ${configPath()}.`);
  }

  if (process.env.SHELF_PASSWORD) {
    console.log('Note: SHELF_PASSWORD is set in this shell and still wins over the file.');
  }
}
