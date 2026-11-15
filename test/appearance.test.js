import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPEARANCE_COOKIE,
  APPEARANCE_MAX_AGE,
  DEFAULT_APPEARANCE,
  TEXT_SIZES,
  appearanceAttributes,
  colorScheme,
  isTextSize,
  isTheme,
  parseAppearance,
  serializeAppearance,
  textScale,
  themeColorMeta,
} from '../src/appearance.ts';
import { THEME_COLORS } from '../src/brand.ts';

const THEMES = ['system', 'light', 'dark'];

function cookie(value) {
  return `${APPEARANCE_COOKIE}=${encodeURIComponent(value)}`;
}

test('the cookie is one year, one name, and one default', () => {
  assert.equal(APPEARANCE_COOKIE, 'shelf_look');
  assert.equal(APPEARANCE_MAX_AGE, 365 * 24 * 60 * 60);
  assert.deepEqual(DEFAULT_APPEARANCE, { theme: 'system', size: 'normal' });
  assert.deepEqual([...TEXT_SIZES], ['compact', 'normal', 'large', 'xlarge']);
});

test('every theme and size survives the round trip', () => {
  for (const theme of THEMES) {
    for (const size of TEXT_SIZES) {
      const look = { theme, size };
      const raw = serializeAppearance(look);
      assert.equal(raw, `theme=${theme}&size=${size}`);
      assert.deepEqual(parseAppearance(cookie(raw)), look, `${theme}/${size} did not round-trip`);
    }
  }
});

test('a missing or unknown cookie is the default', () => {
  assert.deepEqual(parseAppearance(undefined), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance(''), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance('other=1'), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance(cookie('')), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance(cookie('theme=sepia&size=huge')), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance(cookie('theme=DARK&size=Large')), DEFAULT_APPEARANCE);
});

test('one bad half does not throw away the other', () => {
  assert.deepEqual(parseAppearance(cookie('theme=dark&size=huge')), {
    theme: 'dark',
    size: 'normal',
  });
  assert.deepEqual(parseAppearance(cookie('theme=sepia&size=large')), {
    theme: 'system',
    size: 'large',
  });
});

test('a malformed percent-encoded cookie is the default, not an exception', () => {
  // `decodeURIComponent` throws on a lone `%`. This runs before routing, so an
  // exception here would 500 every page for that browser until it clears the
  // cookie; the value has to fall through to the guards instead.
  for (const header of [
    `${APPEARANCE_COOKIE}=%`,
    `${APPEARANCE_COOKIE}=%E0%A4%A`,
    `a=b; ${APPEARANCE_COOKIE}=theme=%`,
    `${APPEARANCE_COOKIE}=theme=%&size=large`,
    `${APPEARANCE_COOKIE}=theme=dark&size=%ZZ`,
  ]) {
    assert.doesNotThrow(() => parseAppearance(header), header);
  }

  assert.deepEqual(parseAppearance(`${APPEARANCE_COOKIE}=%`), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance(`${APPEARANCE_COOKIE}=theme=%&size=large`), {
    theme: 'system',
    size: 'large',
  });
  assert.deepEqual(parseAppearance(`${APPEARANCE_COOKIE}=theme=dark&size=%ZZ`), {
    theme: 'dark',
    size: 'normal',
  });
});

test('the appearance cookie is found among the session cookie', () => {
  const header = `shelf_session=v1.1.sig; ${cookie('theme=light&size=compact')}; other=x`;
  assert.deepEqual(parseAppearance(header), { theme: 'light', size: 'compact' });
});

test('the raw cookie the Worker sets parses as written', () => {
  const raw = `${APPEARANCE_COOKIE}=${serializeAppearance({ theme: 'dark', size: 'xlarge' })}`;
  assert.equal(raw, 'shelf_look=theme=dark&size=xlarge');
  assert.deepEqual(parseAppearance(`${raw}; shelf_session=v1.1.sig`), {
    theme: 'dark',
    size: 'xlarge',
  });
});

test('the guards accept exactly the offered values', () => {
  for (const theme of THEMES) assert.equal(isTheme(theme), true);
  for (const size of TEXT_SIZES) assert.equal(isTextSize(size), true);

  for (const value of ['sepia', 'Dark', '', null, undefined, 1, {}, ['dark']]) {
    assert.equal(isTheme(value), false, `${String(value)} is not a theme`);
    assert.equal(isTextSize(value), false, `${String(value)} is not a size`);
  }
});

test('the root scale is the choice, on the 16px root', () => {
  assert.equal(textScale({ theme: 'system', size: 'compact' }), 0.9);
  assert.equal(textScale({ theme: 'system', size: 'normal' }), 1);
  assert.equal(textScale({ theme: 'system', size: 'large' }), 1.1);
  assert.equal(textScale({ theme: 'system', size: 'xlarge' }), 1.2);
});

test('the html attributes write the theme only when one was chosen', () => {
  assert.equal(appearanceAttributes({ theme: 'system', size: 'normal' }), ' data-size="normal"');
  assert.equal(
    appearanceAttributes({ theme: 'light', size: 'compact' }),
    ' data-theme="light" data-size="compact"',
  );
  assert.equal(
    appearanceAttributes({ theme: 'dark', size: 'large' }),
    ' data-theme="dark" data-size="large"',
  );
  assert.equal(
    appearanceAttributes({ theme: 'dark', size: 'xlarge' }),
    ' data-theme="dark" data-size="xlarge"',
  );
  // The size is an attribute, never an inline style: CSP keeps style-src 'self'.
  assert.doesNotMatch(appearanceAttributes(DEFAULT_APPEARANCE), /style=/);
  assert.doesNotMatch(appearanceAttributes(DEFAULT_APPEARANCE), /data-theme/);
});

test('a system choice keeps both chrome colours, a chosen one needs a single', () => {
  assert.equal(colorScheme(DEFAULT_APPEARANCE), 'light dark');
  assert.equal(colorScheme({ theme: 'light', size: 'normal' }), 'light');
  assert.equal(colorScheme({ theme: 'dark', size: 'normal' }), 'dark');

  const system = themeColorMeta(DEFAULT_APPEARANCE);
  assert.match(system, new RegExp(`content="${THEME_COLORS.light}" media="\\(prefers-color-scheme: light\\)"`));
  assert.match(system, new RegExp(`content="${THEME_COLORS.dark}" media="\\(prefers-color-scheme: dark\\)"`));

  assert.equal(
    themeColorMeta({ theme: 'light', size: 'normal' }),
    `<meta name="theme-color" content="${THEME_COLORS.light}">`,
  );
  assert.equal(
    themeColorMeta({ theme: 'dark', size: 'normal' }),
    `<meta name="theme-color" content="${THEME_COLORS.dark}">`,
  );
});
