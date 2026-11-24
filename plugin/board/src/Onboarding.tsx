import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ArrowUp16Filled, CheckmarkCircleRegular, ErrorCircleRegular } from '@fluentui/react-icons';
import appIcon from './icons/CrewAppIcon.png';
import { desktop } from './desktop.ts';
import { AgentMark, Chip, Dialog, Icon, tNodes } from './ui.tsx';
import { t, translated } from './i18n.ts';
import styles from './Onboarding.module.css';

type Page = { title: string; art: ReactNode; body: ReactNode };

/** First-run guide, matching WelcomeView in the macOS app: what Crew is, how to start work, where requests arrive, and what to set up. */
export function Onboarding({ close }: { close: () => void }) {
  const [index, setIndex] = useState(0);
  const pages = PAGES();
  const last = index === pages.length - 1;
  const finish = () => {
    void desktop?.welcome?.done();
    close();
  };
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'ArrowRight') setIndex((current) => Math.min(current + 1, pages.length - 1));
      else if (event.key === 'ArrowLeft') setIndex((current) => Math.max(current - 1, 0));
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [pages.length]);
  const page = pages[index];
  return (
    <Dialog label={t('Welcome to Crew')} onClose={finish} className={styles.sheet}>
      {/* Built from the board's own components so each illustration matches the UI it describes. */}
      <div className={styles.stage} aria-hidden="true" inert key={`art-${index}`}>{page.art}</div>
      {/* Every page's text shares one grid cell so the sheet keeps the tallest page's height and never jumps. */}
      <div className={styles.copies}>
        {pages.map((item, n) => (
          <div className={styles.copy} key={item.title} data-current={n === index || undefined} aria-hidden={n !== index || undefined}>
            <h2 className={`title ${styles.title}`}>{item.title}</h2>
            {item.body}
          </div>
        ))}
      </div>
      <div className={styles.dots} role="tablist" aria-label={t('Pages')}>
        {pages.map((item, n) => (
          <button
            key={item.title}
            role="tab"
            aria-selected={n === index}
            aria-label={t('{title}, page {page} of {count}', { title: item.title, page: n + 1, count: pages.length })}
            onClick={() => setIndex(n)}
          />
        ))}
      </div>
      <footer className={styles.footer}>
        {index === 0 ? (
          <button type="button" className="large" onClick={finish}>{t('Skip')}</button>
        ) : (
          <button type="button" className="large" onClick={() => setIndex(index - 1)}>{t('Back')}</button>
        )}
        <button type="button" className="large prominent" data-autofocus onClick={() => (last ? finish() : setIndex(index + 1))}>
          {last ? t('Get Started') : t('Continue')}
        </button>
      </footer>
    </Dialog>
  );
}

const Mark = ({ agent, state }: { agent: string; state: string }) => (
  <span className="agent-avatar" data-state={state}><AgentMark agent={agent} size={26} /></span>
);

