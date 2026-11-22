/**
 * Cutting text by length. A cut between the halves of a surrogate pair leaves a lone half, which JSON carries as an
 * escape that strict decoders refuse: the macOS app's rejects the whole state with it, and so stops showing anything.
 * Every length cut of text that reaches the saved or broadcast state goes through these.
 */

/** The first `length` UTF-16 units of `text`, less a pair's first half left at the end. */
export const clip = (text: string, length: number): string => text.slice(0, length).replace(/[\ud800-\udbff]$/, '');

/** The last `length` UTF-16 units of `text`, less a pair's second half left at the start. */
export const clipEnd = (text: string, length: number): string => text.slice(-length).replace(/^[\udc00-\udfff]/, '');
