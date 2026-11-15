import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, shippedChanges } from '../scripts/deploy-check.ts';

const clean = {
  branch: 'main',
  status: [],
  ahead: 0,
  behind: 0,
  hasOriginMain: true,
};

test('clean main with a fetched origin deploys', () => {
  assert.deepEqual(evaluate(clean), []);
});

test('another branch is refused and named', () => {
  const problems = evaluate({ ...clean, branch: 'feat/restyle' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /feat\/restyle/);
  assert.match(problems[0], /git switch main/);
});

test('a detached HEAD is refused, not reported as a branch called HEAD', () => {
  const problems = evaluate({ ...clean, branch: 'HEAD' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /detached/i);
});

test('outside a git work tree there is nothing to deploy from', () => {
  const problems = evaluate({ ...clean, branch: '', hasOriginMain: false });
  assert.deepEqual(problems, ['not a git work tree: run this from the repository']);
});

test('a tracked edit anywhere blocks the deploy', () => {
  const problems = evaluate({ ...clean, status: [' M docs/AGENT-POSTS.md'] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /docs\/AGENT-POSTS\.md/);
});

test('an untracked file under src/ or public/ blocks, one at the root does not', () => {
  assert.deepEqual(shippedChanges(['?? public/fonts/Inter.woff2']), ['public/fonts/Inter.woff2']);
  assert.deepEqual(shippedChanges(['?? src/scratch.ts']), ['src/scratch.ts']);
  assert.deepEqual(shippedChanges(['?? wrangler.personal.jsonc', '?? public/fonts/x.woff2']), [
    'public/fonts/x.woff2',
  ]);
});

test('a long dirty list is abbreviated instead of dumped', () => {
  const status = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => ` M src/${name}.ts`);
  const problems = evaluate({ ...clean, status });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /7 uncommitted changes/);
  assert.match(problems[0], /\+2 more/);
});

test('being behind origin/main is refused, being ahead is not', () => {
  assert.match(evaluate({ ...clean, behind: 2 })[0], /2 commits behind/);
  assert.deepEqual(evaluate({ ...clean, ahead: 3 }), []);
});

test('an unfetched origin/main is refused rather than assumed', () => {
  const problems = evaluate({ ...clean, hasOriginMain: false });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /git fetch origin main/);
});

test('every problem is reported at once, not one per attempt', () => {
  const problems = evaluate({
    branch: 'fix/apk-launcher',
    status: [' M src/render.ts'],
    ahead: 0,
    behind: 4,
    hasOriginMain: true,
  });
  assert.equal(problems.length, 3);
});
