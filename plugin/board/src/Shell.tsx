import { memo, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { AlertBadgeRegular, FlagRegular, SpinnerIosRegular } from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import type { Snapshot } from './types.ts';
import { projectOf, relativeDuration } from './model.ts';
import { Icon, useFade, useClock, WordReveal } from './ui.tsx';
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
export const NavList = memo(function NavList({ label, heading, items, current, onSelect, onHover }: {
  label: string;
  heading?: string;
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
      {heading && <h2 className="nav-heading">{heading}</h2>}
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

/** Kept in step with the media query in board.css that hides the tabs' names. */
const COMPACT = matchMedia('(max-width: 1000px)');
const subscribeCompact = (change: () => void) => {
  COMPACT.addEventListener('change', change);
  return () => COMPACT.removeEventListener('change', change);
};
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
  // Narrow windows show the tabs' icons only (board.css), so each names itself in a tooltip.
  const compact = useSyncExternalStore(subscribeCompact, () => COMPACT.matches);
  useLayoutEffect(() => {
    const element = list.current!;
    let placed = '';
    const measure = () => {
      const tab = element.querySelector<HTMLElement>(`[data-tab="${CSS.escape(current)}"]`);
      if (!tab || placed === `${tab.offsetLeft}:${tab.offsetWidth}`) return;
      placed = `${tab.offsetLeft}:${tab.offsetWidth}`;
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