function WelcomeArt() {
  // Every agent shown working at once; role assignments are user-configured, so none is given a fixed role here.
  const agents: [string, string, string, string][] = [
    ['claude', 'Claude', t('Working'), 'working'],
    ['codex', 'Codex', t('Working'), 'working'],
    ['antigravity', 'Antigravity', t('Working'), 'working'],
  ];
  return (
    <div className={styles.welcome}>
      <img className={styles.appIcon} src={appIcon} alt="" />
      <ul className={`card ${styles.agents}`}>
        {agents.map(([agent, name, role, state]) => (
          <li className={styles.agent} key={agent}>
            <Mark agent={agent} state={state} />
            <h3 className="card-title">{name}</h3>
            <p className="caption secondary">{role}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CommandArt() {
  return (
    <div className={`card ${styles.composer}`}>
      <div className={styles.composerHead}>
        <AgentMark agent="claude" size={14} />
        <span>Claude Code</span>
      </div>
      <p className={styles.prompt}>
        <span className={styles.slash}>/crew:run</span> {t('Add a dark mode')}<i className={styles.caret} />
      </p>
      <div className={styles.composerFoot}>
        <span className="caption secondary">~/Projects/app</span>
        <span className={styles.send}><Icon icon={ArrowUp16Filled} size={14} /></span>
      </div>
    </div>
  );
}

function NeedsArt() {
  return (
    <div className={styles.needs}>
      <div className={`card need ${styles.behind}`}>
        <div className="need-bar">
          <Chip state="waiting">{t('Input')}</Chip>
          <span className="need-who"><AgentMark agent="claude" size={13} /><span>Claude</span></span>
        </div>
      </div>
      <div className={`card need ${styles.front}`}>
        <div className="need-head">
          <div className="need-bar">
            <Chip state="waiting">{t('Approval')}</Chip>
            <span className="need-who"><AgentMark agent="codex" size={13} /><span>Codex</span></span>
            <span className="need-age digits">{t('{n}m', { n: 2 })}</span>
          </div>
          <p className="need-title">{t('Add a dark mode to the settings page')}</p>
        </div>
        <div className="answer">
          <p className="headline">{tNodes('Run {command}', { command: <code>npm test</code> })}</p>
          <div className="answer-actions">
            <button className="small">{t('Deny')}</button>
            <button className="small prominent">{t('Approve')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SetupArt() {
  const items: [string, string, boolean][] = [
    ['Crew plugin and `crew` command', 'Installed', true],
    ['Claude Code', '2.1.326', true],
    ['Codex CLI and sign-in', 'Run `codex login`', false],
    ['Antigravity CLI', '1.4.0', true],
  ];
  return (
    <div className={`card ${styles.setup}`}>
      <h3 className="card-title">{t('Set up Crew')}</h3>
      <ul className="setup-list">
        {items.map(([label, detail, ok]) => (
          <li key={label} data-ok={ok || undefined}>
            <Icon icon={ok ? CheckmarkCircleRegular : ErrorCircleRegular} size={14} />
            <span>{withCode(label)}</span>
            <span className="secondary caption">{withCode(detail)}</span>
          </li>
        ))}
      </ul>
      <div className="setup-actions"><button className="small">{t('Check Again')}</button></div>
    </div>
  );
}

const withCode = (text: string) => text.split('`').map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part));

const COMMANDS = translated((): [string, string][] => [
  ['/crew:run', t('Plan, build, review, and fix with the crew')],
  ['/crew:review', t('Review a change')],
  ['/crew:debate', t('Talk through a hard decision')],
  ['/crew:board', t('Open this board')],
]);

const PAGES = translated((): Page[] => [
  {
    title: t('Welcome to Crew'),
    art: <WelcomeArt />,
    body: (
      <p className="secondary">
        {t('Crew runs several coding agents together. The session you start in leads: it splits the work and hands pieces to the other agents to run in parallel. This app shows every agent live and lets you answer them.')}
      </p>
    ),
  },
  {
    title: t('Start in Claude Code or Codex'),
    art: <CommandArt />,
    body: (
      <>
        <p className="secondary">{t('Open a new Claude Code or Codex session and type a command. In Codex, commands start with $ instead of /.')}</p>
        <dl className={styles.commands}>
          {COMMANDS().map(([command, what]) => (
            <div key={command}>
              <dt><code>{command}</code></dt>
              <dd className="secondary">{what}</dd>
            </div>
          ))}
        </dl>
      </>
    ),
  },
  {
    title: t('Answer from here'),
    art: <NeedsArt />,
    body: (
      <p className="secondary">
        {t('Approvals and questions from agents appear in Needs You. Answer them here, or open a waiting Claude session in Claude.')}{' '}
        {desktop
          ? t('Close the window and Crew stays in the tray, still running jobs.')
          : t('Jobs keep running after you close the board.')}
      </p>
    ),
  },
  {
    title: t('Finish setting up'),
    art: <SetupArt />,
    body: (
      <p className="secondary">
        {tNodes(
          'Overview lists what is still missing, such as {login} for Codex or running {agy} once for Antigravity. Choose which agent does what in Settings.',
          { login: <code>codex login</code>, agy: <code>agy</code> },
        )}
      </p>
    ),
  },
]);
