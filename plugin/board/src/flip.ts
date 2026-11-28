import { EASE_IN_OUT, EASE_OUT } from './ui.tsx';

/**
 * Cards and rows move, arrive, and leave as the daemon's updates change the page, as the app's `Motion.arrive` moves
 * them (docs/design-tokens.md): a card that changes place glides there, one that arrives settles in from slightly
 * smaller out of a soft blur, one that leaves goes the same way, and its neighbours move into place meanwhile.
 *
 * An element takes part by carrying `data-flip` with a key unique on its page; the same key elsewhere after an update
 * is the same card moved, even when React mounted a new element for it (a card changing column). The page is measured
 * just before an update renders (`capture`) and again once it has (`play`); only the daemon's updates are animated,
 * so a page, filter, or window change keeps its own motion.
 */
const SELECTOR = '[data-flip]';
const MOVE_MS = 420;
const LEAVE_MS = 260;

interface Seen {
  element: HTMLElement;
  rect: DOMRect;
  /** The key of the nearest enclosing element that takes part, which carries this one along when it moves. */
  parent?: string;
}

let before: { scroller: HTMLElement; seen: Map<string, Seen> } | null = null;
const moves = new WeakMap<HTMLElement, Animation>();
let ghosts: HTMLDivElement | null = null;

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const scrollerOf = () => document.querySelector<HTMLElement>('main.page');

function measure(scroller: HTMLElement) {
  const seen = new Map<string, Seen>();
  const keys = new Map<Element, string>();
  const counts = new Map<string, number>();
  // Document order, so a parent is keyed before what it holds.
  for (const element of scroller.querySelectorAll<HTMLElement>(SELECTOR)) {
    const base = element.dataset.flip!;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    const key = count ? `${base}#${count}` : base;
    keys.set(element, key);
    const rect = element.getBoundingClientRect();
    // Folded away (a closed stage, a hidden column): nothing to see move.
    if (!rect.width && !rect.height) continue;
    const holder = element.parentElement?.closest(SELECTOR);
    seen.set(key, { element, rect, parent: holder ? keys.get(holder) : undefined });
  }
  return seen;
}

/** Measures the page as it stands, before an update renders. */
export function captureLayout() {
  before = null;
  if (document.hidden || reduced()) return;
  const scroller = scrollerOf();
  if (scroller) before = { scroller, seen: measure(scroller) };
}

/** Forgets a measure no render followed, so a later render of the user's own does not animate from it. */
export function dropLayout() {
  before = null;
}

/** Animates what the update just rendered changed. Call once the update's DOM is in place, before it is painted. */
export function playLayout() {
  const last = before;
  before = null;
  const scroller = scrollerOf();
  // A page that is new (another page or project) or was empty comes in with its own motion.
  if (!last || !last.seen.size || scroller !== last.scroller) return;
  // The new layout is measured without the moves still under way; each restarts from where it was seen.
  for (const { element } of last.seen.values()) moves.get(element)?.cancel();
  const after = measure(scroller);
  const view = scroller.getBoundingClientRect();
  const inView = (rect: DOMRect) => rect.bottom > view.top && rect.top < view.bottom;
  const shifts = new Map<string, [number, number]>();
  const arrived = new Set<string>();
  for (const [key, now] of after) {
    const was = last.seen.get(key);
    if (!was) {
      arrived.add(key);
      // Arriving inside a card that arrives too, it comes in with that card.
      if (now.parent && arrived.has(now.parent)) continue;
      if (inView(now.rect)) arrive(now.element);
      continue;
    }
    // Its parent's move already carries it that far.
    const [px, py] = (now.parent && shifts.get(now.parent)) || [0, 0];
    const dx = was.rect.left - now.rect.left;
    const dy = was.rect.top - now.rect.top;
    shifts.set(key, [dx, dy]);
    const [x, y] = [dx - px, dy - py];
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
    if (!inView(was.rect) && !inView(now.rect)) continue;
    moves.set(now.element, now.element.animate(
      [{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }],
      { duration: MOVE_MS, easing: EASE_OUT, composite: 'add' },
    ));
  }
  for (const [key, was] of last.seen) {
    if (after.has(key) || was.element.isConnected || !inView(was.rect)) continue;
    // Leaving inside a card that leaves too, it goes with that card.
    let parent = was.parent;
    while (parent && after.has(parent)) parent = last.seen.get(parent)?.parent;
    if (parent) continue;
    leave(was, scroller);
  }
}

function arrive(element: HTMLElement) {
  // In place of the rise a card has when it mounts (board.css), so it arrives once.
  for (const animation of element.getAnimations()) if (animation instanceof CSSAnimation) animation.cancel();
  element.animate([{ opacity: 0, scale: '0.96', filter: 'blur(4px)' }, {}], { duration: MOVE_MS, easing: EASE_OUT });
}

/** A card React has removed fades where it was, over the page, while its neighbours close the gap beneath it. */
function leave(was: Seen, scroller: HTMLElement) {
  const layer = ghostLayer(scroller);
  const box = layer.getBoundingClientRect();
  const ghost = was.element;
  moves.get(ghost)?.cancel();
  delete ghost.dataset.flip;
  Object.assign(ghost.style, {
    position: 'absolute',
    left: `${was.rect.left - box.left}px`,
    top: `${was.rect.top - box.top}px`,
    width: `${was.rect.width}px`,
    height: `${was.rect.height}px`,
    margin: '0',
  });
  layer.append(ghost);
  ghost.animate([{}, { opacity: 0, scale: '0.96', filter: 'blur(4px)' }], { duration: LEAVE_MS, easing: EASE_IN_OUT, fill: 'forwards' })
    .finished.catch(() => {}).finally(() => {
      ghost.remove();
      if (ghosts && !ghosts.childElementCount) {
        ghosts.remove();
        ghosts = null;
      }
    });
}

/** Over the page's stage and clipped to it, as wide as it is so its cards keep their container-query layout. */
function ghostLayer(scroller: HTMLElement) {
  if (!ghosts) {
    ghosts = document.createElement('div');
    ghosts.className = 'flip-ghosts';
    ghosts.inert = true;
    ghosts.setAttribute('aria-hidden', 'true');
    document.body.append(ghosts);
  }
  const rect = scroller.getBoundingClientRect();
  const style = getComputedStyle(scroller);
  Object.assign(ghosts.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    borderRadius: style.borderRadius,
    paddingLeft: style.paddingLeft,
    paddingRight: style.paddingRight,
  });
  return ghosts;
}
