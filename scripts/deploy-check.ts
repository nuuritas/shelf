#!/usr/bin/env bun
/**
 * The check that runs before `cf deploy` sees a single file.
 *
 * A Worker deploy publishes the working tree, not a commit: `src/` is bundled
 * from disk and `public/` is copied whole. Nothing in that path asks git what
 * HEAD is, so an unfinished edit on a feature branch uploads as happily as
 * clean `main` — which is how a restyle that was still in progress went to
 * production.
 *
 * So: deploy only `main`, only what is committed, and only what `origin/main`
 * already has. A dry run (`bun run deploy:dry`) skips this check, because it
 * uploads nothing.
 *
 * Only the files that actually ship are checked: a change under `src/` or
 * `public/` blocks a deploy even when it is untracked, while a local config at
 * the repository root (`wrangler.personal.jsonc`) is left alone.
 */

import { spawnSync } from 'node:child_process';

/** Directories `cf deploy` reads: the bundle entry's tree and the asset dir. */
export const SHIPPED = ['src/', 'public/'];

export type RepoState = {
  /** `git rev-parse --abbrev-ref HEAD`, or `''` outside a work tree. */
  branch: string;
  /** Raw `git status --porcelain` lines. */
  status: string[];
  /** Commits on HEAD that `origin/main` does not have. */
  ahead: number;
  /** Commits on `origin/main` that HEAD does not have. */
  behind: number;
  /** Whether `origin/main` resolves at all. */
  hasOriginMain: boolean;
};

/**
 * The porcelain lines that would reach the deployed Worker. A tracked file
 * counts wherever it lives; an untracked one only counts inside `src/` or
 * `public/`, because those are the two trees the deploy reads.
 */
export function shippedChanges(status: string[]): string[] {
  const paths: string[] = [];
  for (const raw of status) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    const flag = line.slice(0, 2);
    const path = line.slice(3).replace(/^"|"$/g, '');
    if (flag !== '??') paths.push(path);
    else if (SHIPPED.some((dir) => path.startsWith(dir))) paths.push(path);
  }
  return paths;
}

/** Every reason not to deploy, in the order a person would fix them. */
export function evaluate(state: RepoState): string[] {
  const problems: string[] = [];

  if (!state.branch) {
    problems.push('not a git work tree: run this from the repository');
    return problems;
  }

  if (state.branch !== 'main') {
    problems.push(
      state.branch === 'HEAD'
        ? 'HEAD is detached. Deploys come from main: git switch main'
        : `on branch '${state.branch}'. Deploys come from main: git switch main`,
    );
  }

  const shipped = shippedChanges(state.status);
  if (shipped.length > 0) {
    const listed = shipped.slice(0, 5).join(', ');
    const rest = shipped.length > 5 ? `, +${shipped.length - 5} more` : '';
    problems.push(
      `${shipped.length} uncommitted change${shipped.length === 1 ? '' : 's'} would ship ` +
        `(${listed}${rest}). src/ is bundled and public/ is copied from disk, so commit first.`,
    );
  }

  if (!state.hasOriginMain) {
    problems.push('origin/main is not fetched: git fetch origin main');
  } else if (state.behind > 0) {
    problems.push(
      `main is ${state.behind} commit${state.behind === 1 ? '' : 's'} behind ` +
        'origin/main: git pull --ff-only, then deploy again',
    );
  }

  return problems;
}

function git(args: string[]): { ok: boolean; out: string } {
  const run = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: run.status === 0, out: run.stdout ?? '' };
}

/** `git` for a single value, where surrounding whitespace is noise. */
function gitText(args: string[]): string {
  return git(args).out.trim();
}

function readState(): RepoState {
  if (!git(['rev-parse', '--git-dir']).ok) {
    return { branch: '', status: [], ahead: 0, behind: 0, hasOriginMain: false };
  }

  // Refreshing origin/main is what makes "is this main?" mean "is this the
  // commit GitHub has?". Offline, the local ref is all there is: say so and
  // let the check fall back to it rather than pretending it is current.
  if (!git(['fetch', '--quiet', 'origin', 'main']).ok) {
    console.warn('deploy guard: cannot reach origin, comparing against the last fetch');
  }

  const branch = gitText(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git(['status', '--porcelain']).out.split('\n');
  const hasOriginMain = git(['rev-parse', '--verify', '--quiet', 'origin/main']).ok;
  const ahead = hasOriginMain ? Number(gitText(['rev-list', '--count', 'origin/main..HEAD']) || 0) : 0;
  const behind = hasOriginMain ? Number(gitText(['rev-list', '--count', 'HEAD..origin/main']) || 0) : 0;

  return { branch, status, ahead, behind, hasOriginMain };
}

function main(): void {
  const state = readState();
  const problems = evaluate(state);

  if (problems.length > 0) {
    console.error('deploy guard refused:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const sha = gitText(['rev-parse', '--short', 'HEAD']);
  const note = state.ahead > 0 ? ` (${state.ahead} commit(s) not yet pushed)` : '';
  console.log(`deploy guard: main @ ${sha}, clean and level with origin/main${note}`);
}

if (import.meta.main) main();
