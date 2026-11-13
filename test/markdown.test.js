import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownToText, renderMarkdown } from '../src/markdown.ts';

test('renders headings, paragraphs, strong, italic and inline code', () => {
  const html = renderMarkdown('# Title\n\nSome **bold** and *italic* with `code`.');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
});

test('escapes raw HTML in markdown instead of passing it through', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img[^>]*onerror/);
  assert.match(html, /&lt;script&gt;/);
});

test('only http(s) links and images become elements', () => {
  const html = renderMarkdown(
    '[ok](https://example.com/a) [bad](javascript:alert(1))\n\n![alt](https://example.com/i.png) ![x](data:text/html,hi)',
  );
  assert.match(html, /href="https:\/\/example\.com\/a"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /<img src="https:\/\/example\.com\/i\.png" alt="alt"/);
  assert.doesNotMatch(html, /src="data:text\/html/);
});

test('renders lists, quotes, code fences, rules and tables', () => {
  const html = renderMarkdown(`- one
- two

> quoted

\`\`\`ts
const x = 1 < 2;
\`\`\`

---

| A | B |
| --- | --- |
| 1 | 2 |
`);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<pre><code class="language-ts">const x = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<table>/);
  assert.match(html, /<td>1<\/td>/);
});

test('plain text strips markdown syntax for search', () => {
  const text = markdownToText('# Title\n\n**bold** [link](https://example.com) `code`\n\n- item');
  assert.equal(text, 'Title\n\nbold link code\n\nitem');
});
