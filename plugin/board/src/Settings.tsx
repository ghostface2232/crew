import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronLeft, ChevronRight, FileText, Folder, Hammer, Info, ShieldCheck, SlidersHorizontal, Type } from 'lucide-react';
import type { Preset, PresetName, Snapshot } from './types.ts';
import type { JobKind, Role, RoleAssignment, RoleInfo, RoleSettings } from '../../bridge/config.ts';
import { request } from './api.ts';
import { board } from './store.ts';
import { knownProjects, projectNames, resolveDraft, rolesOf } from './model.ts';
import { AgentMark, CloseButton, Dialog, Icon } from './ui.tsx';
import styles from './Settings.module.css';

/** The app's one-line summary of a preset. */
function presetDescription(preset: Preset) {
  const agents: [string, { model?: string; effort?: string } | undefined][] = [['Codex', preset.codex], ['Antigravity', preset.antigravity]];
  return [
    ...agents.flatMap(([name, agent]) =>
      agent ? [`${name}: ${[agent.model ?? 'Agent default', agent.effort && `${agent.effort} effort`].filter(Boolean).join(' · ')}`] : []),
    `Subagents: ${preset.subagentModel ?? 'inherit'}${preset.subagentMax ? ` (up to ${preset.subagentMax})` : ''}`,
    ...(preset.maxTier ? [`Workers up to the ${preset.maxTier} tier`] : []),
  ].join('; ');
}

/** One page of settings, listed in the sidebar: the roles by kind of work, what every agent shares, then each project's own instructions. */
type Fixed = 'build' | 'review' | 'edit' | 'presets' | 'instructions';
type Pane = Fixed | `project:${string}`;
const PANES: Record<Fixed, { title: string; icon: LucideIcon; tint: string; kind?: JobKind }> = {
  build: { title: 'Build', icon: Hammer, tint: 'var(--accent)', kind: 'delegate' },
  review: { title: 'Review', icon: ShieldCheck, tint: 'var(--green)', kind: 'review' },
  edit: { title: 'Edit', icon: Type, tint: 'var(--orange)', kind: 'polish' },
  presets: { title: 'Presets', icon: SlidersHorizontal, tint: '#8e8e93' },
  instructions: { title: 'Instructions', icon: FileText, tint: '#5856d6' },
};

/** Projects share one tile, apart from the roles' colors. */
const PROJECT_TINT = '#30b0c7';

/**
 * The role table the form edits: what the user wrote, so a role left to follow its parent keeps following it.
 * A daemon without the registry sends only the resolved table, which for its three roles is the same thing.
 */
const editableRoles = (state: Snapshot): RoleSettings => structuredClone(state.roleInfo ? state.roleSettings ?? {} : state.roles);

/** Two role tables say the same when every role sets the same fields, whatever the order they were written in. */
function sameRoles(a: RoleSettings, b: RoleSettings) {
  const canonical = (table: RoleSettings) => JSON.stringify(Object.entries(table)
    .map(([role, entry]) => [role, Object.entries(entry ?? {}).filter(([, value]) => value).sort()] as const)
    .filter(([, entry]) => entry.length)
    .sort());
  return canonical(a) === canonical(b);
}

