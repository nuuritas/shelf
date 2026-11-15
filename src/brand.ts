/**
 * One brand for every web surface.
 *
 * The palette, the `@font-face` set and the mark live here and nowhere else.
 * `src/render.ts` starts its stylesheet from `BRAND_CSS` and drops `BRAND_MARK`
 * into the header, so a colour or a typeface changes in one file. The sibling
 * of this module is `src/brand.ts` in `nuuritas/shelf-cloud`, which the public
 * site, the in-app library and the native clients read; this Worker and Shelf
 * Cloud therefore draw the same tokens, the same type and the same mark.
 *
 * Fonts are self-hosted subsets in `public/fonts`, served from `/fonts/`; no
 * request leaves the origin. Figtree is the voice, Onest is the interface,
 * JetBrains Mono is only for values (refs, counts, dates, sizes).
 *
 * Theme is a token swap in one of two places: `[data-theme="dark"]` when the
 * reader picked dark, or the media query when the choice is the system.
 * `[data-theme="light"]` wins over a dark OS, which is the point of the
 * setting. `src/appearance.ts` reads the reader's cookie and `pageShell` writes
 * the attribute on the server, so the first paint is already right.
 */

/**
 * Version of the brand files in `public/`.
 *
 * Cloudflare serves an asset at a fixed path from cache, so a file that keeps
 * its name and changes its bytes can keep showing the old drawing: the cobalt
 * mark was redrawn under the same `icon.svg` URL as the terracotta one. Every
 * icon link in `pageShell` carries this value instead, and the manifest link
 * with it. Bump it in the same commit that redraws a file under `public/`;
 * version 1 was the terracotta mark, version 2 the cobalt one.
 */
export const ASSET_VERSION = '2';

/** A `public/` URL pinned to the version above, so a redraw gets a new URL. */
export function assetUrl(file: string): string {
  return `/${file}?v=${ASSET_VERSION}`;
}

const LIGHT_TOKENS = `
--paper:#f4f6f9;
--paper-deep:#e9edf3;
--card:#ffffff;
--ink:#0f1720;
--ink-soft:#33404f;
--soft:#5a6775;
--rule:#dce2ea;
--rule-strong:#c3ccd8;
--accent:#1d4ed8;
--accent-wash:#e4ebff;
--ok:#0f6b4c;
--ok-wash:#e7f2ec;
--danger:#b42318;
--danger-wash:#fdecea;
--label-1-ink:#1d4ed8;
--label-1-wash:#e4ebff;
--label-2-ink:#0f6b4c;
--label-2-wash:#e7f2ec;
--label-3-ink:#8a5a00;
--label-3-wash:#fbf1dc;
--label-4-ink:#a8321f;
--label-4-wash:#fdecea;
--label-5-ink:#6a3fa8;
--label-5-wash:#f0eafc;
--label-6-ink:#3f5566;
--label-6-wash:#e9eff5;
--deep:#0b1017;
--deep-ink:#e8eef5;
--deep-soft:#98a4b3;
--shadow:0 18px 50px rgba(15,23,32,.08);
color-scheme:light;
`;

const DARK_TOKENS = `
--paper:#0d1117;
--paper-deep:#11161d;
--card:#151b23;
--ink:#e8eef5;
--ink-soft:#c3cdd8;
--soft:#97a3b1;
--rule:#232b35;
--rule-strong:#323c48;
--accent:#7da2ff;
--accent-wash:#16203a;
--ok:#6fcfa6;
--ok-wash:#12251d;
--danger:#ff9b90;
--danger-wash:#3a1d1a;
--label-1-ink:#a6bdff;
--label-1-wash:#1a2440;
--label-2-ink:#7fd8b0;
--label-2-wash:#12251d;
--label-3-ink:#f0c071;
--label-3-wash:#2b2213;
--label-4-ink:#ffa79c;
--label-4-wash:#331a17;
--label-5-ink:#c6aaf7;
--label-5-wash:#241a38;
--label-6-ink:#b3c3d1;
--label-6-wash:#1c242c;
--deep:#070b10;
--deep-ink:#e8eef5;
--deep-soft:#8494a3;
--shadow:0 22px 60px rgba(0,0,0,.35);
color-scheme:dark;
`;

/**
 * The tokens are named after what they paint. The library was built on an
 * older set (`--bg`, `--surface`, `--muted`), so those names stay as aliases
 * instead of rewriting every rule. An alias is a `var()` reference, so it
 * follows the dark block without being declared twice.
 *
 * `--text-scale` is the one value here that is not a colour: the stylesheet's
 * root `font-size` multiplies by it and every text size downstream is in
 * `rem`, so it is what makes the reader's size choice real.
 */
const ALIASES = `
--display:"Figtree",system-ui,-apple-system,"Segoe UI",sans-serif;
--ui:"Onest","Figtree",system-ui,-apple-system,"Segoe UI",sans-serif;
--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--sans:var(--ui);
--serif:var(--display);
--bg:var(--paper);
--surface:var(--card);
--surface-soft:var(--paper-deep);
--muted:var(--soft);
--faint:color-mix(in srgb,var(--soft) 70%,var(--paper));
--line:var(--rule);
--line-strong:var(--rule-strong);
--accent-ink:var(--accent);
--accent-soft:var(--accent-wash);
--green:var(--ok);
--green-soft:var(--ok-wash);
--red:var(--danger);
--red-soft:var(--danger-wash);
--radius:16px;
--text-scale:1;
`;

