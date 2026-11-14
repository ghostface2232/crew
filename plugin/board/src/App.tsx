import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  ArrowUpRight, Bell, BellDot, ChevronRight, Clock, Folder, LayoutGrid, LockKeyhole, Plus, RotateCw, Search,
  Settings as SettingsIcon, SquareStack, WifiOff, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { board } from './store.ts';
import { knownProjects, projectNames, projectOf } from './model.ts';
import { AgentMark, ClockProvider, Icon } from './ui.tsx';
import { Activity, matches, Summary, Workspace } from './Overview.tsx';
import { NeedsYou } from './NeedsYou.tsx';
import { JobDrawer } from './JobDrawer.tsx';
import { Settings } from './Settings.tsx';
import { Dispatch } from './Dispatch.tsx';

type Page = 'overview' | 'needs' | 'activity' | 'history';
const PAGES: [Page, string, LucideIcon][] = [
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
export function App() {
  const state = useSyncExternalStore(board.subscribe, board.getSnapshot);
  const [selection, setSelection] = useState(storedSelection);
  const [search, setSearch] = useState('');
  const [settings, setSettings] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [jobId, setJobId] = useState(() => location.hash.slice(1));
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
  useEffect(() => board.connect(), []);
  useEffect(() => {
    document.title = pending ? `(${pending}) Crew` : 'Crew';
  }, [pending]);
  useEffect(() => {
    const change = () => setJobId(location.hash.slice(1));
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const select = (value: string) => {
    setSelection(value);
    try {
      localStorage.setItem('crew.selection', value);
    } catch {
      /* Embedded panes may disable storage. */
    }
  };
  const reviewRequests = () => {
    select('needs');
    setSearch('');
  };
  const openJob = (id: string) => {
    setJobId(id);
    history.replaceState(null, '', `#${id}`);
  };
  const closeJob = () => {
    setJobId('');
    history.replaceState(null, '', location.pathname + location.search);
  };
  if (state.connection === 'unauthorized') {
    return (
      <main className="sign-in" aria-labelledby="sign-in-title">
        <Icon icon={LockKeyhole} size={32} />
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
  const withSummary = page === 'overview';
  const scope = { state, project, search, names, selectedJob: jobId, openJob };
  return (
    <ClockProvider skew={state.clockSkew}>
      <div className="app">
        <nav className="sidebar" aria-label="Projects">
          <p className="brand">
            <AgentMark agent="crew" size={18} />
            Crew
          </p>
          <button className="sidebar-item" aria-current={!project && page === 'overview'} onClick={() => select('overview')}>
            <Icon icon={SquareStack} />
            <span>All projects</span>
          </button>
          {projects.length > 0 && <h2 className="sidebar-heading">Projects</h2>}
          {projects.map((dir) => (
            <button className="sidebar-item" key={dir} title={dir} aria-current={project === dir} onClick={() => select(`project:${dir}`)}>
              <Icon icon={Folder} />
              <span>{names.get(dir)}</span>
            </button>
          ))}
          <div className="sidebar-foot">
            <button className="sidebar-item" id="open-settings" disabled={!Object.keys(state.roles).length} onClick={() => setSettings(true)}>
              <Icon icon={SettingsIcon} />
              <span>Settings</span>
            </button>
          </div>
        </nav>
        <div className="workspace">
          <header className="toolbar">
            <select
              className="toolbar-project"
              aria-label="Project"
              value={project}
              onChange={(event) => select(event.target.value ? `project:${event.target.value}` : 'overview')}
            >
              <option value="">All projects</option>
              {projects.map((dir) => (
                <option key={dir} value={dir}>
                  {names.get(dir)}
                </option>
              ))}
            </select>
            <div className="segmented tabs" role="tablist" aria-label="Workspace">
              {PAGES.map(([id, label, icon]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={!project && page === id}
                  onClick={() => select(id)}
                  className={id === 'needs' && pending ? 'tab-badge' : undefined}
                >
                  <Icon icon={id === 'needs' && pending ? BellDot : icon} size={13} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <label className="search">
              <Icon icon={Search} />
              <input
                type="search"
                aria-label="Search work"
                placeholder="Search work"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <p className="connection" role="status" data-state={state.connection}>
              {live ? 'Live' : state.connection === 'lost' ? 'Reconnecting…' : 'Connecting…'}
            </p>
            <button className="glass" disabled={!live} title="New job" onClick={() => setDispatching(true)}>
              <Icon icon={Plus} />
              New Job
            </button>
          </header>
          <main className="page" key={selection}>
            {state.connection === 'lost' && (
              <div className="banner" role="alert">
                <span>
                  <Icon icon={WifiOff} />
                  Lost the connection to Crew. Reconnecting…
                </span>
                <button onClick={board.retry}>Retry</button>
              </div>
            )}
            <div className="heading">
              <div className="heading-copy">
                <h1 className="page-title">{title}</h1>
                {project && (
                  <p className="path" title={project}>
                    {project}
                  </p>
                )}
                {page === 'overview' && !project && pending > 0 && (
                  <button className="glass large" onClick={reviewRequests}>
                    <Icon icon={ArrowUpRight} />
                    Review requests
                  </button>
                )}
              </div>
              {withSummary && <Summary state={state} project={project} />}
            </div>
            {pending > 0 && page !== 'needs' && project && (
              <button className="glass attention-banner" onClick={reviewRequests}>
                <Icon icon={BellDot} />
                <span>
                  {pending} {pending === 1 ? 'request needs' : 'requests need'} your attention
                </span>
                <small>Review</small>
                <Icon icon={ChevronRight} size={11} />
              </button>
            )}
            {page === 'needs' ? (
              <NeedsYou
                jobs={waitingJobs.filter((job) =>
                  matches(search, `${job.title} ${projectOf(job)} ${job.agent} ${job.waiting?.reason ?? ''}`),
                )}
                sessions={waitingSessions.filter((session) =>
                  matches(search, `${session.title} ${projectOf(session)} Claude ${session.waitingFor ?? ''}`),
                )}
                pending={pending}
                names={names}
                openJob={openJob}
              />
            ) : page === 'activity' ? (
              <Activity state={state} search={search} openJob={openJob} />
            ) : (
              <Workspace {...scope} history={page === 'history'} newJob={() => setDispatching(true)} />
            )}
          </main>
        </div>
        {dispatching && <Dispatch state={state} project={project} openJob={openJob} close={() => setDispatching(false)} />}
        {jobId && <JobDrawer key={jobId} id={jobId} state={state} close={closeJob} openJob={openJob} />}
        {settings && <Settings state={state} close={() => setSettings(false)} />}
      </div>
    </ClockProvider>
  );
}
