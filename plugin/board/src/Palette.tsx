import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  AddRegular, AlertOffRegular, AlertRegular, ArrowTurnDownLeftRegular, ChatMultipleRegular, ClockRegular,
  FlagRegular, FlashRegular, FolderRegular, GridRegular, HandWaveRegular, SearchRegular, SettingsRegular, StackRegular, WrenchRegular,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import type { Snapshot } from './types.ts';
import { jobLabel, missionStep, missionStops, NAMES, projectOf, roleLabel, jobRole } from './model.ts';
import { AgentMark, Chip, EASE_IN_OUT, EASE_OUT, Icon, reducedMotion, Elapsed, tNodes, useClock, WordReveal } from './ui.tsx';
import { jobStatusState, missionStateLabel, sessionStateLabel } from './Missions.tsx';
import { t } from './i18n.ts';
import { notificationPermission, notificationsWanted, requestNotifications, setNotificationsWanted } from './notify.ts';

interface Entry {
  id: string;
  group: string;
  title: string;
  subtitle: string;
  icon?: FluentIcon;
  agent?: string;
  run: () => void;
  preview: () => { eyebrow: string; chip?: [string, string]; lines: ReactNode[]; text?: string };
}
export interface PaletteActions {
  select: (selection: string) => void;
  openJob: (id: string) => void;
  openSession: (id: string) => void;
  newJob: () => void;
  settings: () => void;
  welcome: () => void;
}
const PAGE_ENTRIES: [string, string, FluentIcon, string][] = [
  ['overview', t('Overview'), GridRegular, t('Every project at a glance')],
  ['needs', t('Needs You'), AlertRegular, t('Approvals and questions waiting on you')],
  ['activity', t('Activity'), FlashRegular, t('What the crew did, as it happened')],
  ['history', t('History'), ClockRegular, t('Finished missions and jobs')],
];
/** Groups are named in English for the code that checks them, and shown in the reader's language. */
const GROUPS: Record<string, string> = {
  Actions: t('Actions'), Pages: t('Pages'), Projects: t('Projects'), Missions: t('Missions'), 'Claude sessions': t('Claude sessions'), Jobs: t('Jobs'),
};

/**
 * Search and jump: the search control grows into this panel, a list beside a preview of what is under the pointer
 * or the keyboard, and shrinks back into the control when it closes.
 */
