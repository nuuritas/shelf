import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { canonicalRedirectUrl, parseSource, sourceFilterSql, sourceOfUrl } from '../src/util.ts';

const urls = [
  'https://x.com/nuuritas/status/123',
  'https://twitter.com/nuuritas/status/456',
  'https://mobile.twitter.com/nuuritas/status/789',
  'https://www.linkedin.com/posts/nuuritas_shelf-activity-7123',
  'https://linkedin.com/posts/nuuritas_shelf-activity-7124',
  'https://youtube.com/watch?v=abc',
  'https://m.youtube.com/watch?v=def',
  'https://youtu.be/ghi',
  'https://example.com/blog/post',
  'https://notyoutube.com/watch?v=jkl',
  'not a url',
  '',
];

test('maps a bookmark URL to its platform', () => {
  assert.equal(sourceOfUrl('https://x.com/a/status/1'), 'x');
  assert.equal(sourceOfUrl('https://twitter.com/a/status/1'), 'x');
  assert.equal(sourceOfUrl('https://mobile.twitter.com/a/status/1'), 'x');
  assert.equal(sourceOfUrl('https://www.linkedin.com/posts/a'), 'linkedin');
  assert.equal(sourceOfUrl('https://youtu.be/abc'), 'youtube');
  assert.equal(sourceOfUrl('https://m.youtube.com/watch?v=abc'), 'youtube');
  assert.equal(sourceOfUrl('https://example.com/post'), 'other');
  assert.equal(sourceOfUrl('https://notyoutube.com/watch?v=abc'), 'other');
  assert.equal(sourceOfUrl(''), 'other');
  assert.equal(sourceOfUrl(null), 'other');
});

test('unknown source values fall back to all', () => {
  assert.equal(parseSource('x'), 'x');
  assert.equal(parseSource('LinkedIn'), 'linkedin');
  assert.equal(parseSource(' youtube '), 'youtube');
  assert.equal(parseSource('all'), 'all');
  assert.equal(parseSource('other'), 'all');
  assert.equal(parseSource('x; DROP TABLE bookmarks'), 'all');
  assert.equal(parseSource(null), 'all');
});

test('the SQL filter agrees with sourceOfUrl', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE bookmarks (url TEXT)');
  const insert = db.prepare('INSERT INTO bookmarks (url) VALUES (?)');
  for (const url of urls) insert.run(url);

  for (const source of ['x', 'linkedin', 'youtube']) {
    const rows = db
      .prepare(`SELECT url FROM bookmarks WHERE ${sourceFilterSql(source)} ORDER BY url`)
      .all()
      .map(row => row.url);
    const expected = urls.filter(url => sourceOfUrl(url) === source).sort();
    assert.deepEqual(rows, expected, `source=${source}`);
  }

  db.close();
});


test('legacy hosts move to the canonical host, others are untouched', () => {
  const url = new URL('https://bookmark.example.com/t/ai?source=youtube');
  assert.equal(
    canonicalRedirectUrl(url, 'shelf.example.com', 'bookmark.example.com, old.example.com'),
    'https://shelf.example.com/t/ai?source=youtube',
  );
  assert.equal(
    canonicalRedirectUrl(new URL('https://shelf.example.com/x'), 'shelf.example.com', 'bookmark.example.com'),
    null,
  );
  assert.equal(
    canonicalRedirectUrl(new URL('https://unrelated.example/x'), 'shelf.example.com', 'bookmark.example.com'),
    null,
  );
  assert.equal(canonicalRedirectUrl(url, '', 'bookmark.example.com'), null);
});
