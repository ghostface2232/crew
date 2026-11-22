import { Fragment, useEffect, useRef, useState } from 'react';
import {
  ChevronLeftRegular, ChevronRightRegular, DocumentText16Regular, Folder16Regular, Gauge16Regular, Info16Regular,
  Options16Regular, ShieldCheckmark16Regular, TextFont16Regular, Wrench16Regular,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import type { AppUpdate, Preset, PresetName, Snapshot } from './types.ts';
import type { AgentSettings, Holder, JobKind, Role, RoleAssignment, RoleInfo, RoleSettings, WorkerAgent } from '../../bridge/config.ts';
import { formatDate, timeOfDay } from './dates.ts';
import { request } from './api.ts';
import { board } from './store.ts';
import { agentSettings, HOLDERS, knownProjects, NAMES, projectNames, resolveDraft, rolesOf, sortHolders } from './model.ts';
import { AgentMark, ask, CloseButton, Dialog, Icon, Select, useFade } from './ui.tsx';
import { Scores } from './Scores.tsx';
import { desktop } from './desktop.ts';
import appIcon from './icons/CrewAppIcon.png';
import styles from './Settings.module.css';

/** The app's one-line summary of a preset. */
/** A sidebar item's name, fading at its end when it is too long for the sidebar. */
function ItemTitle({ text, current }: { text: string; current: boolean }) {
  const fade = useFade<HTMLSpanElement>(text, current);
  return <span className={`${styles.itemTitle} fade-line`} ref={fade}>{text}</span>;
}

const PRESET_SUMMARY: Record<PresetName, string> = {
  economy: 'Lower cost and faster runs for straightforward tasks.',
  balanced: 'Everyday balance of quality, speed, and cost.',
  best: 'Maximum reasoning depth for complex work.',
};

function formatModelName(name: string) {
  if (name === 'inherit') return 'Same as lead';
  return /[-./]/.test(name) ? name : name.charAt(0).toUpperCase() + name.slice(1);
}

/** Structured rows for the Model Presets settings page. */
function presetDetails(preset: Preset): [string, string][] {
  const agents: [string, { model?: string; effort?: string } | undefined][] = [['Codex', preset.codex], ['Antigravity', preset.antigravity]];
  const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
  const subagent = formatModelName(preset.subagentModel ?? 'inherit');
  return [
    ...agents.flatMap(([name, agent]): [string, string][] =>
      agent ? [[name, [agent.model ?? 'Default model', agent.effort && `${cap(agent.effort)} effort`].filter(Boolean).join(' · ')]] : []),
    ['Subagents', preset.subagentMax ? `${subagent} (max ${formatModelName(preset.subagentMax)})` : subagent],
    ...(preset.maxTier ? [['Worker cap', `Up to ${cap(preset.maxTier)} tier`] as [string, string]] : []),
  ];
}

/** One page of settings, listed in the sidebar: the roles by kind of work, what every agent shares, each project's own instructions, then the desktop app. */
type Fixed = 'build' | 'review' | 'edit' | 'presets' | 'models' | 'instructions' | 'about';
type Pane = Fixed | `project:${string}`;
const PANES: Record<Fixed, { title: string; icon: FluentIcon; tint: string; kind?: JobKind }> = {
  build: { title: 'Build', icon: Wrench16Regular, tint: 'var(--accent)', kind: 'delegate' },
  review: { title: 'Review', icon: ShieldCheckmark16Regular, tint: 'var(--green)', kind: 'review' },
  edit: { title: 'Edit', icon: TextFont16Regular, tint: 'var(--orange)', kind: 'polish' },
  presets: { title: 'Model Presets', icon: Options16Regular, tint: 'var(--gray)' },
  models: { title: 'Model Scores', icon: Gauge16Regular, tint: 'var(--purple)' },
  instructions: { title: 'Instructions', icon: DocumentText16Regular, tint: 'var(--indigo)' },
  about: { title: 'About Crew', icon: Info16Regular, tint: 'var(--gray)' },
};

/** Where the desktop app's update stands, in one line. */
function updateSummary(update: AppUpdate) {
  const checked = update.checkedAt
    ? `Last checked at ${formatDate(timeOfDay, new Date(update.checkedAt))}`
    : 'Not checked yet';
  switch (update.state) {
    case 'unsupported': return 'Updates come with the installed app';
    case 'idle': return update.checkedAt && !update.error ? 'Crew is up to date' : checked;
    case 'checking': return 'Checking for updates…';
    case 'available': return `Version ${update.latest} is available`;
    case 'downloading': return `Downloading version ${update.latest}… ${Math.round((update.progress ?? 0) * 100)}%`;
    case 'ready': return `Version ${update.latest} is ready to install`;
    case 'installing': return update.waiting
      ? `Version ${update.latest} will install when ${update.waiting} running job${update.waiting === 1 ? '' : 's'} finish${update.waiting === 1 ? 'es' : ''}`
      : update.waiting === 0 ? `Version ${update.latest} will install once the Crew daemon answers`
      : `Restarting to install version ${update.latest}…`;
  }
}

/** Fixing review findings sits with the reviews it answers, though it runs as a build job. */
const paneKind = (role: RoleInfo): JobKind => (role.role === 'fix' ? 'review' : role.kind);

/** Projects share one tile, apart from the roles' colors. */
const PROJECT_TINT = 'var(--teal)';

/**
 * The role table the form edits: what the user wrote, so a role left to follow its parent keeps following it.
 * A daemon without the registry sends only the resolved table, which for its three roles is the same thing.
 */
const editableRoles = (state: Snapshot): RoleSettings => structuredClone(state.roleInfo ? state.roleSettings ?? {} : state.roles);

/** A role's entry as the daemon would store it: holders in order, blank fields and empty settings left out. */
function cleanEntry(entry: Partial<RoleAssignment> = {}): Partial<RoleAssignment> {
  const clean: Partial<RoleAssignment> = entry.agents ? { agents: sortHolders(entry.agents) } : {};
  for (const agent of ['codex', 'antigravity'] as const) {
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

export function Settings({ state, update, close }: { state: Snapshot; update: AppUpdate | null; close: () => void }) {
  const [pane, setPane] = useState<Pane>('build');
  // On a phone the sidebar is a list of its own, and a page replaces it; wider, both show.
  const [view, setView] = useState<'list' | 'page'>('list');
  const back = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // The title's blur shows only once the page has scrolled under it.
  const [scrolled, setScrolled] = useState(false);
  const [roles, setRoles] = useState<RoleSettings>(() => editableRoles(state));
  const [savedRoles, setSavedRoles] = useState<RoleSettings>(() => editableRoles(state));
  const info = rolesOf(state);
  const resolved = resolveDraft(info, roles, state.roles);
  const [roleStatus, setRoleStatus] = useState('');
  const [savingRoles, setSavingRoles] = useState(false);
  const roleLock = useRef(false);
  const [preset, setPreset] = useState<PresetName | null>(state.preset ?? null);
  const [savedPreset, setSavedPreset] = useState(preset);
  const [presetStatus, setPresetStatus] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);
  const presetLock = useRef(false);
  const selectedPreset = preset ? state.presets?.[preset] : undefined;
  const [scope, setScope] = useState('');
  // Whose instructions the editor holds; until a newly chosen set arrives, it still holds the previous one.
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [file, setFile] = useState('');
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const saveLock = useRef(false);
  const rolesDirty = !sameRoles(roles, savedRoles);
  const dirty = text !== saved || rolesDirty || preset !== savedPreset;
  const dirs = knownProjects(state);
  const names = projectNames(dirs);
  useEffect(() => {
    const attempt = ++generation.current;
    const abort = new AbortController();
    setLoad('loading');
    setStatus('');
    setSaving(false);
    saveLock.current = false;
    void request<{ file: string; text: string }>(
      `/api/instructions${scope ? `?project=${encodeURIComponent(scope)}` : ''}`,
      undefined,
      abort.signal,
    ).then(
      (result) => {
        if (attempt !== generation.current) return;
        setText(result.text);
        setSaved(result.text);
        setFile(result.file);
        setLoadedScope(scope);
        setLoad('ready');
      },
      (error: Error) => {
        if (abort.signal.aborted || attempt !== generation.current) return;
        setText('');
        setSaved('');
        setFile('');
        setLoad('failed');
        setStatus(`Could not load instructions: ${error.message}`);
      },
    );
    return () => {
      generation.current++;
      abort.abort();
    };
  }, [scope, retry]);
  useEffect(() => {
    if (!dirty && !saving && !savingRoles && !savingPreset) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty, saving, savingRoles, savingPreset]);
  // On a phone, opening a page moves focus to its way back, as a pushed screen does, and going back returns it to the page's row.
  const nav = useRef<HTMLElement>(null);
  const pushed = useRef(false);
  useEffect(() => {
    if (view === 'page') {
      pushed.current = true;
      if (back.current?.offsetParent) back.current.focus();
    } else if (pushed.current) nav.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
  }, [view, pane]);
  const closeSettings = async () => {
    if ((!dirty && !saving && !savingRoles && !savingPreset) || await ask('Close without saving your changes?', 'Close')) close();
  };
  /** Replaces a role's entry in the draft, dropping it when nothing is left. */
  const setEntry = (role: Role, change: (own: Partial<RoleAssignment>) => Partial<RoleAssignment>) =>
    setRoles((current) => {
      const entry = cleanEntry(change({ ...current[role] }));
      const { [role]: _entry, ...others } = current;
      return Object.keys(entry).length ? { ...others, [role]: entry } : others;
    });
  /**
   * Turns a holder on or off; a role keeps at least one. A role without a parent that comes back to the holders it
   * resolves to unwritten writes none, as it was saved.
   */
  const toggleHolder = (role: RoleInfo, holder: Holder) =>
    setEntry(role.role, (own) => {
      const shown = resolved[role.role]?.agents ?? [];
      const next = shown.includes(holder) ? shown.filter((other) => other !== holder) : sortHolders([...shown, holder]);
      if (!next.length) return own;
      // Off, an agent's settings go; back on, they come back as saved.
      if (holder !== 'claude') {
        if (next.includes(holder)) own[holder] ??= savedRoles[role.role]?.[holder];
        else delete own[holder];
      }
      const unwritten = !role.parent && !savedRoles[role.role]?.agents ? state.roles[role.role]?.agents : undefined;
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
  const editSetting = (role: Role, agent: WorkerAgent, key: keyof AgentSettings, value: string) =>
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
  const savePreset = async () => {
    if (presetLock.current) return;
    presetLock.current = true;
    setSavingPreset(true);
    setPresetStatus('Saving…');
    const submitted = preset;
    try {
      const result = await request<Pick<Snapshot, 'preset' | 'presets'>>('/api/preset', { preset: submitted });
      setPreset((current) => (current === submitted ? result.preset ?? null : current));
      setSavedPreset(result.preset ?? null);
      board.receive('preset', result);
      setPresetStatus('Saved');
    } catch (error) {
      setPresetStatus((error as Error).message);
    } finally {
      presetLock.current = false;
      setSavingPreset(false);
    }
  };
  const saveRoles = async () => {
    if (roleLock.current) return;
    roleLock.current = true;
    setSavingRoles(true);
    setRoleStatus('Saving…');
    const submitted = roles;
    try {
      const result = await request<{ roles?: Snapshot['roles']; roleSettings?: RoleSettings }>('/api/roles', { roles });
      if (result.roleSettings && result.roles) {
        // The form shows what was stored, unless it was edited meanwhile.
        setRoles((current) => (sameRoles(current, submitted) ? structuredClone(result.roleSettings!) : current));
        setSavedRoles(result.roleSettings);
        board.receive('roles', result.roles);
        board.receive('roleSettings', result.roleSettings);
      } else setSavedRoles(submitted);
      setRoleStatus('Saved');
    } catch (error) {
      setRoleStatus((error as Error).message);
    } finally {
      roleLock.current = false;
      setSavingRoles(false);
    }
  };
  const saveInstructions = async () => {
    if (saveLock.current || load !== 'ready') return;
    saveLock.current = true;
    setSaving(true);
    setStatus('Saving…');
    const attempt = generation.current;
    const draft = text;
    try {
      const result = await request<{ file: string; text: string }>('/api/instructions', {
        project: scope || null,
        text: draft,
      });
      if (attempt !== generation.current) return;
      setText((current) => (current === draft ? result.text : current));
      setSaved(result.text);
      setFile(result.file);
      setStatus('Saved');
    } catch (error) {
      if (attempt === generation.current) setStatus((error as Error).message);
    } finally {
      if (attempt === generation.current) {
        saveLock.current = false;
        setSaving(false);
      }
    }
  };
  // A daemon without presets or notes has no page for them.
  const current: Pane =
    (pane === 'presets' && !state.presets) || (pane === 'models' && !state.modelScores) || (pane === 'about' && !update) ? 'build' : pane;
  const project = current.startsWith('project:') ? current.slice('project:'.length) : null;
  const fixed = project === null ? PANES[current as Fixed] : undefined;
  const kind = fixed?.kind;
  // The instructions this page edits: '' for every project, a project's own; null on the other pages.
  const pageScope = current === 'instructions' ? '' : project;
  const title = project === null ? fixed!.title : names.get(project) ?? project;
  // The three roles pages edit one table, so they share one save.
  const paneSaving = kind ? savingRoles : current === 'presets' ? savingPreset : saving;
  const paneDirty = kind ? rolesDirty : current === 'presets' ? preset !== savedPreset : text !== saved;
  const paneStatus = kind ? roleStatus : current === 'presets' ? presetStatus : load === 'loading' ? 'Loading…' : status;
  const readOnly = current === 'models' || current === 'about';
  const canSave = !readOnly && state.connection === 'live' && !paneSaving && (pageScope === null || (load === 'ready' && loadedScope === pageScope));
  const saveCurrent = async () => {
    if (!canSave) return;
    if (kind) await saveRoles();
    else if (current === 'presets') await savePreset();
    else await saveInstructions();
  };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !event.altKey) {
        event.preventDefault();
        // Not while a question is open over Settings, such as whether to close without saving.
        if (event.target instanceof Element && event.target.closest('dialog.ask')) return;
        void saveCurrent();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  });
  // Each page opens at its top.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setScrolled(false);
  }, [current, view]);
  const open = async (next: Pane) => {
    const nextScope = next === 'instructions' ? '' : next.startsWith('project:') ? next.slice('project:'.length) : null;
    // Another set of instructions loads in place of the one being edited, so unsaved edits are asked about first.
    if (nextScope !== null && nextScope !== scope) {
      if (text !== saved && !(await ask('Discard the unsaved changes to these instructions?', 'Discard'))) return;
      // Discarded now, not when the next set arrives: nothing is left to ask about meanwhile.
      setText(saved);
      setScope(nextScope);
    }
    setPane(next);
    setView('page');
  };
  const item = (id: Pane) => {
    const dir = id.startsWith('project:') ? id.slice('project:'.length) : null;
    const page = dir === null ? PANES[id as Fixed] : undefined;
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
        <span className={styles.tile} style={{ background: page?.tint ?? PROJECT_TINT }}><Icon icon={page?.icon ?? Folder16Regular} /></span>
        <ItemTitle text={page?.title ?? names.get(dir!) ?? dir!} current={current === id} />
        <Icon icon={ChevronRightRegular} className={styles.chevron} />
      </button>
    );
  };
  // An older daemon may not know every agent; Claude is always one.
  const holders = HOLDERS.filter((holder) => holder === 'claude' || holder in state.agents);
  const models = (agent: WorkerAgent) => state.agents[agent]?.models ?? [];
  const holderLabel = (holder: Holder) => holder === 'claude' ? 'Claude (the lead)' : `${state.agents[holder].name}${state.agents[holder].enabled ? '' : ' (disabled)'}`;
  const roleGroup = (role: RoleInfo) => {
    const own = roles[role.role] ?? {};
    const parentLabel = info.find((other) => other.role === role.parent)?.label ?? role.parent;
    const following = Boolean(role.parent && !own.agents);
    const shown = resolved[role.role];
    // What a field means when left blank: the parent's setting for that agent while the role follows it.
    const inherited = (agent: WorkerAgent, key: keyof AgentSettings) => (following ? resolved[role.parent!]?.[agent]?.[key] : undefined);
    const blank = (agent: WorkerAgent, key: keyof AgentSettings) => {
      const value = inherited(agent, key);
      return value ? `${models(agent).find((model) => model.id === value)?.name ?? value} (same as ${parentLabel})` : 'Agent default';
    };
    /**
     * A model or effort picked from what the agent offers, or typed when the daemon offers nothing. A value written by
     * hand that is not offered stays a choice, so opening the settings never changes it.
     */
    const field = (agent: WorkerAgent, key: keyof AgentSettings) => {
      const label = `${role.label} ${NAMES[agent]} ${key === 'model' ? 'model' : 'reasoning effort'}`;
      const value = own[agent]?.[key] ?? '';
      const change = (next: string) => editSetting(role.role, agent, key, next);
      const offered = models(agent);
      if (!offered.length) return <input aria-label={label} value={value} placeholder={blank(agent, key)} onChange={(event) => change(event.target.value)} />;
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
    const workers = (shown?.agents ?? []).filter((holder): holder is WorkerAgent => holder !== 'claude' && holder in state.agents);
    return (
      <section className={styles.group} key={role.role} aria-label={role.label}>
        <header className={styles.groupHead}>
          <AgentMark agent={shown?.agents[0] ?? 'codex'} size={22} />
          <div>
            <h3 className={styles.groupTitle}>{role.label}</h3>
            {state.roleInfo && <p className={styles.footnote}>{role.summary}</p>}
          </div>
        </header>
        <div className={styles.rows}>
          {role.parent && (
            <label className={styles.row}>
              <span>Same as {parentLabel}</span>
              <input type="checkbox" className="switch" checked={following} onChange={(event) => follow(role, event.target.checked)} />
            </label>
          )}
          <div className={styles.row}>
            <span id={`${role.role}-agents`}>Agents</span>
            <span className={styles.checks} role="group" aria-labelledby={`${role.role}-agents`}>
              {holders.map((holder) => {
                const held = shown?.agents.includes(holder) ?? false;
                // An agent that cannot do the role's work is not offered, though one already held can be turned off.
                const unable = holder !== 'claude' && Boolean(role.unable?.includes(holder));
                return (
                  <label key={holder} className={styles.check}>
                    <input
                      type="checkbox"
                      aria-label={`${role.label}: ${holderLabel(holder)}`}
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
                <span>{NAMES[agent]} model</span>
                {field(agent, 'model')}
              </label>
              <label className={styles.row}>
                <span>{NAMES[agent]} reasoning effort</span>
                {field(agent, 'effort')}
              </label>
            </Fragment>
          ))}
        </div>
      </section>
    );
  };
  return (
    <Dialog labelId="settings-title" onClose={closeSettings}>
      <div className={styles.panel} data-view={view}>
        <nav className={styles.sidebar} aria-label="Settings pages" ref={nav}>
          <header className={styles.sidebarHead}>
            <h2 className={styles.windowTitle} id="settings-title">Settings</h2>
            <span className={styles.listClose}><CloseButton label="Close settings" onClose={closeSettings} /></span>
          </header>
          <p className={styles.sectionLabel}>Roles</p>
          <div className={styles.section}>{(['build', 'review', 'edit'] as Pane[]).map(item)}</div>
          <p className={styles.sectionLabel}>Shared</p>
          <div className={styles.section}>
            {([...(state.presets ? ['presets'] : []), ...(state.modelScores ? ['models'] : []), 'instructions'] as Pane[]).map(item)}
          </div>
          {dirs.length > 0 && (
            <>
              <p className={styles.sectionLabel}>Projects</p>
              <div className={styles.section}>{dirs.map((dir) => item(`project:${dir}`))}</div>
            </>
          )}
          {update && (
            <>
              <p className={styles.sectionLabel}>App</p>
              <div className={styles.section}>{item('about')}</div>
            </>
          )}
        </nav>
        <div className={styles.detail}>
          <div className={styles.scroll} ref={scroller} onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}>
            <header className={styles.pageHead} data-scrolled={scrolled || undefined}>
              <button type="button" ref={back} className={`borderless ${styles.back}`} onClick={() => setView('list')}>
                <Icon icon={ChevronLeftRegular} />
                Settings
              </button>
              <h2 className={styles.pageTitle}>{title}</h2>
              <span className={styles.pageClose}><CloseButton label="Close settings" onClose={closeSettings} /></span>
            </header>
            <div className={styles.body}>
              {kind && info.filter((role) => paneKind(role) === kind).map(roleGroup)}
              {kind && (
                <p className={styles.footnote}>
                  The lead picks the holder; by default, Antigravity takes wording and Codex the rest, among holders that can.
                  Claude means the lead does it itself.
                </p>
              )}
              {current === 'presets' && (
                <>
                  <section className={styles.group}>
                    <div className={styles.rows}>
                      <label className={styles.row}>
                        <span>Default</span>
                        <Select<PresetName | ''>
                          label="Model preset"
                          value={preset ?? ''}
                          options={[['', 'None'], ['economy', 'Economy'], ['balanced', 'Balanced'], ['best', 'Best']]}
                          onChange={(next) => setPreset(next || null)}
                        />
                      </label>
                      {selectedPreset && presetDetails(selectedPreset).map(([label, value]) => (
                        <div className={styles.row} key={label}><span>{label}</span><span className={styles.value}>{value}</span></div>
                      ))}
                    </div>
                    <p className={styles.footnote}>{preset ? PRESET_SUMMARY[preset] : "Uses each agent's own model and effort settings."}</p>
                  </section>
                  <section className={styles.group}>
                    <header className={styles.groupHead}><h3 className={styles.groupTitle}>Priority</h3></header>
                    <div className={styles.rows}>
                      <div className={styles.row}><span>Role settings</span><span className={styles.value}>Override any preset</span></div>
                      <div className={styles.row}><span>Mission preset</span><span className={styles.value}>Overrides default for new jobs</span></div>
                    </div>
                    <p className={styles.footnote}>Change a mission's preset from its menu, or name one in your prompt.</p>
                  </section>
                </>
              )}
              {current === 'about' && update && (
                <>
                  <section className={styles.about}>
                    <img className={styles.aboutIcon} src={appIcon} alt="" />
                    <div>
                      <p className={styles.aboutName}>Crew</p>
                      <p className={styles.footnote}>Version {update.current}</p>
                    </div>
                  </section>
                  <section className={styles.group}>
                    <div className={styles.rows}>
                      <div className={styles.row}>
                        <span className={styles.updateLine} role="status">{updateSummary(update)}</span>
                        {update.state === 'installing' && update.waiting !== undefined ? (
                          <button type="button" className="small" onClick={() => void desktop?.update.cancel()}>Cancel Update</button>
                        ) : update.state === 'ready' || update.state === 'installing' ? (
                          <button type="button" className="prominent small" disabled={update.state === 'installing'} onClick={() => void desktop?.update.install()}>
                            Restart to Update
                          </button>
                        ) : update.state !== 'unsupported' && update.state !== 'downloading' && (
                          <button
                            type="button"
                            className="small"
                            disabled={update.state === 'checking'}
                            onClick={() => void desktop?.update.check()}
                          >
                            {update.state === 'available' ? 'Download Now' : 'Check for Updates'}
                          </button>
                        )}
                      </div>
                      {update.state === 'downloading' && (
                        <div className={styles.row}>
                          <progress className={styles.progress} value={update.progress ?? 0} max={1} aria-label="Download progress" />
                        </div>
                      )}
                      {update.page && update.latest && (
                        <div className={styles.row}>
                          <span>Release notes</span>
                          <a href={update.page} target="_blank" rel="noreferrer">What’s new in {update.latest}</a>
                        </div>
                      )}
                    </div>
                    {update.error && (
                      <p className={`${styles.footnote} ${styles.note}`}>
                        <Icon icon={Info16Regular} />
                        {update.error}
                      </p>
                    )}
                    <p className={styles.footnote}>
                      {update.state === 'unsupported'
                        ? 'This copy cannot update itself. Install Crew from GitHub releases for updates.'
                        : 'Updates download in the background and install only on Restart to Update, after running jobs finish.'}
                    </p>
                  </section>
                </>
              )}
              {current === 'models' && (
                <section className={styles.group}>
                  <Scores scores={state.modelScores!} />
                  <p className={styles.footnote}>
                    Scored from review findings per build size, with fixes scored apart. A model is ranked after three build
                    reviews; a review by its own agent counts half.
                  </p>
                </section>
              )}
              {current === 'models' && state.peerRatings !== undefined && (
                <section className={styles.group}>
                  <div className={styles.rows}>
                    <label className={styles.row}>
                      <span>Peer ratings</span>
                      <input type="checkbox" className="switch" checked={state.peerRatings} onChange={(event) => void setPeerRatings(event.target.checked)} />
                    </label>
                  </div>
                  <p className={styles.footnote} role={ratingsStatus ? 'alert' : undefined}>
                    {ratingsStatus || 'The lead and the workers rate each other\'s work as they see it, in turns they already have, and the ratings move half of a score from where the review findings put it. Off, nobody is asked to rate and the scores come from the review findings alone; ratings already given are kept.'}
                  </p>
                </section>
              )}
              {pageScope !== null && (
                <>
                  <p className={styles.footnote} id="instructions-hint">
                    {project === null
                      ? 'Given to every agent with its next job, in every project, and to Claude sessions when they start.'
                      : 'Given to every agent working in this project, after the instructions for every project.'}
                  </p>
                  <section className={styles.group}>
                    <textarea
                      className={styles.editor}
                      id="instructions-text"
                      aria-label="Shared instructions"
                      aria-describedby="instructions-hint"
                      rows={12}
                      spellCheck={false}
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                      disabled={load !== 'ready' || loadedScope !== pageScope}
                    />
                    <p className={`${styles.footnote} ${styles.file}`}>{file}</p>
                    {text.length > 9000 && (
                      <p className={`${styles.footnote} ${styles.note}`}>
                        <Icon icon={Info16Regular} />
                        Claude sessions will be pointed to this file because it is longer than 9,000 characters.
                      </p>
                    )}
                  </section>
                </>
              )}
            </div>
          </div>
          {!readOnly && <footer className={styles.footer}>
            <div className={styles.status} role="status">
              {paneStatus && <span className="callout secondary">{paneStatus}</span>}
              {paneDirty && <span className="unsaved">Unsaved changes</span>}
            </div>
            <div className={styles.actions}>
              {pageScope !== null && load === 'failed' && (
                <button type="button" className="large" onClick={() => setRetry((value) => value + 1)}>Retry Loading</button>
              )}
              <button type="button" className="large prominent" disabled={!canSave} onClick={() => void saveCurrent()}>
                {paneSaving ? 'Saving…' : kind ? 'Save Roles' : current === 'presets' ? 'Save Preset' : 'Save Instructions'}
              </button>
            </div>
          </footer>}
        </div>
      </div>
    </Dialog>
  );
}
