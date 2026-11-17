import assert from 'node:assert/strict';
import test from 'node:test';
import { searchQuerySql } from '../src/util.ts';

const placeholderCount = sql => sql.match(/\?/g)?.length ?? 0;

test('no terms means no predicate', () => {
  assert.equal(searchQuerySql([]), null);
  assert.equal(searchQuerySql(['', '']), null);
});

test('one term searches the url column, one argument per placeholder', () => {
  const query = searchQuerySql(['bloomberg']);
  assert.ok(query);
  assert.ok(query.sql.includes("instr(lower(COALESCE(url, '')), lower(?)) > 0"));
  assert.equal(query.args.length, placeholderCount(query.sql));
  assert.ok(query.args.length > 0);
  assert.ok(query.args.every(arg => arg === 'bloomberg'));
});

test('two terms are separate AND-ed groups, arguments in term order', () => {
  const single = searchQuerySql(['claude']);
  assert.ok(single);
  const query = searchQuerySql(['claude', 'code']);
  assert.ok(query);
  assert.equal(query.sql.split(' AND ').length, 2);
  assert.equal(query.args.length, placeholderCount(query.sql));
  const perTerm = single.args.length;
  assert.deepEqual(query.args.slice(0, perTerm), Array(perTerm).fill('claude'));
  assert.deepEqual(query.args.slice(perTerm), Array(perTerm).fill('code'));
});

test('nine terms are capped at eight', () => {
  const terms = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];
  const query = searchQuerySql(terms);
  assert.ok(query);
  assert.equal(query.sql.split(' AND ').length, 8);
  assert.equal(query.args.length, placeholderCount(query.sql));
  assert.equal(query.args.at(-1), 't8');
  assert.ok(!query.args.includes('t9'));
});

test('a term is bound unchanged', () => {
  const term = 'Bloomberg.com/news?x=1&y=2';
  const query = searchQuerySql([term]);
  assert.ok(query);
  assert.ok(query.args.every(arg => arg === term));
});
