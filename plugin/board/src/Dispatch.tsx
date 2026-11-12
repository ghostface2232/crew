import { useState } from 'react';
import type { Role } from '../../bridge/config.ts';
import type { BoardJob, Snapshot } from './types.ts';
import { request } from './api.ts';
import { NAMES } from './model.ts';
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
  const cwd = project || directory;
  const agent = state.roles[role]?.agent;
  return (
    <section className={styles.panel} aria-labelledby="dispatch-title">
      <div className={styles.heading}>
        <h2 id="dispatch-title">Send work</h2>
        <p className="hint">
          One job, using your role settings. Changes stay on its worktree branch until reviewed and merged.
        </p>
      </div>
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
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
            <option value="delegate">Implementation</option>
            <option value="review">Read-only review</option>
            <option value="polish">Wording polish</option>
          </select>
        </label>
        <p className="hint">{agent ? `Assigned to ${NAMES[agent]}` : 'Waiting for role settings'}</p>
      </div>
      {role === 'polish' && (
        <label className="field">
          <span>Allowed files or directories (one per line)</span>
          <textarea value={targets} onChange={(event) => setTargets(event.target.value)} />
        </label>
      )}
      <Composer
        label="New job"
        placeholder={
          role === 'review'
            ? 'What should the agent check in the uncommitted changes?'
            : 'Describe the work and how to know it is done'
        }
        actionKey="dispatch"
        onSend={async (task) => {
          if (!cwd.trim()) throw new Error('Enter a project directory first.');
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
