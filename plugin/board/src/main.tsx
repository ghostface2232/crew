import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initializeSession, UnauthorizedError } from './api.ts';
import { board } from './store.ts';
import '../board.css';

// The thin bar's width, so a scrolling area can take it out of its padding and keep its content's edges even.
const probe = document.createElement('div');
probe.style.cssText = 'position:absolute;visibility:hidden;width:100px;height:100px;overflow:scroll;scrollbar-width:thin';
document.body.append(probe);
document.documentElement.style.setProperty('--scrollbar-w', `${probe.offsetWidth - probe.clientWidth}px`);
probe.remove();

// Marks whatever is scrolling for a moment, so its scrollbar can show only then; scroll events do not bubble.
const scrolling = new WeakMap<Element, number>();
document.addEventListener(
  'scroll',
  (event) => {
    const element = event.target instanceof Element ? event.target : document.documentElement;
    element.toggleAttribute('data-scrolling', true);
    clearTimeout(scrolling.get(element));
    scrolling.set(element, window.setTimeout(() => element.toggleAttribute('data-scrolling', false), 800));
  },
  { capture: true, passive: true },
);

// Also marks the element whose scrollbar the pointer is over, found by its gutter: the bar is not an element to hover.
const gutter = (element: Element, event: PointerEvent) => {
  const style = getComputedStyle(element);
  const bar = (client: number, offset: number, borders: string[]) =>
    offset - client - borders.reduce((sum, side) => sum + parseFloat(style.getPropertyValue(`border-${side}-width`)), 0) > 0.5;
  const box = element.getBoundingClientRect();
  const x = event.clientX - box.left - element.clientLeft;
  const y = event.clientY - box.top - element.clientTop;
  const { clientWidth, clientHeight, offsetWidth, offsetHeight } = element as HTMLElement;
  return (bar(clientWidth, offsetWidth, ['left', 'right']) && x > clientWidth) || (bar(clientHeight, offsetHeight, ['top', 'bottom']) && y > clientHeight);
};
let overBar: Element | null = null;
const markBar = (element: Element | null) => {
  if (element === overBar) return;
  overBar?.toggleAttribute('data-scrollbar-hover', false);
  element?.toggleAttribute('data-scrollbar-hover', true);
  overBar = element;
};
document.addEventListener(
  'pointermove',
  (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const root = document.documentElement;
    // Nothing over the page's own scrollbar reaches the page, so the pointer arriving at the window's edge stands in for it.
    const atPageBar = root.scrollHeight > root.clientHeight && event.clientX >= root.clientWidth - 6;
    markBar(target && gutter(target, event) ? target : atPageBar ? root : null);
  },
  { passive: true },
);
// Moving onto the page's bar also leaves the page, so that bar stays marked until the pointer is seen elsewhere.
document.documentElement.addEventListener('pointerleave', () => overBar !== document.documentElement && markBar(null));

// Where the page scrolls in its own box rather than the document (the Windows app), keys that scroll the document
// reach it only once something inside it has focus; until then they are passed to it here.
const SCROLL_KEYS: Record<string, (page: HTMLElement) => number> = {
  PageDown: (page) => page.clientHeight * 0.875,
  PageUp: (page) => -page.clientHeight * 0.875,
  ArrowDown: () => 40,
  ArrowUp: () => -40,
  Home: (page) => -page.scrollHeight,
  End: (page) => page.scrollHeight,
  ' ': (page) => page.clientHeight * 0.875,
};
document.addEventListener('keydown', (event) => {
  const step = SCROLL_KEYS[event.key];
  const page = document.querySelector<HTMLElement>('main.page');
  const root = document.documentElement;
  if (!step || !page || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (root.scrollHeight > root.clientHeight || document.querySelector('dialog:modal')) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  // Space presses buttons, and editors and lists keep their own keys.
  if (target && target !== document.body && (event.key === ' ' || target.closest('input, textarea, select, [contenteditable], [role="listbox"], [role="menu"]'))) return;
  // Inside the page, or in another box that scrolls, the browser already scrolls the right thing.
  const scrolls = (node: HTMLElement) => node.scrollHeight > node.clientHeight && !['visible', 'hidden'].includes(getComputedStyle(node).overflowY);
  for (let node = target; node && node !== document.body; node = node.parentElement) if (node === page || scrolls(node)) return;
  event.preventDefault();
  page.scrollBy({ top: (event.shiftKey && event.key === ' ' ? -1 : 1) * step(page) });
});

async function start() {
  try {
    await initializeSession();
  } catch (error) {
    if (error instanceof UnauthorizedError) board.signOut();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
void start();
