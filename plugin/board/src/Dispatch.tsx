import { useRef, useState } from 'react';
import { ArrowUp, CircleAlert, Send } from 'lucide-react';
import type { Role } from '../../bridge/config.ts';
import type { BoardJob, Mission, Snapshot } from './types.ts';
import { request } from './api.ts';
import { projectOf, ROLE_NAMES } from './model.ts';
import { board } from './store.ts';
import { Dialog, Icon, Segmented } from './ui.tsx';
import styles from './Dispatch.module.css';

export function Dispatch({
  state,
  project,
  openJob,
  close,
}: {
  state: Snapshot;
  project: string;
  openJob: (id: string) => void;
  close: () => void;
}) {
  const initialDirectory = useRef(project);
  const [directory, setDirectory] = useState(project);
  const [role, setRole] = useState<Role>('delegate');
  const [targets, setTargets] = useState('');
  const [intent, setIntent] = useState('command');
  const [destination, setDestination] = useState('project');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const sendingLock = useRef(false);
  const [error, setError] = useState('');
  const cwd = directory;
  const agent = state.roles[intent === 'question' ? 'delegate' : role]?.agent;
  const worker = agent ? state.agents[agent] : undefined;
  const missions = state.missions.filter((mission) => mission.state === 'active' && projectOf(mission) === cwd.trim());
  const dirty = intent !== 'command' || destination !== 'project' || text !== '' || targets !== ''
    || role !== 'delegate' || directory !== initialDirectory.current;
  const canSend = !sending && state.connection === 'live' && Boolean(text.trim())
    && (intent === 'information' && destination === 'global'
      || Boolean(cwd.trim()) && (intent === 'information'
        ? destination === 'project' || missions.some((mission) => `mission:${mission.id}` === destination)
        : worker?.enabled === true));
  const closeDraft = () => {
    if (!sendingLock.current && (!dirty || confirm('Discard this job draft?'))) close();
  };
  const send = async () => {
    if (sendingLock.current || !canSend) return;
    const task = text.trim();
    const target = destination;
    try {
      if (!(intent === 'information' && target === 'global') && !cwd.trim())
        throw new Error('Enter a project directory first.');
      if (intent !== 'information' && !worker?.enabled)
        throw new Error('The assigned agent is unavailable. Choose an enabled agent in Settings.');
      const allowed = targets
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean);
      if (intent === 'command' && role === 'polish' && !allowed.length)
        throw new Error('List the files or directories the editor may change.');
      sendingLock.current = true;
      setSending(true);
      setError('');
      if (intent === 'information') {
        if (target.startsWith('mission:')) {
          const mission = await request<Mission>(`/api/missions/${target.slice(8)}`, { note: task });
          board.receive('mission', mission);
        } else {
          await request('/api/instructions', { append: task, project: target === 'global' ? null : cwd.trim() });
        }
        close();
        return;
      }
      if (intent === 'question') {
        const job = await request<BoardJob>('/api/jobs', { kind: 'delegate', ask: true, task, cwd: cwd.trim() });
        openJob(job.id);
        close();
        return;
      }
      const job = await request<BoardJob>('/api/jobs', {
        kind: role,
        cwd: cwd.trim(),
        project: cwd.trim(),
        task,
        isolation: 'worktree',
        ...(role === 'review' ? { review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } } : {}),
        ...(role === 'polish' ? { targets: allowed } : {}),
      });
      openJob(job.id);
      close();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      sendingLock.current = false;
      setSending(false);
    }
  };
  return (
    <Dialog labelId="dispatch-title" onClose={closeDraft}>
      <fieldset className={`sheet-body ${styles.body}`} disabled={sending}>
        <h2 className={`title ${styles.title}`} id="dispatch-title">
          <Icon icon={Send} size={18} />
          New Job
        </h2>
        <Segmented
          label="Intent"
          value={intent}
          options={[['command', 'Command'], ['question', 'Question'], ['information', 'Information']]}
          onChange={setIntent}
        />
        <div className={styles.fields}>
          <label className="field">
            <span>Project</span>
            <input
              aria-label="Project directory"
              value={cwd}
              placeholder="/path/to/repository"
              onChange={(event) => {
                setDirectory(event.target.value);
                setDestination('project');
              }}
            />
          </label>
          {intent === 'command' && (
            <div className={styles.assignment}>
              <label className="field">
                <span>Role</span>
                <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
                  {(Object.keys(ROLE_NAMES) as Role[]).map((role) => (
                    <option key={role} value={role}>{ROLE_NAMES[role]}</option>
                  ))}
                </select>
              </label>
              <div className="field">
                <span>Assigned to</span>
                <p className={styles.worker}>
                  {worker ? `${worker.name}${worker.enabled ? '' : ' (disabled)'}` : 'No agent assigned'}
                </p>
              </div>
            </div>
          )}
          {intent === 'command' && role === 'polish' && (
            <label className="field">
              <span>Allowed files or directories</span>
              <textarea
                rows={3}
                placeholder="One path per line"
                value={targets}
                onChange={(event) => setTargets(event.target.value)}
              />
            </label>
          )}
          {intent === 'information' && (
            <label className="field">
              <span>Add to</span>
              <select
                aria-label="Information destination"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
              >
                <option value="project">This project's shared instructions</option>
                <option value="global">Every project's shared instructions</option>
                {missions.map((mission) => (
                  <option key={mission.id} value={`mission:${mission.id}`}>{mission.title}</option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>
              {intent === 'question' ? 'What would you like to know?'
                : intent === 'information' ? 'What should be remembered?'
                  : role === 'review' ? 'What should be checked?' : 'What needs to be done?'}
            </span>
            <textarea
              className={styles.editor}
              aria-label="New job instructions"
              aria-describedby="dispatch-caption"
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={6}
            />
            <span className="caption secondary" id="dispatch-caption">
              {intent === 'information' ? 'Adds information only. This starts no work.'
                : intent === 'question' ? 'Answers the question in read-only mode.'
                  : role === 'review' ? 'Reviews uncommitted changes in read-only mode.'
                    : 'Changes stay on an isolated worktree branch until reviewed and merged.'}
            </span>
          </label>
        </div>
        {error && <p className={`error ${styles.error}`} role="alert"><Icon icon={CircleAlert} />{error}</p>}
        <footer className={styles.footer}>
          <button type="button" onClick={closeDraft}>Cancel</button>
          <button type="button" className="prominent" disabled={!canSend} onClick={() => void send()}>
            <Icon icon={ArrowUp} />
            {sending ? 'Sending…' : intent === 'information' ? 'Save Information'
              : intent === 'question' ? 'Ask Question' : 'Send Job'}
          </button>
        </footer>
      </fieldset>
    </Dialog>
  );
}
