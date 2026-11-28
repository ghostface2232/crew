import { language, onLanguageChange } from './i18n.ts';

export const longDay = { weekday: 'long', month: 'long', day: 'numeric' } as const;
export const shortDay = { weekday: 'short', month: 'short', day: 'numeric' } as const;
export const shortMonth = { month: 'short' } as const;
export const timeOfDay = { hour: 'numeric', minute: '2-digit' } as const;
export const shortDateTime = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } as const;

let offset = new Date().getTimezoneOffset();
const formatters = new Map<Intl.DateTimeFormatOptions, Intl.DateTimeFormat>();
onLanguageChange(() => formatters.clear());

/** Crew's language, in the region the viewer's own preferences give it, so English stays British for a British browser. */
function locales() {
  const preferred = typeof navigator === 'undefined' ? [] : navigator.languages ?? [];
  return [...preferred.filter((tag) => tag.toLowerCase().split('-')[0] === language), language];
}

export function formatDate(options: Intl.DateTimeFormatOptions, date: Date) {
  if (Number.isNaN(date.getTime())) return 'Invalid Date';
  const currentOffset = new Date().getTimezoneOffset();
  if (currentOffset !== offset) {
    offset = currentOffset;
    formatters.clear();
  }
  let formatter = formatters.get(options);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locales(), options);
    formatters.set(options, formatter);
  }
  return formatter.format(date);
}
