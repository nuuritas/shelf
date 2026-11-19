import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NOTE_LIMITS,
  NoteInputError,
  noteIdFor,
  notePlainText,
  noteTitle,
  normalizeNoteInput,
  sanitizeNoteHtml,
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

test('the transport is never stored as the author', () => {
  for (const name of ['Shelf CLI', 'shelf-cli', 'Shelf MCP', 'shelf-mcp']) {
    const note = normalizeNoteInput({
      format: 'markdown',
      content: 'Body.',
      agent: { name, model: 'deepseek-v4.1-flash', tool: 'shelf-cli' },
    });
    assert.equal(note.agent?.name, '');
    assert.equal(note.agent?.model, 'deepseek-v4.1-flash');
    assert.equal(note.agent?.tool, 'shelf-cli');
  }
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

test('accepts a note ref to update and rejects malformed ones', () => {
  const note = normalizeNoteInput({
    format: 'html',
    content: '<h1>Revised</h1>',
    ref: 'xqajj',
  });
  assert.equal(note.ref, 'xqajj');
  assert.equal(note.clientId, null);
  assert.throws(
    () => normalizeNoteInput({ format: 'markdown', content: 'x', ref: 'has space' }),
    /ref must be/,
  );
  assert.throws(
    () => normalizeNoteInput({ format: 'markdown', content: 'x', ref: 'a'.repeat(31) }),
    /ref is limited to 30 characters/,
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


test('sanitises dangerous HTML but keeps styles, SVG and https images', () => {
  const html = sanitizeNoteHtml(`<script>alert(1)</script>
    <img src="https://example.com/a.png" onerror="alert(1)">
    <a href="javascript:alert(1)">bad</a>
    <form action="/steal"><input name="x"></form>
    <meta http-equiv="refresh" content="0;url=//evil">
    <iframe src="//evil"></iframe>
    <object data="x"></object>
    <style>body { color: red; }</style>
    <svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>`);

  assert.doesNotMatch(html, /<script|<iframe|<object|<form|<input|<meta/i);
  assert.doesNotMatch(html, /onerror|javascript:/i);
  assert.match(html, /<style>body \{ color: red; \}<\/style>/);
  assert.match(html, /<svg viewBox="0 0 10 10">/);
  assert.match(html, /src="https:\/\/example\.com\/a\.png"/);
});

test('the API path stores sanitised HTML content', () => {
  const note = normalizeNoteInput({
    format: 'html',
    content: '<h1>Hi</h1><script>alert(1)</script><p onclick="x()">Body</p>',
  });
  assert.doesNotMatch(note.content, /<script|onclick/);
  assert.match(note.content, /<h1>Hi<\/h1>/);
});
