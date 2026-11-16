import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initializeSession, UnauthorizedError } from './api.ts';
import { board } from './store.ts';
import '../board.css';

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
document.addEventListener('pointermove', (event) => markBar(event.target instanceof Element && gutter(event.target, event) ? event.target : null), { passive: true });
document.documentElement.addEventListener('pointerleave', () => markBar(null));

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
