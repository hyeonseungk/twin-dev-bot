import { en, type TranslationKey } from "./en.js";

export type { TranslationKey };

type Locale = "en";
type TranslationMap = Record<TranslationKey, string>;

const translations: Record<Locale, TranslationMap> = { en };

let currentLocale: Locale = "en";

/**
 * Initialize locale. Currently only "en" is supported.
 *
 * To add a new locale:
 * 1. Create a new translation file (e.g. ko.ts).
 * 2. Extend the Locale union type.
 * 3. Add parsing logic here to detect the locale (e.g. from an env var).
 */
export function initLocale(): void {
  // no-op while only "en" is supported
}

export function getCurrentLocale(): Locale {
  return currentLocale;
}

/**
 * Look up a translation key for the current locale.
 * Replaces {{param}} placeholders with values from params.
 *
 * Fallback chain: current locale -> en -> raw key string.
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const map = translations[currentLocale];
  let text = map[key] ?? translations.en[key] ?? key;

  if (params) {
    text = text.replace(/\{\{(\w+)\}\}/g, (match, k) =>
      k in params ? String(params[k]) : match,
    );
  }

  return text;
}
