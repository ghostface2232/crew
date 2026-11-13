import { useState } from 'react';
import type { Role } from '../../bridge/config.ts';
import type { BoardJob, Mission, Snapshot } from './types.ts';
import { request } from './api.ts';
import { NAMES, projectOf } from './model.ts';
import { board } from './store.ts';
import { Composer } from './ui.tsx';
import styles from './Dispatch.module.css';

export function Dispatch({
  state,
  project,
  openJob,
}: {
  state: Snapshot;
  project: string;
  openJob: (id: string) => void;
}) {
  const [directory, setDirectory] = useState(project);
  const [role, setRole] = useState<Role>('delegate');
  const [targets, setTargets] = useState('');
  const [intent, setIntent] = useState('command');
  const [destination, setDestination] = useState('project');
  const cwd = project || directory;
  const agent = state.roles[role]?.agent;
  const missions = state.missions.filter((mission) => mission.state === 'active' && projectOf(mission) === cwd.trim());
  const target =
    destination.startsWith('mission:') && !missions.some((mission) => `mission:${mission.id}` === destination)
      ? 'project'
      : destination;
  return (
    <section className={styles.panel} aria-labelledby="dispatch-title">
      <div className={styles.heading}>
        <h2 id="dispatch-title">Send work</h2>
        <p className="hint">
          {intent === 'command'
            ? 'One job, using your role settings. Changes stay on its worktree branch until reviewed and merged.'
            : intent === 'question'
              ? 'Ask a read-only question about this project.'
              : 'Save information for future work. This starts no job.'}
        </p>
      </div>
      <label className="field">
        <span>Intent</span>
        <select value={intent} onChange={(event) => setIntent(event.target.value)}>
          <option value="command">Command</option>
          <option value="question">Question</option>
          <option value="information">Information</option>
        </select>
      </label>
      <div className={styles.fields}>
        <label className="field">
          <span>Project directory</span>
          <input
            aria-label="Project directory"
            value={cwd}
            readOnly={Boolean(project)}
            placeholder="/path/to/repository"
            onChange={(event) => setDirectory(event.target.value)}
          />
        </label>
        {intent === 'command' && (
          <label className="field">
            <span>Role</span>
            <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
              <option value="delegate">Implementation</option>
              <option value="review">Read-only review</option>
              <option value="polish">Wording polish</option>
            </select>
          </label>
        )}
        {intent === 'command' && (
          <p className="hint">{agent ? `Assigned to ${NAMES[agent]}` : 'Waiting for role settings'}</p>
        )}
        {intent === 'information' && (
          <label className="field">
            <span>Save information to</span>
            <select value={target} onChange={(event) => setDestination(event.target.value)}>
              <option value="project">This project's shared instructions</option>
              <option value="global">All projects' shared instructions</option>
              {missions.map((mission) => (
                <option key={mission.id} value={`mission:${mission.id}`}>{mission.title}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {intent === 'command' && role === 'polish' && (
        <label className="field">
          <span>Allowed files or directories (one per line)</span>
          <textarea value={targets} onChange={(event) => setTargets(event.target.value)} />
        </label>
      )}
      <Composer
        key={intent}
        label={intent === 'command' ? 'New job' : intent === 'question' ? 'Question' : 'Information'}
        placeholder={
          intent === 'question'
            ? 'What would you like to know about this project?'
            : intent === 'information'
              ? 'Information to remember for future work'
              : role === 'review'
                ? 'What should the agent check in the uncommitted changes?'
                : 'Describe the work and how to know it is done'
        }
        actionKey="dispatch"
        onSend={async (task) => {
          if (!(intent === 'information' && target === 'global') && !cwd.trim())
            throw new Error('Enter a project directory first.');
          if (intent === 'information') {
            if (target.startsWith('mission:')) {
              const mission = await request<Mission>(`/api/missions/${target.slice(8)}`, { note: task });
              board.receive('mission', mission);
            } else {
              await request('/api/instructions', { append: task, project: target === 'global' ? null : cwd.trim() });
            }
            return;
          }
          if (intent === 'question') {
            const job = await request<BoardJob>('/api/jobs', { kind: 'delegate', ask: true, task, cwd: cwd.trim() });
            openJob(job.id);
            return;
          }
          if (!agent || !state.agents[agent]?.enabled)
            throw new Error('The assigned agent is unavailable. Choose an enabled agent in Settings.');
          const allowed = targets
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean);
          if (role === 'polish' && !allowed.length)
            throw new Error('List the files or directories the editor may change.');
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
        }}
      />
    </section>
  );
}
