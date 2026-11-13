import { useEffect, useRef, useState } from 'react';
import type { PresetName, Roles, Snapshot } from './types.ts';
import type { Role, RoleAssignment } from '../../bridge/config.ts';
import { request } from './api.ts';
import { board } from './store.ts';
import { knownProjects, projectNames, ROLE_NAMES } from './model.ts';
import { Dialog } from './ui.tsx';

export function Settings({ state, close }: { state: Snapshot; close: () => void }) {
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
  return (
    <Dialog title="Settings" labelId="settings-title" onClose={closeSettings}>
      {state.presets && (
        <form
          className="section"
          onSubmit={async (event) => {
            event.preventDefault();
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
          }}
        >
          <h3>Preset</h3>
          <label className="field">
            <span>Model preset</span>
            <select value={preset ?? ''} onChange={(event) => setPreset((event.target.value as PresetName) || null)}>
              <option value="">None</option>
              <option value="economy">Economy</option>
              <option value="balanced">Balanced</option>
              <option value="best">Best</option>
            </select>
          </label>
          {selectedPreset && (
            <dl className="facts">
              <div>
                <dt>Codex</dt>
                <dd>
                  {[selectedPreset.codex?.model, selectedPreset.codex?.effort && `${selectedPreset.codex.effort} effort`]
                    .filter(Boolean).join(' · ') || 'Agent default'}
                </dd>
              </div>
              <div>
                <dt>Antigravity</dt>
                <dd>{selectedPreset.antigravity?.model || 'Agent default'}</dd>
              </div>
              <div>
                <dt>Claude subagent model</dt>
                <dd>{selectedPreset.subagentModel || 'inherit'}</dd>
              </div>
            </dl>
          )}
          <p className="hint">A model or effort set on a role overrides the preset.</p>
          <div className="actions">
            <button className="primary" type="submit" disabled={savingPreset}>
              {savingPreset ? 'Saving…' : 'Save preset'}
            </button>
            <span className="status" role="status">
              {presetStatus}
            </span>
          </div>
        </form>
      )}
      <form
        className="section"
        onSubmit={async (event) => {
          event.preventDefault();
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
        }}
      >
        <h3>Roles</h3>
        <p className="hint">Applies to the next job. Leave model and effort empty to use the agent’s default.</p>
        <div className="roles">
          {(Object.keys(ROLE_NAMES) as Role[]).map((role) => (
            <div className="role-row" key={role}>
              <p>
                <strong>{ROLE_NAMES[role]}</strong>
              </p>
              <label className="field">
                <span>Agent</span>
                <select
                  aria-label={`${ROLE_NAMES[role]} agent`}
                  value={roles[role]?.agent ?? ''}
                  onChange={(event) => editRole(role, 'agent', event.target.value)}
                >
                  {Object.entries(state.agents).map(([id, agent]) => (
                    <option key={id} value={id}>
                      {agent.name}
                      {agent.enabled ? '' : ' (disabled)'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Model</span>
                <input
                  value={roles[role]?.model ?? ''}
                  placeholder="Agent default"
                  onChange={(event) => editRole(role, 'model', event.target.value)}
                />
              </label>
              <label className="field">
                <span>Effort</span>
                <input
                  value={roles[role]?.effort ?? ''}
                  placeholder="Agent default"
                  onChange={(event) => editRole(role, 'effort', event.target.value)}
                />
              </label>
            </div>
          ))}
        </div>
        <div className="actions">
          <button className="primary" type="submit" disabled={savingRoles}>
            {savingRoles ? 'Saving…' : 'Save roles'}
          </button>
          <span className="status" role="status">
            {roleStatus}
          </span>
        </div>
      </form>
      <form
        className="section"
        onSubmit={async (event) => {
          event.preventDefault();
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
        }}
      >
        <h3>Shared instructions</h3>
        <p className="hint">Given to every agent with its next job and to Claude sessions when they start.</p>
        <label className="field">
          <span>Applies to</span>
          <select
            value={scope}
            onChange={(event) => {
              if (text !== saved && !confirm('Discard the unsaved changes to these instructions?')) return;
              setScope(event.target.value);
            }}
          >
            <option value="">Every project</option>
            {dirs.map((dir) => (
              <option key={dir} value={dir}>
                Only {names.get(dir)}
              </option>
            ))}
          </select>
        </label>
        <textarea
          id="instructions-text"
          aria-label="Shared instructions"
          rows={12}
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={load !== 'ready'}
        />
        <p className="hint" data-warn={text.length > 9000 ? '' : undefined}>
          {file}
          {text.length > 9000 &&
            ' · Longer than 9,000 characters: Claude sessions are pointed to this file instead of being given the text.'}
        </p>
        <div className="actions">
          <button className="primary" type="submit" disabled={saving || load !== 'ready'}>
            {saving ? 'Saving…' : 'Save instructions'}
          </button>
          {load === 'failed' && (
            <button type="button" onClick={() => setRetry((value) => value + 1)}>
              Retry loading
            </button>
          )}
          <span className="status" role="status">
            {load === 'loading' ? 'Loading…' : status}
          </span>
        </div>
        {dirty && <p className="hint">Unsaved changes</p>}
      </form>
    </Dialog>
  );
}
