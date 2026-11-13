import { useEffect, useState, useSyncExternalStore } from 'react';
import { Settings as SettingsIcon, Folder, LockKeyhole, RotateCw } from 'lucide-react';
import { board } from './store.ts';
import { knownProjects, projectNames } from './model.ts';
import { ClockProvider, Icon } from './ui.tsx';
import { Overview, Activity } from './Overview.tsx';
import { NeedsYou } from './NeedsYou.tsx';
import { ProjectGroup } from './Missions.tsx';
import { JobDrawer } from './JobDrawer.tsx';
import { Settings } from './Settings.tsx';
import { Dispatch } from './Dispatch.tsx';

function storedProject() {
  try {
    return localStorage.getItem('crew.project') ?? '';
  } catch {
    return '';
  }
}
export function App() {
  const state = useSyncExternalStore(board.subscribe, board.getSnapshot);
  const [project, setProject] = useState(storedProject);
  const [settings, setSettings] = useState(false);
  const [jobId, setJobId] = useState(() => location.hash.slice(1));
  const dirs = knownProjects(state);
  const names = projectNames(dirs);
  const only = dirs.includes(project) ? project : '';
  const pending = [...state.jobs, ...state.claude].filter((item) => item.state === 'waiting').length;
  useEffect(() => board.connect(), []);
  useEffect(() => {
    document.title = pending ? `(${pending}) Crew` : 'Crew';
  }, [pending]);
  useEffect(() => {
    const change = () => setJobId(location.hash.slice(1));
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const selectProject = (value: string) => {
    setProject(value);
    try {
      localStorage.setItem('crew.project', value);
    } catch {
      /* Embedded panes may disable storage. */
    }
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
      <main className="sign-in section" aria-labelledby="sign-in-title">
        <Icon icon={LockKeyhole} size={32} />
        <h1 id="sign-in-title">The board is not signed in</h1>
        <p>Run <code>crew board</code> in a terminal, or choose <strong>Open Web Board</strong> in the Crew app.</p>
        <button className="primary" onClick={board.retry}>
          <Icon icon={RotateCw} />
          Retry
        </button>
      </main>
    );
  }
  return (
    <ClockProvider skew={state.clockSkew}>
      <div className="main">
        <header className="top">
          <h1>
            <i className="logo" aria-hidden="true" />
            Crew
          </h1>
          {(dirs.length > 1 || only) && (
            <label className="project-picker">
              <Icon icon={Folder} />
              <select aria-label="Filter project" value={only} onChange={(event) => selectProject(event.target.value)}>
                <option value="">All projects</option>
                {dirs.map((dir) => (
                  <option key={dir} value={dir}>
                    {names.get(dir)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="connection" role="status" data-state={state.connection}>
            {state.connection === 'live'
              ? 'Live'
              : state.connection === 'lost'
                ? 'Disconnected — reconnecting…'
                : 'Connecting…'}
          </p>
          <button id="open-settings" disabled={!state.now} onClick={() => setSettings(true)}>
            <Icon icon={SettingsIcon} />
            Settings
          </button>
        </header>
        <Overview state={state} project={only} openJob={openJob} />
        <NeedsYou state={state} openJob={openJob} />
        <div className="layout">
          <main className="board">
            <div className="groups">
              {(only ? [only] : dirs.length ? dirs : ['']).map((dir) => (
                <ProjectGroup
                  key={dir}
                  dir={dir}
                  name={names.get(dir) ?? 'Projects'}
                  state={state}
                  openJob={openJob}
                  selectProject={selectProject}
                />
              ))}
            </div>
          </main>
          <Activity state={state} project={only} openJob={openJob} />
        </div>
        <Dispatch key={only} state={state} project={only} openJob={openJob} />
        {jobId && <JobDrawer key={jobId} id={jobId} state={state} close={closeJob} />}
        {settings && <Settings state={state} close={() => setSettings(false)} />}
      </div>
    </ClockProvider>
  );
}
