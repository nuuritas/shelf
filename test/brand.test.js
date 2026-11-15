import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ASSET_VERSION, BRAND_CSS, BRAND_MARK, THEME_COLORS, assetUrl } from '../src/brand.ts';
import { CSS, renderCalendar, renderLogin, renderPage, renderSettings } from '../src/render.ts';

/** The fifteen nouns the brand paints with, plus the two shadow tokens. */
const SEMANTIC_TOKENS = [
  'paper',
  'paper-deep',
  'card',
  'ink',
  'ink-soft',
  'soft',
  'rule',
  'rule-strong',
  'accent',
  'accent-wash',
  'ok',
  'ok-wash',
  'danger',
  'danger-wash',
  'deep',
  'deep-ink',
  'deep-soft',
  'shadow',
];

/** `--old-name` → the semantic token it resolves to. */
const COLOUR_ALIASES = {
  bg: 'paper',
  surface: 'card',
  'surface-soft': 'paper-deep',
  muted: 'soft',
  line: 'rule',
  'line-strong': 'rule-strong',
  'accent-ink': 'accent',
  'accent-soft': 'accent-wash',
  green: 'ok',
  'green-soft': 'ok-wash',
  red: 'danger',
  'red-soft': 'danger-wash',
};

const LIGHT_BLOCK = /:root\{([^}]*)\}/;
const DARK_BLOCK = /:root\[data-theme="dark"\]\{([^}]*)\}/;
const SYSTEM_DARK_BLOCK = /@media\(prefers-color-scheme:dark\)\{\s*:root:not\(\[data-theme="light"\]\)\{([^}]*)\}/;

function declarations(body) {
  const found = new Map();
  for (const chunk of body.split(';')) {
    const at = chunk.indexOf(':');
    if (at < 1) continue;
    found.set(chunk.slice(0, at).trim(), chunk.slice(at + 1).trim());
  }
  return found;
}

function block(css, pattern, label) {
  const match = css.match(pattern);
  assert.ok(match, `BRAND_CSS has no ${label} block`);
  return declarations(match[1]);
}

function read(file) {
  return readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
}

