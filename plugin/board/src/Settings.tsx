import { useEffect, useRef, useState } from 'react';
import { Info, SlidersHorizontal } from 'lucide-react';
import type { Preset, PresetName, Snapshot } from './types.ts';
import type { JobKind, Role, RoleAssignment, RoleSettings } from '../../bridge/config.ts';
import { request } from './api.ts';
import { board } from './store.ts';
import { knownProjects, projectNames, resolveDraft, rolesOf } from './model.ts';
import { AgentMark, CloseButton, Dialog, Icon, Segmented } from './ui.tsx';
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
const ROLE_GROUPS: [JobKind, string][] = [['delegate', 'Build'], ['review', 'Review'], ['polish', 'Edit']];

/**
 * The role table the form edits: what the user wrote, so a role left to follow its parent keeps following it.
 * A daemon without the registry sends only the resolved table, which for its three roles is the same thing.
 */
const editableRoles = (state: Snapshot): RoleSettings => structuredClone(state.roleInfo ? state.roleSettings ?? {} : state.roles);

export function Settings({ state, close }: { state: Snapshot; close: () => void }) {
  const [tab, setTab] = useState('roles');
  const [roles, setRoles] = useState<RoleSettings>(() => editableRoles(state));
  const [savedRoles, setSavedRoles] = useState(() => JSON.stringify(editableRoles(state)));
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
  const dirty = text !== saved || JSON.stringify(roles) !== savedRoles || preset !== savedPreset;
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
  const closeSettings = () => {
    if ((!dirty && !saving && !savingRoles && !savingPreset) || confirm('Close without saving your changes?')) close();
  };
  const editRole = (role: Role, key: keyof RoleAssignment, value: string) =>
    setRoles((current) => ({ ...current, [role]: { ...current[role], [key]: value } as Partial<RoleAssignment> }));
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
    const submitted = JSON.stringify(roles);
    try {
      const result = await request<{ roles?: Snapshot['roles']; roleSettings?: RoleSettings }>('/api/roles', { roles });
      if (result.roleSettings && result.roles) {
        // Blank fields come back dropped; the form shows what was stored, unless it was edited meanwhile.
        const stored = JSON.stringify(result.roleSettings);
        setRoles((current) => (JSON.stringify(current) === submitted ? structuredClone(result.roleSettings!) : current));
        setSavedRoles(stored);
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
  const currentTab = tab === 'presets' && !state.presets ? 'roles' : tab;
  const tabSaving = currentTab === 'roles' ? savingRoles : currentTab === 'presets' ? savingPreset : saving;
  const tabDirty = currentTab === 'roles' ? JSON.stringify(roles) !== savedRoles
    : currentTab === 'presets' ? preset !== savedPreset : text !== saved;
  const tabStatus = currentTab === 'roles' ? roleStatus : currentTab === 'presets' ? presetStatus
    : load === 'loading' ? 'Loading…' : status;
  const canSave = state.connection === 'live' && !tabSaving && (currentTab !== 'instructions' || load === 'ready');
  const saveCurrent = async () => {
    if (!canSave) return;
    if (currentTab === 'roles') await saveRoles();
    else if (currentTab === 'presets') await savePreset();
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
  return (
    <Dialog labelId="settings-title" onClose={closeSettings}>
      <div className={styles.panel}>
        <header className={`sheet-head ${styles.header}`}>
          <h2 className="window-title" id="settings-title">Settings</h2>
          <Segmented
            label="Settings section"
            value={currentTab}
            options={[
              ['roles', 'Roles'],
              ['instructions', 'Instructions'],
              ...(state.presets ? [['presets', 'Presets'] as [string, string]] : []),
            ]}
            onChange={setTab}
          />
          <CloseButton label="Close settings" onClose={closeSettings} />
        </header>
        <div className={styles.content}>
          {currentTab === 'roles' && (
            <div className={styles.roles}>
              {ROLE_GROUPS.map(([kind, group]) => (
                <section className={styles.group} key={kind} aria-label={group}>
                  {state.roleInfo && <h3 className="section-title">{group}</h3>}
                  {info.filter((role) => role.kind === kind).map(({ role, label, summary, parent }) => {
                    const own = roles[role] ?? {};
                    const inherited = parent ? resolved[parent] : undefined;
                    const following = Boolean(parent && !own.agent);
                    const shown = resolved[role];
                    return (
                      <section className={`card ${styles.role}`} key={role} aria-label={label}>
                        <div className={styles.roleHeader}>
                          <AgentMark agent={shown?.agent ?? 'codex'} size={23} />
                          <div className={styles.roleTitle}>
                            <h3 className="card-title">{label}</h3>
                            {state.roleInfo && <p className="caption secondary">{summary}</p>}
                          </div>
                          <select
                            aria-label={`${label} agent`}
                            value={own.agent ?? (parent ? '' : shown?.agent ?? '')}
                            onChange={(event) => editRole(role, 'agent', event.target.value)}
                          >
                            {parent && <option value="">Same as {info.find((other) => other.role === parent)?.label ?? parent}</option>}
                            {Object.entries(state.agents).sort(([a], [b]) => a.localeCompare(b)).map(([id, agent]) => (
                              <option key={id} value={id}>
                                {agent.name}{agent.enabled ? '' : ' (disabled)'}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className={styles.roleFields}>
                          <label className="field">
                            <span>Model</span>
                            <input
                              aria-label={`${label} model`}
                              value={own.model ?? ''}
                              placeholder={(following && inherited?.model) || 'Agent default'}
                              onChange={(event) => editRole(role, 'model', event.target.value)}
                            />
                          </label>
                          <label className="field">
                            <span>Reasoning effort</span>
                            <input
                              aria-label={`${label} reasoning effort`}
                              value={own.effort ?? ''}
                              placeholder={(following && inherited?.effort) || 'Agent default'}
                              onChange={(event) => editRole(role, 'effort', event.target.value)}
                            />
                          </label>
                        </div>
                      </section>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
          {currentTab === 'presets' && (
            <div className={styles.presets}>
              <section className={`card ${styles.role}`}>
                <div className={styles.roleHeader}>
                  <Icon icon={SlidersHorizontal} size={18} />
                  <h3 className="card-title">Model preset</h3>
                  <select aria-label="Model preset" value={preset ?? ''} onChange={(event) => setPreset((event.target.value as PresetName) || null)}>
                    <option value="">None</option>
                    <option value="economy">Economy</option>
                    <option value="balanced">Balanced</option>
                    <option value="best">Best</option>
                  </select>
                </div>
                <p className="callout secondary">
                  {selectedPreset ? presetDescription(selectedPreset) : "Uses each agent's configured model and effort."}
                </p>
                <p className="caption tertiary">A model or effort set on a role overrides the preset. A mission can run under its own preset instead, when you name one for the command or set it on the mission.</p>
              </section>
            </div>
          )}
          {currentTab === 'instructions' && (
            <section className={styles.instructions} aria-labelledby="instructions-title">
              <div className={styles.instructionsHeader}>
                <h3 className="section-title" id="instructions-title">Shared instructions</h3>
                <label className={`field ${styles.scope}`}>
                  <span>Applies to</span>
                  <select
                    value={scope}
                    disabled={saving}
                    onChange={(event) => {
                      if (text !== saved && !confirm('Discard the unsaved changes to these instructions?')) return;
                      setScope(event.target.value);
                    }}
                  >
                    <option value="">Every project</option>
                    {dirs.map((dir) => <option key={dir} value={dir}>{names.get(dir)}</option>)}
                  </select>
                </label>
              </div>
              <p className="callout secondary" id="instructions-hint">
                Given to every agent with its next job and to Claude sessions when they start.
              </p>
              <textarea
                className={`mono ${styles.editor}`}
                id="instructions-text"
                aria-label="Shared instructions"
                aria-describedby="instructions-hint"
                rows={12}
                spellCheck={false}
                value={text}
                onChange={(event) => setText(event.target.value)}
                disabled={load !== 'ready'}
              />
              <p className={`caption secondary ${styles.file}`}>{file}</p>
              {text.length > 9000 && (
                <p className={`callout secondary ${styles.note}`}>
                  <Icon icon={Info} />
                  Claude sessions will be pointed to this file because it is longer than 9,000 characters.
                </p>
              )}
            </section>
          )}
        </div>
        <footer className={styles.footer}>
          <div className={styles.status} role="status">
            {tabStatus && <span className="callout secondary">{tabStatus}</span>}
            {tabDirty && <span className="unsaved">Unsaved changes</span>}
          </div>
          <div className={styles.actions}>
            {currentTab === 'instructions' && load === 'failed' && (
              <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry Loading</button>
            )}
            <button type="button" className="large prominent" disabled={!canSave} onClick={() => void saveCurrent()}>
              {tabSaving ? 'Saving…' : currentTab === 'roles' ? 'Save Roles'
                : currentTab === 'presets' ? 'Save Preset' : 'Save Instructions'}
            </button>
          </div>
        </footer>
      </div>
    </Dialog>
  );
}
