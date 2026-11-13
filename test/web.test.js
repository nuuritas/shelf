import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WebPageError,
  canonicalWebUrl,
  parseWebUrl,
  readWebPost,
  webBookmarkId,
} from '../src/links.ts';

function stubPage(body, { type = 'text/html', url = '' } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const response = new Response(body, { status: 200, headers: { 'Content-Type': type } });
    if (url) Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  return () => {
    globalThis.fetch = original;
  };
}

test('accepts a plain page and leaves platform links to their readers', () => {
  assert.deepEqual(parseWebUrl('read https://example.com/blog/post now'), {
    canonicalUrl: 'https://example.com/blog/post',
  });
  assert.equal(parseWebUrl('https://x.com/a/status/1'), null);
  assert.equal(parseWebUrl('https://www.linkedin.com/posts/a'), null);
  assert.equal(parseWebUrl('https://youtu.be/abc'), null);
  assert.equal(parseWebUrl('javascript:alert(1)'), null);
  assert.equal(parseWebUrl('no link here'), null);
});

test('canonicalises the URL used for the bookmark key', () => {
  assert.equal(
    canonicalWebUrl('https://Example.com/Blog/Post/?utm_source=x&b=2&a=1&fbclid=z#section'),
    'https://example.com/Blog/Post?a=1&b=2',
  );
  assert.equal(canonicalWebUrl('https://example.com/'), 'https://example.com/');
  assert.equal(canonicalWebUrl('ftp://example.com/file'), null);
});

test('the same page produces one id across tracking variants', async () => {
  const plain = canonicalWebUrl('https://example.com/blog/post');
  const tracked = canonicalWebUrl('https://example.com/blog/post?utm_source=newsletter');
  assert.equal(await webBookmarkId(plain), await webBookmarkId(tracked));
  assert.match(await webBookmarkId(plain), /^web-[0-9a-f]{16}$/);
  assert.notEqual(await webBookmarkId(plain), await webBookmarkId('https://example.com/other'));
});

test('reads a page into the bookmark shape', async () => {
  const restore = stubPage(`
    <html><head>
      <title>Post title fallback</title>
      <meta property="og:title" content="The era of personal software">
      <meta property="og:site_name" content="Example Journal">
      <meta property="og:description" content="A short description.">
      <meta property="article:published_time" content="2026-10-01T00:00:00.000Z">
    </head><body><article><h1>Heading</h1><p>${'Readable body text. '.repeat(30)}</p></article></body></html>
  `);
  try {
    const post = await readWebPost('https://example.com/blog/post?utm_source=x');
    assert.equal(post.provider, 'web');
    assert.equal(post.tweetId.startsWith('web-'), true);
    assert.equal(post.url, 'https://example.com/blog/post');
    assert.equal(post.article?.title, 'The era of personal software');
    assert.equal(post.author?.name, 'Example Journal');
    assert.equal(post.author?.username, null);
    assert.equal(post.createdAt, '2026-10-01T00:00:00.000Z');
    assert.match(String(post.article?.text), /Readable body text/);
    assert.equal(post.text, 'A short description.');
  } finally {
    restore();
  }
});

test('a non-HTML page is a readable 422', async () => {
  const restore = stubPage('%PDF-1.7', { type: 'application/pdf' });
  try {
    await assert.rejects(
      () => readWebPost('https://example.com/paper.pdf'),
      (error) => error instanceof WebPageError && error.status === 422,
    );
  } finally {
    restore();
  }
});

test('a private host is rejected before any fetch', async () => {
  let fetched = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response('');
  };
  try {
    await assert.rejects(
      () => readWebPost('http://127.0.0.1/admin'),
      (error) => error instanceof WebPageError && error.status === 400,
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = original;
  }
});
