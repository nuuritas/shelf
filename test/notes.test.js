import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NOTE_LIMITS,
  NoteInputError,
  noteIdFor,
  notePlainText,
  noteTitle,
  normalizeNoteInput,
} from '../src/notes.ts';

test('accepts a markdown note and fills the title from the first heading', () => {
  const note = normalizeNoteInput({
    format: 'markdown',
    content: '# How memory works\n\nBody.',
    clientId: 'daily-1',
    agent: { name: 'Claude Code', model: 'claude-sonnet-4.5', tool: 'claude-code' },
  });
  assert.equal(note.title, 'How memory works');
  assert.equal(note.clientId, 'daily-1');
  assert.equal(note.agent?.name, 'Claude Code');
  assert.equal(note.summary, null);
  assert.equal(note.sourceUrl, null);
});

test('rejects a missing format, empty content, oversize content and a bad URL', () => {
  assert.throws(() => normalizeNoteInput({ content: 'x' }), NoteInputError);
  assert.throws(() => normalizeNoteInput({ format: 'markdown', content: '   ' }), /required/);
  assert.throws(
    () =>
      normalizeNoteInput({
        format: 'markdown',
        content: 'x'.repeat(NOTE_LIMITS.markdown + 1),
      }),
    /limited to 256 KB/,
  );
  assert.throws(
    () => normalizeNoteInput({ format: 'markdown', content: 'x', sourceUrl: 'javascript:alert(1)' }),
    /http\(s\)/,
  );
});

test('the same clientId always maps to the same note id', async () => {
  const first = await noteIdFor('research-agent-memory');
  assert.equal(first, await noteIdFor('research-agent-memory'));
  assert.match(first, /^note-[0-9a-f]{16}$/);
  assert.notEqual(first, await noteIdFor('other'));
  assert.match(await noteIdFor(null), /^note-[0-9a-f]{16}$/);
});

test('plain text never keeps HTML tags or markdown markers', () => {
  assert.equal(notePlainText('markdown', '# Title\n\n**bold** text'), 'Title\n\nbold text');
  const html = notePlainText(
    'html',
    '<html><head><title>T</title><script>alert(1)</script></head><body><h1>H</h1><p>Body</p></body></html>',
  );
  assert.doesNotMatch(html, /<|alert/);
  assert.match(html, /Body/);
});

test('an HTML note takes its title from title or h1, stripped of tags', () => {
  assert.equal(noteTitle(null, 'html', '<title>Doc title</title>'), 'Doc title');
  assert.equal(noteTitle(null, 'html', '<h1>Hello <em>there</em></h1>'), 'Hello there');
  assert.equal(noteTitle('  ', 'markdown', 'no heading'), 'no heading');
  assert.equal(noteTitle(null, 'markdown', '   '), 'Untitled note');
});
