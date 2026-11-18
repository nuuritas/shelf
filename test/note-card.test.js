import assert from 'node:assert/strict';
import test from 'node:test';
import { CSS, renderNotePage, renderPage } from '../src/render.ts';

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

test('renders a note with its title, attribution and abstract', () => {
  const html = renderPage({ bookmarks: [note()], total: 1, query: '', layout: 'saves' });
  assert.match(html, /How agent memory works/);
  assert.doesNotMatch(html, /AI-generated/);
  assert.match(html, /Claude Code/);
  assert.doesNotMatch(html, /claude-sonnet-4\.5/);
  assert.match(html, /class="note-label">Abstract</);
  assert.match(html, /A short abstract\./);
  // The document is the note page's job, not the card's.
  assert.doesNotMatch(html, /<h2>Memory<\/h2>/);
  assert.doesNotMatch(html, /<strong>Short<\/strong>/);
  assert.doesNotMatch(html, /class="note-body"/);
  assert.doesNotMatch(html, /Summary not configured/);
});

test('the author line stays short and the note title is the card lede', () => {
  const longTitle = 'shelf for agents: what a private archive should expose to a coding agent';
  const html = renderPage({
    bookmarks: [note({ title: longTitle })],
    total: 1,
    query: '',
    layout: 'saves',
  });
  assert.match(html, /<strong class="note-agent-name">Claude Code<\/strong>/);
  assert.match(html, new RegExp(`<h3 class="note-card-title"><a href="/p/n0te1">${longTitle}</a></h3>`));
});

test('a note without a source has no dead outbound link', () => {
  const html = renderPage({ bookmarks: [note()], total: 1, query: '', layout: 'saves' });
  assert.doesNotMatch(html, /href="#"/);
  assert.match(html, /class="x-link note-kind" title="Note">Note</);
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

test('an HTML note keeps its document off the library card', () => {
  const html = renderPage({
    bookmarks: [
      note({
        format: 'html',
        content: '<h1>Hi</h1><script>alert(1)</script>',
        text: 'Hi alert(1)',
        title: 'HTML note',
        summary: 'The short version of the document.',
      }),
    ],
    total: 1,
    query: '',
    layout: 'saves',
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<iframe/);
  assert.doesNotMatch(html, /\/p\/n0te1\/frame/);
  assert.match(html, /The short version of the document\./);
  assert.doesNotMatch(html, /Hi alert\(1\)/);
  // The title is the way into the note; the card has no second link row.
  assert.match(html, /<h3 class="note-card-title"><a href="\/p\/n0te1">HTML note<\/a><\/h3>/);
  assert.doesNotMatch(html, /class="card-foot"/);
  assert.doesNotMatch(html, />Open full note/);
  assert.match(html, /HTML document/);
});


test('an HTML note without an abstract falls back to a plain-text excerpt', () => {
  const html = renderPage({
    bookmarks: [
      note({
        format: 'html',
        content: '<h1>Report</h1><p>The installed base grew.</p>',
        text: 'The installed base grew.',
        title: 'Report',
        summary: null,
        summaryStatus: 'disabled',
      }),
    ],
    total: 1,
    query: '',
    layout: 'saves',
  });
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /class="note-excerpt">The installed base grew\.<\/p>/);
});

test('a markdown note without an abstract falls back to a 260-character excerpt', () => {
  const text = `${'x'.repeat(259)}${'y'.repeat(50)}`;
  const html = renderPage({
    bookmarks: [note({ text, summary: null, summaryStatus: 'disabled' })],
    total: 1,
    query: '',
    layout: 'saves',
  });
  assert.ok(html.includes(`<p class="note-excerpt">${'x'.repeat(259)}…</p>`));
  assert.ok(!html.includes('yyyy'));
  assert.doesNotMatch(html, /class="note-body"/);
  assert.doesNotMatch(html, /<h2>Memory<\/h2>/);
});

test('a note card links to the artifact itself, not only through its title', () => {
  const html = renderPage({ bookmarks: [note()], total: 1, query: '', layout: 'saves' });
  assert.match(html, /<a class="x-link" href="\/p\/n0te1">Open artifact ↗<\/a>/);
  // With no source the kind chip stays beside it.
  assert.match(html, /class="x-link note-kind" title="Note">Note</);
});

test('a note with a source keeps its outbound link beside the artifact link', () => {
  const html = renderPage({
    bookmarks: [note({ sourceUrl: 'https://example.com/paper' })],
    total: 1,
    query: '',
    layout: 'saves',
  });
  assert.match(html, /<a class="x-link" href="\/p\/n0te1">Open artifact ↗<\/a>/);
  assert.match(
    html,
    /<a class="x-link" href="https:\/\/example\.com\/paper" target="_blank" rel="noopener noreferrer">Source ↗<\/a>/,
  );
});

test('the full note page renders markdown and the HTML frame', () => {
  const markdown = renderNotePage({ bookmark: note() });
  assert.match(markdown, /<h1 class="note-title">How agent memory works<\/h1>/);
  assert.match(markdown, /AI-generated/);
  assert.match(markdown, /Claude Code · claude-sonnet-4\.5/);
  assert.match(markdown, /<h2>Memory<\/h2>/);
  assert.match(markdown, /class="note-label">Abstract</);

  const html = renderNotePage({
    bookmark: note({ format: 'html', content: '<h1>Doc</h1><script>alert(1)</script>', title: 'Doc' }),
  });
  assert.match(html, /<iframe class="note-frame note-frame-full" src="\/p\/n0te1\/frame"/);
  assert.match(html, /sandbox/);
  assert.match(html, /<h1 class="sr-only">Doc<\/h1>/);
  assert.match(html, /class="note-abstract-fold"/);
  assert.doesNotMatch(html, /Full document/);
  assert.doesNotMatch(html, /<script>alert/);
});

test('the card-wide overlay sits under the note body and its interactive content', () => {
  assert.match(CSS, /\.note-card-title a::after \{[^}]*position: absolute;[^}]*inset: 0/);
  assert.match(CSS, /\.note-card \.note-body, [^{}]*\{[^}]*z-index: 1;/);
  assert.match(CSS, /\.note-card \.note-abstract[^{}]*\{[^}]*z-index: 1;/);
  assert.match(CSS, /\.note-card \.note-body a[^{}]*\{[^}]*z-index: 1;/);
  assert.match(CSS, /\.note-card \.note-body pre[^{}]*\{[^}]*z-index: 1;/);
  assert.match(CSS, /\.note-card \.table-wrap[^{}]*\{[^}]*z-index: 1;/);
});
