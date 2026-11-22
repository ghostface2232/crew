export const longDay = new Intl.DateTimeFormat([], { weekday: 'long', month: 'long', day: 'numeric' });
export const shortDay = new Intl.DateTimeFormat([], { weekday: 'short', month: 'short', day: 'numeric' });
export const shortMonth = new Intl.DateTimeFormat([], { month: 'short' });
export const timeOfDay = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
export const shortDateTime = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function formatDate(formatter: Intl.DateTimeFormat, date: Date) {
  return Number.isNaN(date.getTime()) ? 'Invalid Date' : formatter.format(date);
}
