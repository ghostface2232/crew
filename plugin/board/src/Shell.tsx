import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { CSSProperties } from 'react';
import { AlertBadgeRegular, FlagRegular, SpinnerIosRegular } from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import type { Snapshot } from './types.ts';
import { projectOf, relativeDuration } from './model.ts';
import { EASE_OUT, Icon, useFade, useClock, WordReveal } from './ui.tsx';
import { t } from './i18n.ts';

export interface NavItem {
  id: string;
  label: string;
  icon: FluentIcon;
  count?: number;
  title?: string;
  /** A state the item is in, drawn as a dot: working or waiting. */
  dot?: string;
}
/**
 * A list of sidebar items. A soft highlight glides to the item under the pointer while the others dim, and comes
 * to rest on nothing when the pointer leaves, as the reference menus behave.
 */
export const NavList = memo(function NavList({ label, items, current, onSelect, onHover }: {
  label: string;
  items: NavItem[];
  current: string;
  onSelect: (id: string) => void;
  onHover?: (id: string, element: HTMLElement | null) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [glide, setGlide] = useState<{ top: number; height: number; moving: boolean } | null>(null);
  useLayoutEffect(() => {
    if (hovered === null) return setGlide(null);
    const element = list.current?.querySelector<HTMLElement>(`[data-nav="${CSS.escape(hovered)}"]`);
    if (!element) return;
    // The first item hovered fades in where it is; later ones are reached by sliding.
    setGlide((previous) => ({ top: element.offsetTop, height: element.offsetHeight, moving: previous !== null }));
  }, [hovered, items.length]);
  return (
    <nav className="nav" aria-label={label}>
      <div
        className="nav-list"
        ref={list}
        data-hovering={hovered !== null || undefined}
        onPointerLeave={() => {
          setHovered(null);
          onHover?.('', null);
        }}
      >
        <span
          className="nav-glide"
          aria-hidden="true"
          data-moving={glide?.moving || undefined}
          style={glide ? ({ '--top': `${glide.top}px`, '--height': `${glide.height}px`, opacity: 1 } as CSSProperties) : undefined}
        />
        {items.map((item) => (
          <button
            key={item.id}
            className="nav-item"
            data-nav={item.id}
            title={item.title}
            // The dot's state is said apart from the name, so the item is still found by its name.
            aria-description={item.dot === 'waiting' ? t('Needs you') : item.dot === 'working' ? t('Working') : undefined}
            aria-current={current === item.id || undefined}
            onPointerEnter={(event) => {
              setHovered(item.id);
              onHover?.(item.id, event.currentTarget);
            }}
            onClick={() => onSelect(item.id)}
          >
            <Icon icon={item.icon} filled={current === item.id} />
            <NavLabel label={item.label} current={current === item.id} />
            {item.dot && <i className="nav-dot" data-state={item.dot} aria-hidden="true" />}
            {item.count ? <span className="nav-count" aria-label={t('{count} waiting', { count: item.count })}>{item.count}</span> : null}
          </button>
        ))}
      </div>
    </nav>
  );
});

/**
 * The pages, as a segmented control in the top bar, as the app's toolbar has them. A raised thumb slides to the page
 * you are on; it snaps when the tabs only change width (a count, the language, the window).
 */
export const PageTabs = memo(function PageTabs({ label, items, current, onSelect }: {
  label: string;
  items: NavItem[];
  current: string;
  onSelect: (id: string) => void;
}) {
  const list = useRef<HTMLElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number; slide: boolean } | null>(null);
  const shown = useRef('');
  // Kept across runs: new items (a count changing) must not restart the thumb where it already is, or cut its slide.
  const placed = useRef('');
  // A narrow bar shows the tabs' icons only (board.css), so each then names itself in a tooltip. Read from the label,
  // since the bar's width, not the window's, decides.
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const element = list.current!;
    const measure = () => {
      const tab = element.querySelector<HTMLElement>(`[data-tab="${CSS.escape(current)}"]`);
      if (!tab) return;
      setCompact((tab.querySelector<HTMLElement>('.tab-label')?.offsetWidth ?? 0) <= 1);
      const place = `${current}:${tab.offsetLeft}:${tab.offsetWidth}`;
      if (placed.current === place) return;
      placed.current = place;
      setThumb({ left: tab.offsetLeft, width: tab.offsetWidth, slide: shown.current !== '' && shown.current !== current });
      shown.current = current;
    };
    measure();
    const observer = new ResizeObserver(() => {
      // Only a change of page slides; a resize puts the thumb where it now belongs at once. The observer's first call
      // reports the sizes just measured, which change nothing, so the slide above runs on.
      shown.current = current;
      measure();
    });
    for (const tab of element.querySelectorAll('[data-tab]')) observer.observe(tab);
    return () => observer.disconnect();
  }, [current, items]);
  return (
    <nav className="tabs" aria-label={label} ref={list}>
      <span
        className="tabs-thumb"
        aria-hidden="true"
        data-slide={thumb?.slide || undefined}
        style={thumb ? ({ '--left': `${thumb.left}px`, '--width': `${thumb.width}px` } as CSSProperties) : { opacity: 0 }}
      />
      {items.map((item, index) => (
        <button
          key={item.id}
          className="tab"
          data-tab={item.id}
          title={compact ? item.label : undefined}
          aria-keyshortcuts={String(index + 1)}
          aria-current={current === item.id ? 'page' : undefined}
          onClick={() => onSelect(item.id)}
        >
          <Icon icon={item.icon} size={16} filled={current === item.id} />
          <span className="tab-label">{item.label}</span>
          {/* Waiting requests are a dot on the icon's shoulder at every width, as the app's bell badge is; the page says how many. */}
          {item.count ? <span className="tab-dot" role="img" aria-label={t('{count} waiting', { count: item.count })} /> : null}
        </button>
      ))}
    </nav>
  );
});

