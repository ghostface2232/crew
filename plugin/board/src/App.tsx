import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowRight, Bell, Clock, Command, FolderClosed, LayoutGrid, LockKeyhole, PanelLeft, Plus, RotateCw, Search,
  Settings as SettingsIcon, SquareStack, WifiOff, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { board } from './store.ts';
import { knownProjects, projectNames, projectOf } from './model.ts';
import { ClockProvider, CopyMenu, Icon, RollingNumber } from './ui.tsx';
import appIcon from './icons/CrewAppIcon.svg';
import { Activity, History, Workspace } from './Overview.tsx';
import { NeedsYou } from './NeedsYou.tsx';
import { JobDrawer, SessionDrawer } from './JobDrawer.tsx';
import { Settings } from './Settings.tsx';
import { Dispatch } from './Dispatch.tsx';
import { Palette } from './Palette.tsx';
import { NavList, ProjectPeek } from './Shell.tsx';
import { Notifier } from './notify.ts';

export type Page = 'overview' | 'needs' | 'activity' | 'history';
export const PAGES: [Page, string, LucideIcon][] = [
  ['overview', 'Overview', LayoutGrid],
  ['needs', 'Needs You', Bell],
  ['activity', 'Activity', Zap],
  ['history', 'History', Clock],
];
const TITLES: Record<Page, string> = { overview: 'Overview', needs: 'Needs You', activity: 'Activity', history: 'History' };

