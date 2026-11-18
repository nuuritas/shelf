import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInstagramUrl, readInstagramPost } from '../src/instagram.ts';

const CODE = 'C8xYzAbC123';
const CANONICAL = `https://www.instagram.com/p/${CODE}/`;

test('reel, p, tv and a ?igsh link all resolve to the canonical post', () => {
  for (const value of [
    `https://www.instagram.com/reel/${CODE}/?igsh=abc`,
    `https://instagram.com/p/${CODE}/`,
    `https://www.instagram.com/tv/${CODE}/?igsh=xyz`,
  ]) {
    assert.deepEqual(parseInstagramUrl(value), { id: `ig${CODE}`, username: null, canonicalUrl: CANONICAL });
  }
  assert.equal(parseInstagramUrl('https://www.instagram.com/stories/jane/1/'), null);
});

test('reads the caption and account with the crawler agent, and a 404 is empty', async () => {
  const original = globalThis.fetch;
  let request;
  try {
    globalThis.fetch = async (url, init) => {
      request = { url: String(url), init };
      return { ok: true, status: 200, url: String(url), text: async () => '<meta property="og:title" content="Jane Doe on Instagram: &quot;Hello &amp; welcome&quot;"><meta property="og:url" content="https://www.instagram.com/jane/">' };
    };
    const post = await readInstagramPost(CANONICAL);
    assert.deepEqual([post.tweetId, post.provider, post.text, post.media], [`ig${CODE}`, 'instagram', 'Hello & welcome', []]);
    assert.deepEqual(post.author, { name: 'Jane Doe', username: 'jane', avatarUrl: null, verified: false });
    assert.equal(request.url, CANONICAL);
    assert.match(request.init.headers['User-Agent'], /facebookexternalhit/);
    globalThis.fetch = async () => ({ ok: false, status: 404, url: CANONICAL, text: async () => '' });
    assert.equal((await readInstagramPost(CANONICAL)).text, '');
  } finally {
    globalThis.fetch = original;
  }
});
