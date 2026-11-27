import { Fragment, useEffect, useRef, useState } from 'react';
import {
  ChevronLeftRegular, ChevronRightRegular, DocumentText16Regular, ErrorCircle16Regular, Folder16Regular, Gauge16Regular, Info16Regular,
  Options16Regular, ShieldCheckmark16Regular, TextFont16Regular, Wrench16Regular,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import type { AppUpdate, Preset, PresetName, ProjectSettings, Snapshot } from './types.ts';
import type { AgentSettings, Holder, JobKind, Role, RoleAssignment, RoleInfo, RoleSettings, TurnTokenBudget, WorkerAgent } from '../../bridge/config.ts';
import { formatDate, timeOfDay } from './dates.ts';
import { request } from './api.ts';
import { board } from './store.ts';
import { agentSettings, CLAUDE_MODELS, HOLDERS, knownProjects, NAMES, projectNames, resolveDraft, rolesOf, sortHolders } from './model.ts';
import { AgentMark, ask, CloseButton, Dialog, Icon, Select, useFade } from './ui.tsx';
import { Scores } from './Scores.tsx';
import { desktop } from './desktop.ts';
import { language as interfaceLanguage, t, translated } from './i18n.ts';
import type { Language } from './i18n.ts';
import appIcon from './icons/CrewAppIcon.png';
import styles from './Settings.module.css';

/** The app's one-line summary of a preset. */
/** A sidebar item's name, fading at its end when it is too long for the sidebar. */
function ItemTitle({ text, current }: { text: string; current: boolean }) {
  const fade = useFade<HTMLSpanElement>(text, current);
  return <span className={`${styles.itemTitle} fade-line`} ref={fade}>{text}</span>;
}

const PRESET_SUMMARY = translated((): Record<PresetName, string> => ({
  economy: t('Lower cost and faster runs for straightforward tasks.'),
  balanced: t('Everyday balance of quality, speed, and cost.'),
  best: t('Maximum reasoning depth for complex work.'),
}));

function formatModelName(name: string) {
  if (name === 'inherit') return t('Same as lead');
  return /[-./]/.test(name) ? name : name.charAt(0).toUpperCase() + name.slice(1);
}

/** Structured rows for the Model Presets settings page. */
function presetDetails(preset: Preset): [string, string][] {
  const agents: [string, { model?: string; effort?: string } | undefined][] = [['Codex', preset.codex], ['Claude', preset.claude], ['Antigravity', preset.antigravity]];
  const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
  const subagent = formatModelName(preset.subagentModel ?? 'inherit');
  return [
    ...agents.flatMap(([name, agent]): [string, string][] =>
      agent ? [[name, [agent.model ?? t('Default model'), agent.effort && t('{effort} effort', { effort: t(cap(agent.effort)) })].filter(Boolean).join(' · ')]] : []),
    [t('Subagents'), preset.subagentMax ? t('{model} (max {max})', { model: subagent, max: formatModelName(preset.subagentMax) }) : subagent],
    ...(preset.maxTier ? [[t('Worker cap'), t('Up to {tier} tier', { tier: t(cap(preset.maxTier)) })] as [string, string]] : []),
  ];
}

/** One page of settings, listed in the sidebar: the roles by kind of work, what every agent shares, each project's own instructions, then the desktop app. */
type Fixed = 'about' | 'build' | 'review' | 'edit' | 'presets' | 'models' | 'instructions';
type Pane = Fixed | `project:${string}`;
const PANES = translated((): Record<Fixed, { title: string; icon: FluentIcon; kind?: JobKind }> => ({
  build: { title: t('Build'), icon: Wrench16Regular, kind: 'delegate' },
  review: { title: t('Review'), icon: ShieldCheckmark16Regular, kind: 'review' },
  edit: { title: t('Edit'), icon: TextFont16Regular, kind: 'polish' },
  presets: { title: t('Model Presets'), icon: Options16Regular },
  models: { title: t('Model Scores'), icon: Gauge16Regular },
  instructions: { title: t('Instructions'), icon: DocumentText16Regular },
  // The app's own page: its updates and the settings that are the app's rather than the agents'. Named as the app is.
  about: { title: 'Crew', icon: Info16Regular },
}));

/** What each of a project's switches lets Crew do there without asking, as in the app. */
const PROJECT_SWITCHES = translated((): { key: keyof ProjectSettings; label: string; note: string }[] => [
  { key: 'autonomy', label: t('Push and open pull requests'), note: t('Work is pushed only after it is reviewed and its checks pass. Crew never merges or deploys.') },
  { key: 'watchAway', label: t('Watch pull requests while away'), note: t('Crew checks pull requests every 10 minutes while the lead session is closed.') },
  { key: 'autoResume', label: t('Resume after a usage limit'), note: t('A job stopped by the limit continues once usage resets, but only for a mission still in progress.') },
]);

/**
 * The note under the update section, said only where it explains what the user sees: no updates at all, or one
 * waiting on jobs, as in the app.
 */
function updateNote(update: AppUpdate) {
  if (update.state === 'unsupported') return t('This copy cannot update itself. Install Crew from GitHub releases for updates.');
  return update.state === 'ready' ? t('Updates install after running jobs finish.') : null;
}

/** Where the desktop app's update stands, in one line. */
function updateSummary(update: AppUpdate) {
  const checked = update.checkedAt
    ? t('Last checked at {time}', { time: formatDate(timeOfDay, new Date(update.checkedAt)) })
    : t('Not checked yet');
  const version = String(update.latest);
  switch (update.state) {
    case 'unsupported': return t('Updates come with the installed app');
    case 'idle': return update.checkedAt && !update.error ? t('Crew is up to date') : checked;
    case 'checking': return t('Checking for updates…');
    case 'available': return t('Version {version} is available', { version });
    case 'downloading': return t('Downloading version {version}… {percent}%', { version, percent: Math.round((update.progress ?? 0) * 100) });
    case 'ready': return t('Version {version} is ready to install', { version });
    case 'installing': return update.waiting
      ? update.waiting === 1
        ? t('Version {version} will install when 1 running job finishes', { version })
        : t('Version {version} will install when {count} running jobs finish', { version, count: update.waiting })
      : update.waiting === 0 ? t('Version {version} will install once the Crew daemon answers', { version })
      : t('Restarting to install version {version}…', { version });
  }
}

/** Fixing review findings sits with the reviews it answers, though it runs as a build job. */
const paneKind = (role: RoleInfo): JobKind => (role.role === 'fix' ? 'review' : role.kind);

/**
 * The role table the form edits: what the user wrote, so a role left to follow its parent keeps following it.
 * A daemon without the registry sends only the resolved table, which for its three roles is the same thing.
 */
const editableRoles = (state: Snapshot): RoleSettings => structuredClone(state.roleInfo ? state.roleSettings ?? {} : state.roles);

/** A role's entry as the daemon would store it: holders in order, blank fields and empty settings left out. */
function cleanEntry(entry: Partial<RoleAssignment> = {}): Partial<RoleAssignment> {
  const clean: Partial<RoleAssignment> = entry.agents ? { agents: sortHolders(entry.agents) } : {};
  for (const agent of ['codex', 'antigravity', 'claude'] as const) {
    const settings = agentSettings(entry[agent]);
    if (settings) clean[agent] = settings;
  }
  return clean;
}

/** Two role tables say the same when every role sets the same things, whatever the order they were written in. */
function sameRoles(a: RoleSettings, b: RoleSettings) {
  const canonical = (table: RoleSettings) => JSON.stringify(Object.entries(table)
    .map(([role, entry]) => [role, Object.entries(cleanEntry(entry)).sort()] as const)
    .filter(([, entry]) => entry.length)
    .sort());
  return canonical(a) === canonical(b);
}

/** A token count as the interface's language says it briefly: 80M, or 8000만. */
const tokenCount = (tokens: number) => new Intl.NumberFormat(interfaceLanguage, { notation: 'compact', maximumFractionDigits: 1 }).format(tokens);
/** The daemon's TURN_TOKEN_CHOICES; the board takes only types from the bridge, whose modules need Node. */
const TOKEN_CHOICES = [1_000_000, 5_000_000, 10_000_000, 20_000_000, 30_000_000, 50_000_000, 100_000_000];

/**
 * A setting stored as it is changed, with no save step. One request runs at a time, and a change made meanwhile goes
 * out when it returns, so the last one made is the one stored. A change that cannot be stored is undone, and the
 * reason kept to show.
 */

function useStored<T>(initial: () => T, same: (a: T, b: T) => boolean, store: (value: T) => Promise<T>) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const now = useRef({ value, stored: value, storing: null as Promise<boolean> | null }).current;
  const send = useRef(store);
  send.current = store;
  /** Stores until the value is the stored one; whether that went through. */
  const run = async () => {
    try {
      while (!same(now.value, now.stored)) {
        const submitted = now.value;
        now.stored = await send.current(submitted);
        // The form shows what was stored, unless it was changed meanwhile.
        if (same(now.value, submitted)) setValue(now.value = now.stored);
      }
      setError('');
      return true;
    } catch (failure) {
      setValue(now.value = now.stored);
      setError((failure as Error).message);
      return false;
    }
  };
  const change = (next: T) => {
    now.value = next;
    setValue(next);
    if (now.storing) return;
    setBusy(true);
    const storing = run();
    now.storing = storing;
    void storing.then(() => {
      now.storing = null;
      setBusy(false);
    });
  };
  /**
   * Takes a value stored from elsewhere as the stored one, so the next change starts from it; whether it was taken.
   * Not while a change made here is being stored: that one goes out as it was made.
   */
  const adopt = (next: T) => {
    if (now.storing || same(next, now.stored)) return false;
    setValue(now.value = now.stored = next);
    return true;
  };
  /**
   * `latest` is the value as last changed, ahead of the render that shows it. `settled` answers once nothing is being
   * stored, with whether the change that was went through: at once, and true, when none is.
   */
  return { value, error, busy, change, adopt, latest: () => now.value, settled: () => now.storing ?? Promise.resolve(true) };
}

