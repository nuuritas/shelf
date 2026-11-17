/**
 * The language a reader picks in Settings.
 *
 * Interface text is translated into English and Turkish only, so a choice
 * outside those two changes what the product writes rather than how it reads:
 * new summaries are written in the chosen language. That costs nothing to
 * support for a language with no copy, so the list below is a convenience and
 * not a gate — any language `Intl` knows, and any language typed by its own
 * name, resolves to a tag.
 */

export type Language = {
  /** Canonical BCP-47 tag, e.g. `pt-BR`. */
  tag: string;
  /** The language's own name, e.g. `Português`. */
  native: string;
  /** Its English name, e.g. `Portuguese`. */
  english: string;
};

/**
 * The offered languages. Base tags only: a regional variant such as `pt-BR`
 * is still accepted when typed, it just is not worth a menu row.
 */
const TAGS: readonly string[] = [
  'af', 'am', 'ar', 'as', 'az', 'be', 'bg', 'bn', 'bs', 'ca', 'cs', 'cy', 'da',
  'de', 'el', 'en', 'eo', 'es', 'et', 'eu', 'fa', 'fi', 'fil', 'fr', 'ga', 'gl',
  'gu', 'ha', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'ig', 'is', 'it', 'ja', 'ka',
  'kk', 'km', 'kn', 'ko', 'ku', 'ky', 'lo', 'lt', 'lv', 'mk', 'ml', 'mn', 'mr',
  'ms', 'mt', 'my', 'ne', 'nl', 'no', 'pa', 'pl', 'ps', 'pt', 'ro', 'ru', 'si',
  'sk', 'sl', 'so', 'sq', 'sr', 'st', 'sv', 'sw', 'ta', 'te', 'th', 'tk', 'tr',
  'tt', 'uk', 'ur', 'uz', 'vi', 'xh', 'yo', 'zh', 'zu',
];

/**
 * A name for a tag in a locale, or an empty string when `Intl` only echoes the
 * tag back — which is how it answers a language it does not know.
 */
function displayName(tag: string, locales: string[]): string {
  try {
    const name = new Intl.DisplayNames(locales, { type: 'language' }).of(tag) ?? '';
    return name.trim().toLowerCase() === tag.trim().toLowerCase() ? '' : name.trim();
  } catch {
    return '';
  }
}

let options: Language[] | null = null;

/** The menu, alphabetised by English name. Built once: `Intl` is not cheap. */
export function languageOptions(): Language[] {
  if (options) return options;
  const list = TAGS.map((tag) => {
    const english = displayName(tag, ['en']) || tag;
    return { tag, english, native: displayName(tag, [tag]) || english };
  });
  list.sort((a, b) => a.english.localeCompare(b.english, 'en'));
  return (options = list);
}

/**
 * Comparison form: case, accents and extra spaces should not decide whether a
 * language is recognised, because people type `Turkce` as often as `Türkçe`.
 */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

let index: Map<string, string> | null = null;

/** Names and tags both point at a canonical tag. */
function nameIndex(): Map<string, string> {
  if (index) return index;
  const map = new Map<string, string>();
  for (const language of languageOptions()) {
    for (const key of [language.tag, language.english, language.native]) {
      const folded = fold(key);
      if (!map.has(folded)) map.set(folded, language.tag);
    }
  }
  return (index = map);
}

export const LANGUAGE_TAG_MAX = 35;

/**
 * What a reader is told when nothing they typed names a language. Shared so the
 * JSON route and the Settings page refuse the same value with the same words.
 */
export const LANGUAGE_UNKNOWN_MESSAGE =
  'That is not a language we recognise. Try a name such as Deutsch, or a tag such as de or sr-Latn.';

/**
 * What a reader typed, as a tag. A name (`Deutsch`, `Turkish`), a tag (`de`,
 * `pt-br`) and a tag with a script or region (`sr-Latn`, `en-GB`) all work.
 * Anything `Intl` cannot name is rejected rather than stored, so a typo does
 * not become a language.
 */
export function resolveLanguage(input: string | null | undefined): string | null {
  const value = (input ?? '').trim().replace(/\s+/g, ' ');
  if (!value || value.length > LANGUAGE_TAG_MAX) return null;

  const named = nameIndex().get(fold(value));
  if (named) return named;

  let canonical: string;
  try {
    canonical = Intl.getCanonicalLocales(value)[0] ?? '';
  } catch {
    return null;
  }
  if (!canonical || canonical.length > LANGUAGE_TAG_MAX) return null;
  // `Intl` accepts a well-formed tag for a language it cannot name; that is a
  // typo, not a choice, so it needs a name to be kept.
  const base = canonical.split('-')[0] ?? '';
  return displayName(base, ['en']) ? canonical : null;
}

/** A tag as names; an unlisted tag is named by `Intl` and falls back to itself. */
export function languageOf(tag: string): Language {
  const known = languageOptions().find(
    (language) => language.tag.toLowerCase() === tag.toLowerCase(),
  );
  if (known) return known;
  const english = displayName(tag, ['en']) || tag;
  return { tag, native: displayName(tag, [tag]) || english, english };
}

/** The English name a prompt can use, e.g. `Serbian` for `sr-Latn`. */
export function englishLanguageName(tag: string | null | undefined): string {
  const value = (tag ?? '').trim();
  if (!value) return 'English';
  return languageOf(value).english || 'English';
}
