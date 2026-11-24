import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import {
  bundleIcon, AddRegular, AlertFilled, AlertRegular, ArrowCircleDownRegular, ArrowClockwiseRegular,
  ArrowRight16Filled, ClockFilled, ClockRegular, ErrorCircleRegular, FlashFilled, FlashRegular, FolderFilled,
  FolderRegular, GridFilled, GridRegular, LockClosedKeyRegular, PanelLeftRegular, SearchRegular, SettingsRegular,
  StackFilled, StackRegular, WifiOffRegular,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import { board } from './store.ts';
import { formatDate, longDay } from './dates.ts';
import { knownProjects, projectNames, projectOf } from './model.ts';
import { AskHost, ClockProvider, CopyMenu, Icon, tNodes, LeavingContext, PANEL_EXIT_MS, RollingNumber, SHEET_EXIT_MS, useLinger, useStableItems } from './ui.tsx';
import appIcon from './icons/CrewAppIcon.png';
import { Activity, History, Workspace } from './Overview.tsx';
import { NeedsYou } from './NeedsYou.tsx';
import { JobDrawer, SessionDrawer } from './JobDrawer.tsx';
import { Settings } from './Settings.tsx';
import { Dispatch } from './Dispatch.tsx';
import { Palette } from './Palette.tsx';
import { Onboarding } from './Onboarding.tsx';
import { NavList, ProjectPeek } from './Shell.tsx';
import { Notifier } from './notify.ts';
import { desktop, useAppUpdate } from './desktop.ts';
import { followSetting, language, onLanguageChange, t, translated } from './i18n.ts';

export type Page = 'overview' | 'needs' | 'activity' | 'history';
const GridNavIcon = bundleIcon(GridFilled, GridRegular);
const AlertNavIcon = bundleIcon(AlertFilled, AlertRegular);
const FlashNavIcon = bundleIcon(FlashFilled, FlashRegular);
const ClockNavIcon = bundleIcon(ClockFilled, ClockRegular);
const StackNavIcon = bundleIcon(StackFilled, StackRegular);
const FolderNavIcon = bundleIcon(FolderFilled, FolderRegular);
export const PAGES = translated((): [Page, string, FluentIcon][] => [
  ['overview', t('Overview'), GridNavIcon],
  ['needs', t('Needs You'), AlertNavIcon],
  ['activity', t('Activity'), FlashNavIcon],
  ['history', t('History'), ClockNavIcon],
]);
const TITLES = translated((): Record<Page, string> => ({ overview: t('Overview'), needs: t('Needs You'), activity: t('Activity'), history: t('History') }));

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
  const shown = useSyncExternalStore(onLanguageChange, () => language);
  const [selection, setSelection] = useState(storedSelection);
  const [settings, setSettings] = useState<boolean | 'about' | 'language'>(false);
  // A change of language draws everything below again (the key on ClockProvider), so Settings, if open, comes back on
  // its Language page, where the change was most likely made.
  const [drawnIn, setDrawnIn] = useState(shown);
  if (drawnIn !== shown) {
    setDrawnIn(shown);
    if (settings) setSettings('language');
  }
  const update = useAppUpdate();
  /** Where a sheet grows from: the control that opened it, or nothing for a keyboard shortcut. */
  const [dispatching, setDispatching] = useState<{ origin?: DOMRect } | null>(null);
  const [palette, setPalette] = useState<{ origin?: DOMRect } | null>(null);
  const [welcome, setWelcome] = useState(false);
  const [detail, setDetail] = useState(detailFromHash);
  const project = selection.startsWith('project:') ? selection.slice(8) : '';
  const page: Page = project ? 'overview' : (PAGES().find(([id]) => id === selection)?.[0] ?? 'overview');
  const { jobs, claude, missions } = state;
  const known = useMemo(() => knownProjects({ jobs, claude, missions }), [jobs, claude, missions]);
  const projects = useStableItems(project && !known.includes(project) ? [...known, project].sort() : known);
  const names = useMemo(() => projectNames(projects), [projects]);
  const waitingJobs = useMemo(() => jobs.filter((job) => job.state === 'waiting')
    .sort((a, b) => (a.waiting?.since ?? 0) - (b.waiting?.since ?? 0)), [jobs]);
  const waitingSessions = useMemo(() => claude.filter((session) => session.state === 'waiting'), [claude]);
  const pending = waitingJobs.length + waitingSessions.length;
  const live = state.connection === 'live';
  const connectionWord = live ? t('Live') : state.connection === 'lost' ? t('Reconnecting…') : t('Connecting…');
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
  const fold = useCallback(() => {
    if (!drawer) return;
    // Committed at once, so the page behind is no longer inert and its button takes focus now, before a dialog
    // opened next records where to return focus.
    flushSync(() => setDrawer(false));
    toggle.current?.focus();
  }, [drawer]);
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

  useEffect(() => {
    document.title = pending ? `(${pending}) Crew` : 'Crew';
  }, [pending]);
  useEffect(() => followSetting(state.language), [state.language]);
  useEffect(() => {
    document.documentElement.lang = shown;
  }, [shown]);
  useEffect(() => {
    const change = () => setDetail(detailFromHash());
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const select = useCallback((value: string) => {
    setSelection(value);
    fold();
    try {
      localStorage.setItem('crew.selection', value);
    } catch {
      /* Embedded panes may disable storage. */
    }
  }, [fold]);
  const show = useCallback((value: string) => {
    setDetail(value);
    history.replaceState(null, '', value ? `#${encodeURIComponent(value)}` : location.pathname + location.search);
  }, []);
  const currentDetail = useRef(detail);
  useLayoutEffect(() => {
    currentDetail.current = detail;
  }, [detail]);
  /** A row opens its panel, or closes it when it is the one already open, as the app's rows do. */
  const openJob = useCallback((id: string) => show(currentDetail.current === id ? '' : id), [show]);
  const showSession = useCallback((id: string) => show(`session:${id}`), [show]);
  const openSession = useCallback((id: string) => show(currentDetail.current === `session:${id}` ? '' : `session:${id}`), [show]);
  const closeDetail = useCallback(() => show(''), [show]);
  // A closed panel stays up while it slides out; a different one replaces it at once.
  const [panel, panelLeaving] = useLinger(detail, PANEL_EXIT_MS);
  // Settings stay up while they settle out, as the panel does.
  const [shownSettings, settingsLeaving] = useLinger(settings === true ? 'open' : settings || '', SHEET_EXIT_MS);
  /** After New Job, the job's own project, so the new job is in view, as the app goes there. */
  const openNewJob = (id: string, root?: string) => {
    if (root && project !== root) select(`project:${root}`);
    show(id);
  };
  const newJob = useCallback((origin?: Element | null) => {
    if (live) setDispatching({ origin: origin?.getBoundingClientRect() });
  }, [live]);
  const openPalette = () => setPalette({ origin: searchButton.current?.getBoundingClientRect() });
  const openSettings = useCallback(() => {
    // First, so the settings dialog returns focus to the drawer's button when it closes.
    fold();
    setSettings(true);
  }, [fold]);
  const openAbout = useCallback(() => {
    fold();
    setSettings('about');
  }, [fold]);
  const openWelcome = useCallback(() => {
    fold();
    setWelcome(true);
  }, [fold]);
  const paletteActions = useMemo(() => ({ select, openJob: show, openSession: showSession, newJob: () => newJob(), settings: openSettings, welcome: openWelcome }), [select, show, showSession, newJob, openSettings, openWelcome]);
  // The desktop app greets a new user once, on a first install; it owes no guide after an update.
  useEffect(() => {
    void desktop?.welcome?.pending().then((pending) => pending && setWelcome(true), () => {});
  }, []);
  const closePalette = useCallback(() => setPalette(null), []);
  // Notifications for requests that arrive while the board is in the background, as the app sends them.
  const notifier = useRef<Notifier>(null);
  notifier.current ??= new Notifier();
  notifier.current.onOpen = (id) => id && show(id);
  useEffect(() => board.connect(undefined, notifier.current!), []);
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
      select(PAGES()[Number(event.key) - 1][0]);
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current?.(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const scope = useMemo(() => ({ state, project, names, selected: detail, openJob, openSession }), [state, project, names, detail, openJob, openSession]);
  const pageItems = useMemo(() => PAGES().map(([id, label, icon]) => ({ id, label, icon, count: id === 'needs' ? pending : undefined })), [pending, shown]);
  if (state.connection === 'unauthorized') {
    return (
      <main className="sign-in" aria-labelledby="sign-in-title">
        <span className="sign-in-mark"><Icon icon={LockClosedKeyRegular} size={36} /></span>
        <h1 className="title" id="sign-in-title">{t('The board is not signed in')}</h1>
        <p className="secondary">
          {t('A browser tab stays signed in only while it is open, so a reload signs it out.')}{' '}
          {tNodes('Run {command} in a terminal, or choose {action} in the Crew app.', { command: <code>crew board</code>, action: <strong>{t('Open Web Board')}</strong> })}
        </p>
        <button className="prominent" onClick={board.retry}>
          <Icon icon={ArrowClockwiseRegular} />
          {t('Retry')}
        </button>
      </main>
    );
  }
  const title = project ? (names.get(project) ?? project) : TITLES()[page];
  const pageNav = (
    <NavList
      label={t('Pages')}
      items={pageItems}
      current={project ? (page === 'overview' ? '' : page) : page}
      onSelect={select}
      shortcut
    />
  );
  return (
    // Some components are memoized and would keep text in the language they were drawn in.
    <ClockProvider key={shown} skew={state.clockSkew}>
      <div className="app">
        <aside className="sidebar" id="sidebar" aria-label={t('Sidebar')} ref={sidebar} data-open={drawer || undefined} inert={folded}>
          <div className="brand">
            <img className="brand-mark" src={appIcon} alt="" />
            <span className="brand-name">Crew</span>
          </div>
          {pageNav}
          <ProjectNav projects={projects} names={names} project={project} state={state} select={select} />
          <div className="sidebar-foot">
            {update?.installError ? (
              <button className="sidebar-item sidebar-update" data-state="failed" id="update-failed" title={update.installError} disabled={!Object.keys(state.roles).length} onClick={openAbout}>
                <Icon icon={ErrorCircleRegular} />
                <span>{t('Update failed')}</span>
              </button>
            ) : (update?.state === 'ready' || update?.state === 'installing') && (
              <button
                className="sidebar-item sidebar-update"
                id="install-update"
                disabled={update.state === 'installing'}
                title={t('Restart Crew to install version {version}', { version: update.latest ?? '' })}
                onClick={() => void desktop?.update.install()}
              >
                <Icon icon={ArrowCircleDownRegular} />
                <span>
                  {update.state === 'ready' ? t('Update Now')
                    : update.waiting ? (update.waiting === 1 ? t('1 job left…') : t('{count} jobs left…', { count: update.waiting }))
                    : update.waiting === 0 ? t('Waiting…') : t('Updating…')}
                </span>
                <span className="sidebar-update-version">{update.latest}</span>
              </button>
            )}
            <div className="sidebar-foot-row">
              <button className="sidebar-item" id="open-settings" disabled={!Object.keys(state.roles).length} onClick={openSettings}>
                <Icon icon={SettingsRegular} />
                <span>{t('Settings')}</span>
              </button>
              {/* Only a light: green live, orange while lost. The word is its tooltip, and the page's banner says a lost one in full. */}
              <p className="connection" role="status" data-state={state.connection} title={connectionWord}>
                <i aria-hidden="true" />
                <span>{connectionWord}</span>
              </p>
            </div>
          </div>
        </aside>
        {drawer && <div className="sidebar-scrim" aria-hidden="true" onClick={fold} />}
        {/* While the drawer is out over it, the page is out of reach, so Tab stays in the drawer. */}
        <div className="workspace" inert={drawer}>
          <header className="topbar">
            <button
              className="icon topbar-sidebar"
              ref={toggle}
              aria-label={drawer ? t('Hide sidebar') : t('Show sidebar')}
              title={drawer ? t('Hide sidebar') : t('Show sidebar')}
              aria-expanded={drawer}
              aria-controls="sidebar"
              onClick={() => setDrawer(!drawer)}
            >
              <Icon icon={PanelLeftRegular} />
            </button>
            <nav className="crumbs" aria-label={t('Location')}>
              <button className="crumb" onClick={() => select('overview')} disabled={!project && page === 'overview'}>
                {project ? t('Projects') : 'Crew'}
              </button>
              <span aria-hidden="true">/</span>
              <span className="crumb-current" aria-current="page">{title}</span>
            </nav>
            <span className="topbar-spacer" />
            <button
              className="search-pill"
              ref={searchButton}
              onClick={openPalette}
              title={t('Search (⌘K)')}
              aria-label={t('Search')}
              aria-keyshortcuts="Meta+K /"
              data-hidden={palette ? '' : undefined}
            >
              <Icon icon={SearchRegular} />
              <span>{t('Search work, projects…')}</span>
              <kbd>⌘K</kbd>
            </button>
            <button className="new-job prominent" disabled={!live} title={t('New job (N)')} aria-keyshortcuts="N" onClick={(event) => newJob(event.currentTarget)}>
              <Icon icon={AddRegular} />
              <span className="new-job-label">{t('New Job')}</span>
            </button>
          </header>
          <main className="page" key={selection}>
            {state.connection === 'lost' && (
              <div className="banner" role="alert">
                <Icon icon={WifiOffRegular} />
                <span>{t('Lost the connection to Crew. Reconnecting…')}</span>
                <button onClick={board.retry}>{t('Retry')}</button>
              </div>
            )}
            <header className="page-head">
              <div className="page-head-copy">
                {project ? (
                  <CopyMenu text={project} label={t('Copy Path')}>
                    <p className="eyebrow path" title={project}><Icon icon={FolderRegular} size={12} />{project}</p>
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
                  aria-label={pending === 1 ? t('1 request needs your attention') : t('{count} requests need your attention', { count: pending })}
                  onClick={() => select('needs')}
                >
                  <span className="attention-count"><RollingNumber value={pending} /></span>
                  <span>{t('Needs You')}</span>
                  <Icon icon={ArrowRight16Filled} />
                </button>
              )}
            </header>
            {page === 'needs' ? (
              <NeedsYou jobs={waitingJobs} sessions={waitingSessions} pending={pending} openJob={openJob} openSession={openSession} />
            ) : page === 'activity' ? (
              <Activity events={state.events} jobs={jobs} missions={missions} openJob={openJob} />
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
        {welcome && <Onboarding close={() => setWelcome(false)} />}
        {palette && (
          <Palette
            state={state}
            names={names}
            projects={projects}
            origin={palette.origin}
            close={closePalette}
            actions={paletteActions}
          />
        )}
        <LeavingContext value={panelLeaving}>
          {panel.startsWith('session:') ? (
            <SessionDrawer key={panel} id={panel.slice(8)} state={state} close={closeDetail} />
          ) : (
            panel && <JobDrawer key={panel} id={panel} state={state} close={closeDetail} />
          )}
        </LeavingContext>
        <LeavingContext value={settingsLeaving}>
          {shownSettings && <Settings state={state} update={update} close={() => setSettings(false)} initial={shownSettings === 'about' || shownSettings === 'language' ? shownSettings : undefined} />}
        </LeavingContext>
        <AskHost />
      </div>
    </ClockProvider>
  );
}

function eyebrow(page: Page, now: number) {
  const date = formatDate(longDay, new Date(now));
  return page === 'overview' ? date : page === 'needs' ? t('Requests from your agents') : page === 'activity' ? t('Everything the crew did') : t('Finished work');
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
  const { jobs, claude } = state;
  const dots = useMemo(() => {
    const dots = new Map<string, 'waiting' | 'working'>();
    for (const item of [...jobs, ...claude]) {
      const dir = projectOf(item);
      if (item.state === 'waiting') dots.set(dir, 'waiting');
      else if ((item.state === 'running' || item.state === 'working') && !dots.has(dir)) dots.set(dir, 'working');
    }
    return dots;
  }, [jobs, claude]);
  const items = useStableItems([
    { id: '', label: t('All projects'), icon: StackNavIcon, dot: undefined },
    // No tooltip: the preview beside the list shows the path, and a tooltip would cover it.
    ...projects.map((dir) => ({ id: dir, label: names.get(dir) ?? dir, icon: FolderNavIcon, dot: dots.get(dir) })),
  ], (a, b) => a.id === b.id && a.label === b.label && a.dot === b.dot);
  const selectProject = useCallback((id: string) => {
    setPeek(null);
    select(id ? `project:${id}` : 'overview');
  }, [select]);
  const hoverProject = useCallback((id: string, element: HTMLElement | null) => {
    clearTimeout(timer.current);
    if (!hover) return;
    // A short rest before the first preview, none while moving between projects.
    const open = () => setPeek(id && element ? { dir: id, top: element.getBoundingClientRect().top } : null);
    if (!id) timer.current = setTimeout(open, 120);
    else if (peek) open();
    else timer.current = setTimeout(open, 260);
  }, [hover, peek]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <>
      <NavList
        label={t('Projects')}
        heading={t('Projects')}
        items={items}
        current={project}
        onSelect={selectProject}
        onHover={hoverProject}
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
