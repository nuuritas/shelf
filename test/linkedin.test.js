import assert from 'node:assert/strict';
import test from 'node:test';
import { LinkedInReadError, parseLinkedInUrl, readLinkedInPost } from '../src/linkedin.ts';

const ID = '7525978195154649089';
const CANONICAL = `https://www.linkedin.com/posts/jane-doe_we-are-hiring-activity-${ID}-AbCd`;
const POST = `${CANONICAL}/?trk=public_post`;
const SHARE_ID = '7525978194345132034';
const SHARE = `https://www.linkedin.com/posts/reisdebora_databricks-databrickscertification-dataengineering-share-${SHARE_ID}--NtC/`;

test('parses post, feed update, and pulse URLs, and rejects links without an activity id', () => {
  assert.deepEqual(parseLinkedInUrl(POST), { id: `li${ID}`, activityId: ID, canonicalUrl: CANONICAL });
  assert.equal(parseLinkedInUrl(`linkedin.com/feed/update/urn:li:activity:${ID}/`).id, `li${ID}`);
  assert.equal(
    parseLinkedInUrl(`https://www.linkedin.com/pulse/ship-small-activity-${ID}-XyZ`).activityId,
    ID,
  );
  assert.equal(parseLinkedInUrl('https://x.com/a/status/123'), null);
  assert.equal(parseLinkedInUrl('not a link'), null);
  assert.equal(parseLinkedInUrl('https://www.linkedin.com/pulse/no-id-here'), null);
});

test('parses the share URL with its share id', () => {
  assert.deepEqual(parseLinkedInUrl(SHARE), {
    id: `li${SHARE_ID}`,
    activityId: SHARE_ID,
    canonicalUrl: SHARE.replace(/\/+$/, ''),
  });
});

test('readLinkedInPost returns an empty post when LinkedIn answers 999 or has no body', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 999, url: POST, text: async () => '' });
    let post = await readLinkedInPost(POST);
    assert.deepEqual([post.tweetId, post.provider, post.text, post.media], [`li${ID}`, 'linkedin', '', []]);

    globalThis.fetch = async () => ({ ok: true, status: 200, url: POST, text: async () => '<html></html>' });
    post = await readLinkedInPost(POST);
    assert.equal(post.text, '');
    assert.deepEqual(post.media, []);
  } finally {
    globalThis.fetch = original;
  }
});

test('readLinkedInPost reads the author, text, image, canonical URL, and request headers', async () => {
  const html = `<head>
    <meta property="og:title" content="Jane Doe on LinkedIn: We are hiring.">
    <meta property="og:url" content="${CANONICAL}">
    <meta property="og:image" content="https://media.licdn.com/photo.jpg">
  </head><body><main><p>We are hiring.</p></main></body>`;
  const original = globalThis.fetch;
  let request;
  try {
    globalThis.fetch = async (url, init) => {
      request = { url, init };
      return { ok: true, status: 200, url: POST, text: async () => html };
    };
    const post = await readLinkedInPost(POST);
    assert.equal(post.text, 'We are hiring.');
    assert.deepEqual(post.author, { name: 'Jane Doe', username: null, avatarUrl: null, verified: false });
    assert.deepEqual(post.media, [{
      type: 'photo', url: 'https://media.licdn.com/photo.jpg', posterUrl: null,
      width: null, height: null, altText: null, durationMs: null, variants: [],
    }]);
    assert.equal(post.url, CANONICAL);
    assert.equal(request.init.redirect, 'follow');
    assert.match(request.init.headers['User-Agent'], /Mozilla\/5\.0/);
    assert.equal('Cookie' in request.init.headers, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('readLinkedInPost prefers the meta description and reads the author after the last pipe in og:title', async () => {
  const body =
    'Starts today! The Databricks Advanced Learning Festival runs through December 08 2026.';
  const html = `<head>
    <meta name="description" content="${body}">
    <meta property="og:title" content="Databricks Advanced Learning Festival: November 10 - December 08 2026 | Debora Reis, MSc.">
    <meta property="og:url" content="${CANONICAL}">
  </head><body><main>
    <p>Debora Reis, MSc.</p>
    <p>Starts today!</p>
    <p>Like Comment Share</p>
    <p>A comment that must not become the post body.</p>
    <p>To view or add a comment, sign in</p>
  </main></body>`;
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, url: POST, text: async () => html });
    const post = await readLinkedInPost(POST);
    assert.equal(post.text, body);
    assert.deepEqual(post.author, {
      name: 'Debora Reis, MSc.', username: null, avatarUrl: null, verified: false,
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("readLinkedInPost keeps the text after an apostrophe inside a double-quoted meta content", async () => {
  const body =
    "It's a good way to: read the whole post, not just the part before the apostrophe. Short link and hashtags follow.";
  const html = `<head>
    <meta name="description" content="${body}">
  </head><body><main><p>It</p></main></body>`;
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, url: POST, text: async () => html });
    const post = await readLinkedInPost(POST);
    assert.equal(post.text, body);
  } finally {
    globalThis.fetch = original;
  }
});

test('readLinkedInPost falls through a short meta description to og:description', async () => {
  const description = 'A longer og description that carries the real post body.';
  const html = `<head>
    <meta name="description" content="LinkedIn">
    <meta property="og:description" content="${description}">
  </head><body><main><p>Author header and comment chrome.</p></main></body>`;
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, url: POST, text: async () => html });
    const post = await readLinkedInPost(POST);
    assert.equal(post.text, description);
  } finally {
    globalThis.fetch = original;
  }
});

test('readLinkedInPost falls through a short meta description to the article text', async () => {
  const html = `<head>
    <meta name="description" content="LinkedIn">
  </head><body><main><p>Short description fallback body.</p></main></body>`;
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, url: POST, text: async () => html });
    const post = await readLinkedInPost(POST);
    assert.equal(post.text, 'Short description fallback body.');
  } finally {
    globalThis.fetch = original;
  }
});

test('readLinkedInPost reads the profile username from a canonical /in/ URL', async () => {
  const profile = 'https://www.linkedin.com/in/debora-reis';
  const html = `<head>
    <meta name="description" content="A profile description long enough to stand in for the post body.">
    <meta property="og:title" content="Debora Reis, MSc. | Debora Reis, MSc.">
    <link rel="canonical" href="${profile}">
  </head><body></body>`;
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, url: POST, text: async () => html });
    const post = await readLinkedInPost(POST);
    assert.equal(post.author.username, 'debora-reis');
  } finally {
    globalThis.fetch = original;
  }
});

test('readLinkedInPost collapses a share link to the canonical activity id', async () => {
  const html = `<head>
    <meta property="og:url" content="${CANONICAL}">
  </head><body><main><p>We are hiring.</p></main></body>`;
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, url: CANONICAL, text: async () => html });
    const post = await readLinkedInPost(SHARE);
    assert.equal(post.tweetId, `li${ID}`);
    assert.equal(post.url, CANONICAL);
  } finally {
    globalThis.fetch = original;
  }
});

test('readLinkedInPost throws LinkedInReadError only for an unparseable URL', async () => {
  await assert.rejects(readLinkedInPost('https://x.com/a/status/123'), error => {
    assert.ok(error instanceof LinkedInReadError);
    assert.equal(error.code, 'INVALID_URL');
    assert.equal(error.message, 'That does not look like a LinkedIn post link.');
    return true;
  });
});
