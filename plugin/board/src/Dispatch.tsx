import { useRef, useState } from 'react';
import { ArrowUp16Filled, ErrorCircleRegular, SendRegular } from '@fluentui/react-icons';
import type { Role, WorkerAgent } from '../../bridge/config.ts';
import type { BoardJob, Mission, Snapshot } from './types.ts';
import { request } from './api.ts';
import { holdersOf, preferredWorkers, projectOf, rolesOf } from './model.ts';
import { board } from './store.ts';
import { ask, Dialog, Icon, Segmented, Select } from './ui.tsx';
import styles from './Dispatch.module.css';
import { t } from './i18n.ts';

export function Dispatch({
  state,
  project,
  origin,
  openJob,
  close,
  draft = '',
}: {
  state: Snapshot;
  project: string;
  /** The control the sheet grows out of. */
  origin?: DOMRect;
  /** Opens the new job, in its project's page. */
  openJob: (id: string, project: string) => void;
  close: () => void;
  /** A task the sheet opens with, such as an issue the user chose to start from; sending it stays theirs. */
  draft?: string;
}) {
  const initialDirectory = useRef(project);
  const [directory, setDirectory] = useState(project);
  const [role, setRole] = useState<Role>('delegate');
  const [targets, setTargets] = useState('');
  const [intent, setIntent] = useState('command');
  const [destination, setDestination] = useState('project');
  const [text, setText] = useState(draft);
  const [sending, setSending] = useState(false);
  const sendingLock = useRef(false);
  const [error, setError] = useState('');
  const cwd = directory;
  // A debate needs the lead to answer each round, so it is not started from here.
  const choices = rolesOf(state).filter((info) => info.role !== 'debate');
  const kind = choices.find((info) => info.role === role)?.kind ?? 'delegate';
  // The role's holders that are workers; Claude holding it means a lead session takes it.
  const assignment = state.roles[intent === 'question' ? 'delegate' : role];
  const info = rolesOf(state).find((other) => other.role === (intent === 'question' ? 'delegate' : role));
  const workers = preferredWorkers(info, holdersOf(assignment)).filter((holder) => holder in state.agents);
  const [picked, setPicked] = useState<WorkerAgent | ''>('');
  // Unless another is chosen, the first that can take the work, as the daemon would pick.
  const able = workers.filter((holder) => state.agents[holder].enabled && !info?.unable?.includes(holder));
  // With no worker able, a role Claude holds is the lead's, as the daemon would decide.
  const claudeHolds = holdersOf(assignment).includes('claude');
  const agent = picked && workers.includes(picked) ? picked : able[0] ?? (claudeHolds ? undefined : workers[0]);
  const worker = agent ? state.agents[agent] : undefined;
  const leadOnly = Boolean(assignment) && !agent && claudeHolds;
  const missions = state.missions.filter((mission) => mission.state === 'active' && projectOf(mission) === cwd.trim());
  const dirty = intent !== 'command' || destination !== 'project' || text !== draft || targets !== ''
    || role !== 'delegate' || directory !== initialDirectory.current || picked !== '';
  const canSend = !sending && state.connection === 'live' && Boolean(text.trim())
    && (intent === 'information' && destination === 'global'
      || Boolean(cwd.trim()) && (intent === 'information'
        ? destination === 'project' || missions.some((mission) => `mission:${mission.id}` === destination)
        : worker?.enabled === true));
  const closeDraft = async () => {
    if (sendingLock.current) return;
    if (!dirty || await ask(t('Discard this job draft?'), t('Discard'), t('Your instructions and job options have not been sent.'))) close();
  };
  const send = async () => {
    if (sendingLock.current || !canSend) return;
    const task = text.trim();
    const target = destination;
    try {
      if (!(intent === 'information' && target === 'global') && !cwd.trim())
        throw new Error(t('Enter a project directory first.'));
      if (intent !== 'information' && leadOnly)
        throw new Error(t('Claude holds this role, so it starts from a lead session: Claude Code does it itself, and Codex hands it to a Claude worker.'));
      if (intent !== 'information' && !worker?.enabled)
        throw new Error(t('The assigned agent is unavailable. Choose an enabled agent in Settings.'));
      const allowed = targets
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean);
      if (intent === 'command' && kind === 'polish' && !allowed.length)
        throw new Error(t('List the files or directories the editor may change.'));
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
      // With one worker holder the daemon picks it anyway; among several, the one shown is named.
      const named = agent && workers.length > 1 ? { agent } : {};
      if (intent === 'question') {
        const job = await request<BoardJob>('/api/jobs', { kind: 'delegate', ask: true, task, cwd: cwd.trim(), ...named });
        openJob(job.id, projectOf(job));
        close();
        return;
      }
      const job = await request<BoardJob>('/api/jobs', {
        // A daemon without the registry knows only the kind, which for its three roles names the role.
        ...(state.roleInfo ? { role } : {}),
        kind,
        cwd: cwd.trim(),
        project: cwd.trim(),
        task,
        isolation: 'worktree',
        ...named,
        ...(kind === 'review' ? { review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } } : {}),
        ...(kind === 'polish' ? { targets: allowed } : {}),
      });
      // The job's project is its repository root, which may differ from the directory typed.
      openJob(job.id, projectOf(job));
      close();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      sendingLock.current = false;
      setSending(false);
    }
  };
  return (
    <Dialog labelId="dispatch-title" onClose={closeDraft} origin={origin}>
      <fieldset className={`sheet-body ${styles.body}`} disabled={sending}>
        <h2 className={`title ${styles.title}`} id="dispatch-title">
          <Icon icon={SendRegular} size={18} />
          {t('New Job')}
        </h2>
        <Segmented
          label={t('Intent')}
          value={intent}
          options={[['command', t('Command')], ['question', t('Question')], ['information', t('Information')]]}
          onChange={(next) => { setIntent(next); setPicked(''); }}
        />
        <div className={styles.fields}>
          <label className="field">
            <span>{t('Project')}</span>
            <input
              aria-label={t('Project directory')}
              value={cwd}
              placeholder="/path/to/repository"
              onChange={(event) => {
                setDirectory(event.target.value);
                if (destination.startsWith('mission:')) setDestination('project');
              }}
            />
          </label>
          {intent !== 'information' && (
            <div className={styles.assignment}>
              {intent === 'command' && <label className="field">
                <span>{t('Role')}</span>
                <Select label={t('Role')} value={role} options={choices.map((info) => [info.role, t(info.label)])} onChange={setRole} />
              </label>}
              {workers.length > 1 ? (
                <label className="field">
                  <span>{t('Assigned to')}</span>
                  <Select<WorkerAgent | ''>
                    label={t('Assigned to')}
                    value={agent ?? ''}
                    options={[
                      ...(agent ? [] : [['', t('Claude, in a lead session')] as ['', string]]),
                      ...workers.map((id): [WorkerAgent, string] => [id, state.agents[id].enabled ? state.agents[id].name : t('{name} (disabled)', { name: state.agents[id].name })]),
                    ]}
                    onChange={(id) => id && setPicked(id)}
                  />
                </label>
              ) : (
                <div className="field">
                  <span>{t('Assigned to')}</span>
                  <p className={styles.worker}>
                    {worker ? (worker.enabled ? worker.name : t('{name} (disabled)', { name: worker.name })) : leadOnly ? t('Claude, in a lead session') : t('No agent assigned')}
                  </p>
                </div>
              )}
            </div>
          )}
          {intent !== 'information' && leadOnly && (
            <p className="callout secondary">{t('Start this job from a Claude Code or Codex session: Claude Code does it itself or in a subagent, and Codex hands it to a Claude worker.')}</p>
          )}
          {intent === 'command' && kind === 'polish' && (
            <label className="field">
              <span>{t('Allowed files or directories')}</span>
              <textarea
                rows={3}
                placeholder={t('One path per line')}
                value={targets}
                onChange={(event) => setTargets(event.target.value)}
              />
            </label>
          )}
          {intent === 'information' && (
            <label className="field">
              <span>{t('Add to')}</span>
              <Select
                label={t('Information destination')}
                value={destination}
                options={[
                  ['project', t("This project's shared instructions")],
                  ['global', t("Every project's shared instructions")],
                  ...missions.map((mission): [string, string] => [`mission:${mission.id}`, mission.title]),
                ]}
                onChange={setDestination}
              />
            </label>
          )}
          <label className="field">
            <span>
              {intent === 'question' ? t('What would you like to know?')
                : intent === 'information' ? t('What should be remembered?')
                  : kind === 'review' ? t('What should be checked?') : t('What needs to be done?')}
            </span>
            <textarea
              className={styles.editor}
              aria-label={t('New job instructions')}
              aria-describedby="dispatch-caption"
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={6}
            />
            <span className="caption secondary" id="dispatch-caption">
              {intent === 'information' ? t('Adds information only. This starts no work.')
                : intent === 'question' ? t('Answers the question in read-only mode.')
                  : role === 'verify' ? t('Reviews uncommitted changes by running the app in a snapshot of them.')
                    : kind === 'review' ? t('Reviews uncommitted changes in read-only mode.')
                    : role === 'release' ? t('Prepares the release on an isolated worktree branch. Nothing is published or deployed.')
                    : t('Changes stay on an isolated worktree branch until reviewed and merged.')}
            </span>
          </label>
        </div>
        {error && <p className={`error ${styles.error}`} role="alert"><Icon icon={ErrorCircleRegular} />{error}</p>}
        <footer className={styles.footer}>
          <button type="button" className="large" onClick={closeDraft}>{t('Cancel')}</button>
          <button type="button" className="large prominent" disabled={!canSend} onClick={() => void send()}>
            <Icon icon={ArrowUp16Filled} />
            {sending ? t('Sending…') : intent === 'information' ? t('Save Information')
              : intent === 'question' ? t('Ask Question') : t('Send Job')}
          </button>
        </footer>
      </fieldset>
    </Dialog>
  );
}
