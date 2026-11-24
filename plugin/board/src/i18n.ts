import { ko } from './ko.ts';

/**
 * Interface text in the viewer's language. The English text is the key, so a string with no entry, such as text
 * the daemon sends, still reads in English. How languages are chosen and how to add text is in docs/localization.md.
 */
export type Language = 'en' | 'ko';
const catalogs: Record<Exclude<Language, 'en'>, Record<string, string>> = { ko };

/** The first language in a preference list that the interface speaks, or English when none is. */
export function pickLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (base === 'en' || base in catalogs) return base as Language;
  }
  return 'en';
}

// Decided before any other module reads text, as some keep translated text in constants. Node, which runs the
// board's modules in tests and runs the Windows app's main process, has no window and reads English until told.
export let language: Language = typeof window === 'undefined' ? 'en' : pickLanguage(navigator.languages);
export function setLanguage(next: Language) {
  language = next;
}

/** `text` in the current language, with each `{name}` replaced by `values[name]`. */
export function t(text: string, values?: Record<string, string | number>): string {
  const template = language === 'en' ? text : (catalogs[language][text] ?? text);
  return values ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match)) : template;
}