/** A setting typed by hand: stored when the field is left or Return is pressed, not at every keystroke. */
function TypedSetting({ label, value, placeholder, onCommit }: { label: string; value: string; placeholder: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  // The stored value changed under the field, as when a change that failed is undone. Text being typed and not yet
  // stored is kept: a change made elsewhere must not replace what the user is in the middle of writing.
  if (value !== shown) {
    setShown(value);
    if (draft === shown) setDraft(value);
  }
  return (
    <input
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { if (draft !== value) onCommit(draft); }}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
    />
  );
}

/** `initial` opens a page at once, as the sidebar's failed update opens About. */
export function Settings({ state, update, close, initial }: { state: Snapshot; update: AppUpdate | null; close: () => void; initial?: 'about' }) {
  const [pane, setPane] = useState<Pane>(initial ?? 'build');
  // On a phone the sidebar is a list of its own, and a page replaces it; wider, both show.
  const [view, setView] = useState<'list' | 'page'>(initial ? 'page' : 'list');
  const back = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Roles and the preset are stored as they are changed; only the instructions, being prose, have a save of their own.
  const storedRoles = useStored<RoleSettings>(() => editableRoles(state), sameRoles, async (submitted) => {
    const result = await request<{ roles?: Snapshot['roles']; roleSettings?: RoleSettings }>('/api/roles', { roles: submitted });
    // A daemon without the registry answers without the table it stored.
    if (!result.roleSettings || !result.roles) return submitted;
    board.receive('roles', result.roles);
    board.receive('roleSettings', result.roleSettings);
    return structuredClone(result.roleSettings);
  });
  const roles = storedRoles.value;
  // The table and the resolved roles as Settings opened, and each agent's settings as it was turned off since.
  const [opened, setOpened] = useState(() => ({ settings: editableRoles(state), roles: state.roles }));
  // A table changed elsewhere (the app, another tab, config.json) replaces the form's copy, as if Settings opened on
  // it: each change here stores the whole table, so an older copy would undo that change.
  const streamedRoles = state.roleInfo ? state.roleSettings : state.roles;
  useEffect(() => {
    if (storedRoles.adopt(editableRoles(state))) setOpened({ settings: editableRoles(state), roles: state.roles });
  }, [streamedRoles]);
  const dropped = useRef<Record<string, AgentSettings | undefined>>({});
  /** The role last changed, under whose rows a change that could not be stored says so. */
  const changedRole = useRef<Role | null>(null);
  const info = rolesOf(state);
  // Against the roles as Settings opened, not as last stored: a role returns to writing no holders only where it wrote
  // none then, and the holders it had then are what that means until the daemon has answered.
  const resolved = resolveDraft(info, roles, opened.roles);
  const storedPreset = useStored<PresetName | null>(() => state.preset ?? null, Object.is, async (submitted) => {
    const revision = board.getPresetRevision();
    const result = await request<Pick<Snapshot, 'preset' | 'presets'>>('/api/preset', { preset: submitted });
    // The stream may already have delivered this save and a newer one. Use the reply when there was no stream update.
    if (board.getPresetRevision() === revision) board.receive('preset', result);
    return result.preset ?? null;
  });
  useEffect(() => {
    storedPreset.adopt(state.preset ?? null);
  }, [state.preset, storedPreset.busy]);
  const preset = storedPreset.value;
  // Saved as it changes, like the preset, and guarded the same way against a reply that arrives after a newer value.
  const storedBudget = useStored<TurnTokenBudget>(() => state.turnTokenBudget ?? null, Object.is, async (submitted) => {
    const revision = board.getBudgetRevision();
    const saved = (await request<{ turnTokenBudget: TurnTokenBudget }>('/api/turn-token-budget', { budget: submitted })).turnTokenBudget;
    if (board.getBudgetRevision() === revision) board.receive('turnTokenBudget', saved);
    return saved;
  });
  useEffect(() => {
    if (state.turnTokenBudget !== undefined) storedBudget.adopt(state.turnTokenBudget);
  }, [state.turnTokenBudget, storedBudget.busy]);
  const budget = storedBudget.value;
  const selectedPreset = preset ? state.presets?.[preset] : undefined;
  const [scope, setScope] = useState('');
  // Whose instructions the editor holds; until a newly chosen set arrives, it still holds the previous one.
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const saveLock = useRef(false);
  const dirty = text !== saved;
  // Whether the instructions are unsaved as they stand now, for a close that waited on a store and so outlived the
  // render it began in.
  const unsaved = useRef(false);
  unsaved.current = dirty || saving;
  const dirs = knownProjects(state);
  const names = projectNames(dirs);
  useEffect(() => {
    const attempt = ++generation.current;
    const abort = new AbortController();
    setLoad('loading');
    setStatus('');
    setSaving(false);
    saveLock.current = false;
    void request<{ text: string }>(
      `/api/instructions${scope ? `?project=${encodeURIComponent(scope)}` : ''}`,
      undefined,
      abort.signal,
    ).then(
      (result) => {
        if (attempt !== generation.current) return;
        setText(result.text);
        setSaved(result.text);
        setLoadedScope(scope);
        setLoad('ready');
      },
      (error: Error) => {
        if (abort.signal.aborted || attempt !== generation.current) return;
        setText('');
        setSaved('');
        setLoad('failed');
        setStatus(t('Could not load instructions: {error}', { error: error.message }));
      },
    );
    return () => {
      generation.current++;
      abort.abort();
    };
  }, [scope, retry]);
  useEffect(() => {
    if (!dirty && !saving && !storedRoles.busy && !storedPreset.busy) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty, saving, storedRoles.busy, storedPreset.busy]);
  // On a phone, opening a page moves focus to its way back, as a pushed screen does, and going back returns it to the page's row.
  const nav = useRef<HTMLElement>(null);
  const pushed = useRef(false);
  useEffect(() => {
    if (view === 'page') {
      pushed.current = true;
      if (back.current?.offsetParent) back.current.focus();
    } else if (pushed.current) nav.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
  }, [view, pane]);
  // A failed install leaves the sidebar once About has shown why, when Settings closes, so the note stays while it is read.
  const shownInstallError = useRef(false);
  const closeSettings = async () => {
    // A model or effort typed by hand is stored as its field is left, which a browser need not report for a dialog going away.
    (document.activeElement as HTMLElement | null)?.blur();
    // A change still being stored is waited for. One that cannot be stored keeps Settings open, where it says so:
    // closed, the change would be undone with nothing left to show why.
    if (!(await storedRoles.settled()) || !(await storedPreset.settled()) || !(await storedBudget.settled())) return;
    if (unsaved.current && !await ask(t('Close without saving your changes?'), t('Close'))) return;
    if (shownInstallError.current) void desktop?.update.seen?.();
    close();
  };
  /** Replaces a role's entry and stores the table, dropping the entry when nothing is left. */
  const setEntry = (role: Role, change: (own: Partial<RoleAssignment>) => Partial<RoleAssignment>) => {
    const current = storedRoles.latest();
    const entry = cleanEntry(change({ ...current[role] }));
    const { [role]: _entry, ...others } = current;
    changedRole.current = role;
    void storedRoles.change(Object.keys(entry).length ? { ...others, [role]: entry } : others);
  };
  /**
   * Turns a holder on or off; a role keeps at least one. A role without a parent that comes back to the holders it
   * resolved to unwritten when Settings opened writes none again.
   */
  const toggleHolder = (role: RoleInfo, holder: Holder) =>
    setEntry(role.role, (own) => {
      const shown = resolved[role.role]?.agents ?? [];
      const next = shown.includes(holder) ? shown.filter((other) => other !== holder) : sortHolders([...shown, holder]);
      if (!next.length) return own;
      // Off, an agent's settings go; back on while Settings stays open, they come back as they were.
      if (holder !== 'claude') {
        const key = `${role.role}:${holder}`;
        if (next.includes(holder)) own[holder] ??= dropped.current[key];
        else {
          dropped.current[key] = own[holder];
          delete own[holder];
        }
      }
      const unwritten = !role.parent && !opened.settings[role.role]?.agents ? opened.roles[role.role]?.agents : undefined;
      if (unwritten && unwritten.join() === next.join()) delete own.agents;
      else own.agents = next;
      return own;
    });
  /** Follows the parent's holders, or starts from them as the role's own. Settings for an agent the parent lacks stay, unused. */
  const follow = (role: RoleInfo, on: boolean) =>
    setEntry(role.role, (own) => {
      const { agents: _agents, ...rest } = own;
      const parent = resolved[role.parent!]?.agents;
      return on ? rest : parent?.length ? { ...rest, agents: parent } : own;
    });
  const editSetting = (role: Role, agent: Holder, key: keyof AgentSettings, value: string) =>
    setEntry(role, (own) => {
      const settings = { ...own[agent], [key]: value };
      // A new model drops an effort it does not accept, rather than send the pair.
      const accepts = models(agent).find((choice) => choice.id === value)?.efforts;
      if (key === 'model' && settings.effort && accepts?.length && !accepts.includes(settings.effort)) delete settings.effort;
      return { ...own, [agent]: settings };
    });
  // A switch, not a draft: it saves as it is flipped, and the daemon's answer is what the board then shows.
  const [ratingsStatus, setRatingsStatus] = useState('');
  const setPeerRatings = async (enabled: boolean) => {
    setRatingsStatus('');
    try {
      board.receive('peerRatings', (await request<{ peerRatings: boolean }>('/api/peer-ratings', { enabled })).peerRatings);
    } catch (error) {
      setRatingsStatus((error as Error).message);
    }
  };
  const [cardsStatus, setCardsStatus] = useState('');
  const setProgressCards = async (enabled: boolean) => {
    setCardsStatus('');
    try {
      board.receive('progressCards', (await request<{ progressCards: boolean }>('/api/progress-cards', { enabled })).progressCards);
    } catch (error) {
      setCardsStatus(t('Not saved: {error}', { error: (error as Error).message }));
    }
  };
  // Windows keeps whether the app opens at sign-in, and the user can change it there too, so it is read each time
  // the Crew page opens. Null until the app answers, and where this copy cannot open at sign-in.
  const [openAtLogin, setOpenAtLogin] = useState<boolean | null>(null);
  const [loginSaving, setLoginSaving] = useState(false);
  const [loginStatus, setLoginStatus] = useState('');
  const aboutShown = pane === 'about';
  useEffect(() => {
    if (!aboutShown || !desktop?.login) return;
    let live = true;
    void desktop.login.state().then((open) => live && setOpenAtLogin(open), () => {});
    return () => {
      live = false;
    };
  }, [aboutShown]);
  const changeOpenAtLogin = async (open: boolean) => {
    setLoginStatus('');
    setLoginSaving(true);
    try {
      setOpenAtLogin(await desktop!.login!.set(open));
    } catch (error) {
      setLoginStatus(t('Not saved: {error}', { error: (error as Error).message }));
    } finally {
      setLoginSaving(false);
    }
  };
  // A project's switches save as they are flipped, like peer ratings. One saves at a time, as in the app, so two
  // quick flips cannot land out of order.
  // A failure is kept with its project, so it shows only on that project's page.
  const [projectStatus, setProjectStatus] = useState<{ project: string; text: string } | null>(null);
  const [projectSaving, setProjectSaving] = useState(false);
  const setProjectSwitch = async (dir: string, key: keyof ProjectSettings, on: boolean) => {
    setProjectStatus(null);
    setProjectSaving(true);
    try {
      // A newer state from the stream, such as the app's flip, wins over this save's older answer.
      const revision = board.getProjectsRevision();
      const saved = await request<{ projects: Record<string, ProjectSettings> }>('/api/project-settings', { project: dir, changes: { [key]: on } });
      if (board.getProjectsRevision() === revision) board.receive('projects', saved.projects);
    } catch (error) {
      setProjectStatus({ project: dir, text: t('Not saved: {error}', { error: (error as Error).message }) });
    } finally {
      setProjectSaving(false);
    }
  };
  // Stored as it is picked; the board then switches to the language the daemon reports (followSetting in i18n.ts).
  const [languageStatus, setLanguageStatus] = useState('');
  const chooseLanguage = async (language: Language | null) => {
    setLanguageStatus('');
    try {
      board.receive('language', await request<Pick<Snapshot, 'language'>>('/api/language', { language }));
    } catch (error) {
      setLanguageStatus(t('Not saved: {error}', { error: (error as Error).message }));
    }
  };
  const saveInstructions = async () => {
    if (saveLock.current || load !== 'ready') return;
    saveLock.current = true;
    setSaving(true);
    setStatus('');
    const attempt = generation.current;
    const draft = text;
    try {
      const result = await request<{ text: string }>('/api/instructions', {
        project: scope || null,
        text: draft,
      });
      if (attempt !== generation.current) return;
      setText((current) => (current === draft ? result.text : current));
      setSaved(result.text);
      setStatus(t('Saved'));
    } catch (error) {
      if (attempt === generation.current) setStatus((error as Error).message);
    } finally {
      if (attempt === generation.current) {
        saveLock.current = false;
        setSaving(false);
      }
    }
  };
  // A daemon without presets or notes has no page for them, and the Crew page needs an update to show or a setting.
  const hasAbout = Boolean(update) || state.language !== undefined || state.progressCards !== undefined || Boolean(desktop?.login);
  const current: Pane =
    (pane === 'presets' && !state.presets) || (pane === 'models' && !state.modelScores) ||
    (pane === 'about' && !hasAbout) ? 'build' : pane;
  useEffect(() => {
    if (current === 'about' && update?.installError) shownInstallError.current = true;
  }, [current, update?.installError]);
  const project = current.startsWith('project:') ? current.slice('project:'.length) : null;
  const fixed = project === null ? PANES()[current as Fixed] : undefined;
  const kind = fixed?.kind;
  // The instructions this page edits: '' for every project, a project's own; null on the other pages.
  const pageScope = current === 'instructions' ? '' : project;
  const title = project === null ? fixed!.title : names.get(project) ?? project;
  const canSave = pageScope !== null && state.connection === 'live' && !saving && load === 'ready' && loadedScope === pageScope;
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !event.altKey) {
        event.preventDefault();
        // Not while a question is open over Settings, such as whether to close without saving.
        if (event.target instanceof Element && event.target.closest('dialog.ask')) return;
        if (canSave) void saveInstructions();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  });
  // Each page opens at its top.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [current, view]);
  const open = async (next: Pane) => {
    const nextScope = next === 'instructions' ? '' : next.startsWith('project:') ? next.slice('project:'.length) : null;
    // Another set of instructions loads in place of the one being edited, so unsaved edits are asked about first.
    if (nextScope !== null && nextScope !== scope) {
      if (text !== saved && !(await ask(t('Discard the unsaved changes to these instructions?'), t('Discard')))) return;
      // Discarded now, not when the next set arrives: nothing is left to ask about meanwhile.
      setText(saved);
      setScope(nextScope);
    }
    setPane(next);
    setView('page');
  };
  const item = (id: Pane) => {
    const dir = id.startsWith('project:') ? id.slice('project:'.length) : null;
    const page = dir === null ? PANES()[id as Fixed] : undefined;
    return (
      <button
        type="button"
        key={id}
        className={styles.item}
        aria-current={current === id ? 'page' : undefined}
        // Another set of instructions cannot load while these are being saved.
        disabled={saving && (dir ?? (id === 'instructions' ? '' : null)) !== null && (dir ?? '') !== scope}
        onClick={() => open(id)}
        title={dir ?? undefined}
      >
        <Icon icon={page?.icon ?? Folder16Regular} className={styles.glyph} />
        <ItemTitle text={page?.title ?? names.get(dir!) ?? dir!} current={current === id} />
        <Icon icon={ChevronRightRegular} className={styles.chevron} />
      </button>
    );
  };
  // An older daemon may not know every agent; Claude is always one.
  const holders = HOLDERS.filter((holder) => holder === 'claude' || holder in state.agents);
  const models = (agent: Holder) => (agent === 'claude' ? CLAUDE_MODELS : state.agents[agent]?.models ?? []);
  const holderLabel = (holder: Holder) =>
    holder === 'claude' ? 'Claude' : state.agents[holder].enabled ? state.agents[holder].name : t('{name} (disabled)', { name: state.agents[holder].name });
  const roleGroup = (role: RoleInfo) => {
    const own = roles[role.role] ?? {};
    const roleLabel = t(role.label);
    const parentLabel = t(info.find((other) => other.role === role.parent)?.label ?? role.parent ?? '');
    const following = Boolean(role.parent && !own.agents);
    const shown = resolved[role.role];
    // What a field means when left blank: the parent's setting for that agent while the role follows it.
    const inherited = (agent: Holder, key: keyof AgentSettings) => (following ? resolved[role.parent!]?.[agent]?.[key] : undefined);
    const blank = (agent: Holder, key: keyof AgentSettings) => {
      const value = inherited(agent, key);
      return value
        ? t('{model} (same as {role})', { model: models(agent).find((model) => model.id === value)?.name ?? value, role: parentLabel })
        : t('Agent default');
    };
    /**
     * A model or effort picked from what the agent offers, or typed when the daemon offers nothing. A value written by
     * hand that is not offered stays a choice, so opening the settings never changes it.
     */
    const field = (agent: Holder, key: keyof AgentSettings) => {
      const label = key === 'model'
        ? t('{role} {agent} model', { role: roleLabel, agent: NAMES[agent] })
        : t('{role} {agent} reasoning effort', { role: roleLabel, agent: NAMES[agent] });
      const value = own[agent]?.[key] ?? '';
      const change = (next: string) => editSetting(role.role, agent, key, next);
      const offered = models(agent);
      if (!offered.length) return <TypedSetting label={label} value={value} placeholder={blank(agent, key)} onCommit={change} />;
      const model = own[agent]?.model || inherited(agent, 'model');
      // A model that lists no efforts says nothing about them, so every offered effort stays a choice.
      const listed = offered.find((choice) => choice.id === model)?.efforts;
      const efforts = listed?.length ? listed : [...new Set(offered.flatMap((choice) => choice.efforts ?? []))];
      const options = key === 'model' ? offered.map((choice) => [choice.id, choice.name]) : efforts.map((effort) => [effort, effort]);
      if (value && !options.some(([id]) => id === value)) options.push([value, value]);
      return (
        <Select label={label} value={value} options={[['', blank(agent, key)], ...(options as [string, string][])]} onChange={change} />
      );
    };
    // Claude's settings apply when it runs as a worker, under a Codex lead; a Claude Code lead does the work itself.
    const workers = (shown?.agents ?? []).filter((holder) => holder === 'claude' || holder in state.agents);
    return (
      <section className={styles.group} key={role.role} aria-label={roleLabel}>
        <header className={styles.groupHead}>
          <AgentMark agent={shown?.agents[0] ?? 'codex'} size={22} />
          <div>
            <h3 className={styles.groupTitle}>{roleLabel}</h3>
            {state.roleInfo && <p className={styles.footnote}>{t(role.summary)}</p>}
          </div>
        </header>
        <div className={styles.rows}>
          {role.parent && (
            <label className={styles.row}>
              <span>{t('Same as {role}', { role: parentLabel })}</span>
              <input type="checkbox" className="switch" checked={following} onChange={(event) => follow(role, event.target.checked)} />
            </label>
          )}
          <div className={styles.row}>
            <span id={`${role.role}-agents`}>{t('Agents')}</span>
            <span className={styles.checks} role="group" aria-labelledby={`${role.role}-agents`}>
              {holders.map((holder) => {
                const held = shown?.agents.includes(holder) ?? false;
                // An agent that cannot do the role's work is not offered, though one already held can be turned off.
                const unable = holder !== 'claude' && Boolean(role.unable?.includes(holder));
                return (
                  <label key={holder} className={styles.check}>
                    <input
                      type="checkbox"
                      aria-label={`${roleLabel}: ${holderLabel(holder)}`}
                      checked={held}
                      // A role keeps at least one holder, and a following role shows its parent's.
                      disabled={following || (held && shown?.agents.length === 1) || (unable && !held)}
                      onChange={() => toggleHolder(role, holder)}
                    />
                    {holderLabel(holder)}
                  </label>
                );
              })}
            </span>
          </div>
          {workers.map((agent) => (
            <Fragment key={agent}>
              <label className={styles.row}>
                <span>{t('{agent} model', { agent: NAMES[agent] })}</span>
                {field(agent, 'model')}
              </label>
              <label className={styles.row}>
                <span>{t('{agent} reasoning effort', { agent: NAMES[agent] })}</span>
                {field(agent, 'effort')}
              </label>
            </Fragment>
          ))}
        </div>
        {storedRoles.error && changedRole.current === role.role && (
          <p className={`${styles.footnote} ${styles.note} error`} role="alert">
            <Icon icon={ErrorCircle16Regular} />
            {t('Not saved: {error}', { error: storedRoles.error })}
          </p>
        )}
      </section>
    );
  };
  return (
    <Dialog labelId="settings-title" onClose={closeSettings}>
      <div className={styles.panel} data-view={view}>
        <nav className={styles.sidebar} aria-label={t('Settings pages')} ref={nav}>
          <header className={styles.sidebarHead}>
            <h2 className={styles.windowTitle} id="settings-title">{t('Settings')}</h2>
            <span className={styles.listClose}><CloseButton label={t('Close settings')} onClose={closeSettings} /></span>
          </header>
          {hasAbout && <div className={styles.section}>{item('about')}</div>}
          <p className={styles.sectionLabel}>{t('Roles')}</p>
          <div className={styles.section}>{(['build', 'review', 'edit'] as Pane[]).map(item)}</div>
          <p className={styles.sectionLabel}>{t('Shared')}</p>
          <div className={styles.section}>
            {([
              ...(state.presets ? ['presets'] : []), ...(state.modelScores ? ['models'] : []), 'instructions',
            ] as Pane[]).map(item)}
          </div>
          {dirs.length > 0 && (
            <>
              <p className={styles.sectionLabel}>{t('Projects')}</p>
              <div className={styles.section}>{dirs.map((dir) => item(`project:${dir}`))}</div>
            </>
          )}
        </nav>
        <div className={styles.detail}>
          <header className={styles.pageHead}>
            <button type="button" ref={back} className={`borderless ${styles.back}`} onClick={() => setView('list')}>
              <Icon icon={ChevronLeftRegular} />
              {t('Settings')}
            </button>
            <h2 className={styles.pageTitle}>{title}</h2>
            <span className={styles.pageClose}><CloseButton label={t('Close settings')} onClose={closeSettings} /></span>
          </header>
          {/* The page is the stage the dialog's frame wraps, as in the window. Named here, since only a phone shows the title row. */}
          <section className={styles.stage} aria-label={title}>
          <div className={styles.scroll} ref={scroller}>
            <div className={styles.body}>
              {kind && info.filter((role) => paneKind(role) === kind).map(roleGroup)}
              {current === 'presets' && (
                <>
                  <section className={styles.group}>
                    <div className={styles.rows}>
                      <label className={styles.row}>
                        <span>{t('Default')}</span>
                        <Select<PresetName | ''>
                          label={t('Model preset')}
                          value={preset ?? ''}
                          options={[['', t('None')], ['economy', t('Economy')], ['balanced', t('Balanced')], ['best', t('Best')]]}
                          onChange={(next) => void storedPreset.change(next || null)}
                        />
                      </label>
                      {selectedPreset && presetDetails(selectedPreset).map(([label, value]) => (
                        <div className={styles.row} key={label}><span>{label}</span><span className={styles.value}>{value}</span></div>
                      ))}
                    </div>
                    {storedPreset.error && (
                      <p className={`${styles.footnote} ${styles.note} error`} role="alert">
                        <Icon icon={ErrorCircle16Regular} />
                        {t('Not saved: {error}', { error: storedPreset.error })}
                      </p>
                    )}
                    <p className={styles.footnote}>{preset ? PRESET_SUMMARY()[preset] : t("Uses each agent's own model and effort settings.")}</p>
                  </section>
                  {state.turnTokenBudget !== undefined && (
                    <section className={styles.group}>
                      <header className={styles.groupHead}><h3 className={styles.groupTitle}>{t('Turn Budget')}</h3></header>
                      <div className={styles.rows}>
                        <label className={styles.row}>
                          <span>{t('Tokens per Turn')}</span>
                          {/* Keyed as text, since the select's values are strings; null is By Difficulty. */}
                          <Select<string>
                            label={t('Tokens per Turn')}
                            value={budget === null ? 'difficulty' : String(budget)}
                            options={[
                              ['difficulty', t('By Difficulty')],
                              ...TOKEN_CHOICES.map((tokens) => [String(tokens), tokenCount(tokens)] as [string, string]),
                              ['unlimited', t('Unlimited')],
                            ]}
                            onChange={(next) => storedBudget.change(next === 'difficulty' ? null : next === 'unlimited' ? 'unlimited' : Number(next))}
                          />
                        </label>
                      </div>
                      {storedBudget.error && (
                        <p className={`${styles.footnote} ${styles.note} error`} role="alert">
                          <Icon icon={ErrorCircle16Regular} />
                          {t('Not saved: {error}', { error: storedBudget.error })}
                        </p>
                      )}
                      <p className={styles.footnote}>
                        {budget === null
                          ? t("A worker turn's token cap depends on job difficulty: {routine} for routine, {standard} for standard, and {hard} for hard. A turn also stops after 2 to 4 hours.", { routine: tokenCount(60_000_000), standard: tokenCount(80_000_000), hard: tokenCount(120_000_000) })
                          : budget === 'unlimited' ? t('Tokens never stop a turn; only the 2-to-4-hour time limit does.') : t('Besides this token cap, a turn also stops after 2 to 4 hours.')}
                      </p>
                    </section>
                  )}
                  <section className={styles.group}>
                    <header className={styles.groupHead}><h3 className={styles.groupTitle}>{t('Priority')}</h3></header>
                    <div className={styles.rows}>
                      <div className={styles.row}><span>{t('Role settings')}</span><span className={styles.value}>{t('Override any preset')}</span></div>
                      <div className={styles.row}><span>{t('Mission preset')}</span><span className={styles.value}>{t('Overrides default for new jobs')}</span></div>
                    </div>
                  </section>
                </>
              )}
              {current === 'about' && update && (
                // Laid out like Software Update, as in the macOS app: the state beside the app's icon with the check on
                // that row, and an update's action under the list on one line with the note.
                <section className={styles.group}>
                  <div className={styles.rows}>
                    <div className={`${styles.row} ${styles.update}`}>
                      <img className={styles.aboutIcon} src={appIcon} alt="" />
                      <div className={styles.updateText}>
                        <span role="status">{updateSummary(update)}</span>
                        {update.state === 'downloading' && (
                          <progress className={styles.progress} value={update.progress ?? 0} max={1} aria-label={t('Download progress')} />
                        )}
                        <span className={styles.updateVersion}>Crew {update.current}</span>
                      </div>
                      {(update.state === 'idle' || update.state === 'checking') && (
                        <button type="button" disabled={update.state === 'checking'} onClick={() => void desktop?.update.check()}>
                          {t('Check for Updates')}
                        </button>
                      )}
                    </div>
                    {update.page && update.latest && (
                      <div className={styles.row}>
                        <span>{t('Release notes')}</span>
                        <a href={update.page} target="_blank" rel="noreferrer">{t('What’s new in {version}', { version: update.latest })}</a>
                      </div>
                    )}
                  </div>
                  {update.installError && (
                    <p className={`${styles.footnote} ${styles.note} error`}>
                      <Icon icon={ErrorCircle16Regular} />
                      {update.installError}
                    </p>
                  )}
                  {update.error && (
                    <p className={`${styles.footnote} ${styles.note}`}>
                      <Icon icon={Info16Regular} />
                      {update.error}
                    </p>
                  )}
                  {/* With neither a note nor an action, the line is left out rather than leaving its gap under the list. */}
                  {(updateNote(update) || ['ready', 'installing', 'available'].includes(update.state)) && <div className={styles.saveRow}>
                    <p className={styles.footnote}>{updateNote(update)}</p>
                    {update.state === 'installing' && update.waiting !== undefined ? (
                      <button type="button" onClick={() => void desktop?.update.cancel()}>{t('Cancel Update')}</button>
                    ) : update.state === 'ready' || update.state === 'installing' ? (
                      <button type="button" className="prominent" disabled={update.state === 'installing'} onClick={() => void desktop?.update.install()}>
                        {t('Update Now')}
                      </button>
                    ) : update.state === 'available' && (
                      <button type="button" className="prominent" onClick={() => void desktop?.update.check()}>{t('Download Now')}</button>
                    )}
                  </div>}
                </section>
              )}
              {current === 'models' && (
                <section className={styles.group}>
                  <Scores scores={state.modelScores!} />
                </section>
              )}
              {current === 'models' && state.peerRatings !== undefined && (
                <section className={styles.group}>
                  <div className={styles.rows}>
                    <label className={styles.row}>
                      <span>{t('Peer ratings')}</span>
                      <input type="checkbox" className="switch" checked={state.peerRatings} onChange={(event) => void setPeerRatings(event.target.checked)} />
                    </label>
                  </div>
                  {ratingsStatus && <p className={styles.footnote} role="alert">{ratingsStatus}</p>}
                </section>
              )}
              {current === 'about' && state.language !== undefined && (
                <section className={styles.group}>
                  <div className={styles.rows}>
                    <label className={styles.row}>
                      <span>{t('Language')}</span>
                      {/* Each language is named in itself, so it can be found whatever the page reads in. */}
                      <Select<Language | ''>
                        label={t('Language')}
                        value={state.language ?? ''}
                        options={[['', t('Match System')], ['en', 'English'], ['ko', '한국어']]}
                        onChange={(next) => void chooseLanguage(next || null)}
                      />
                    </label>
                  </div>
                  {/* The board switches at once; only the macOS app needs reopening, and it says so itself. */}
                  {languageStatus && <p className={styles.footnote} role="alert">{languageStatus}</p>}
                </section>
              )}
              {current === 'about' && state.progressCards !== undefined && (
                <section className={styles.group}>
                  <div className={styles.rows}>
                    <label className={`${styles.row} ${styles.described}`}>
                      <span>
                        <span id="progress-cards">{t('Progress cards in chat')}</span>
                        <small id="progress-cards-note">{t('Shows each mission step as a card in the Claude and Codex desktop apps.')}</small>
                      </span>
                      <input
                        type="checkbox"
                        className="switch"
                        aria-labelledby="progress-cards"
                        aria-describedby="progress-cards-note"
                        checked={state.progressCards}
                        onChange={(event) => void setProgressCards(event.target.checked)}
                      />
                    </label>
                  </div>
                  {cardsStatus && <p className={styles.footnote} role="alert">{cardsStatus}</p>}
                </section>
              )}
              {current === 'about' && openAtLogin !== null && (
                <section className={styles.group}>
                  <div className={styles.rows}>
                    <label className={`${styles.row} ${styles.described}`}>
                      <span>
                        <span id="open-at-login">{t('Open at Login')}</span>
                        <small id="open-at-login-note">{t('Crew starts in the tray when you sign in, so jobs stopped by a usage limit can resume with no session open.')}</small>
                      </span>
                      <input
                        type="checkbox"
                        className="switch"
                        aria-labelledby="open-at-login"
                        aria-describedby="open-at-login-note"
                        checked={openAtLogin}
                        disabled={loginSaving}
                        onChange={(event) => void changeOpenAtLogin(event.target.checked)}
                      />
                    </label>
                  </div>
                  {loginStatus && <p className={styles.footnote} role="alert">{loginStatus}</p>}
                </section>
              )}
              {project !== null && pageScope !== null && state.projects !== undefined && (
                <section className={styles.group}>
                  <div className={styles.rows}>
                    {PROJECT_SWITCHES().map(({ key, label, note }) => (
                      <label key={key} className={`${styles.row} ${styles.described}`}>
                        {/* The note is read as the switch's description rather than as part of its name, as the app's subtitle is. */}
                        <span>
                          <span id={`project-switch-${key}`}>{label}</span>
                          <small id={`project-switch-${key}-note`}>{note}</small>
                        </span>
                        <input
                          type="checkbox"
                          className="switch"
                          aria-labelledby={`project-switch-${key}`}
                          aria-describedby={`project-switch-${key}-note`}
                          checked={state.projects?.[project]?.[key] === true}
                          disabled={projectSaving || state.connection !== 'live'}
                          onChange={(event) => void setProjectSwitch(project, key, event.target.checked)}
                        />
                      </label>
                    ))}
                  </div>
                  {projectStatus?.project === project && <p className={styles.footnote} role="alert">{projectStatus.text}</p>}
                </section>
              )}
              {pageScope !== null && (
                <>
                  <p className={styles.footnote} id="instructions-hint">
                    {project === null
                      ? t('Shared with every agent in every project.')
                      : t('Shared with every agent in this project.')}
                  </p>
                  <section className={styles.group}>
                    <textarea
                      className={styles.editor}
                      id="instructions-text"
                      aria-label={t('Shared instructions')}
                      aria-describedby="instructions-hint"
                      rows={12}
                      spellCheck={false}
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                      disabled={load !== 'ready' || loadedScope !== pageScope}
                    />
                    {/* Under the editor it saves, not in a bar of its own: no other page has anything to save. */}
                    <div className={styles.saveRow}>
                      <div className={styles.status} role="status">
                        {(load === 'loading' || status) && <span className="callout secondary">{load === 'loading' ? t('Loading…') : status}</span>}
                        {dirty && <span className="unsaved">{t('Unsaved changes')}</span>}
                      </div>
                      <div className={styles.actions}>
                        {load === 'failed' && <button type="button" onClick={() => setRetry((value) => value + 1)}>{t('Retry Loading')}</button>}
                        <button type="button" className="prominent" disabled={!canSave} onClick={() => void saveInstructions()}>
                          {saving ? t('Saving…') : t('Save')}
                        </button>
                      </div>
                    </div>
                    {text.length > 9000 && (
                      <p className={`${styles.footnote} ${styles.note}`}>
                        <Icon icon={Info16Regular} />
                        {t('Too long to give lead sessions in full.')}
                      </p>
                    )}
                  </section>
                </>
              )}
            </div>
          </div>
          </section>
        </div>
      </div>
    </Dialog>
  );
}
