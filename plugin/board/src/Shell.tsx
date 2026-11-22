import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { AlertBadgeRegular, FlagRegular, SpinnerIosRegular } from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import type { Snapshot } from './types.ts';
import { projectOf, relativeDuration } from './model.ts';
import { Icon, useFade, useNow, WordReveal } from './ui.tsx';

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
export function NavList({ label, heading, items, current, onSelect, onHover, shortcut = false }: {
  label: string;
  heading?: string;
  items: NavItem[];
  current: string;
  onSelect: (id: string) => void;
  onHover?: (id: string, element: HTMLElement | null) => void;
  shortcut?: boolean;
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
        {items.map((item, index) => (
          <button
            key={item.id}
            className="nav-item"
            data-nav={item.id}
            title={item.title}
            // The dot's state is said apart from the name, so the item is still found by its name.
            aria-description={item.dot === 'waiting' ? 'Needs you' : item.dot === 'working' ? 'Working' : undefined}
            aria-current={current === item.id || undefined}
            onPointerEnter={(event) => {
              setHovered(item.id);
              onHover?.(item.id, event.currentTarget);
            }}
            onClick={() => onSelect(item.id)}
          >
            <Icon icon={item.icon} filled={current === item.id} />
            <NavLabel label={item.label} />
            {item.dot && <i className="nav-dot" data-state={item.dot} aria-hidden="true" />}
            {item.count ? <span className="nav-count" aria-label={`${item.count} waiting`}>{item.count}</span> : null}
            {shortcut && !item.count && <kbd className="nav-key" aria-hidden="true">{index + 1}</kbd>}
          </button>
        ))}
      </div>
    </nav>
  );
}

/** An item's name, fading at its end instead of widening the sidebar when it is too long for it. */
function NavLabel({ label }: { label: string }) {
  const fade = useFade<HTMLSpanElement>();
  return <span className="nav-label fade-line" ref={fade}>{label}</span>;
}

/** A project's live state beside the sidebar, while the pointer rests on it in the list. */
export function ProjectPeek({ dir, name, top, state }: { dir: string; name: string; top: number; state: Snapshot }) {
  const now = useNow();
  const jobs = state.jobs.filter((job) => projectOf(job) === dir);
  const sessions = state.claude.filter((session) => projectOf(session) === dir);
  const running = jobs.filter((job) => job.state === 'running').length + sessions.filter((session) => session.state === 'working').length;
  const waiting = jobs.filter((job) => job.state === 'waiting').length + sessions.filter((session) => session.state === 'waiting').length;
  const missions = state.missions.filter((mission) => projectOf(mission) === dir && mission.state === 'active');
  const last = Math.max(0, ...jobs.map((job) => job.activeAt ?? job.createdAt), ...sessions.map((session) => session.activeAt));
  const line = running || waiting
    ? [running && `${running} working`, waiting && `${waiting} waiting on you`].filter(Boolean).join(', ')
    : last ? `Quiet for ${relativeDuration(now - last)}` : 'No work yet';
  return (
    <div className="peek" aria-hidden="true" style={{ '--top': `${Math.max(12, Math.min(top - 12, innerHeight - 260))}px` } as CSSProperties}>
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
