import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { isAiConfigured } from '../src/ai.ts';
import { recoverWaitingSummariesSql } from '../src/util.ts';

const SCHEMA = `CREATE TABLE bookmarks (
    tweet_id TEXT PRIMARY KEY,
    saved_at TEXT NOT NULL,
    summary_status TEXT NOT NULL,
    summary_error TEXT,
    summary_started_at INTEGER,
    summary_attempts INTEGER NOT NULL DEFAULT 0,
    summary_retry_at INTEGER,
    kind TEXT NOT NULL DEFAULT 'post'
  )`;

/**
 * One in-memory library. Each entry is a row: `id`, `status`, and optionally
 * `kind`, `savedAt`, or the error columns. Every row starts with a stale error
 * and a retry stamp, so a test can prove which columns a pass clears and which
 * rows it leaves alone.
 */
function library(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const insert = db.prepare(
    `INSERT INTO bookmarks
       (tweet_id, saved_at, summary_status, summary_error, summary_started_at,
        summary_attempts, summary_retry_at, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  rows.forEach((row, index) => {
    insert.run(
      row.id,
      row.savedAt ?? `2026-11-14T08:${String(index + 1).padStart(2, '0')}:00.000Z`,
      row.status,
      row.error === undefined ? `parked as ${row.status}` : row.error,
      row.startedAt ?? 1,
      row.attempts ?? 2,
      row.retryAt ?? 1,
      row.kind ?? 'post',
    );
  });
  return db;
}

const PARKED = ['disabled', 'idle', 'needs_key'];

/** `count` parked posts, oldest first, cycling the three parked states. */
function parkedPosts(count, status) {
  return Array.from({ length: count }, (_, index) => ({
    id: `d${index + 1}`,
    status: status ?? PARKED[index % PARKED.length],
  }));
}

function rows(db, status) {
  return db
    .prepare('SELECT tweet_id FROM bookmarks WHERE summary_status = ? ORDER BY saved_at')
    .all(status)
    .map(row => row.tweet_id);
}

function count(db, status) {
  return db
    .prepare('SELECT COUNT(*) AS total FROM bookmarks WHERE summary_status = ?')
    .get(status).total;
}

test('no key leaves every waiting summary alone', () => {
  const db = library([
    ...parkedPosts(12, 'disabled'),
    { id: 'idle-1', status: 'idle' },
    { id: 'note-1', status: 'disabled', kind: 'note' },
  ]);

  // Nothing can be written, so neither mode produces a statement.
  assert.equal(recoverWaitingSummariesSql(isAiConfigured({}), false), null);
  assert.equal(recoverWaitingSummariesSql(isAiConfigured({}), true), null);

  assert.equal(count(db, 'disabled'), 13);
  assert.equal(count(db, 'idle'), 1);
  assert.equal(count(db, 'needs_key'), 0);
  assert.equal(count(db, 'pending'), 0);
  db.close();
});

test('a configured Worker re-queues every parked state, oldest first', () => {
  const db = library([
    ...parkedPosts(12),
    { id: 'note-1', status: 'disabled', kind: 'note' },
    { id: 'note-2', status: 'needs_key', kind: 'note' },
    { id: 'failed-1', status: 'failed' },
    { id: 'done-1', status: 'done' },
  ]);
  const sql = recoverWaitingSummariesSql(isAiConfigured({ AI_API_KEY: 'test-key' }), true);
  assert.ok(sql);

  db.exec(sql);
  // The oldest ten, whichever parked state they carry.
  assert.deepEqual(rows(db, 'pending'), [
    'd1',
    'd2',
    'd3',
    'd4',
    'd5',
    'd6',
    'd7',
    'd8',
    'd9',
    'd10',
  ]);
  assert.deepEqual(rows(db, 'disabled'), ['note-1']);
  assert.deepEqual(rows(db, 'idle'), ['d11']);
  assert.deepEqual(rows(db, 'needs_key'), ['d12', 'note-2']);
  assert.deepEqual(rows(db, 'failed'), ['failed-1']);
  assert.deepEqual(rows(db, 'done'), ['done-1']);

  const recovered = db.prepare('SELECT * FROM bookmarks WHERE tweet_id = ?').get('d1');
  assert.equal(recovered.summary_error, null);
  assert.equal(recovered.summary_started_at, null);
  assert.equal(recovered.summary_attempts, 0);
  assert.equal(recovered.summary_retry_at, null);

  const waiting = db.prepare('SELECT * FROM bookmarks WHERE tweet_id = ?').get('d11');
  assert.equal(waiting.summary_error, 'parked as idle');
  assert.equal(waiting.summary_started_at, 1);
  assert.equal(waiting.summary_attempts, 2);
  assert.equal(waiting.summary_retry_at, 1);

  db.exec(sql);
  assert.deepEqual(rows(db, 'pending'), [
    'd1',
    'd2',
    'd3',
    'd4',
    'd5',
    'd6',
    'd7',
    'd8',
    'd9',
    'd10',
    'd11',
    'd12',
  ]);
  assert.deepEqual(rows(db, 'disabled'), ['note-1']);
  assert.deepEqual(rows(db, 'needs_key'), ['note-2']);
  db.close();
});

test('with summaries off only needs_key rows become idle', () => {
  const db = library([
    { id: 'key-1', status: 'needs_key' },
    { id: 'key-2', status: 'needs_key' },
    { id: 'idle-1', status: 'idle' },
    { id: 'off-1', status: 'disabled' },
    { id: 'note-1', status: 'needs_key', kind: 'note' },
    { id: 'done-1', status: 'done' },
  ]);
  const sql = recoverWaitingSummariesSql(isAiConfigured({ AI_API_KEY: 'test-key' }), false);
  assert.ok(sql);

  db.exec(sql);
  // A key without the switch corrects the state; it never queues work.
  assert.deepEqual(rows(db, 'idle'), ['key-1', 'key-2', 'idle-1']);
  assert.deepEqual(rows(db, 'needs_key'), ['note-1']);
  assert.deepEqual(rows(db, 'disabled'), ['off-1']);
  assert.deepEqual(rows(db, 'pending'), []);
  assert.deepEqual(rows(db, 'done'), ['done-1']);

  const downgraded = db.prepare('SELECT * FROM bookmarks WHERE tweet_id = ?').get('key-1');
  assert.equal(downgraded.summary_error, null);
  assert.equal(downgraded.summary_attempts, 0);
  assert.equal(downgraded.summary_retry_at, null);

  // Rows that already say the right thing keep their stamps.
  const untouched = db.prepare('SELECT * FROM bookmarks WHERE tweet_id = ?').get('off-1');
  assert.equal(untouched.summary_error, 'parked as disabled');
  assert.equal(untouched.summary_started_at, 1);
  assert.equal(untouched.summary_attempts, 2);
  assert.equal(untouched.summary_retry_at, 1);
  db.close();
});

test('an agent note without an abstract is never re-queued for a summary', () => {
  const db = library([
    { id: 'd1', status: 'disabled' },
    { id: 'note-1', status: 'disabled', kind: 'note' },
  ]);
  db.exec(recoverWaitingSummariesSql(isAiConfigured({ AI_API_KEY: 'test-key' }), true));

  assert.deepEqual(rows(db, 'pending'), ['d1']);
  assert.deepEqual(rows(db, 'disabled'), ['note-1']);

  const note = db.prepare('SELECT * FROM bookmarks WHERE tweet_id = ?').get('note-1');
  assert.equal(note.kind, 'note');
  assert.equal(note.summary_status, 'disabled');
  assert.equal(note.summary_attempts, 2);
  assert.equal(note.summary_retry_at, 1);
  db.close();
});

test('the batch stays at ten rows per pass', () => {
  const db = library(parkedPosts(25));
  db.exec(recoverWaitingSummariesSql(isAiConfigured({ AI_API_KEY: 'test-key' }), true));

  assert.equal(count(db, 'pending'), 10);
  assert.equal(count(db, 'disabled') + count(db, 'idle') + count(db, 'needs_key'), 15);
  db.close();
});
