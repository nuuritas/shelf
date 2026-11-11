import assert from 'node:assert/strict';
import test from 'node:test';
import { parseYouTubeUrl, readYouTubePost } from '../src/youtube.ts';

const ID = 'h70ZC1li5vY';
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

test('parses every shape of video link, including share tracking parameters', () => {
  const shapes = [
    `https://youtu.be/${ID}?si=Xslwl7lIjWFDqnQ_`,
    `https://www.youtube.com/watch?v=${ID}&si=Xslwl7lIjWFDqnQ_`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`,
    `https://www.youtube.com/shorts/${ID}?feature=share`,
    `https://www.youtube.com/live/${ID}?si=abc`,
    `https://www.youtube.com/embed/${ID}`,
    `youtu.be/${ID}`,
    `https://www.youtube.com/watch?v=${ID}&t=42s`,
  ];

  for (const shape of shapes) {
    assert.deepEqual(parseYouTubeUrl(shape), { videoId: ID, canonicalUrl: CANONICAL }, shape);
  }
});

test('rejects links that are not a single video', () => {
  for (const value of [
    'https://www.youtube.com/@somechannel',
    'https://www.youtube.com/playlist?list=PL123',
    'https://x.com/a/status/123',
    'https://youtu.be/',
    'not a link',
    null,
    undefined,
  ]) {
    assert.equal(parseYouTubeUrl(value), null, String(value));
  }
});

test('reads title, channel, description and date without an API key', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async input => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.includes('/oembed')) {
      return new Response(
        JSON.stringify({
          title: 'How a shelf works',
          author_name: 'Shelf Channel',
          thumbnail_url: 'https://i.ytimg.com/vi/h70ZC1li5vY/hqdefault.jpg',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(
      '<html><head><meta property="og:description" content="A short film &amp; a long idea.">' +
        '<meta itemprop="datePublished" content="2024-05-01T12:00:00-07:00"></head></html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    );
  };

  try {
    const post = await readYouTubePost(`https://youtu.be/${ID}?si=Xslwl7lIjWFDqnQ_`);
    assert.equal(post.tweetId, `yt${ID}`);
    assert.equal(post.url, CANONICAL);
    assert.equal(post.provider, 'youtube');
    assert.equal(post.author?.name, 'Shelf Channel');
    assert.equal(post.text, 'A short film & a long idea.');
    assert.equal(post.createdAt, '2024-05-01T19:00:00.000Z');
    assert.equal(post.media.length, 1);
    assert.equal(post.media[0].url, 'https://i.ytimg.com/vi/h70ZC1li5vY/hqdefault.jpg');
    assert.ok(seen.some(url => url.includes('/oembed')));
  } finally {
    globalThis.fetch = original;
  }
});

test('still saves a video whose page and oEmbed are unavailable', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 404 });

  try {
    const post = await readYouTubePost(CANONICAL);
    assert.equal(post.tweetId, `yt${ID}`);
    assert.equal(post.text, '');
    assert.equal(post.author, null);
    assert.equal(post.media.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('a non-video link is a 400, not a 502', async () => {
  await assert.rejects(
    () => readYouTubePost('https://www.youtube.com/@somechannel'),
    error => error.status === 400,
  );
});
