import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPage } from '../src/render.js';
import { slugify } from '../src/util.js';

test('slugify folds Turkish letters into URL-safe slugs', () => {
  assert.equal(slugify('Ajan Mimarisi'), 'ajan-mimarisi');
  assert.equal(slugify('Yapay Zekâ Kodlama'), 'yapay-zeka-kodlama');
  assert.equal(slugify('Doğu Akdeniz & Ege'), 'dogu-akdeniz-ege');
  assert.equal(slugify('  '), 'topic');
});

test('renders topic navigation with counts and an active topic', () => {
  const html = renderPage({
    bookmarks: [],
    total: 18,
    query: '',
    topics: [
      { slug: 'ajan-mimarisi', name: 'Ajan Mimarisi', count: 7 },
      { slug: 'dogu-akdeniz', name: 'Doğu Akdeniz', count: 2 },
    ],
    topic: {
      slug: 'ajan-mimarisi',
      name: 'Ajan Mimarisi',
      description: 'Ajanların oturum sınırlarını aşması.',
      overview: 'Birinci paragraf.\n\nİkinci paragraf.',
      count: 7,
    },
    notice: null,
    error: null,
    aiConfigured: true,
  });

  assert.match(html, /href="\/t\/ajan-mimarisi"/);
  assert.match(html, /href="\/t\/dogu-akdeniz"/);
  assert.match(html, /topic-chip active[^>]*href="\/"|href="\/"[^>]*|class="topic-chip all active"/);
  assert.match(html, /Ajan Mimarisi/);
  assert.match(html, /Ajanların oturum sınırlarını aşması\./);
  assert.match(html, /<p>Birinci paragraf\.<\/p>/);
  assert.match(html, /<p>İkinci paragraf\.<\/p>/);
  assert.match(html, /topic-chip active/);
});

test('escapes topic syntheses before rendering them', () => {
  const html = renderPage({
    bookmarks: [],
    total: 1,
    query: '',
    topics: [],
    topic: {
      slug: 'test',
      name: '<script>alert(1)</script>',
      description: '',
      overview: '<img src=x onerror=alert(1)>',
      count: 1,
    },
    notice: null,
    error: null,
    aiConfigured: true,
  });

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
});
