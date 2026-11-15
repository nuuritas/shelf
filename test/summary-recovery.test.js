import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { isAiConfigured } from '../src/ai.ts';
import { recoverDisabledSummariesSql } from '../src/util.ts';

function library(disabledCount) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE bookmarks (
    tweet_id TEXT PRIMARY KEY,
    saved_at TEXT NOT NULL,
    summary_status TEXT NOT NULL,
    summary_error TEXT,
    summary_started_at INTEGER,
    summary_attempts INTEGER NOT NULL DEFAULT 0,
    summary_retry_at INTEGER
  )`);
  const insert = db.prepare(
    `INSERT INTO bookmarks
       (tweet_id, saved_at, summary_status, summary_error, summary_attempts, summary_retry_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= disabledCount; i += 1) {
    insert.run(
      `d${i}`,
      `2026-11-14T08:${String(i).padStart(2, '0')}:00.000Z`,
      'disabled',
      'AI was off when this was saved.',
      2,
      1,
    );
  }
  insert.run('failed-1', '2026-11-13T00:00:00.000Z', 'failed', 'boom', 3, null);
  insert.run('done-1', '2026-11-12T00:00:00.000Z', 'done', null, 0, null);
  return db;
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

test('disabled summaries stay put while AI is unconfigured', () => {
  const db = library(12);

  const sql = recoverDisabledSummariesSql(isAiConfigured({}));
  assert.equal(sql, null);
  if (sql) db.exec(sql);

  assert.equal(count(db, 'disabled'), 12);
  assert.equal(count(db, 'pending'), 0);
  db.close();
});

test('a configured Worker re-queues ten disabled rows per pass, oldest first', () => {
  const db = library(12);
  const sql = recoverDisabledSummariesSql(isAiConfigured({ AI_API_KEY: 'test-key' }));
  assert.ok(sql);

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
  ]);
  assert.deepEqual(rows(db, 'disabled'), ['d11', 'd12']);
  assert.deepEqual(rows(db, 'failed'), ['failed-1']);
  assert.deepEqual(rows(db, 'done'), ['done-1']);

  const recovered = db.prepare('SELECT * FROM bookmarks WHERE tweet_id = ?').get('d1');
  assert.equal(recovered.summary_error, null);
  assert.equal(recovered.summary_started_at, null);
  assert.equal(recovered.summary_attempts, 0);
  assert.equal(recovered.summary_retry_at, null);

  const waiting = db.prepare('SELECT * FROM bookmarks WHERE tweet_id = ?').get('d11');
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
  assert.equal(count(db, 'disabled'), 0);
  db.close();
});
