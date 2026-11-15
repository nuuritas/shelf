# Design: Slate and Cobalt

Shelf is one brand on several surfaces. The tokens, the type and the mark are
written once, in `src/brand.ts`, and this Worker's whole stylesheet is that
block plus its own rules.

The private Shelf Cloud repository carries the sibling module of this one, and
it is the same design: this Worker and Shelf Cloud draw the same tokens, the
same three typefaces and the same 1024-unit mark, so a reader who moves between
them sees one product. Changing a colour here means changing
`src/brand.ts` there too, and the reverse.

| Surface | Where | Mark | Type |
| --- | --- | --- | --- |
| library, folder, calendar, settings, login | `src/render.ts` | `BRAND_MARK` from `src/brand.ts` | Figtree / Onest / JetBrains Mono |
| browser tab, app header | `public/favicon.svg` | `rx 224` plate | — |
| installed PWA | `public/icon-192.png`, `public/icon-512.png` | full bleed | — |
| installed PWA, masked launcher | `public/icon-maskable-512.png` | plate plus safe-zone motif | — |

Three rules hold it together:

1. **One accent.** Cool paper, blue-black ink, one cobalt accent. There is no
   second brand colour, and no gradient used as decoration.
2. **Three typefaces, three jobs.** Figtree is the voice, Onest is the
   interface, JetBrains Mono is only for values. No italic anywhere.
3. **One mark.** The same geometry in `BRAND_MARK`, `public/favicon.svg`,
   `public/icon.svg` and `public/icon-maskable.svg`.

## Colour

Every colour is a token. Dark mode is a token swap: one block for
`[data-theme="dark"]`, one for a dark system scheme. No rule lower in the
stylesheet knows which theme is active, and no rule outside `src/brand.ts`
writes a hex value.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--paper` | `#f4f6f9` | `#0d1117` | page background, input fill |
| `--paper-deep` | `#e9edf3` | `#11161d` | day banner, segmented track, code blocks |
| `--card` | `#ffffff` | `#151b23` | cards, add form, login card, control backgrounds |
| `--ink` | `#0f1720` | `#e8eef5` | body text, primary button fill, the mark plate |
| `--ink-soft` | `#33404f` | `#c3cdd8` | list text that is not a heading |
| `--soft` | `#5a6775` | `#97a3b1` | secondary text, leads, meta, labels |
| `--rule` | `#dce2ea` | `#232b35` | hairlines between rows and bands |
| `--rule-strong` | `#c3ccd8` | `#323c48` | input borders, dot separators |
| `--accent` | `#1d4ed8` | `#7da2ff` | emphasis, links, focus, the leaning spine |
| `--accent-wash` | `#e4ebff` | `#16203a` | day count, selected chip |
| `--ok` | `#0f6b4c` | `#6fcfa6` | the success banner |
| `--ok-wash` | `#e7f2ec` | `#12251d` | the success banner fill |
| `--danger` | `#b42318` | `#ff9b90` | the error banner |
| `--danger-wash` | `#fdecea` | `#3a1d1a` | the error banner fill |
| `--deep` | `#0b1017` | `#070b10` | reserved; nothing paints with it yet |
| `--deep-ink` | `#e8eef5` | `#e8eef5` | reserved, text on `--deep` |
| `--deep-soft` | `#98a4b3` | `#8494a3` | reserved, secondary text on `--deep` |
| `--shadow` | `0 18px 50px rgba(15,23,32,.08)` | `0 22px 60px rgba(0,0,0,.35)` | the add form and the login card |

The paper is cool (a faint blue cast, not cream) so the page reads as a working
surface rather than as stationery. The accent is a single cobalt: dark enough
on paper to carry body-size links and light enough on the dark background to
stay legible. Nothing else is allowed to be a brand colour; the `--ok` green
belongs to status, not identity.