export function Settings({ state, close }: { state: Snapshot; close: () => void }) {
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
  // Opening a page on a phone moves focus to its way back, as a pushed screen does.
  useEffect(() => {
    if (view === 'page' && back.current?.offsetParent) back.current.focus();
  }, [view, pane]);
  const closeSettings = () => {
    if ((!dirty && !saving && !savingRoles && !savingPreset) || confirm('Close without saving your changes?')) close();
  };
  /**
   * A blank field is the same as one never set, so clearing it again leaves nothing behind. Back to what was saved,
   * a field is written as it was saved: a role without a parent shows the agent it resolves to when none is written.
   */
  const editRole = (role: Role, key: keyof RoleAssignment, value: string) =>
    setRoles((current) => {
      const saved = savedRoles[role]?.[key];
      const savedShown = saved ?? (key === 'agent' && !info.find((other) => other.role === role)?.parent ? state.roles[role]?.agent : undefined);
      const next = value === (savedShown ?? '') ? saved ?? '' : value;
      const { [key]: _old, ...rest } = current[role] ?? {};
      const entry = next ? { ...rest, [key]: next } : rest;
      const { [role]: _entry, ...others } = current;
      return Object.keys(entry).length ? { ...others, [role]: entry } : others;
    });
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
  const current: Pane = pane === 'presets' && !state.presets ? 'build' : pane;
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
  const canSave = state.connection === 'live' && !paneSaving && (pageScope === null || (load === 'ready' && scope === pageScope));
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
  }, [current]);
  const open = (next: Pane) => {
    const nextScope = next === 'instructions' ? '' : next.startsWith('project:') ? next.slice('project:'.length) : null;
    // Another set of instructions loads in place of the one being edited, so unsaved edits are asked about first.
    if (nextScope !== null && nextScope !== scope) {
      if (text !== saved && !confirm('Discard the unsaved changes to these instructions?')) return;
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
        <span className={styles.tile} style={{ background: page?.tint ?? PROJECT_TINT }}><Icon icon={page?.icon ?? Folder} /></span>
        <span className={styles.itemTitle}>{page?.title ?? names.get(dir!) ?? dir}</span>
        <Icon icon={ChevronRight} className={styles.chevron} />
      </button>
    );
  };
  const roleGroup = (role: RoleInfo) => {
    const own = roles[role.role] ?? {};
    const inherited = role.parent ? resolved[role.parent] : undefined;
    const following = Boolean(role.parent && !own.agent);
    const shown = resolved[role.role];
    return (
      <section className={styles.group} key={role.role} aria-label={role.label}>
        <header className={styles.groupHead}>
          <AgentMark agent={shown?.agent ?? 'codex'} size={22} />
          <div>
            <h3 className={styles.groupTitle}>{role.label}</h3>
            {state.roleInfo && <p className={styles.footnote}>{role.summary}</p>}
          </div>
        </header>
        <div className={styles.rows}>
          <label className={styles.row}>
            <span>Agent</span>
            <select aria-label={`${role.label} agent`} value={own.agent ?? (role.parent ? '' : shown?.agent ?? '')} onChange={(event) => editRole(role.role, 'agent', event.target.value)}>
              {role.parent && <option value="">Same as {info.find((other) => other.role === role.parent)?.label ?? role.parent}</option>}
              {Object.entries(state.agents).sort(([a], [b]) => a.localeCompare(b)).map(([id, agent]) => (
                <option key={id} value={id}>{agent.name}{agent.enabled ? '' : ' (disabled)'}</option>
              ))}
            </select>
          </label>
          <label className={styles.row}>
            <span>Model</span>
            <input aria-label={`${role.label} model`} value={own.model ?? ''} placeholder={(following && inherited?.model) || 'Agent default'} onChange={(event) => editRole(role.role, 'model', event.target.value)} />
          </label>
          <label className={styles.row}>
            <span>Reasoning effort</span>
            <input aria-label={`${role.label} reasoning effort`} value={own.effort ?? ''} placeholder={(following && inherited?.effort) || 'Agent default'} onChange={(event) => editRole(role.role, 'effort', event.target.value)} />
          </label>
        </div>
      </section>
    );
  };
  return (
    <Dialog labelId="settings-title" onClose={closeSettings}>
      <div className={styles.panel} data-view={view}>
        <nav className={styles.sidebar} aria-label="Settings pages">
          <header className={styles.sidebarHead}>
            <h2 className={styles.windowTitle} id="settings-title">Settings</h2>
            <span className={styles.listClose}><CloseButton label="Close settings" onClose={closeSettings} /></span>
          </header>
          <p className={styles.sectionLabel}>Roles</p>
          <div className={styles.section}>{(['build', 'review', 'edit'] as Pane[]).map(item)}</div>
          <p className={styles.sectionLabel}>Shared</p>
          <div className={styles.section}>{(state.presets ? ['presets', 'instructions'] : ['instructions'] as Pane[]).map((id) => item(id as Pane))}</div>
          {dirs.length > 0 && (
            <>
              <p className={styles.sectionLabel}>Projects</p>
              <div className={styles.section}>{dirs.map((dir) => item(`project:${dir}`))}</div>
            </>
          )}
        </nav>
        <div className={styles.detail}>
          <div className={styles.scroll} ref={scroller} onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}>
            <header className={styles.pageHead} data-scrolled={scrolled || undefined}>
              <button type="button" ref={back} className={`borderless ${styles.back}`} onClick={() => setView('list')}>
                <Icon icon={ChevronLeft} />
                Settings
              </button>
              <h2 className={styles.pageTitle}>{title}</h2>
              <span className={styles.pageClose}><CloseButton label="Close settings" onClose={closeSettings} /></span>
            </header>
            <div className={styles.body}>
              {kind && info.filter((role) => role.kind === kind).map(roleGroup)}
              {current === 'presets' && (
                <>
                  <section className={styles.group}>
                    <div className={styles.rows}>
                      <label className={styles.row}>
                        <span>Global preset</span>
                        <select aria-label="Model preset" value={preset ?? ''} onChange={(event) => setPreset((event.target.value as PresetName) || null)}>
                          <option value="">None</option>
                          <option value="economy">Economy</option>
                          <option value="balanced">Balanced</option>
                          <option value="best">Best</option>
                        </select>
                      </label>
                    </div>
                    <p className={styles.footnote}>{selectedPreset ? presetDescription(selectedPreset) : "Uses each agent's configured model and effort."}</p>
                  </section>
                  <section className={styles.group}>
                    <div className={styles.rows}>
                      <div className={styles.row}><span>A role's own model or effort</span><span className={styles.value}>Wins over any preset</span></div>
                      <div className={styles.row}><span>A mission's preset</span><span className={styles.value}>Replaces this one for its new jobs</span></div>
                    </div>
                    <p className={styles.footnote}>The lead gives a mission the preset you name for a command; you can also change it from the mission.</p>
                  </section>
                </>
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
                      className={`mono ${styles.editor}`}
                      id="instructions-text"
                      aria-label="Shared instructions"
                      aria-describedby="instructions-hint"
                      rows={12}
                      spellCheck={false}
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                      disabled={load !== 'ready' || scope !== pageScope}
                    />
                    <p className={`${styles.footnote} ${styles.file}`}>{file}</p>
                    {text.length > 9000 && (
                      <p className={`${styles.footnote} ${styles.note}`}>
                        <Icon icon={Info} />
                        Claude sessions will be pointed to this file because it is longer than 9,000 characters.
                      </p>
                    )}
                  </section>
                </>
              )}
            </div>
          </div>
          <footer className={styles.footer}>
            <div className={styles.status} role="status">
              {paneStatus && <span className="callout secondary">{paneStatus}</span>}
              {paneDirty && <span className="unsaved">Unsaved changes</span>}
            </div>
            <div className={styles.actions}>
              {pageScope !== null && load === 'failed' && (
                <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry Loading</button>
              )}
              <button type="button" className="large prominent" disabled={!canSave} onClick={() => void saveCurrent()}>
                {paneSaving ? 'Saving…' : kind ? 'Save Roles' : current === 'presets' ? 'Save Preset' : 'Save Instructions'}
              </button>
            </div>
          </footer>
        </div>
      </div>
    </Dialog>
  );
}
