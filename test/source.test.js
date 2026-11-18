import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  canonicalRedirectUrl,
  filterInSql,
  parseSource,
  parseSourceList,
  sourceFilterSql,
  sourceFiltersSql,
  sourceOfUrl,
} from '../src/util.ts';

const urls = [
  'https://x.com/nuuritas/status/123',
  'https://twitter.com/nuuritas/status/456',
  'https://mobile.twitter.com/nuuritas/status/789',
  'https://www.linkedin.com/posts/nuuritas_shelf-activity-7123',
  'https://linkedin.com/posts/nuuritas_shelf-activity-7124',
  'https://youtube.com/watch?v=abc',
  'https://m.youtube.com/watch?v=def',
  'https://youtu.be/ghi',
  'https://www.instagram.com/reel/abc/',
  'https://instagram.com/p/def/',
  'https://example.com/blog/post',
  'https://notyoutube.com/watch?v=jkl',
  'https://notinstagram.com/p/ghi/',
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
  assert.equal(sourceOfUrl('https://www.instagram.com/reel/abc/'), 'instagram');
  assert.equal(sourceOfUrl('https://instagram.com/p/def/'), 'instagram');
  assert.equal(sourceOfUrl('https://example.com/post'), 'other');
  assert.equal(sourceOfUrl('https://notyoutube.com/watch?v=abc'), 'other');
  assert.equal(sourceOfUrl('https://notinstagram.com/p/abc/'), 'other');
  assert.equal(sourceOfUrl(''), 'other');
  assert.equal(sourceOfUrl(null), 'other');
});

test('unknown source values fall back to all', () => {
  assert.equal(parseSource('x'), 'x');
  assert.equal(parseSource('LinkedIn'), 'linkedin');
  assert.equal(parseSource(' youtube '), 'youtube');
  assert.equal(parseSource('instagram'), 'instagram');
  assert.equal(parseSource('Instagram'), 'instagram');
  assert.equal(parseSource('note'), 'note');
  assert.equal(parseSource('web'), 'web');
  assert.equal(parseSource('Web'), 'web');
  assert.equal(parseSource('all'), 'all');
  assert.equal(parseSource('other'), 'all');
  assert.equal(parseSource('x; DROP TABLE bookmarks'), 'all');
  assert.equal(parseSource(null), 'all');
});

test('the SQL filter agrees with sourceOfUrl', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE bookmarks (url TEXT, kind TEXT)');
  const insert = db.prepare('INSERT INTO bookmarks (url, kind) VALUES (?, NULL)');
  for (const url of urls) insert.run(url);

  for (const source of ['x', 'linkedin', 'youtube', 'instagram']) {
    const rows = db
      .prepare(`SELECT url FROM bookmarks WHERE ${sourceFilterSql(source)} ORDER BY url`)
      .all()
      .map(row => row.url);
    const expected = urls.filter(url => sourceOfUrl(url) === source).sort();
    assert.deepEqual(rows, expected, `source=${source}`);
  }

  db.close();
});

test('web and note filter a row by its shape, not by its host', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE bookmarks (id TEXT, url TEXT, kind TEXT)');
  const insert = db.prepare('INSERT INTO bookmarks (id, url, kind) VALUES (?, ?, ?)');
  const rows = [
    ['li-post', 'https://www.linkedin.com/posts/a', 'post'],
    ['note-cites', 'https://example.com/paper', 'note'],
    ['note-plain', '', 'note'],
    ['page-null-kind', 'https://example.com/blog/post', null],
    ['page-post', 'https://example.com/blog/other', 'post'],
    ['x-post', 'https://x.com/a/status/1', 'post'],
    ['yt-video', 'https://youtu.be/abc', 'post'],
    ['ig-post', 'https://www.instagram.com/reel/abc/', 'post'],
  ];
  for (const row of rows) insert.run(...row);

  const ids = sql =>
    db
      .prepare(`SELECT id FROM bookmarks WHERE ${sql} ORDER BY id`)
      .all()
      .map(row => row.id);

  // A note that cites a page is an artifact, never a saved page.
  assert.deepEqual(ids(sourceFilterSql('note')), ['note-cites', 'note-plain']);
  assert.deepEqual(ids(sourceFilterSql('instagram')), ['ig-post']);
  // A saved Instagram post is its own platform, never an uncategorized page.
  assert.deepEqual(ids(sourceFilterSql('web')), ['page-null-kind', 'page-post']);
  assert.deepEqual(ids(sourceFiltersSql(['web', 'note'])), [
    'note-cites',
    'note-plain',
    'page-null-kind',
    'page-post',
  ]);

  db.close();
});

