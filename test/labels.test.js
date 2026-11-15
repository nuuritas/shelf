import assert from 'node:assert/strict';
import test from 'node:test';
import { LABEL_LIMITS, labelSlug, labelTone, parseLabelNames } from '../src/labels.ts';
import { normalizeNoteInput } from '../src/notes.ts';

test('a label slug is the name, lowercased and joined with dashes', () => {
  assert.equal(labelSlug('Read Later'), 'read-later');
  assert.equal(labelSlug('  spaced   out  '), 'spaced-out');
  assert.equal(labelSlug('Design/Systems'), 'design-systems');
});

test('a label slug keeps letters a Turkish reader types', () => {
  assert.equal(labelSlug('Tasarım'), 'tasarım');
  assert.equal(labelSlug('Çiğdem'), 'çiğdem');
});

test('a label slug drops punctuation rather than turning it into separators', () => {
  assert.equal(labelSlug("Editor's Picks"), 'editors-picks');
  assert.equal(labelSlug('C++'), 'c');
  assert.equal(labelSlug('  ---  '), '');
});

test('reads one comma-separated line from a form field', () => {
  assert.deepEqual(parseLabelNames('reading, design, later'), [
    { name: 'reading', slug: 'reading' },
    { name: 'design', slug: 'design' },
    { name: 'later', slug: 'later' },
  ]);
});

test('reads an array from the JSON API and keeps the first spelling', () => {
  assert.deepEqual(parseLabelNames(['Design', 'design ', 'DESIGN']), [
    { name: 'Design', slug: 'design' },
  ]);
});

test('ignores blanks, non-strings and a field that never arrived', () => {
  assert.deepEqual(parseLabelNames(''), []);
  assert.deepEqual(parseLabelNames(undefined), []);
  assert.deepEqual(parseLabelNames([1, null, '  ']), []);
});

test('truncates a long name instead of refusing the post', () => {
  const [label] = parseLabelNames('x'.repeat(LABEL_LIMITS.name + 20));
  assert.equal(label?.name.length, LABEL_LIMITS.name);
});

test('stops at the per-post cap', () => {
  const many = Array.from({ length: LABEL_LIMITS.perBookmark + 5 }, (_, i) => `tag-${i}`);
  assert.equal(parseLabelNames(many).length, LABEL_LIMITS.perBookmark);
});

test('a label keeps one colour, and the colour is one of the six tones', () => {
  assert.equal(labelTone('reading'), labelTone('reading'));
  assert.match(labelTone('design').toString(), /^[1-6]$/);
  // Different words should not all land on one tone.
  const tones = new Set(['design', 'reading', 'later', 'ai', 'cloud', 'video'].map(labelTone));
  assert.ok(tones.size > 1, 'every label got the same tone');
  // A blank slug still has to be paintable.
  assert.match(labelTone('').toString(), /^[1-6]$/);
});

test('a note that carries labels parses them once', () => {
  const note = normalizeNoteInput({
    format: 'markdown',
    content: '# Agent memory',
    labels: 'reading, design',
  });
  assert.deepEqual(note.labels, [
    { name: 'reading', slug: 'reading' },
    { name: 'design', slug: 'design' },
  ]);
});

test('a note without the field is not a request to clear its labels', () => {
  const note = normalizeNoteInput({ format: 'markdown', content: '# Agent memory' });
  assert.equal(note.labels, null);
});
