import { EASE_IN_OUT, EASE_OUT } from './ui.tsx';

/**
 * FLIP layout transitions for daemon updates, mirroring the macOS app's `Motion.arrive` (docs/design-tokens.md).
 * Elements with a page-unique `data-flip` key glide to new positions (even across column remounts), settle in from
 * a slight scale and blur, or fade out in a clipped ghost layer while neighbors close the gap. Snapshot with
 * `captureLayout` before a daemon update renders and animate with `playLayout` after commit so user actions keep
 * their own motion.
 */
const SELECTOR = '[data-flip]';
const MOVE_MS = 420;
const LEAVE_MS = 260;

interface Seen {
  element: HTMLElement;
  rect: DOMRect;
  /** Nearest participating ancestor key, so parent motion is not applied twice. */
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
  // Document order ensures ancestors are keyed before descendants.
  for (const element of scroller.querySelectorAll<HTMLElement>(SELECTOR)) {
    const base = element.dataset.flip!;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    const key = count ? `${base}#${count}` : base;
    keys.set(element, key);
    const rect = element.getBoundingClientRect();
    // Skip collapsed or hidden elements (closed stages, hidden columns).
    if (!rect.width && !rect.height) continue;
    const holder = element.parentElement?.closest(SELECTOR);
    seen.set(key, { element, rect, parent: holder ? keys.get(holder) : undefined });
  }
  return seen;
}

/** Snapshots current layout before a daemon update renders. */
export function captureLayout() {
  before = null;
  if (document.hidden || reduced()) return;
  const scroller = scrollerOf();
  if (scroller) before = { scroller, seen: measure(scroller) };
}

/** Discards an unused snapshot so later user-driven renders do not animate from it. */
export function dropLayout() {
  before = null;
}

/** Animates layout changes from the last snapshot; call after DOM commit, before paint. */
export function playLayout() {
  const last = before;
  before = null;
  const scroller = scrollerOf();
  // Skip when the page changed or started empty so view transitions keep their own motion.
  if (!last || !last.seen.size || scroller !== last.scroller) return;
  // Cancel in-flight moves before measuring the target layout; `last` already recorded where each was seen.
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
      // Skip items whose ancestor is also arriving so they enter together.
      if (now.parent && arrived.has(now.parent)) continue;
      if (inView(now.rect)) arrive(now.element);
      continue;
    }
    // Subtract the ancestor's delta because its move already carries this element.
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
    // Skip items whose ancestor is also leaving so they exit together.
    let parent = was.parent;
    while (parent && after.has(parent)) parent = last.seen.get(parent)?.parent;
    if (parent) continue;
    leave(was, scroller);
  }
}

function arrive(element: HTMLElement) {
  // Cancel the mount rise animation (board.css) so the element animates in only once.
  for (const animation of element.getAnimations()) if (animation instanceof CSSAnimation) animation.cancel();
  element.animate([{ opacity: 0, scale: '0.96', filter: 'blur(4px)' }, {}], { duration: MOVE_MS, easing: EASE_OUT });
}

/** Fades a removed element in place over the page while neighbors close the gap. */
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

/** Clipped overlay matched to the stage's bounds and width so exiting cards keep container-query sizing. */
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
