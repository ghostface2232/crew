import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ArrowUp16Filled, CheckmarkCircleRegular, ErrorCircleRegular } from '@fluentui/react-icons';
import appIcon from './icons/CrewAppIcon.png';
import { desktop } from './desktop.ts';
import { AgentMark, Chip, Dialog, Icon } from './ui.tsx';
import styles from './Onboarding.module.css';

type Page = { title: string; art: ReactNode; body: ReactNode };

/** The first-run guide, as WelcomeView in the app: what Crew is, how to start work, where requests arrive, and what to set up. */
export function Onboarding({ close }: { close: () => void }) {
  const [index, setIndex] = useState(0);
  const pages = PAGES;
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
    <Dialog label="Welcome to Crew" onClose={finish} className={styles.sheet}>
      {/* Drawn from the board's own parts, so the pictures match the pages they point to. */}
      <div className={styles.stage} aria-hidden="true" inert key={`art-${index}`}>{page.art}</div>
      {/* Every page's text takes the same cell, so the sheet keeps the tallest one's height and never jumps. */}
      <div className={styles.copies}>
        {pages.map((item, n) => (
          <div className={styles.copy} key={item.title} data-current={n === index || undefined} aria-hidden={n !== index || undefined}>
            <h2 className={`title ${styles.title}`}>{item.title}</h2>
            {item.body}
          </div>
        ))}
      </div>
      <div className={styles.dots} role="tablist" aria-label="Pages">
        {pages.map((item, n) => (
          <button
            key={item.title}
            role="tab"
            aria-selected={n === index}
            aria-label={`${item.title}, page ${n + 1} of ${pages.length}`}
            onClick={() => setIndex(n)}
          />
        ))}
      </div>
      <footer className={styles.footer}>
        {index === 0 ? (
          <button type="button" className="large" onClick={finish}>Skip</button>
        ) : (
          <button type="button" className="large" onClick={() => setIndex(index - 1)}>Back</button>
        )}
        <button type="button" className="large prominent" data-autofocus onClick={() => (last ? finish() : setIndex(index + 1))}>
          {last ? 'Get Started' : 'Continue'}
        </button>
      </footer>
    </Dialog>
  );
}

const Mark = ({ agent, state }: { agent: string; state: string }) => (
  <span className="agent-avatar" data-state={state}><AgentMark agent={agent} size={26} /></span>
);

function WelcomeArt() {
  // Every agent at work at once; which agent takes which work is the user's setting, so none is given a role here.
  const agents: [string, string, string, string][] = [
    ['claude', 'Claude', 'Working', 'working'],
    ['codex', 'Codex', 'Working', 'working'],
    ['antigravity', 'Antigravity', 'Working', 'working'],
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
        <span className={styles.slash}>/crew:run</span> Add a dark mode<i className={styles.caret} />
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
          <Chip state="waiting">Input</Chip>
          <span className="need-who"><AgentMark agent="claude" size={13} /><span>Claude</span></span>
        </div>
      </div>
      <div className={`card need ${styles.front}`}>
        <div className="need-head">
          <div className="need-bar">
            <Chip state="waiting">Approval</Chip>
            <span className="need-who"><AgentMark agent="codex" size={13} /><span>Codex</span></span>
            <span className="need-age digits">2m</span>
          </div>
          <p className="need-title">Add a dark mode to the settings page</p>
        </div>
        <div className="answer">
          <p className="headline">Run <code>npm test</code></p>
          <div className="answer-actions">
            <button className="small">Deny</button>
            <button className="small prominent">Approve</button>
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
      <h3 className="card-title">Set up Crew</h3>
      <ul className="setup-list">
        {items.map(([label, detail, ok]) => (
          <li key={label} data-ok={ok || undefined}>
            <Icon icon={ok ? CheckmarkCircleRegular : ErrorCircleRegular} size={14} />
            <span>{withCode(label)}</span>
            <span className="secondary caption">{withCode(detail)}</span>
          </li>
        ))}
      </ul>
      <div className="setup-actions"><button className="small">Check Again</button></div>
    </div>
  );
}

const withCode = (text: string) => text.split('`').map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part));

const COMMANDS: [string, string][] = [
  ['/crew:run <task>', 'Plan, build, review, and fix with the crew'],
  ['/crew:review', 'Review a change'],
  ['/crew:debate', 'Talk through a hard decision'],
  ['/crew:board', 'Open this board in Claude'],
];

const PAGES: Page[] = [
  {
    title: 'Welcome to Crew',
    art: <WelcomeArt />,
    body: (
      <p className="secondary">
        Crew runs several coding agents together. Claude leads from Claude Code and hands pieces of the work to the
        other agents, which work in parallel. This app shows every agent live and lets you answer them.
      </p>
    ),
  },
  {
    title: 'Start in Claude Code',
    art: <CommandArt />,
    body: (
      <>
        <p className="secondary">Open a new Claude Code session, then type a command.</p>
        <dl className={styles.commands}>
          {COMMANDS.map(([command, what]) => (
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
    title: 'Answer from here',
    art: <NeedsArt />,
    body: (
      <p className="secondary">
        When an agent needs approval or asks a question, it shows in Needs You. Answer it here, or open a Claude
        session in Claude. {desktop
          ? 'Closing the window keeps Crew in the tray, and jobs keep running.'
          : 'Jobs keep running after you close the board.'}
      </p>
    ),
  },
  {
    title: 'Finish setting up',
    art: <SetupArt />,
    body: (
      <p className="secondary">
        Overview lists anything still missing, such as signing in to Codex with <code>codex login</code>, or to
        Antigravity by running <code>agy</code> once. Choose which agent takes which work in Settings.
      </p>
    ),
  },
];
