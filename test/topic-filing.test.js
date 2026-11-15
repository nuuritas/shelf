import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { filingReadySql } from '../src/util.ts';

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