`--ink-soft` and the three `--deep` tokens are carried for parity with Shelf
Cloud rather than because this Worker paints with them. They are part of the
shared schema; deleting them here would make the two brand modules differ for
no reason.

### Aliases

The library was built before the tokens were named after what they paint, so
`--bg`, `--surface`, `--surface-soft`, `--muted`, `--faint`, `--line`,
`--line-strong`, `--accent-ink`, `--accent-soft`, `--green`, `--green-soft`,
`--red` and `--red-soft` stay as aliases of the token above them. An alias is a
`var()` reference (or, for `--faint`, a `color-mix` of `--soft` and `--paper`),
so it follows the dark block without being declared twice.

`--display`, `--ui`, `--sans`, `--serif`, `--mono` and `--radius` live in the
same block. `--sans` is `var(--ui)`, so rules that predate the split keep
working.

### Measured contrast

Every text token clears WCAG AA (4.5:1) at body size.

| Pair | Light | Dark |
| --- | --- | --- |
| ink on paper | 16.7:1 | 16.2:1 |
| ink on card | 18.0:1 | 14.8:1 |
| ink-soft on paper | 9.8:1 | 11.8:1 |
| soft on paper | 5.3:1 | 7.4:1 |
| soft on card | 5.8:1 | 6.8:1 |
| soft on paper-deep | 4.9:1 | 7.1:1 |
| accent on paper | 6.2:1 | 7.6:1 |
| accent on card | 6.7:1 | 7.0:1 |
| `--ok` on card | 6.5:1 | 9.2:1 |
| paper on an accent fill (hover chip, tag) | 6.2:1 | 7.6:1 |
| deep-soft on deep | 7.5:1 | 6.3:1 |
| deep-ink on deep | 16.3:1 | 16.9:1 |

`--soft` is deliberately the lightest secondary text, and it is the token to
re-check first if you touch the palette: at 5.3:1 it has little room, and on
`--paper-deep` it is 4.9:1. Do not darken the paper or lighten the ink without
re-running these numbers.

Selection and focus use the accent. Any control that is filled with the accent
takes `--paper` as its label (`--accent` on `--paper` and `--paper` on
`--accent` are the same 6.2:1 pair), which is why no rule needs white.

## Theme

Today the page follows the operating system: `@media(prefers-color-scheme:dark)`
swaps the tokens on `:root`. The two `data-theme` selectors are already in
`BRAND_CSS` and are the ones the reader's own choice will use:

- `[data-theme="dark"]` wins over a light system.
- `[data-theme="light"]` wins over a dark system.
- No `data-theme` attribute means the media query decides.

Nothing writes the attribute yet. A build that does writes it on `<html>` on
the server, in `src/render.ts`, so the first paint is already correct and no
script is needed. The stylesheet below the brand block never learns that a
theme exists.

## The mark

The icon is the app artwork, drawn as vectors. It is a plate, inside it a book
frame with one divider (the two shelves), two rows of three spines with
different heights, and one spine leaning against the bottom row in the accent.
The lean is the only asymmetric thing in the identity.

Geometry on a 1024 grid:

```
plate         0 0 1024 1024          rx 224 (tab, header) / full bleed (store icon)
frame         272 184 480 656        rx 60, stroke 36
divider       M254 526 H770          stroke 36
top spines    340/424/508 × 370/348/396, 60 wide, 119/141/93 tall, rx 10
bottom spines 340/424/508 × 618/588/644, 60 wide, 204/234/178 tall, rx 10
leaning spine 614 638 56 182         rx 10, rotate 10° about (642, 729), accent
maskable      the same mark at 80% about (512, 512) on a full-bleed plate
```

The mark is fixed hex — `#0F1720` plate, `#F4F6F9` spines, `#1D4ED8` lean —
and not tokens. It is the mark, not a themed surface: it stays dark on paper
and on ink, and it is never inverted or haloed per theme. The `rx` on the outer
rect is the shape, so no wrapper clips it to another radius.

