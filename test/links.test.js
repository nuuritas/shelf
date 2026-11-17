import assert from 'node:assert/strict';
import test from 'node:test';
import { extractExternalUrls, htmlToText, parseGitHubUrl, readPoster } from '../src/links.ts';

test('extracts external links but skips X media links', () => {
  const urls = extractExternalUrls({
    text: 'Read https://jakub.kr/writing/the-era-of-personal-software and https://github.com/leodavincs/kalem',
    quote: { text: 'ignore https://x.com/a/status/1 and https://pbs.twimg.com/media/a.jpg' },
  });

  assert.deepEqual(urls, [
    'https://jakub.kr/writing/the-era-of-personal-software',
    'https://github.com/leodavincs/kalem',
  ]);
});

test('parses GitHub repository URLs and ignores non-repo paths', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/leodavincs/kalem'), {
    owner: 'leodavincs',
    repo: 'kalem',
    canonicalUrl: 'https://github.com/leodavincs/kalem',
    apiUrl: 'https://api.github.com/repos/leodavincs/kalem',
  });
  assert.equal(parseGitHubUrl('https://github.com/features/actions'), null);
  assert.equal(parseGitHubUrl('https://example.com/owner/repo'), null);
});

test('converts article HTML to readable text', () => {
  const text = htmlToText(`
    <html><body>
      <nav>Menu</nav>
      <article>
        <h1>The era of personal software</h1>
        <p>Software is becoming personal&nbsp;again.</p>
        <script>alert(1)</script>
        <ul><li>One</li><li>Two</li></ul>
      </article>
      <footer>Footer</footer>
    </body></html>
  `);

  assert.match(text, /The era of personal software/);
  assert.match(text, /Software is becoming personal again/);
  assert.match(text, /- One/);
  assert.doesNotMatch(text, /Menu|Footer|alert/);
});

test('reads an og:image and its alt text', () => {
  const poster = readPoster(`
    <html><head>
      <meta property="og:image" content="https://example.com/art/cover.png">
      <meta property="og:image:alt" content="A blue notebook on a desk">
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
    </head></html>
  `);

  assert.deepEqual(poster, {
    url: 'https://example.com/art/cover.png',
    alt: 'A blue notebook on a desk',
  });
});

test('an og:image with no alt still gives a picture', () => {
  const poster = readPoster('<meta property="og:image" content="https://example.com/a.png">');
  assert.deepEqual(poster, { url: 'https://example.com/a.png', alt: null });
});

test('an http image is not hotlinked into a page served over TLS', () => {
  assert.equal(readPoster('<meta property="og:image" content="http://example.com/a.png">'), null);
});

test('a 1×1 tracking pixel is rejected by its declared size', () => {
  const html = `
    <meta property="og:image" content="https://example.com/pixel.gif">
    <meta property="og:image:width" content="1">
    <meta property="og:image:height" content="1">
  `;
  assert.equal(readPoster(html), null);
  assert.equal(
    readPoster('<meta property="og:image" content="https://example.com/a.png"><meta property="og:image:width" content="120">'),
    null,
  );
});

test('an HTML-escaped og:image is decoded once', () => {
  const poster = readPoster(
    '<meta property="og:image" content="https://example.com/a.png?w=1&amp;h=2">',
  );
  assert.equal(poster?.url, 'https://example.com/a.png?w=1&h=2');
});

test('an og:image longer than 2048 characters is rejected', () => {
  const long = `https://example.com/${'a'.repeat(2050)}.png`;
  assert.equal(readPoster(`<meta property="og:image" content="${long}">`), null);
});