/** One selection, as in the app: a page, or `project:<path>` for a project's overview. */
function storedSelection() {
  try {
    const saved = localStorage.getItem('crew.selection');
    if (saved) return saved;
    const project = localStorage.getItem('crew.project');
    return project ? `project:${project}` : 'overview';
  } catch {
    return 'overview';
  }
}
/** The open detail panel, kept in the URL fragment: a job's id, or `session:<id>` for a Claude session. */
const detailFromHash = () => decodeURIComponent(location.hash.slice(1));
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export function App() {
  const state = useSyncExternalStore(board.subscribe, board.getSnapshot);
  const [selection, setSelection] = useState(storedSelection);
  const [settings, setSettings] = useState(false);
  /** Where a sheet grows from: the control that opened it, or nothing for a keyboard shortcut. */
  const [dispatching, setDispatching] = useState<{ origin?: DOMRect } | null>(null);
  const [palette, setPalette] = useState<{ origin?: DOMRect } | null>(null);
  const [detail, setDetail] = useState(detailFromHash);
  const project = selection.startsWith('project:') ? selection.slice(8) : '';
  const page: Page = project ? 'overview' : (PAGES.find(([id]) => id === selection)?.[0] ?? 'overview');
  const known = knownProjects(state);
  const projects = project && !known.includes(project) ? [...known, project].sort() : known;
  const names = projectNames(projects);
  const waitingJobs = state.jobs
    .filter((job) => job.state === 'waiting')
    .sort((a, b) => (a.waiting?.since ?? 0) - (b.waiting?.since ?? 0));
  const waitingSessions = state.claude.filter((session) => session.state === 'waiting');
  const pending = waitingJobs.length + waitingSessions.length;
  const live = state.connection === 'live';
  const narrow = useNarrow();
  // Narrow windows keep the sidebar folded away until its button brings it out over the page.
  const [drawer, setDrawer] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const folded = narrow && !drawer;
  useEffect(() => {
    if (!narrow) setDrawer(false);
  }, [narrow]);
  /** Folds the drawer away and gives focus back to its button, which would otherwise fall to the page as the drawer turns inert. */
  const fold = () => {
    if (!drawer) return;
    // Committed at once, so the page behind is no longer inert and its button takes focus now, before a dialog
    // opened next records where to return focus.
    flushSync(() => setDrawer(false));
    toggle.current?.focus();
  };
  useEffect(() => {
    if (!drawer) return;
    sidebar.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const escape = (event: KeyboardEvent) => {
      // A dialog opened over the page handles its own Escape.
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
      flushSync(() => setDrawer(false));
      toggle.current?.focus();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [drawer]);
  useEffect(() => board.connect(), []);
  useEffect(() => {
    document.title = pending ? `(${pending}) Crew` : 'Crew';
  }, [pending]);
  useEffect(() => {
    const change = () => setDetail(detailFromHash());
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const select = (value: string) => {
    setSelection(value);
    fold();
    try {
      localStorage.setItem('crew.selection', value);
    } catch {
      /* Embedded panes may disable storage. */
    }
  };
  const show = (value: string) => {
    setDetail(value);
    history.replaceState(null, '', value ? `#${encodeURIComponent(value)}` : location.pathname + location.search);
  };
  /** A row opens its panel, or closes it when it is the one already open, as the app's rows do. */
  const openJob = (id: string) => show(detail === id ? '' : id);
  const openSession = (id: string) => show(detail === `session:${id}` ? '' : `session:${id}`);
  const closeDetail = () => show('');
  /** After New Job, the job's own project, so the new job is in view, as the app goes there. */
  const openNewJob = (id: string, root?: string) => {
    if (root && project !== root) select(`project:${root}`);
    show(id);
  };
  const newJob = (origin?: Element | null) => {
    if (live) setDispatching({ origin: origin?.getBoundingClientRect() });
  };
  const openPalette = () => setPalette({ origin: searchButton.current?.getBoundingClientRect() });
  const openSettings = () => {
    // First, so the settings dialog returns focus to the drawer's button when it closes.
    fold();
    setSettings(true);
  };
  // Notifications for requests that arrive while the board is in the background, as the app sends them.
  const notifier = useRef<Notifier>(null);
  notifier.current ??= new Notifier();
  notifier.current.onOpen = (id) => id && show(id);
  useEffect(() => {
    if (state.connection === 'live') notifier.current!.update(state, document.hasFocus());
  }, [state]);
  // Shortcuts that stay clear of the browser's: ⌘K or / to search, N for a new job, 1–4 for the pages.
  const keys = useRef<(event: KeyboardEvent) => void>(null);
  keys.current = (event) => {
    if (event.defaultPrevented || state.connection === 'unauthorized') return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      // An open palette closes itself on ⌘K, shrinking back; another modal keeps the key.
      if (!palette && !document.querySelector('dialog[open]:modal')) openPalette();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || document.querySelector('dialog[open]:modal')) return;
    if (event.key === '/') {
      event.preventDefault();
      openPalette();
    } else if (event.key === 'n' || event.key === 'N') {
      event.preventDefault();
      newJob();
    } else if (/^[1-4]$/.test(event.key)) {
      select(PAGES[Number(event.key) - 1][0]);
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current?.(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  if (state.connection === 'unauthorized') {
    return (
      <main className="sign-in" aria-labelledby="sign-in-title">
        <span className="sign-in-mark"><Icon icon={LockKeyhole} size={22} /></span>
        <h1 className="title" id="sign-in-title">The board is not signed in</h1>
        <p className="secondary">
          Run <code>crew board</code> in a terminal, or choose <strong>Open Web Board</strong> in the Crew app.
        </p>
        <button className="prominent" onClick={board.retry}>
          <Icon icon={RotateCw} />
          Retry
        </button>
      </main>
    );
  }
  const title = project ? (names.get(project) ?? project) : TITLES[page];
  const scope = { state, project, names, selected: detail, openJob, openSession };
  const counts = { needs: pending };
  const pageNav = (
    <NavList
      label="Pages"
      items={PAGES.map(([id, label, icon]) => ({ id, label, icon, count: counts[id as 'needs'] }))}
      current={project ? (page === 'overview' ? '' : page) : page}
      onSelect={(id) => select(id)}
      shortcut
    />
  );
  return (
    <ClockProvider skew={state.clockSkew}>
      <div className="app">
        <aside className="sidebar" id="sidebar" aria-label="Sidebar" ref={sidebar} data-open={drawer || undefined} inert={folded}>
          <div className="brand">
            <img className="brand-mark" src={appIcon} alt="" />
            <span className="brand-name">Crew</span>
            <p className="connection" role="status" data-state={state.connection}>
              <i aria-hidden="true" />
              <span>{live ? 'Live' : state.connection === 'lost' ? 'Reconnecting…' : 'Connecting…'}</span>
            </p>
          </div>
          <button className="search-trigger" onClick={openPalette} aria-keyshortcuts="Meta+K /">
            <Icon icon={Search} />
            <span>Search</span>
            <kbd><Icon icon={Command} size={11} />K</kbd>
          </button>
          {pageNav}
          <ProjectNav projects={projects} names={names} project={project} state={state} select={select} />
          <div className="sidebar-foot">
            <button className="sidebar-item" id="open-settings" disabled={!Object.keys(state.roles).length} onClick={openSettings}>
              <Icon icon={SettingsIcon} />
              <span>Settings</span>
            </button>
          </div>
        </aside>
        {drawer && <div className="sidebar-scrim" aria-hidden="true" onClick={fold} />}
        {/* While the drawer is out over it, the page is out of reach, so Tab stays in the drawer. */}
        <div className="workspace" inert={drawer}>
          <header className="topbar">
            <button
              className="icon topbar-sidebar"
              ref={toggle}
              aria-label={drawer ? 'Hide sidebar' : 'Show sidebar'}
              title={drawer ? 'Hide sidebar' : 'Show sidebar'}
              aria-expanded={drawer}
              aria-controls="sidebar"
              onClick={() => setDrawer(!drawer)}
            >
              <Icon icon={PanelLeft} />
            </button>
            <nav className="crumbs" aria-label="Location">
              <button className="crumb" onClick={() => select('overview')} disabled={!project && page === 'overview'}>
                {project ? 'Projects' : 'Crew'}
              </button>
              <span aria-hidden="true">/</span>
              <span className="crumb-current" aria-current="page">{title}</span>
            </nav>
            <span className="topbar-spacer" />
            <button
              className="search-pill"
              ref={searchButton}
              onClick={openPalette}
              title="Search (⌘K)"
              aria-label="Search"
              data-hidden={palette ? '' : undefined}
            >
              <Icon icon={Search} />
              <span>Search work, projects…</span>
              <kbd>⌘K</kbd>
            </button>
            <button className="new-job prominent" disabled={!live} title="New job (N)" aria-keyshortcuts="N" onClick={(event) => newJob(event.currentTarget)}>
              <Icon icon={Plus} />
              <span className="new-job-label">New Job</span>
            </button>
          </header>
          <main className="page" key={selection}>
            {state.connection === 'lost' && (
              <div className="banner" role="alert">
                <Icon icon={WifiOff} />
                <span>Lost the connection to Crew. Reconnecting…</span>
                <button onClick={board.retry}>Retry</button>
              </div>
            )}
            <header className="page-head">
              <div className="page-head-copy">
                {project ? (
                  <CopyMenu text={project} label="Copy Path">
                    <p className="eyebrow path" title={project}><Icon icon={FolderClosed} size={12} />{project}</p>
                  </CopyMenu>
                ) : (
                  <p className="eyebrow">{eyebrow(page, state.now || Date.now())}</p>
                )}
                <h1 className="page-title">{title}</h1>
              </div>
              {pending > 0 && page !== 'needs' && (
                <button
                  className="attention"
                  // The count already shows in the badge; the name still says it in full.
                  aria-label={`${pending} ${pending === 1 ? 'request needs' : 'requests need'} your attention`}
                  onClick={() => select('needs')}
                >
                  <span className="attention-count"><RollingNumber value={pending} /></span>
                  <span>Needs you</span>
                  <Icon icon={ArrowRight} />
                </button>
              )}
            </header>
            {page === 'needs' ? (
              <NeedsYou jobs={waitingJobs} sessions={waitingSessions} pending={pending} names={names} openJob={openJob} openSession={openSession} />
            ) : page === 'activity' ? (
              <Activity state={state} openJob={openJob} />
            ) : page === 'history' ? (
              <History {...scope} />
            ) : (
              <Workspace {...scope} newJob={newJob} openPage={select} />
            )}
          </main>
        </div>
        <div className="dock" inert={!narrow || drawer}>{pageNav}</div>
        {dispatching && (
          <Dispatch state={state} project={project} origin={dispatching.origin} openJob={openNewJob} close={() => setDispatching(null)} />
        )}
        {palette && (
          <Palette
            state={state}
            names={names}
            projects={projects}
            origin={palette.origin}
            close={() => setPalette(null)}
            actions={{ select, openJob: show, openSession: (id) => show(`session:${id}`), newJob: () => newJob(), settings: openSettings }}
          />
        )}
        {detail.startsWith('session:') ? (
          <SessionDrawer key={detail} id={detail.slice(8)} state={state} close={closeDetail} />
        ) : (
          detail && <JobDrawer key={detail} id={detail} state={state} close={closeDetail} />
        )}
        {settings && <Settings state={state} close={() => setSettings(false)} />}
      </div>
    </ClockProvider>
  );
}

function eyebrow(page: Page, now: number) {
  const date = new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  return page === 'overview' ? date : page === 'needs' ? 'Requests from your agents' : page === 'activity' ? 'Everything the crew did' : 'Finished work';
}

/** The project list, with a preview of each beside the sidebar while the pointer rests on it. */
function ProjectNav({ projects, names, project, state, select }: {
  projects: string[];
  names: Map<string, string>;
  project: string;
  state: ReturnType<typeof board.getSnapshot>;
  select: (value: string) => void;
}) {
  const [peek, setPeek] = useState<{ dir: string; top: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hover = matchMedia('(hover: hover)').matches;
  const activity = (dir: string) => {
    const jobs = state.jobs.filter((job) => projectOf(job) === dir);
    return jobs.some((job) => job.state === 'waiting') || state.claude.some((session) => projectOf(session) === dir && session.state === 'waiting')
      ? 'waiting'
      : jobs.some((job) => job.state === 'running') || state.claude.some((session) => projectOf(session) === dir && session.state === 'working')
        ? 'working'
        : undefined;
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <>
      <NavList
        label="Projects"
        heading="Projects"
        items={[
          { id: '', label: 'All projects', icon: SquareStack },
          // No tooltip: the preview beside the list shows the path, and a tooltip would cover it.
          ...projects.map((dir) => ({ id: dir, label: names.get(dir) ?? dir, icon: FolderClosed, dot: activity(dir) })),
        ]}
        current={project}
        onSelect={(id) => {
          setPeek(null);
          select(id ? `project:${id}` : 'overview');
        }}
        onHover={(id, element) => {
          clearTimeout(timer.current);
          if (!hover) return;
          // A short rest before the first preview, none while moving between projects.
          const open = () => setPeek(id && element ? { dir: id, top: element.getBoundingClientRect().top } : null);
          if (!id) timer.current = setTimeout(open, 120);
          else if (peek) open();
          else timer.current = setTimeout(open, 260);
        }}
      />
      {peek && <ProjectPeek dir={peek.dir} name={names.get(peek.dir) ?? peek.dir} top={peek.top} state={state} />}
    </>
  );
}

/** Below this width the sidebar is hidden (board.css); kept in step with its media query. */
const NARROW = '(max-width: 760px)';
function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const query = matchMedia(NARROW);
    const change = () => setNarrow(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return narrow;
}