Files that must stay in step:

- `src/brand.ts` — `BRAND_MARK`, the inline SVG in the header and on the login
  card.
- `public/favicon.svg` — the same drawing with the `rx 224` plate; the browser
  tab and the app header.
- `public/icon.svg` — full bleed, no `rx`; the store artwork and the source of
  the square PNGs.
- `public/icon-maskable.svg` — the full-bleed plate with the mark at 80%, so a
  launcher can crop it to any shape without cutting the shelf.
- `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png`
  — generated with `rsvg-convert`, never hand-edited:

  ```bash
  rsvg-convert -w 192 -h 192 public/icon.svg -o public/icon-192.png
  rsvg-convert -w 512 -h 512 public/icon.svg -o public/icon-512.png
  rsvg-convert -w 512 -h 512 public/icon-maskable.svg -o public/icon-maskable-512.png
  magick identify public/icon-*.png   # the sizes above must not drift
  ```

Icons keep a fixed path, so every link carries `?v=${ASSET_VERSION}` from
`src/brand.ts`: the `favicon.svg`, `icon-192.png` and `manifest.webmanifest`
links in `pageShell`, and the icon entries inside
`public/manifest.webmanifest`. Bump that constant in the same commit that
redraws a file under `public/`, or a cached copy of the old drawing keeps the
old URL. Version 1 was the terracotta mark; version 2 is the cobalt one.
`test/brand.test.js` fails on an icon link without the current version.

The PNGs are not read by any test's pixels, so look at the rendered file, not
just the exit code.

## Type

| Role | Family | Weight | Size | Where |
| --- | --- | --- | --- | --- |
| wordmark | Figtree | 600 | 1rem | `.brand` |
| hero display | Figtree | 500 | `clamp(42px, 8vw, 76px)`, 1.02 | `.hero h1` |
| section heading | Figtree | 500 | 24px | `.library-head h2` |
| card title | Figtree | 600–650 | 19–21px | `.note-card-title`, card headings |
| post text | Onest | 400 | 17px / 1.62 | `.tweet-text` |
| summary | Onest | 400 | 13.5px / 1.6 | `.summary-text` |
| lead paragraph | Onest | 400 | 17px / 1.6 | `.lede` |
| body | Onest | 400 | 16px / 1.55 | `body` |
| interface label | Onest | 600 | 12–12.5px | `.small-button`, `.calendar-link`, switches |
| meta row | Onest | 400 | 13px | `.top-actions`, card footer |
| numeric / literal | JetBrains Mono | 400 | 11.5px | `.count`, refs, dates |

Figtree is a geometric sans with slightly rounded terminals. It holds at 76px
without needing a serif's optical-size axis, and it carries the wordmark
because it sets the same letterforms as the headings. It is instanced at 400,
500 and 600; headings use 500–600, because a sans at display size needs the
weight a serif's stems used to supply.

Onest carries every piece of reading and interface text: navigation, buttons,
meta rows, form labels. Weights are 400, 500 and 600. A fourth weight would add
a file and blur the distinction between body and label.

JetBrains Mono appears only where a value is meant to be read as a value: a
bookmark ref, a count, a date, a size. It is never a decorative label.
Uppercase mono eyebrows are what made earlier versions look like a template; do
not bring them back.

No italic is used anywhere. Where an emphasis was italic, use weight or the
accent colour.

### Size and spacing rules

- Display sizes use `clamp()` with a `vw` term, so the hero holds two lines at
  1440px in English (three in Turkish, where the copy is longer) and still fits
  a 390px screen without a media query.
- Letter-spacing tightens as size grows: `-.025em` on the hero, `-.02em` on card
  headings, none on body.
- Body measure is capped at 590px for the lead. Nothing runs the full column.

## Fonts

All three families are SIL Open Font License 1.1. They are self-hosted subsets
in `public/fonts/`, served from `/fonts/` by the Worker's asset binding: no
surface loads a third-party font, stylesheet or script, and no rule uses
`@import`.

