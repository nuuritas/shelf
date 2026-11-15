/**
 * How the reader wants the page to look: a theme and a text size.
 *
 * Both live in one cookie rather than on the deployment, because they are a
 * property of the screen in front of the person: a phone wants the compact
 * size, a desktop can take the large one, and the same account uses both. The
 * cookie is read on the server, so the first paint is already right and no
 * script has to run; that keeps the CSP at `script-src 'self'`.
 *
 * The sibling of this module is `src/appearance.ts` in `nuuritas/shelf-cloud`,
 * which the public site and the native clients read. The cookie is the wire
 * format: the Android and iOS clients read `shelf_look` out of the WebView's
 * own cookie store and paint their chrome with it, so the page and the bars
 * around it agree.
 */

import { TEXT_SCALES, THEME_COLORS } from './brand.ts';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type TextSizeChoice = 'compact' | 'normal' | 'large' | 'xlarge';

export type Appearance = {
  theme: ThemeChoice;
  size: TextSizeChoice;
};

export const APPEARANCE_COOKIE = 'shelf_look';
export const APPEARANCE_MAX_AGE = 365 * 24 * 60 * 60;

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', size: 'normal' };

export const TEXT_SIZES: readonly TextSizeChoice[] = ['compact', 'normal', 'large', 'xlarge'];

const THEMES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

export function isTheme(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function isTextSize(value: unknown): value is TextSizeChoice {
  return typeof value === 'string' && (TEXT_SIZES as readonly string[]).includes(value);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    if (part.slice(0, equals).trim() !== name) continue;
    return decodeURIComponent(part.slice(equals + 1).trim());
  }
  return undefined;
}

/** `theme=dark&size=large`, with anything unknown falling back to the default. */
export function parseAppearance(cookieHeader: string | undefined): Appearance {
  const raw = cookieValue(cookieHeader, APPEARANCE_COOKIE) ?? '';
  const values = new URLSearchParams(raw);
  const theme = values.get('theme');
  const size = values.get('size');
  return {
    theme: isTheme(theme) ? theme : DEFAULT_APPEARANCE.theme,
    size: isTextSize(size) ? size : DEFAULT_APPEARANCE.size,
  };
}

export function serializeAppearance(value: Appearance): string {
  return new URLSearchParams({ theme: value.theme, size: value.size }).toString();
}

export function textScale(value: Appearance): number {
  return TEXT_SCALES[value.size];
}

/**
 * Attributes for `<html>`: the theme selector and the text size. A `system`
 * theme writes no `data-theme`, so the stylesheet's media query decides.
 *
 * The size is a `data-size` attribute rather than `style="--text-scale:<n>"`,
 * which is what Shelf Cloud writes. A `style` attribute is an inline style to
 * CSP, so the cloud pays for its one number with `style-src 'unsafe-inline'` on
 * every page. A data attribute needs no inline style: `BRAND_CSS` maps the four
 * values to the same scale in a rule, and `style-src 'self'` stays as it was.
 */
export function appearanceAttributes(value: Appearance): string {
  const theme = value.theme === 'system' ? '' : ` data-theme="${value.theme}"`;
  return `${theme} data-size="${value.size}"`;
}

export function colorScheme(value: Appearance): string {
  return value.theme === 'system' ? 'light dark' : value.theme;
}

/**
 * The browser chrome colour. A system choice keeps the media pair; an explicit
 * theme needs one value, because the OS may be the opposite of the page. The
 * two hexes are `THEME_COLORS`, so the paper is still written once, in
 * `src/brand.ts`.
 */
export function themeColorMeta(value: Appearance): string {
  if (value.theme === 'light') {
    return `<meta name="theme-color" content="${THEME_COLORS.light}">`;
  }
  if (value.theme === 'dark') {
    return `<meta name="theme-color" content="${THEME_COLORS.dark}">`;
  }
  return [
    `<meta name="theme-color" content="${THEME_COLORS.light}" media="(prefers-color-scheme: light)">`,
    `<meta name="theme-color" content="${THEME_COLORS.dark}" media="(prefers-color-scheme: dark)">`,
  ].join('\n  ');
}
