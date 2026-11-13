import assert from 'node:assert/strict';
import test from 'node:test';
import { renderNotePage, renderPage } from '../src/render.ts';

function note(overrides = {}) {
  return {
    ref: 'n0te1',
    tweetId: 'note-0011223344556677',
    url: '',
    text: 'Extracted body text.',
    kind: 'note',
    format: 'markdown',
    title: 'How agent memory works',
    content: '## Memory\n\n**Short** and long term. [Source](https://example.com/paper)',
    agent: { name: 'Claude Code', model: 'claude-sonnet-4.5', tool: 'claude-code' },
    sourceUrl: null,
    createdAt: null,
    savedAt: '2026-11-13T12:00:00.000Z',
    provider: 'note',
    author: null,
    media: [],
    quote: null,
    article: null,
    links: [],
    transcripts: [],
    metrics: {},
    summary: 'A short abstract.',
    summaryStatus: 'done',
    summaryError: null,
    summarizedAt: '2026-11-13T12:00:00.000Z',
    summaryEn: null,
    summaryEnStatus: null,
    summaryEnError: null,
    summaryEnAt: null,
    archivedAt: null,
    versionStatus: null,
    topics: [],
    ...overrides,
  };
}

test('renders a note with its title, attribution and markdown body', () => {
  const html = renderPage({ bookmarks: [note()], total: 1, query: '', layout: 'saves' });
  assert.match(html, /How agent memory works/);
  assert.match(html, /AI-generated/);
  assert.match(html, /Claude Code · claude-sonnet-4\.5/);
  assert.match(html, /<h2>Memory<\/h2>/);
  assert.match(html, /<strong>Short<\/strong>/);
  assert.match(html, /href="https:\/\/example\.com\/paper"/);
  assert.match(html, /Abstract \(agent-written\)/);
  assert.doesNotMatch(html, /Summary not configured/);
});

test('a note without a source has no dead outbound link', () => {
  const html = renderPage({ bookmarks: [note()], total: 1, query: '', layout: 'saves' });
  assert.doesNotMatch(html, /href="#"/);
  assert.match(html, /class="x-link note-kind">Note</);
});

test('a note with a source links to it and hides the duplicate H1', () => {
  const html = renderPage({
    bookmarks: [
      note({
        content: '# How agent memory works\n\nBody copy.',
        sourceUrl: 'https://example.com/paper',
        summary: null,
        summaryStatus: 'disabled',
      }),
    ],
    total: 1,
    query: '',
    layout: 'saves',
  });
  assert.match(html, /href="https:\/\/example\.com\/paper"/);
  assert.match(html, /Source ↗/);
  assert.equal((html.match(/How agent memory works/g) || []).length, 1); // title only; the duplicate H1 is stripped
});

test('an HTML note renders in a sandboxed frame, never raw markup', () => {
  const html = renderPage({
    bookmarks: [
      note({
        format: 'html',
        content: '<h1>Hi</h1><script>alert(1)</script>',
        text: 'Hi alert(1)',
        title: 'HTML note',
      }),
    ],
    total: 1,
    query: '',
    layout: 'saves',
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /<iframe class="note-frame" src="\/p\/n0te1\/frame"/);
  assert.match(html, /sandbox/);
  assert.match(html, /referrerpolicy="no-referrer"/);
});


test('the full note page renders markdown and the HTML frame', () => {
  const markdown = renderNotePage({ bookmark: note() });
  assert.match(markdown, /<h1 class="note-title">How agent memory works<\/h1>/);
  assert.match(markdown, /AI-generated/);
  assert.match(markdown, /Claude Code · claude-sonnet-4\.5/);
  assert.match(markdown, /<h2>Memory<\/h2>/);
  assert.match(markdown, /Abstract \(agent-written\)/);

  const html = renderNotePage({
    bookmark: note({ format: 'html', content: '<h1>Doc</h1><script>alert(1)</script>', title: 'Doc' }),
  });
  assert.match(html, /<iframe class="note-frame note-frame-full" src="\/p\/n0te1\/frame"/);
  assert.match(html, /sandbox/);
  assert.doesNotMatch(html, /<script>alert/);
});