| Family | Weights | Files |
| --- | --- | --- |
| Figtree | 400, 500, 600 | `figtree-{400,500,600}-{latin,latin-ext}.woff2` |
| Onest | 400, 500, 600 | `onest-{400,500,600}-{latin,latin-ext}.woff2` |
| JetBrains Mono | 400, 500 | `jetbrains-mono-{400,500}-{latin,latin-ext}.woff2` |

The `@font-face` blocks live in `BRAND_CSS` in `src/brand.ts`, one pair per
weight. The `unicode-range` on each is the Google subset range, so `latin-ext`
is fetched only when a glyph outside Latin-1 appears. That includes Turkish
(`ş ğ İ ı`), which is why the `latin-ext` files are not optional: the Turkish
page needs them on the first heading.

The licences are `public/fonts/OFL-Figtree.txt`, `public/fonts/OFL-Onest.txt`
and `public/fonts/OFL-JetBrainsMono.txt`. The variable originals were instanced
with `fonttools varLib.instancer` and split into `latin` and `latin-ext`
subsets.

Do not map a Google Fonts URL to a file by guessing its order. Parse the
`@font-face` blocks for family, style and subset first; a swapped file looks
like a font that "did not load" in a screenshot and is hard to spot.

## Layout

One column, one container per band of the page:

- `.topbar` — `min(900px, 100% - 36px)`, one row: mark and wordmark on the
  left, the current page's actions on the right (saves count, Settings or
  Library, Log out).
- `.shell` — `min(820px, 100% - 36px)`, the reading column: the library, a
  folder, the calendar, the settings page and the full-note body.
- `.note-bar` — `min(900px, 100% - 36px)`, the full-note page's own bar: back
  link, AI badge, source link.

Bands are separated by a 1px `--rule` hairline. Cards are `--card` on
`--paper`, one hairline border and `--radius` corners; `--shadow` is reserved
for the add form and the login card, which float above the page.

### Breakpoints

- **650px** — the single breakpoint. The topbar and shell lose 12px of gutter,
  the hero drops to `clamp(38px, 12vw, 58px)`, the add form stacks, the library
  head and its tools go vertical, cards lose padding, the calendar tightens and
  the settings cards go to one column.
- The note page uses the same 650px boundary for its own stack.

Nothing between 651px and 1440px is special-cased; the clamps carry it. Check
768px and 1024px after a layout change, because that is where a two-column
block is closest to failing.

## Motion

One animation, `pulse`: the three accent bars that stand in for a summary that
is still running, 1.2s, staggered by 150ms. Everything else is a colour change
or a 1px lift on hover, 120–130ms.

`@media (prefers-reduced-motion: reduce)` removes the animation, every
transition and smooth scrolling. Keep that block in step with anything new.

## Changing it

- Add a colour by adding a token to both theme blocks in `BRAND_CSS` in
  `src/brand.ts`, to the sibling `src/brand.ts` in Shelf Cloud, and a row to the
  table above. Do not write a hex value inside a rule; `test/brand.test.js`
  fails on a hex outside the token blocks.
- Rename or add a legacy alias in the same block, never in `src/render.ts`.
- Change a size by changing the rule in `src/render.ts`, not by overriding a
  single selector from the page.
- Change the mark by changing the geometry in every file listed under **The
  mark**, then regenerate the PNGs with `rsvg-convert` and look at them.
- A new font needs a web subset in `public/fonts/`, an OFL note, an
  `@font-face` pair with the `unicode-range` in `BRAND_CSS`, and a weight that
  one of the three roles actually uses. Fonts stay same-origin; no CDN, no
  `@import`.
- After a change, render the library, a note, the calendar, the settings page
  and the login page at 1440, 1024, 768 and 390 in both themes, and check the
  Turkish pages: copy is longer and the `latin-ext` files must actually load.