export function Palette({ state, names, projects, origin, close, actions }: {
  state: Snapshot;
  names: Map<string, string>;
  projects: string[];
  origin?: DOMRect;
  close: () => void;
  actions: PaletteActions;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pointer, setPointer] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closing = useRef(false);
  const pressed = useRef(false);
  const unmounting = useRef(false);
  const viewportWidth = useClock(() => innerWidth);
  const width = Math.min(760, viewportWidth - 24);
  const height = useClock(() => Math.min(500, innerHeight - 96));
  // Anchored to the search control's right edge, growing down and to the left from it; centered without one.
  const left = origin ? Math.max(12, Math.min(origin.right - width, viewportWidth - 12 - width)) : (viewportWidth - width) / 2;
  // Where the page draws the title bar (the Windows app), the window buttons keep their corner, so a palette reaching
  // under them starts below them instead.
  // Not yet in TypeScript's DOM types.
  const overlay = (navigator as { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay;
  const below = useClock(() => {
    const bar = overlay?.visible ? overlay.getTitlebarAreaRect() : null;
    return bar && left + width > bar.right ? bar.bottom + 8 : 0;
  }, Boolean(overlay));
  const top = Math.max(origin ? Math.max(8, origin.top) : 72, below);
  // The morph to and from the search control would pass under those buttons, so a palette moved below them fades instead.
  const anchor = below ? undefined : origin;
  const { jobs, claude, missions, roleInfo } = state;
  const notifyState = useClock(notificationPermission);
  const notifyOn = useClock(() => notifyState === 'granted' && notificationsWanted(), notifyState === 'granted');
  const entries = useMemo(() => {
    const list: Entry[] = [];
    list.push({
      id: 'new-job', group: 'Actions', title: t('New Job'), subtitle: t('Hand a task to an agent'), icon: AddRegular,
      run: actions.newJob, preview: () => ({ eyebrow: t('Action'), lines: [t('Shortcut: N')], text: t('Give a command, ask a question, or add information for the crew.') }),
    });
    list.push({
      id: 'settings', group: 'Actions', title: t('Settings'), subtitle: t('Roles, model presets, and instructions'), icon: SettingsRegular,
      run: actions.settings, preview: () => ({ eyebrow: t('Action'), lines: [], text: t('Configure roles, model presets, and shared instructions.') }),
    });
    list.push({
      id: 'welcome', group: 'Actions', title: t('Welcome to Crew'), subtitle: t('Commands and where to start'), icon: HandWaveRegular,
      run: actions.welcome, preview: () => ({ eyebrow: t('Action'), lines: [], text: t('Show the first-run guide again: the crew commands, Needs You, and setup.') }),
    });
    if (notifyState !== 'unsupported') {
      const on = notifyOn;
      list.push({
        id: 'notify', group: 'Actions', title: on ? t('Turn off notifications') : t('Turn on notifications'),
        subtitle: notifyState === 'denied' ? t('Blocked in this browser') : t('When an agent needs you and the board is in the background'),
        icon: on ? AlertOffRegular : AlertRegular,
        run: () => (on ? setNotificationsWanted(false) : void requestNotifications()),
        preview: () => ({
          eyebrow: t('Notifications'),
          lines: [notifyState === 'denied' ? t('The browser blocks them for this page; allow them in its site settings.') : on ? t('On') : t('Off')],
          text: t('Get a notification when a request waits for you, as the Crew app sends them.'),
        }),
      });
    }
    for (const [id, title, icon, subtitle] of PAGE_ENTRIES)
      list.push({ id: `page:${id}`, group: 'Pages', title, subtitle, icon, run: () => actions.select(id), preview: () => ({ eyebrow: t('Page'), lines: [], text: subtitle }) });
    list.push({ id: 'project:', group: 'Projects', title: t('All projects'), subtitle: t('Overview'), icon: StackRegular, run: () => actions.select('overview'), preview: () => ({ eyebrow: t('Projects'), lines: [projects.length === 1 ? t('1 project') : t('{count} projects', { count: projects.length })] }) });
    for (const dir of projects) {
      const projectJobs = jobs.filter((job) => projectOf(job) === dir);
      const activeJobs = projectJobs.filter((job) => job.endedAt == null).length;
      const activeMissions = missions.filter((mission) => projectOf(mission) === dir && mission.state === 'active').length;
      list.push({
        id: `project:${dir}`, group: 'Projects', title: names.get(dir) ?? dir, subtitle: dir, icon: FolderRegular,
        run: () => actions.select(`project:${dir}`),
        preview: () => ({
          eyebrow: t('Project'),
          lines: [dir, activeJobs === 1
            ? t('1 active job · {total} in all', { total: projectJobs.length })
            : t('{count} active jobs · {total} in all', { count: activeJobs, total: projectJobs.length })],
          text: activeMissions === 1 ? t('1 mission in progress') : t('{count} missions in progress', { count: activeMissions }),
        }),
      });
    }
    for (const mission of [...missions].sort((a, b) => Number(b.state === 'active') - Number(a.state === 'active') || b.createdAt - a.createdAt)) {
      const stops = missionStops(mission);
      list.push({
        id: `mission:${mission.id}`, group: 'Missions', title: mission.title, subtitle: names.get(projectOf(mission)) ?? projectOf(mission), icon: FlagRegular,
        run: () => {
          actions.select(mission.state === 'active' ? `project:${projectOf(mission)}` : 'history');
          requestAnimationFrame(() => document.querySelector(`[data-key="${CSS.escape(mission.id)}"]`)?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }));
        },
        preview: () => ({
          eyebrow: t('Mission'),
          chip: [mission.state === 'active' ? 'running' : mission.state, missionStateLabel(mission.state)],
          lines: [
            mission.state === 'done'
              ? t('All {count} steps passed', { count: stops.length })
              : t('Step {step} of {count}: {name}', { step: missionStep(mission) + 1, count: stops.length, name: stops[missionStep(mission)]?.name ?? '' }),
            <Elapsed start={mission.createdAt} end={mission.endedAt} />,
          ],
          text: mission.outcome || mission.notes?.at(-1)?.text,
        }),
      });
    }
    for (const session of claude) {
      list.push({
        id: `session:${session.id}`, group: 'Claude sessions', title: session.title, subtitle: names.get(projectOf(session)) ?? projectOf(session), agent: 'claude',
        run: () => actions.openSession(session.id),
        preview: () => ({
          eyebrow: t('Claude · Lead'),
          chip: [session.stalled ? 'stalled' : session.state, sessionStateLabel(session)],
          lines: [tNodes('Started {time} ago', { time: <Elapsed start={session.startedAt} /> })],
          text: session.waitingFor ?? session.phase,
        }),
      });
    }
    for (const job of [...jobs].sort((a, b) => Number(b.endedAt == null) - Number(a.endedAt == null) || b.createdAt - a.createdAt)) {
      list.push({
        id: `job:${job.id}`, group: 'Jobs', title: job.title, subtitle: `${NAMES[job.agent]} · ${names.get(projectOf(job)) ?? projectOf(job)}`, agent: job.agent, icon: WrenchRegular,
        run: () => actions.openJob(job.id),
        preview: () => ({
          eyebrow: `${NAMES[job.agent]} · ${job.ask && !job.debate ? t('Question') : roleLabel({ roleInfo }, jobRole(job))}`,
          chip: [jobStatusState(job), jobLabel(job)],
          lines: [names.get(projectOf(job)) ?? projectOf(job), <Elapsed start={job.createdAt} end={job.endedAt} />],
          text: job.waiting?.reason ?? job.error?.message ?? (job.endedAt == null ? job.phase : job.result?.stat),
        }),
      });
    }
    return list;
  }, [jobs, claude, missions, roleInfo, names, projects, actions, notifyState, notifyOn]);
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) return entries.filter((entry) =>
      words.every((word) => `${entry.title} ${entry.subtitle} ${entry.group}`.toLowerCase().includes(word))).slice(0, 60);
    // With nothing typed: actions, pages, projects, and only the most recent work.
    const counts = new Map<string, number>();
    return entries.filter(({ group }) => {
      if (group !== 'Jobs' && group !== 'Missions' && group !== 'Claude sessions') return true;
      const count = counts.get(group) ?? 0;
      counts.set(group, count + 1);
      return count < 4;
    });
  }, [entries, query]);
  const current = shown[Math.min(active, shown.length - 1)];
  const finish = (then?: () => void) => {
    if (closing.current) return;
    closing.current = true;
    const element = box.current;
    const done = () => {
      close();
      then?.();
    };
    if (!element || reducedMotion()) return done();
    // The way back is quicker, and the contents go before the shape, which folds into the control.
    element.querySelector('.palette-content')?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
    const to = anchor ?? new DOMRect(left + width / 2 - 20, top, 40, 40);
    element
      .animate([{}, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`, borderRadius: '999px', opacity: anchor ? 1 : 0 }], { duration: 240, easing: EASE_IN_OUT, fill: 'forwards' })
      .finished.then(done, done);
  };
  useLayoutEffect(() => {
    const element = box.current!;
    const layer = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    unmounting.current = false;
    // StrictMode mounts twice; a second showModal on an open dialog would throw in some engines.
    if (!layer.open) layer.showModal();
    element.querySelector('input')?.focus();
    const restore = () => {
      unmounting.current = true;
      layer.close();
      previous?.focus({ preventScroll: true });
    };
    if (reducedMotion()) return restore;
    const from = anchor ?? new DOMRect(left + width / 2 - 20, top + 8, 40, 40);
    element.animate(
      [
        { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, borderRadius: '999px', opacity: anchor ? 1 : 0 },
        { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, borderRadius: '26px', opacity: 1 },
      ],
      { duration: 520, easing: EASE_OUT },
    );
    element.querySelectorAll<HTMLElement>('.palette-item').forEach((item, index) =>
      item.animate([{ opacity: 0, translate: '0 4px' }, { opacity: 0, translate: '0 4px' }, { opacity: 1, translate: '0 0' }], { duration: 360 + Math.min(index, 10) * 24, easing: EASE_OUT }),
    );
    return restore;
  }, []);
  useLayoutEffect(() => {
    box.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const preview = current?.preview();
  const listId = 'palette-results';
  let lastGroup = '';
  return (
    <dialog
      ref={dialog}
      className="palette-layer"
      aria-label={t('Search')}
      onCancel={(event) => {
        event.preventDefault();
        finish();
      }}
      onClose={(event) => {
        // Escape can close a modal without a cancel event; the board must still forget the palette. A close from
        // StrictMode's remount arrives with the dialog open again, and one from unmounting needs nothing.
        if (closing.current || unmounting.current || event.currentTarget.open) return;
        closing.current = true;
        close();
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          event.stopPropagation();
          finish();
        }
      }}
      onPointerDown={(event) => {
        pressed.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // Only a press that began outside the panel closes it, not a text selection dragged past its edge.
        if (pressed.current && event.target === event.currentTarget) finish();
      }}
    >
      <div className="palette" ref={box} style={{ left, top, width, height }}>
        <div className="palette-content" style={{ width, height } as CSSProperties}>
          <label className="palette-search">
            <Icon icon={SearchRegular} size={17} />
            <input
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={current ? `palette-${current.id}` : undefined}
              aria-label={t('Search work, projects and actions')}
              placeholder={t('Search work, projects and actions…')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
                setPointer(false);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setPointer(false);
                  setActive((at) => (Math.min(at, shown.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length));
                } else if (event.key === 'Enter' && current) {
                  event.preventDefault();
                  finish(current.run);
                }
              }}
            />
            <kbd>esc</kbd>
          </label>
          <div className="palette-body">
            <div
              className="palette-list"
              id={listId}
              role="listbox"
              aria-label={t('Results')}
              data-pointer={pointer || undefined}
              onPointerLeave={() => setPointer(false)}
            >
              {!shown.length && <p className="palette-empty">{t('Nothing matches “{query}”.', { query })}</p>}
              {shown.map((entry, index) => {
                const heading = entry.group !== lastGroup;
                lastGroup = entry.group;
                return (
                  <div key={entry.id} role="presentation">
                    {heading && <p className="palette-group" role="presentation">{GROUPS[entry.group] ?? entry.group}</p>}
                    <div
                      className="palette-item"
                      role="option"
                      id={`palette-${entry.id}`}
                      data-index={index}
                      aria-selected={entry === current}
                      onPointerMove={() => {
                        setPointer(true);
                        if (index !== active) setActive(index);
                      }}
                      onClick={() => finish(entry.run)}
                    >
                      {entry.agent ? <AgentMark agent={entry.agent} size={15} /> : entry.icon && <Icon icon={entry.icon} />}
                      <span className="palette-title">{entry.title}</span>
                      <span className="palette-subtitle">{entry.subtitle}</span>
                      {entry === current && <Icon icon={ArrowTurnDownLeftRegular} size={13} className="palette-enter" />}
                    </div>
                  </div>
                );
              })}
            </div>
            {current && preview && (
              <aside className="palette-preview" aria-live="polite" key={current.id}>
                <p className="palette-eyebrow">{preview.eyebrow}</p>
                <p className="palette-preview-title">{current.title}</p>
                {preview.chip && <Chip state={preview.chip[0]}>{preview.chip[1]}</Chip>}
                {preview.lines.filter(Boolean).map((line, index) => (
                  <p className="palette-line" key={index} style={{ '--i': index } as CSSProperties}>{line}</p>
                ))}
                {preview.text && (
                  <p className="palette-text">
                    <WordReveal text={preview.text.length > 220 ? `${preview.text.slice(0, 219)}…` : preview.text} />
                  </p>
                )}
                <span className="palette-hint">
                  {current.group === 'Jobs' || current.group === 'Claude sessions' ? <ChatMultipleRegular fontSize={13} /> : null}
                  {t('Press Return to open')}
                </span>
              </aside>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