/**
 * The reader's four text sizes, as multipliers on the 16px root. They live here
 * because `--text-scale` is a token like any other, and because the rule that
 * reads it belongs next to the palette rather than in a page. `src/appearance.ts`
 * validates the choice and reads this table; the cookie never carries a number,
 * only one of these four names.
 */
export const TEXT_SCALES: Record<'compact' | 'normal' | 'large' | 'xlarge', number> = {
  compact: 0.9,
  normal: 1,
  large: 1.1,
  xlarge: 1.2,
};

/**
 * The attribute, not an inline style: `<html data-size="large">` and this rule.
 * A `style="--text-scale:1.1"` would be an inline style to CSP and would cost
 * `style-src 'unsafe-inline'` on every page.
 */
export const TEXT_SCALE_CSS = Object.entries(TEXT_SCALES)
  .map(([size, scale]) => `:root[data-size="${size}"]{--text-scale:${scale}}`)
  .join('\n');

/**
 * The tile glyph: dark rounded square, white shelf, six bars, one tilted blue
 * bar. `public/favicon.svg` carries the same geometry.
 *
 * Fixed hex, not tokens: this is the mark, not a themed surface. It stays dark
 * on paper and on ink, and it is never inverted or haloed per theme. The `rx`
 * on the outer rect is the shape, so nothing clips it to another radius.
 */
export const BRAND_MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
  <rect width="1024" height="1024" rx="224" fill="#0F1720"/>
  <g fill="none" stroke="#F4F6F9" stroke-width="36">
    <rect x="272" y="184" width="480" height="656" rx="60"/>
    <path d="M254 526H770"/>
  </g>
  <g fill="#F4F6F9">
    <rect x="340" y="370" width="60" height="119" rx="10"/>
    <rect x="424" y="348" width="60" height="141" rx="10"/>
    <rect x="508" y="396" width="60" height="93" rx="10"/>
    <rect x="340" y="618" width="60" height="204" rx="10"/>
    <rect x="424" y="588" width="60" height="234" rx="10"/>
    <rect x="508" y="644" width="60" height="178" rx="10"/>
  </g>
  <rect x="614" y="638" width="56" height="182" rx="10" fill="#1D4ED8" transform="rotate(10 642 729)"/>
</svg>`;

/**
 * The two `<meta name="theme-color">` values: the `--paper` token, read back
 * out of the blocks above so the paper is written once in this file.
 */
function paperOf(tokens: string): string {
  const match = tokens.match(/--paper:(#[0-9a-f]{6});/i);
  if (!match) throw new Error('BRAND_CSS is missing the --paper token');
  return match[1];
}

export const THEME_COLORS = {
  light: paperOf(LIGHT_TOKENS),
  dark: paperOf(DARK_TOKENS),
} as const;

export const BRAND_CSS = `
:root{${LIGHT_TOKENS}${ALIASES}}
:root[data-theme="dark"]{${DARK_TOKENS}}
@media(prefers-color-scheme:dark){
:root:not([data-theme="light"]){${DARK_TOKENS}}
}
${TEXT_SCALE_CSS}
@font-face{font-family:"Figtree";font-style:normal;font-weight:400;font-display:swap;
src:url("/fonts/figtree-400-latin.woff2") format("woff2");
unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Figtree";font-style:normal;font-weight:400;font-display:swap;
src:url("/fonts/figtree-400-latin-ext.woff2") format("woff2");
unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Figtree";font-style:normal;font-weight:500;font-display:swap;
src:url("/fonts/figtree-500-latin.woff2") format("woff2");
unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Figtree";font-style:normal;font-weight:500;font-display:swap;
src:url("/fonts/figtree-500-latin-ext.woff2") format("woff2");
unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Figtree";font-style:normal;font-weight:600;font-display:swap;
src:url("/fonts/figtree-600-latin.woff2") format("woff2");
unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Figtree";font-style:normal;font-weight:600;font-display:swap;
src:url("/fonts/figtree-600-latin-ext.woff2") format("woff2");
unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Onest";font-style:normal;font-weight:400;font-display:swap;
src:url("/fonts/onest-400-latin.woff2") format("woff2");
unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Onest";font-style:normal;font-weight:400;font-display:swap;
src:url("/fonts/onest-400-latin-ext.woff2") format("woff2");
unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Onest";font-style:normal;font-weight:500;font-display:swap;
src:url("/fonts/onest-500-latin.woff2") format("woff2");
unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Onest";font-style:normal;font-weight:500;font-display:swap;
src:url("/fonts/onest-500-latin-ext.woff2") format("woff2");
unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Onest";font-style:normal;font-weight:600;font-display:swap;
src:url("/fonts/onest-600-latin.woff2") format("woff2");
unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Onest";font-style:normal;font-weight:600;font-display:swap;
src:url("/fonts/onest-600-latin-ext.woff2") format("woff2");
unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:400;font-display:swap;
src:url("/fonts/jetbrains-mono-400-latin.woff2") format("woff2");
unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:400;font-display:swap;
src:url("/fonts/jetbrains-mono-400-latin-ext.woff2") format("woff2");
unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:500;font-display:swap;
src:url("/fonts/jetbrains-mono-500-latin.woff2") format("woff2");
unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:500;font-display:swap;
src:url("/fonts/jetbrains-mono-500-latin-ext.woff2") format("woff2");
unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
`;