/** Room left beside the top bar's controls, for the Windows app's window to be dragged by. */
const DRAG_ROOM = 48;
const FOLD_MS = 360;
export type Fold = '' | 'buttons' | 'icons';
/** The window width at which the sidebar folds into a drawer (board.css), giving the bar its room. */
const DRAWER = '(max-width: 760px)';
/**
 * How far the top bar folds: not at all while every name fits with room to drag the window by, then with Search and
 * New Job as icons, and last with the tabs as icons too, since the pages are named nowhere else. Read from what the
 * names need rather than set as a width, so it follows the language. The buttons stay folded once the sidebar has
 * become a drawer, so the room it gives back does not bring their names back as the window narrows. Each fold resizes
 * the controls in motion; the tabs' thumb follows them. `names` changes whenever their words do.
 */
export function useFold(names: unknown): [Fold, (element: HTMLElement | null) => void] {
  // The bar as mounted: absent behind the sign-in screen, and a new element once the board comes back from it.
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const [fold, setFold] = useState<Fold>('');
  // Whether the names are on show to be measured, as when the bar first draws and whenever they change.
  const [measuring, setMeasuring] = useState(true);
  const needs = useRef({ full: 0, buttons: 0 });
  const widths = useRef<Map<HTMLElement, number> | null>(null);
  const hidden = useRef(new Set<Element>());
  const shown = useRef(fold);
  shown.current = fold;
  const controls = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>('.tab, .search-pill, .new-job')];
  const words = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>('.tab-label, .search-label, .new-job-label')];
  const decide = (room: number): Fold =>
    room >= needs.current.full && !matchMedia(DRAWER).matches ? '' : room >= needs.current.buttons ? 'buttons' : 'icons';
  useLayoutEffect(() => setMeasuring(true), [names, bar]);
  // The board's font arrives after the first paint, and its names are wider or narrower than the fallback's.
  useEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => { if (live) setMeasuring(true); });
    return () => { live = false; };
  }, []);
  useLayoutEffect(() => {
    if (!measuring || !bar) return;
    const gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
    const full = [...bar.children].reduce((sum, child) => sum + (child as HTMLElement).offsetWidth + gap, -gap) + DRAG_ROOM;
    // Folded, each button is a circle as tall as it is.
    const buttons = [...bar.querySelectorAll<HTMLElement>('.search-pill, .new-job')].reduce((sum, button) => sum + button.offsetWidth - button.offsetHeight, 0);
    needs.current = { full, buttons: full - buttons - DRAG_ROOM };
    setMeasuring(false);
    setFold(decide(bar.clientWidth));
  }, [measuring, bar]);
  useLayoutEffect(() => {
    if (!bar) return;
    const observer = new ResizeObserver(() => {
      const next = decide(bar.clientWidth);
      if (next === shown.current) return;
      // Widths as they stand, mid-fold included, for the next fold to start from.
      widths.current = new Map(controls(bar).map((control) => [control, control.offsetWidth]));
      hidden.current = new Set(words(bar).filter((word) => word.offsetWidth <= 1));
      // Before the next paint, so a narrowing bar never shows names it has no room for.
      flushSync(() => setFold(next));
    });
    observer.observe(bar);
    return () => observer.disconnect();
  }, [bar]);
  useLayoutEffect(() => {
    const from = widths.current;
    widths.current = null;
    if (!from || !bar || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const control of controls(bar)) {
      for (const animation of control.getAnimations()) if (animation.id === 'fold') animation.cancel();
      const [was, now] = [from.get(control), control.offsetWidth];
      if (was === undefined || was === now) continue;
      // Clipped while it resizes, so a name that comes back does not spill over its neighbours.
      control.animate([{ width: `${was}px`, overflow: 'clip' }, { width: `${now}px`, overflow: 'clip' }], { id: 'fold', duration: FOLD_MS, easing: EASE_OUT });
    }
    // Words that come back fade in as their room opens.
    for (const word of words(bar)) {
      if (hidden.current.has(word) && word.offsetWidth > 1) word.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], { duration: FOLD_MS, easing: 'ease-out' });
    }
  }, [fold]);
  return [measuring ? '' : fold, setBar];
}

