import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import type { Preset, PresetName, Roles, Snapshot } from './types.ts';
import type { Role, RoleAssignment } from '../../bridge/config.ts';
import { request } from './api.ts';
import { board } from './store.ts';
import { knownProjects, projectNames, ROLE_NAMES } from './model.ts';
import { AgentMark, CloseButton, Dialog, Icon, Segmented } from './ui.tsx';
import styles from './Settings.module.css';

/** The app's one-line summary of a preset. */
function presetDescription(preset: Preset) {
  const agents: [string, { model?: string; effort?: string } | undefined][] = [['Codex', preset.codex], ['Antigravity', preset.antigravity]];
  return [
    ...agents.flatMap(([name, agent]) =>
      agent ? [`${name}: ${[agent.model ?? 'Agent default', agent.effort && `${agent.effort} effort`].filter(Boolean).join(' · ')}`] : []),
    `Subagents: ${preset.subagentModel ?? 'inherit'}`,
  ].join('; ');
}
export function Settings({ state, close }: { state: Snapshot; close: () => void }) {
  const [tab, setTab] = useState('roles');
  const [roles, setRoles] = useState<Roles>(() => structuredClone(state.roles));
  const [savedRoles, setSavedRoles] = useState(() => JSON.stringify(state.roles));
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
    setRoles((current) => ({ ...current, [role]: { ...current[role], [key]: value } }));
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
      await request('/api/roles', { roles });
      setSavedRoles(submitted);
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
          <h2 className="title" id="settings-title">Settings</h2>
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
              {(Object.keys(ROLE_NAMES) as Role[]).map((role) => (
                <section className={`card ${styles.role}`} key={role} aria-label={ROLE_NAMES[role]}>
                  <div className={styles.roleHeader}>
                    <AgentMark agent={roles[role]?.agent ?? 'codex'} size={23} />
                    <h3 className="card-title">{ROLE_NAMES[role]}</h3>
                    <select
                      aria-label={`${ROLE_NAMES[role]} agent`}
                      value={roles[role]?.agent ?? ''}
                      onChange={(event) => editRole(role, 'agent', event.target.value)}
                    >
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
                        aria-label={`${ROLE_NAMES[role]} model`}
                        value={roles[role]?.model ?? ''}
                        placeholder="Agent default"
                        onChange={(event) => editRole(role, 'model', event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>Reasoning effort</span>
                      <input
                        aria-label={`${ROLE_NAMES[role]} reasoning effort`}
                        value={roles[role]?.effort ?? ''}
                        placeholder="Agent default"
                        onChange={(event) => editRole(role, 'effort', event.target.value)}
                      />
                    </label>
                  </div>
                </section>
              ))}
            </div>
          )}
          {currentTab === 'presets' && (
            <div className={styles.presets}>
              <label className="field">
                <span>Model preset</span>
                <select value={preset ?? ''} onChange={(event) => setPreset((event.target.value as PresetName) || null)}>
                  <option value="">None</option>
                  <option value="economy">Economy</option>
                  <option value="balanced">Balanced</option>
                  <option value="best">Best</option>
                </select>
              </label>
              <p className="callout secondary">
                {selectedPreset ? presetDescription(selectedPreset) : "Uses each agent's configured model and effort."}
              </p>
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
            {tabDirty && <span className="caption secondary">Unsaved changes</span>}
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