test('the semantic tokens are declared in both theme blocks', () => {
  const light = block(BRAND_CSS, LIGHT_BLOCK, ':root');
  const dark = block(BRAND_CSS, DARK_BLOCK, ':root[data-theme="dark"]');
  const system = block(BRAND_CSS, SYSTEM_DARK_BLOCK, 'prefers-color-scheme dark');

  for (const token of SEMANTIC_TOKENS) {
    assert.ok(light.has(`--${token}`), `light theme is missing --${token}`);
    assert.ok(dark.has(`--${token}`), `dark theme is missing --${token}`);
    assert.ok(system.has(`--${token}`), `the system dark theme is missing --${token}`);
  }

  for (const token of SEMANTIC_TOKENS) {
    const value = light.get(`--${token}`);
    assert.ok(value, `--${token} has no value`);
    if (token !== 'shadow') assert.match(value, /^#[0-9a-f]{6}$/i, `--${token} is not a hex colour`);
  }

  // The dark scheme is a real swap, not the light one repeated.
  for (const token of ['paper', 'card', 'ink', 'soft', 'rule', 'accent', 'danger']) {
    assert.notEqual(light.get(`--${token}`), dark.get(`--${token}`), `--${token} is the same in both themes`);
  }
  assert.equal(light.get('color-scheme'), 'light');
  assert.equal(dark.get('color-scheme'), 'dark');
});

test('every legacy alias resolves to a semantic token', () => {
  const light = block(BRAND_CSS, LIGHT_BLOCK, ':root');

  for (const [alias, token] of Object.entries(COLOUR_ALIASES)) {
    const value = light.get(`--${alias}`);
    assert.equal(value, `var(--${token})`, `--${alias} should resolve to --${token}`);
    assert.ok(SEMANTIC_TOKENS.includes(token), `--${alias} points at --${token}, which is not a token`);
  }

  // `--faint` is mixed rather than aliased, and mixes no raw colour.
  assert.match(light.get('--faint') ?? '', /^color-mix\(in srgb,var\(--soft\) 70%,var\(--paper\)\)$/);
  assert.doesNotMatch(light.get('--faint') ?? '', /#[0-9a-f]{3,8}/i);

  assert.match(light.get('--display') ?? '', /^"Figtree"/);
  assert.match(light.get('--ui') ?? '', /^"Onest"/);
  assert.equal(light.get('--sans'), 'var(--ui)');
  assert.equal(light.get('--serif'), 'var(--display)');
  assert.match(light.get('--mono') ?? '', /^"JetBrains Mono"/);
  assert.match(light.get('--radius') ?? '', /^\d+px$/);
});

test('no raw hex is left outside the token blocks', () => {
  const withoutBlocks = BRAND_CSS
    .replace(LIGHT_BLOCK, '')
    .replace(DARK_BLOCK, '')
    .replace(SYSTEM_DARK_BLOCK, '');
  assert.doesNotMatch(withoutBlocks, /#[0-9a-f]{3,8}\b/i);
});

test('the stylesheet starts from the one brand block', () => {
  assert.ok(CSS.startsWith(BRAND_CSS), 'the page stylesheet does not start with BRAND_CSS');
  const own = CSS.slice(BRAND_CSS.length);
  assert.doesNotMatch(own, /(^|[;{\s])--[a-z][a-z-]*:/m, 'render.ts declares its own custom property');
  assert.doesNotMatch(own, /#[0-9a-f]{3,8}\b/i, 'render.ts paints with a raw hex');
  assert.match(own, /\.brand-mark svg \{[^}]*width: 100%;[^}]*height: 100%/);
  assert.match(own, /@media \(prefers-reduced-motion: reduce\)/);
});

test('the mark is the fixed-hex 1024 plate, not a themed surface', () => {
  assert.match(BRAND_MARK, /viewBox="0 0 1024 1024"/);
  assert.match(BRAND_MARK, /rx="224"/);
  assert.match(BRAND_MARK, /fill="#0F1720"/);
  assert.match(BRAND_MARK, /stroke="#F4F6F9"/);
  assert.match(BRAND_MARK, /fill="#1D4ED8"/);
  assert.match(BRAND_MARK, /rotate\(10 642 729\)/);
  assert.match(BRAND_MARK, /aria-hidden="true"/);
  assert.doesNotMatch(BRAND_MARK, /var\(--/);
  assert.doesNotMatch(BRAND_MARK, /currentColor/);
});

test('the favicon keeps the plate radius and the store icon is full bleed', () => {
  const favicon = read('favicon.svg');
  const icon = read('icon.svg');
  for (const mark of [favicon, icon]) {
    assert.match(mark, /viewBox="0 0 1024 1024"/);
    assert.match(mark, /fill="#0F1720"/);
    assert.match(mark, /fill="#F4F6F9"/);
    assert.match(mark, /fill="#1D4ED8"/);
  }
  assert.match(favicon, /<rect width="1024" height="1024" rx="224"/);
  assert.doesNotMatch(icon, /rx="224"/);
});

test('assetUrl pins a brand file to the asset version', () => {
  assert.equal(assetUrl('favicon.svg'), `/favicon.svg?v=${ASSET_VERSION}`);
  assert.equal(assetUrl('icon-192.png'), `/icon-192.png?v=${ASSET_VERSION}`);
  assert.equal(assetUrl('fonts/figtree-400-latin.woff2'), `/fonts/figtree-400-latin.woff2?v=${ASSET_VERSION}`);
  assert.doesNotMatch(assetUrl('icon.svg'), /\/static\//);
  assert.match(ASSET_VERSION, /^\d+$/);
});

test('the manifest points at the versioned icons', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  for (const icon of manifest.icons) {
    assert.equal(icon.src, `${icon.src.split('?')[0]}?v=${ASSET_VERSION}`, `${icon.src} carries no asset version`);
  }
});

test('the shell theme colours are the paper token', () => {
  const light = block(BRAND_CSS, LIGHT_BLOCK, ':root');
  const dark = block(BRAND_CSS, DARK_BLOCK, ':root[data-theme="dark"]');
  assert.equal(THEME_COLORS.light, light.get('--paper'));
  assert.equal(THEME_COLORS.dark, dark.get('--paper'));
});

const PAGES = {
  library: () => renderPage({ bookmarks: [], total: 0, query: '' }),
  calendar: () => renderCalendar({ calendar: { month: '2026-11', days: [], total: 0 } }),
  settings: () =>
    renderSettings({
      settings: { summaryPrompt: '', summaryLanguage: 'en' },
      ai: { provider: 'custom', model: 'model-x', transport: 'http' },
      aiConfigured: true,
    }),
  login: () => renderLogin({}),
};

for (const [name, render] of Object.entries(PAGES)) {
  test(`the ${name} page links the versioned icons and renders the mark`, () => {
    const html = render();
    assert.equal((html.match(/"brand-mark( large)?"/g) || []).length, 1, 'expected exactly one mark per page');
    assert.match(html, /rel="icon" href="\/favicon\.svg\?v=\d+"/);
    assert.match(html, /rel="apple-touch-icon" href="\/icon-192\.png\?v=\d+"/);
    assert.match(html, /rel="manifest" href="\/manifest\.webmanifest\?v=\d+"/);
    assert.match(html, /<link rel="stylesheet" href="\/style\.css\?v=\d+">/);
    assert.match(html, /fill="#0F1720"/, 'the header does not render the brand mark');
    assert.doesNotMatch(html, /var\(--ink\)"><\/svg>/);
  });
}
