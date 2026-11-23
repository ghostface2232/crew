/**
 * Cutting text by length. A cut between the halves of a surrogate pair leaves a lone half, which JSON carries as an
 * escape that strict decoders refuse: the macOS app's rejects the whole state with it, and so stops showing anything.
 * Every length cut of text that reaches the saved or broadcast state goes through these, and every JSON the daemon
 * writes to a client goes through `clientJson`, for text that was saved before the cuts were safe or arrived malformed.
 */

/** The first `length` UTF-16 units of `text`, less a pair's first half left at the end. */
export const clip = (text: string, length: number): string => text.slice(0, length).replace(/[\ud800-\udbff]$/, '');

/** The last `length` UTF-16 units of `text`, less a pair's second half left at the start. */
export const clipEnd = (text: string, length: number): string => text.slice(-length).replace(/^[\udc00-\udfff]/, '');

// JSON.stringify writes a lone half as a lowercase \udXXX escape and a valid pair as the characters themselves, so
// such an escape is a lone half whenever its backslash is not itself escaped (an even run of backslashes before it).
const LONE_HALF = /(?<!\\)((?:\\\\)*)\\ud[89a-f][0-9a-f]{2}/g;

/** `JSON.stringify(value)` with every lone surrogate half replaced by U+FFFD, as `toWellFormed` would on each string. */
export function clientJson(value: unknown): string {
  const json = JSON.stringify(value);
  return json?.includes('\\ud') ? json.replace(LONE_HALF, '$1\\ufffd') : json;
}