test('repeated source values OR together and an unknown value opens the cut', () => {
  assert.deepEqual(parseSourceList(['x', 'youtube']), ['x', 'youtube']);
  assert.deepEqual(parseSourceList([' youtube ', 'X', 'youtube']), ['youtube', 'x']);
  assert.deepEqual(parseSourceList(['web', 'note']), ['web', 'note']);
  assert.deepEqual(parseSourceList(['x', 'all']), []);
  assert.deepEqual(parseSourceList(['x', 'nope']), []);
  assert.deepEqual(parseSourceList([]), []);
});

test('the OR source predicate matches every selected platform', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE bookmarks (url TEXT)');
  const insert = db.prepare('INSERT INTO bookmarks (url) VALUES (?)');
  for (const url of urls) insert.run(url);

  const rows = db
    .prepare(`SELECT url FROM bookmarks WHERE ${sourceFiltersSql(['x', 'youtube'])} ORDER BY url`)
    .all()
    .map(row => row.url);
  const expected = urls
    .filter(url => ['x', 'youtube'].includes(sourceOfUrl(url)))
    .sort();
  assert.deepEqual(rows, expected);
  assert.equal(sourceFiltersSql([]), '');

  db.close();
});

test('repeated topic and label values OR within a cut and stay AND-ed across cuts', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE bookmarks (tweet_id TEXT, url TEXT);
    CREATE TABLE item_topics (tweet_id TEXT, slug TEXT);
    CREATE TABLE bookmark_labels (tweet_id TEXT, slug TEXT);
  `);
  const bookmarks = [
    ['x-ai', 'https://x.com/a/status/1'],
    ['yt-ai', 'https://youtube.com/watch?v=abc'],
    ['li-design', 'https://www.linkedin.com/posts/a'],
  ];
  const insertBookmark = db.prepare('INSERT INTO bookmarks (tweet_id, url) VALUES (?, ?)');
  const insertTopic = db.prepare('INSERT INTO item_topics (tweet_id, slug) VALUES (?, ?)');
  const insertLabel = db.prepare('INSERT INTO bookmark_labels (tweet_id, slug) VALUES (?, ?)');
  for (const [id, url] of bookmarks) insertBookmark.run(id, url);
  insertTopic.run('x-ai', 'ai');
  insertTopic.run('yt-ai', 'ai');
  insertTopic.run('li-design', 'design');
  insertLabel.run('x-ai', 'true');
  insertLabel.run('yt-ai', '2');
  insertLabel.run('li-design', '2');

  const filters = [];
  const args = [];
  const topic = filterInSql('slug', ['ai', 'design']);
  if (topic) {
    filters.push(`tweet_id IN (SELECT tweet_id FROM item_topics WHERE ${topic.sql})`);
    args.push(...topic.args);
  }
  const label = filterInSql('slug', ['true', '2', '2']);
  if (label) {
    filters.push(`tweet_id IN (SELECT tweet_id FROM bookmark_labels WHERE ${label.sql})`);
    args.push(...label.args);
  }
  filters.push(sourceFiltersSql(['x', 'youtube']));
  const rows = db
    .prepare(`SELECT tweet_id FROM bookmarks WHERE ${filters.join(' AND ')} ORDER BY tweet_id`)
    .all(...args)
    .map(row => row.tweet_id);
  assert.deepEqual(rows, ['x-ai', 'yt-ai']);

  assert.deepEqual(filterInSql('slug', ['a', 'a', 'b']), {
    sql: 'slug IN (?, ?)',
    args: ['a', 'b'],
  });
  assert.equal(filterInSql('slug', []), null);

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
