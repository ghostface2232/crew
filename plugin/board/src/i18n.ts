import { ko } from './ko.ts';
import type { Language } from '../../bridge/config.ts';

/**
 * Interface text in the viewer's language. The English text is the key, so a string with no entry, such as text
 * the daemon sends, still reads in English. How languages are chosen and how to add text is in docs/localization.md.
 */
export type { Language };
const catalogs: Record<Exclude<Language, 'en'>, Record<string, string>> = { ko };

/** The first language in a preference list that the interface speaks, or English when none is. */
export function pickLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (base === 'en' || base in catalogs) return base as Language;
  }
  return 'en';
}

const CHOICE = 'crew.language';
/**
 * The language setting as this page last heard it from the daemon, so a new page starts in it rather than switch once
 * the daemon answers; null when none is set or storage is out of reach.
 */
function remembered(): Language | null {
  try {
    const saved = localStorage.getItem(CHOICE);
    return saved === 'en' || (saved !== null && Object.hasOwn(catalogs, saved)) ? (saved as Language) : null;
  } catch {
    return null;
  }
}

// Node, which runs the board's modules in tests and runs the Windows app's main process, has no window and reads
// English until told.
export let language: Language = typeof window === 'undefined' ? 'en' : remembered() ?? pickLanguage(navigator.languages);
const listeners = new Set<() => void>();
/** Calls `listener` after each change of language; returns the call that stops it. */
export function onLanguageChange(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setLanguage(next: Language) {
  if (next === language) return;
  language = next;
  listeners.forEach((listener) => listener());
}

/**
 * Follows the language setting the daemon sends; null follows the browser, and undefined (an older daemon) changes
 * nothing. The page switches in place: a reload would sign a browser tab out, since its credential lives only in memory.
 */
export function followSetting(choice: Language | null | undefined) {
  if (choice === undefined) return;
  try {
    if (choice) localStorage.setItem(CHOICE, choice);
    else localStorage.removeItem(CHOICE);
  } catch {
    // Not remembered, so the next page starts in the browser's language until the daemon answers.
  }
  setLanguage(choice ?? pickLanguage(navigator.languages));
}

/**
 * A value built from translated text that a module keeps, such as a table of labels: built when first read in each
 * language, and the same object until the language changes, so it can stand in a hook's dependencies.
 */
export function translated<T>(build: () => T): () => T {
  let built: { language: Language; value: T } | undefined;
  return () => (built?.language === language ? built.value : (built = { language, value: build() }).value);
}

/** `text` in the current language, with each `{name}` replaced by `values[name]`. */
export function t(text: string, values?: Record<string, string | number>): string {
  const template = language === 'en' ? text : (catalogs[language][text] ?? text);
  return values ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match)) : template;
}
