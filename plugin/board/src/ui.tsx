import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Circle, CircleCheck, CircleX, Clock3, LoaderCircle, TriangleAlert, Send, X, Copy } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { actions } from './api.ts';
import type { Mark } from './model.ts';

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
export function Icon({
  icon: Glyph,
  size = 18,
  className = '',
}: {
  icon: LucideIcon;
  size?: number;
  className?: string;
}) {
  return <Glyph size={size} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" className={className} />;
}
const marks = {
  working: LoaderCircle,
  waiting: TriangleAlert,
  stalled: Clock3,
  failed: CircleX,
  done: CircleCheck,
  idle: Circle,
};
export function MarkIcon({ state }: { state: Mark | '' }) {
  return <Icon icon={marks[state || 'idle']} className="mark" />;
}
export function Chip({ state, children }: { state: Mark | ''; children: ReactNode }) {
  return (
    <span className="chip" data-state={state}>
      <MarkIcon state={state} />
      {children}
    </span>
  );
}
export function useAction(key: string) {
  return useSyncExternalStore(actions.subscribe, () => actions.get(key));
}
export function ActionStatus({ actionKey }: { actionKey: string }) {
  const state = useAction(actionKey);
  return (
    <span className="status action-status" role="status" data-tone={state.tone}>
      {state.text}
    </span>
  );
}
export function Composer({
  label,
  placeholder,
  onSend,
  actionKey,
  once = false,
}: {
  label: string;
  placeholder: string;
  onSend: (message: string) => Promise<unknown>;
  actionKey: string;
  once?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const state = useAction(actionKey);
  return (
    <form
      className="composer"
      onSubmit={async (event) => {
        event.preventDefault();
        const message = draft.trim();
        if (!message) return;
        const sent = await actions.run(actionKey, () => onSend(message), { once });
        if (sent && draftRef.current.trim() === message) setDraft('');
      }}
    >
      <div className="composer-bar">
        <textarea
          rows={1}
          aria-label={label}
          placeholder={placeholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button
          className="primary"
          type="submit"
          aria-label={`Send ${label.toLowerCase()}`}
          disabled={!draft.trim() || state.pending || state.accepted}
          aria-busy={state.pending}
        >
          <Icon icon={Send} />
          <span>Send</span>
        </button>
      </div>
      <ActionStatus actionKey={actionKey} />
    </form>
  );
}
/** Native dialogs supply focus containment, Escape, inert background, and focus restoration. */
export function Dialog({
  title,
  labelId,
  onClose,
  children,
}: {
  title: string;
  labelId: string;
  onClose: () => void;
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
      className="sheet"
      aria-labelledby={labelId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        pressed.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressed.current && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sheet-body">
        <header className="sheet-head">
          <h2 id={labelId}>{title}</h2>
          <button
            className="quiet icon-button"
            onClick={onClose}
            aria-label={`Close ${title === 'Settings' ? 'settings' : 'details'}`}
          >
            <Icon icon={X} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
export function CopyButton({ text, children }: { text: string; children: ReactNode }) {
  const [status, setStatus] = useState('');
  return (
    <>
      <button
        className="quiet"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setStatus('Copied');
          } catch {
            setStatus(`Could not copy. Select and copy: ${text}`);
          }
        }}
      >
        <Icon icon={Copy} />
        {children}
      </button>
      <span className="status" role="status">
        {status}
      </span>
    </>
  );
}
