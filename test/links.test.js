import assert from 'node:assert/strict';
import test from 'node:test';
import { extractExternalUrls, htmlToText, parseGitHubUrl } from '../src/links.ts';

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
