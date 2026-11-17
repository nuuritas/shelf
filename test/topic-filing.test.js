import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { filingReadySql, TOPIC_LIST_SQL, TOPIC_PROMPT_LIMIT } from '../src/util.ts';

function library() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE bookmarks (
    tweet_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'post',
    summary_status TEXT NOT NULL,
    topics_status TEXT NOT NULL
  )`);
  const insert = db.prepare(
    'INSERT INTO bookmarks (tweet_id, kind, summary_status, topics_status) VALUES (?, ?, ?, ?)',
  );
  insert.run('post-done', 'post', 'done', 'pending');
  insert.run('post-disabled', 'post', 'disabled', 'pending');
  insert.run('post-filed', 'post', 'done', 'done');
  insert.run('note-no-abstract', 'note', 'disabled', 'pending');
  insert.run('note-abstract', 'note', 'done', 'pending');
  insert.run('note-summarizing', 'note', 'pending', 'pending');
  return db;
}

function unfiled(db, aiConfigured) {
  return db
    .prepare(
      `SELECT tweet_id FROM bookmarks
       WHERE ${filingReadySql(aiConfigured)} AND topics_status = 'pending'
       ORDER BY tweet_id`,
    )
    .all()
    .map(row => row.tweet_id);
}

test('a configured Worker files notes from their own text and posts after a summary', () => {
  const db = library();
  assert.deepEqual(unfiled(db, true), [
    'note-abstract',
    'note-no-abstract',
    'note-summarizing',
    'post-done',
  ]);
  db.close();
});

test('without AI only summarized rows are selected, so notes stay pending', () => {
  const db = library();
  assert.deepEqual(unfiled(db, false), ['note-abstract', 'post-done']);
  db.close();
});

const TOPIC_COUNT = 50;

/** A library with more topics than the prompt cap, each used a different amount. */
function taxonomy() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE bookmarks (
    tweet_id TEXT PRIMARY KEY,
    archived_at TEXT
  )`);
  db.exec(`CREATE TABLE topics (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    overview TEXT,
    overview_at TEXT
  )`);
  db.exec(`CREATE TABLE item_topics (
    tweet_id TEXT NOT NULL,
    slug TEXT NOT NULL
  )`);
  const addTopic = db.prepare(
    `INSERT INTO topics (slug, name, description, overview, overview_at)
     VALUES (?, ?, ?, NULL, NULL)`,
  );
  const addBookmark = db.prepare('INSERT INTO bookmarks (tweet_id, archived_at) VALUES (?, NULL)');
  const addItemTopic = db.prepare('INSERT INTO item_topics (tweet_id, slug) VALUES (?, ?)');
  for (let index = 1; index <= TOPIC_COUNT; index += 1) {
    const slug = `topic-${String(index).padStart(2, '0')}`;
    addTopic.run(slug, `Topic ${index}`, `Description ${index}`);
    for (let post = 1; post <= index; post += 1) {
      const tweetId = `${slug}-post-${post}`;
      addBookmark.run(tweetId);
      addItemTopic.run(tweetId, slug);
    }
  }
  return db;
}

test('the filing prompt lists the busiest topics, capped', () => {
  const db = taxonomy();
  const capped = db.prepare(`${TOPIC_LIST_SQL} LIMIT ?`).all(TOPIC_PROMPT_LIMIT);

  assert.equal(TOPIC_PROMPT_LIMIT, 40);
  assert.equal(capped.length, TOPIC_PROMPT_LIMIT);
  assert.equal(capped[0].slug, 'topic-50');
  assert.equal(capped[0].count, 50);
  for (let index = 1; index < capped.length; index += 1) {
    assert.ok(
      capped[index].count <= capped[index - 1].count,
      `counts are not descending at row ${index}`,
    );
  }

  const all = db.prepare(TOPIC_LIST_SQL).all();
  assert.equal(all.length, TOPIC_COUNT);
  db.close();
});
