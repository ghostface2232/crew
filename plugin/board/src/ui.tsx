import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ArrowUp, BellDot, Check, Circle, CircleAlert, CircleCheck, CircleDotDashed, CircleStop, ClockAlert, Copy,
  TriangleAlert, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { actions } from './api.ts';
import claudeMark from '../../../assets/ClaudeCode.svg';
import codexMark from '../../../assets/Codex.svg';
import antigravityMark from '../../../assets/Antigravity.svg';
import crewMark from '../../../assets/crew_menubar.svg';

export const ClockContext = createContext(Date.now());
export const useNow = () => useContext(ClockContext);
export function ClockProvider({ skew, children }: { skew: number; children: ReactNode }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    const visible = () => {
      if (!document.hidden) setNow(Date.now());
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return <ClockContext value={now + skew}>{children}</ClockContext>;
}
export function Icon({ icon: Glyph, size = 15, className = '' }: { icon: LucideIcon; size?: number; className?: string }) {
  return <Glyph size={size} strokeWidth={1.75} aria-hidden="true" className={className} />;
}
const MARKS: Record<string, string> = { claude: claudeMark, codex: codexMark, antigravity: antigravityMark, crew: crewMark };
/** The supplied service SVGs, drawn as template images in the current text color, as the app draws them. */
export function AgentMark({ agent, size = 24 }: { agent: string; size?: number }) {
  return (
    <i
      className="agent-mark"
      aria-hidden="true"
      style={{ '--mark': `url("${MARKS[agent] ?? codexMark}")`, '--size': `${size}px` } as CSSProperties}
    />
  );
}
const STATUS_ICONS: Record<string, LucideIcon> = {
  waiting: BellDot,
  failed: TriangleAlert,
  error: TriangleAlert,
  stalled: ClockAlert,
  done: CircleCheck,
  running: CircleDotDashed,
  working: CircleDotDashed,
  active: CircleDotDashed,
  cancelled: CircleStop,
  abandoned: CircleStop,
};
export const statusIcon = (state: string) => STATUS_ICONS[state] ?? Circle;
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** StatusLabel in the app: the state's symbol and word on a tint of its color. */
export function Chip({ state, children }: { state: string; children?: ReactNode }) {
  return (
    <span className="chip" data-state={state}>
      <Icon icon={statusIcon(state)} />
      {children ?? capitalized(state)}
    </span>
  );
}
export function useAction(key: string) {
  return useSyncExternalStore(actions.subscribe, () => actions.get(key));
}
/** ActionMessage in the app: an error, a spinner while sending, or Sent. */
export function ActionStatus({ actionKey }: { actionKey: string }) {
  const state = useAction(actionKey);
  return (
    <span className="action-message" role="status" data-tone={state.tone}>
      {state.pending ? (
        <i className="spinner" aria-label="Sending" />
      ) : state.text ? (
        <>
          <Icon icon={state.tone ? CircleAlert : Check} />
          {state.text}
        </>
      ) : null}
    </span>
  );
}
/** A text editor with a round send button at its corner. Return adds a newline; only the button sends. */
export function Composer({
  label,
  placeholder,
  onSend,
  actionKey,
  once = false,
  draft,
  setDraft,
}: {
  label: string;
  placeholder: string;
  onSend: (message: string) => Promise<unknown>;
  actionKey: string;
  once?: boolean;
  draft: string;
  setDraft: (value: string) => void;
}) {
  const state = useAction(actionKey);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const locked = state.pending || state.accepted;
  return (
    <div className="composer">
      <textarea
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        disabled={locked}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        className="prominent"
        type="button"
        aria-label={`Send ${label.toLowerCase()}`}
        title={`Send ${label.toLowerCase()}`}
        disabled={!draft.trim() || locked}
        onClick={async () => {
          const message = draft.trim();
          const sent = await actions.run(actionKey, () => onSend(message), { once });
          if (sent && draftRef.current.trim() === message) setDraft('');
        }}
      >
        <Icon icon={ArrowUp} />
      </button>
    </div>
  );
}
/**
 * Native dialogs supply focus containment, Escape, an inert page and focus restoration. A sheet is centered;
 * the detail panel sits over the page's right edge, and a click beside it closes it.
 */
export function Dialog({
  label,
  labelId,
  onClose,
  variant = 'sheet',
  children,
}: {
  label?: string;
  labelId?: string;
  onClose: () => void;
  variant?: 'sheet' | 'detail-panel';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressed = useRef(false);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={variant}
      aria-label={label}
      aria-labelledby={labelId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        pressed.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (!pressed.current || event.target !== event.currentTarget) return;
        // The backdrop shares the dialog as its target; only a click outside the dialog's box closes it.
        const box = event.currentTarget.getBoundingClientRect();
        const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
        if (!inside) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
export function CloseButton({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <button className="icon" onClick={onClose} aria-label={label} title={label}>
      <Icon icon={X} />
    </button>
  );
}
export function CopyButton({ text, children }: { text: string; children: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <button
        className="copy-button"
        title={children}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setFailed(false);
          } catch {
            setFailed(true);
          }
        }}
      >
        <Icon icon={copied ? Check : Copy} />
        {copied ? 'Copied' : children}
      </button>
      {failed && <span className="action-message selectable">Could not copy. Select and copy: {text}</span>}
    </>
  );
}
/** A pop-up menu: opens under its button and closes on a choice, Escape, or a click elsewhere. */
export function Menu({ label, icon, children }: { label: string; icon: LucideIcon; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="icon" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon icon={icon} />
      </button>
      {open && (
        <div className="menu-list" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
/** A light, centered empty state. */
export function EmptyState({ title, icon, detail, children }: { title: string; icon: LucideIcon; detail?: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon icon={icon} />
      <b>{title}</b>
      {detail && <p>{detail}</p>}
      {children}
    </div>
  );
}
export function ContentPanel({ title, icon, children }: { title?: string; icon?: LucideIcon; children: ReactNode }) {
  return (
    <section className="card">
      {title && (
        <h2 className="title panel-title">
          {icon && <Icon icon={icon} />}
          {title}
        </h2>
      )}
      <div className="panel-list">{children}</div>
    </section>
  );
}
/** A segmented picker, as the app's segmented Picker draws one. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([option, text]) => (
        <button key={option} type="button" role="radio" aria-checked={value === option} onClick={() => onChange(option)}>
          {text}
        </button>
      ))}
    </div>
  );
}