/** An item's name, fading at its end instead of widening the sidebar when it is too long for it. */
function NavLabel({ label, current }: { label: string; current: boolean }) {
  const fade = useFade<HTMLSpanElement>(label, current);
  return <span className="nav-label fade-line" ref={fade}>{label}</span>;
}

/** A project's live state beside the sidebar, while the pointer rests on it in the list. */
export function ProjectPeek({ dir, name, top, state }: { dir: string; name: string; top: number; state: Snapshot }) {
  const jobs = state.jobs.filter((job) => projectOf(job) === dir);
  const sessions = state.claude.filter((session) => projectOf(session) === dir);
  const running = jobs.filter((job) => job.state === 'running').length + sessions.filter((session) => session.state === 'working').length;
  const waiting = jobs.filter((job) => job.state === 'waiting').length + sessions.filter((session) => session.state === 'waiting').length;
  const missions = state.missions.filter((mission) => projectOf(mission) === dir && mission.state === 'active');
  const last = Math.max(0, ...jobs.map((job) => job.activeAt ?? job.createdAt), ...sessions.map((session) => session.activeAt));
  const quiet = useClock((now) => last ? t('Quiet for {duration}', { duration: relativeDuration(now - last) }) : t('No work yet'), !running && !waiting && Boolean(last));
  const inset = useClock(() => Math.max(12, Math.min(top - 12, innerHeight - 260)));
  const line = running || waiting
    ? [running && t('{count} working', { count: running }), waiting && t('{count} waiting on you', { count: waiting })].filter(Boolean).join(', ')
    : quiet;
  return (
    <div className="peek" aria-hidden="true" style={{ '--top': `${inset}px` } as CSSProperties}>
      <div className="peek-inner" key={dir}>
        <p className="peek-name">{name}</p>
        <p className="peek-path">{dir}</p>
        <div className="peek-stats">
          <span data-state="working"><Icon icon={SpinnerIosRegular} size={13} />{running}</span>
          <span data-state="waiting"><Icon icon={AlertBadgeRegular} size={13} />{waiting}</span>
          <span><Icon icon={FlagRegular} size={13} />{missions.length}</span>
        </div>
        <p className="peek-line"><WordReveal text={line} /></p>
        {missions.slice(0, 3).map((mission) => (
          <p className="peek-mission" key={mission.id}>{mission.title}</p>
        ))}
      </div>
    </div>
  );
}
