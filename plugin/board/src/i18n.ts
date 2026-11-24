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
/** The language setting as this page last heard it from the daemon; null when none is set or storage is out of reach. */
function remembered(): Language | null {
  try {
    const saved = localStorage.getItem(CHOICE);
    return saved === 'en' || (saved !== null && Object.hasOwn(catalogs, saved)) ? (saved as Language) : null;
  } catch {
    return null;
  }
}

// Decided before any other module reads text, as some keep translated text in constants. Node, which runs the
// board's modules in tests and runs the Windows app's main process, has no window and reads English until told.
export let language: Language = typeof window === 'undefined' ? 'en' : remembered() ?? pickLanguage(navigator.languages);
export function setLanguage(next: Language) {
  language = next;
}

/**
 * Follows the language setting the daemon sends; null follows the browser, and undefined (an older daemon) changes
 * nothing. The page's text was fixed as it loaded, so the setting is remembered for the next load and the page reloads
 * into it. Where it cannot be remembered, the page keeps its language rather than reload into the same one forever.
 */
export function followSetting(choice: Language | null | undefined) {
  if (choice === undefined) return;
  try {
    if (choice) localStorage.setItem(CHOICE, choice);
    else localStorage.removeItem(CHOICE);
  } catch {
    return;
  }
  if (remembered() === choice && (choice ?? pickLanguage(navigator.languages)) !== language) location.reload();
}

/** `text` in the current language, with each `{name}` replaced by `values[name]`. */
export function t(text: string, values?: Record<string, string | number>): string {
  const template = language === 'en' ? text : (catalogs[language][text] ?? text);
  return values ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match)) : template;
}
