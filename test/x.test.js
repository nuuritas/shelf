import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectImages,
  extractXUrl,
  normalizeFxStatus,
  normalizeOfficialResponse,
  parseXUrl,
} from '../src/x.ts';

test('parses normal, mobile, and intent-style X URLs', () => {
  assert.equal(
    parseXUrl('https://x.com/mstockton/status/2116548727473148203?s=20').tweetId,
    '2116548727473148203',
  );
  assert.equal(
    parseXUrl('https://mobile.twitter.com/mstockton/status/2116548727473148203').username,
    'mstockton',
  );
  assert.equal(
    parseXUrl('https://x.com/i/web/status/2116548727473148203').tweetId,
    '2116548727473148203',
  );
  assert.equal(
    parseXUrl('x.com/mstockton/status/2116548727473148203').canonicalUrl,
    'https://x.com/mstockton/status/2116548727473148203',
  );
});

test('rejects non-X and malformed URLs', () => {
  assert.equal(parseXUrl('https://example.com/user/status/123'), null);
  assert.equal(parseXUrl('https://x.com/user/status/not-a-number'), null);
  assert.equal(parseXUrl('https://x.com/user'), null);
});

test('extracts an X URL from share-sheet text', () => {
  const parsed = extractXUrl(
    'Look at this https://x.com/mstockton/status/2116548727473148203?s=20&t=abc',
  );
  assert.equal(parsed.tweetId, '2116548727473148203');
});

test('normalizes FxTwitter quotes and quote media', () => {
  const post = normalizeFxStatus(fxStatus(), 'https://x.com/a/status/123');
  assert.equal(post.text, 'main text');
  assert.equal(post.author.username, 'a');
  assert.equal(post.media.length, 1);
  assert.equal(post.quote.tweetId, '456');
  assert.equal(post.quote.text, 'quoted text');
  assert.equal(post.quote.media.length, 3);
  assert.equal(collectImages(post).length, 4);
});

test('normalizes official API quotes and quote media', () => {
  const post = normalizeOfficialResponse(officialPayload(), 'https://x.com/a/status/123');
  assert.equal(post.text, 'the full long post');
  assert.equal(post.media.length, 1);
  assert.equal(post.quote.tweetId, '456');
  assert.equal(post.quote.media.length, 1);
  assert.equal(post.quote.media[0].url, 'https://pbs.twimg.com/media/quoted.jpg');
});

function fxStatus() {
  return {
    id: '123',
    url: 'https://x.com/a/status/123',
    text: 'main text',
    created_at: 'Sat Oct 31 15:11:54 +0000 2026',
    author: {
      name: 'Author',
      screen_name: 'a',
      avatar_url: 'https://pbs.twimg.com/a.jpg',
      verification: { verified: true },
    },
    media: {
      all: [
        {
          type: 'photo',
          url: 'https://pbs.twimg.com/media/main.jpg',
          width: 100,
          height: 200,
        },
      ],
    },
    quote: {
      type: 'status',
      id: '456',
      url: 'https://x.com/b/status/456',
      text: 'quoted text',
      author: { name: 'Quoted', screen_name: 'b' },
      media: {
        all: [
          { type: 'photo', url: 'https://pbs.twimg.com/media/q1.png' },
          { type: 'photo', url: 'https://pbs.twimg.com/media/q2.png' },
          { type: 'photo', url: 'https://pbs.twimg.com/media/q3.png' },
        ],
      },
    },
    replies: 1,
    reposts: 2,
    likes: 3,
    quotes: 4,
    views: 5,
  };
}

function officialPayload() {
  return {
    data: {
      id: '123',
      text: 'truncated',
      note_tweet: { text: 'the full long post' },
      author_id: 'u1',
      created_at: '2026-10-31T15:11:54.000Z',
      attachments: { media_keys: ['m1'] },
      referenced_tweets: [{ type: 'quoted', id: '456' }],
      public_metrics: { reply_count: 1, retweet_count: 2, like_count: 3, quote_count: 4 },
    },
    includes: {
      users: [
        {
          id: 'u1',
          name: 'Author',
          username: 'a',
          profile_image_url: 'https://pbs.twimg.com/a.jpg',
          verified: true,
        },
      ],
      media: [
        {
          media_key: 'm1',
          type: 'photo',
          url: 'https://pbs.twimg.com/media/main.jpg',
        },
        {
          media_key: 'm2',
          type: 'photo',
          url: 'https://pbs.twimg.com/media/quoted.jpg',
        },
      ],
      tweets: [
        {
          id: '456',
          text: 'quoted text',
          author_id: 'u2',
          attachments: { media_keys: ['m2'] },
        },
      ],
    },
  };
}

test('extracts full text from an X Article', () => {
  const status = {
    ...fxStatus(),
    article: {
      id: '999',
      title: 'Test article',
      preview_text: 'Preview',
      content: {
        blocks: [
          { type: 'header-one', text: 'A heading' },
          { type: 'unstyled', text: 'First paragraph.' },
          { type: 'unordered-list-item', text: 'A bullet' },
        ],
      },
    },
  };

  const post = normalizeFxStatus(status, 'https://x.com/a/status/123');
  assert.equal(post.article.title, 'Test article');
  assert.equal(post.article.url, 'https://x.com/i/article/999');
  assert.match(post.article.text, /# A heading\n\nFirst paragraph\.\n\n- A bullet/);
});
