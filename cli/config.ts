/**
 * The credential file, and the accounts inside it.
 *
 * It used to hold one URL and one password, so `shelf login` to a second
 * instance — the command defaults to the hosted one — overwrote the first, and
 * getting back meant typing that password again. The file now keeps every
 * instance it has signed in to and names the active one at the top level, in the
 * same `{ url, password }` shape an older build reads, so switching is a pointer
 * move rather than a re-login.
 *
 * Environment variables still win over the file: SHELF_URL and SHELF_PASSWORD
 * describe the instance for that shell, and `shelf use` cannot override them.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Account {
  password: string;
  /** The address a hosted sign-in answered with; absent for a Worker. */
  email?: string;
  /** ISO time of the sign-in that wrote this entry, used to pick a fallback. */
  signedInAt?: string;
}

export interface ConfigFile {
  url?: string;
  password?: string;
  accounts?: Record<string, Account>;
}

export interface StoredAccount {
  url: string;
  account: Account;
}

export interface ReadConfig {
  url: string;
  password: string;
  source: string;
  accounts: StoredAccount[];
}

export function configPath(): string {
  return process.env.SHELF_CONFIG || join(homedir(), '.config', 'shelf', 'config.json');
}

/**
 * Location used before the app was renamed. Read once so an existing password
 * keeps working; the next write lands on the new path.
 */
export function legacyConfigPath(): string {
  return join(homedir(), '.config', 'xbv', 'config.json');
}

export function normalizeUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function readRaw(path: string): ConfigFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ConfigFile;
  } catch {
    throw new Error(`Invalid JSON in ${path}`);
  }
}

/**
 * A file written before accounts existed holds one credential at the top level.
 * Seed it as an account so the first sign-in to another instance keeps it
 * instead of silently replacing it.
 */
function seedAccounts(file: ConfigFile): Record<string, Account> {
  const accounts: Record<string, Account> = { ...(file.accounts ?? {}) };
  const url = normalizeUrl(file.url ?? '');
  if (url && file.password && !accounts[url]) accounts[url] = { password: file.password };
  return accounts;
}

export function readConfigFile(): ReadConfig | null {
  const paths = process.env.SHELF_CONFIG
    ? [configPath()]
    : [configPath(), legacyConfigPath()];

  for (const path of paths) {
    const file = readRaw(path);
    if (!file) continue;
    const url = normalizeUrl(file.url ?? '');
    if (!url || !file.password) continue;
    return {
      url,
      password: file.password,
      source: path,
      accounts: Object.entries(seedAccounts(file)).map(([url, account]) => ({ url, account })),
    };
  }

  return null;
}

function writeConfig(url: string, password: string, accounts: Record<string, Account>): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // The file holds credentials: create it private and fix the mode on an
  // existing file, which `writeFileSync` otherwise leaves at 0644.
  writeFileSync(path, `${JSON.stringify({ url, password, accounts }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  return path;
}

function accountMap(accounts: StoredAccount[]): Record<string, Account> {
  return Object.fromEntries(accounts.map(entry => [entry.url, entry.account]));
}

/** Sign in to one instance: upsert its entry, and make it the active one. */
export function saveAccount(
  url: string,
  password: string,
  extra: Omit<Account, 'password'> = {},
): { path: string; url: string } {
  const base = normalizeUrl(url);
  if (!base) throw new Error('A URL is required, for example https://shelfcloud.io');
  const existing = readConfigFile();
  const accounts = existing ? accountMap(existing.accounts) : {};
  accounts[base] = {
    ...accounts[base],
    ...extra,
    password,
    signedInAt: extra.signedInAt ?? new Date().toISOString(),
  };
  writeConfig(base, password, accounts);
  return { path: configPath(), url: base };
}

function matches(entry: StoredAccount, target: string): boolean {
  const wanted = target.trim().toLowerCase().replace(/\/+$/, '');
  if (!wanted) return false;
  const url = entry.url.toLowerCase();
  if (wanted === url || wanted === url.replace(/^https?:\/\//, '')) return true;
  return Boolean(entry.account.email && wanted === entry.account.email.toLowerCase());
}

/** Point the CLI at a saved instance, by URL, host or the address it signed in with. */
export function activateAccount(target: string): StoredAccount {
  const existing = readConfigFile();
  if (!existing) {
    throw new Error(`No saved accounts in ${configPath()}. Run \`shelf login\` first.`);
  }
  const entry = existing.accounts.find(candidate => matches(candidate, target));
  if (!entry) {
    const known = existing.accounts.map(candidate => candidate.url).join(', ');
    throw new Error(`No saved account matches ${target}. Saved: ${known}`);
  }
  writeConfig(entry.url, entry.account.password, accountMap(existing.accounts));
  return entry;
}

/**
 * Forget the active instance and fall back to the newest other one. `all` empties
 * the file instead, which is the old logout.
 */
export function forgetAccount(all = false): { removed: string; next: StoredAccount | null } {
  const existing = readConfigFile();
  if (!existing) {
    rmSync(configPath(), { force: true });
    if (!process.env.SHELF_CONFIG) rmSync(legacyConfigPath(), { force: true });
    return { removed: '', next: null };
  }

  if (all) {
    rmSync(configPath(), { force: true });
    if (!process.env.SHELF_CONFIG) rmSync(legacyConfigPath(), { force: true });
    return { removed: existing.url, next: null };
  }

  const remaining = existing.accounts.filter(entry => entry.url !== existing.url);
  if (!remaining.length) {
    rmSync(existing.source, { force: true });
    return { removed: existing.url, next: null };
  }

  const next = [...remaining].sort((a, b) =>
    (b.account.signedInAt ?? '').localeCompare(a.account.signedInAt ?? ''),
  )[0] as StoredAccount;
  writeConfig(next.url, next.account.password, accountMap(remaining));
  return { removed: existing.url, next };
}
