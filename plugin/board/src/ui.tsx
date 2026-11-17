import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ArrowUp, BellDot, Check, ChevronDown, Circle, CircleAlert, CircleCheck, CircleDotDashed, CircleStop, ClockAlert, Copy,
  TriangleAlert, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { actions, drafts } from './api.ts';
import claudeMark from './icons/ClaudeCode.svg';
import codexMark from './icons/Codex.svg';
import antigravityMark from './icons/Antigravity.svg';

/**
 * Content that opens and closes by height and fade, and stays mounted so it can do both. Closed, it is out of the tab order
 * and the accessibility tree. Its spacing from what precedes it belongs in its own padding: a gap before an empty row would stay.
 */
export function Collapse({ open, className, children }: { open: boolean; className?: string; children: ReactNode }) {
  return (
    <div className="collapse" data-open={open || undefined}>
      <div className="collapse-inner" inert={!open}>
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}

/** How long a side panel takes to leave, shorter than it takes to arrive. */
export const PANEL_EXIT_MS = 300;
/** True while a side panel is still on screen only to play its exit; the Dialog inside reads it. */
export const PanelLeavingContext = createContext(false);
/**
 * Keeps showing a value for `ms` after it is cleared, so what it names can animate out in place instead of vanishing. A new value
 * replaces it at once. Returns what to show and whether it is only lingering.
 */
export function useLinger(value: string, ms: number): [string, boolean] {
  const [kept, setKept] = useState(value);
  const [leaving, setLeaving] = useState(false);
  if (value && (value !== kept || leaving)) {
    setKept(value);
    setLeaving(false);
  }
  useEffect(() => {
    if (value || !kept) return;
    if (reducedMotion()) return setKept('');
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setKept('');
      setLeaving(false);
    }, ms);
    return () => clearTimeout(timer);
  }, [value]);
  return [value || kept, leaving];
}
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
/** The motion language: things open on a long, soft ease-out and close quicker, as the reference menus do. */
export const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
export const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)';
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/**
 * A container transform: the element grows out of the control that opened it. Only transform and opacity
 * move, so text inside stays crisp once it lands; the contents fade in after the shape has mostly settled.
 */
export function growFrom(element: HTMLElement, from: DOMRect | undefined, { duration = 460 } = {}) {
  if (!from || reducedMotion()) return;
  const to = element.getBoundingClientRect();
  if (!to.width || !to.height) return;
  const transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
  element.animate([{ transform, transformOrigin: '0 0', opacity: 0.4 }, { transform: 'none', transformOrigin: '0 0', opacity: 1 }], { duration, easing: EASE_OUT });
  for (const child of element.children)
    (child as HTMLElement).animate([{ opacity: 0 }, { opacity: 0 }, { opacity: 1 }], { duration: duration * 0.75, easing: 'ease-out' });
}
/** The way back: the element shrinks into the control it came from, faster than it opened. */
export function shrinkTo(element: HTMLElement, to: DOMRect | undefined, { duration = 240 } = {}) {
  if (!to || reducedMotion() || !element.isConnected) return Promise.resolve();
  const from = element.getBoundingClientRect();
  if (!from.width || !from.height) return Promise.resolve();
  const transform = `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`;
  for (const child of element.children) (child as HTMLElement).animate([{ opacity: 1 }, { opacity: 0 }], { duration: duration * 0.5, fill: 'forwards' });
  return element
    .animate([{ transform: 'none', transformOrigin: '0 0', opacity: 1 }, { transform, transformOrigin: '0 0', opacity: 0 }], { duration, easing: EASE_IN_OUT, fill: 'forwards' })
    .finished.then(() => undefined, () => undefined);
}
/** A number whose digits roll to their new value, each column on its own. */
export function RollingNumber({ value, className, format }: { value: number; className?: string; format?: (value: number) => string }) {
  const text = format ? format(value) : value.toLocaleString();
  return (
    <span className={`rolling ${className ?? ''}`} aria-label={text} role="img">
      {[...text].map((character, index) =>
        /\d/.test(character) ? (
          // Keyed from the right, so a new leading digit slides in without moving the others.
          <span className="rolling-digit" key={text.length - index} aria-hidden="true">
            <span style={{ translate: `0 ${-Number(character) * 10}%` }}>0123456789</span>
          </span>
        ) : (
          <span key={`s${text.length - index}`} aria-hidden="true">{character}</span>
        ),
      )}
    </span>
  );
}
/** Words that settle in one after another, as a caption fades up under the reference's preview. */
export function WordReveal({ text, className }: { text: string; className?: string }) {
  return (
    <span className={`word-reveal ${className ?? ''}`} key={text}>
      {text.split(/(\s+)/).map((part, index) =>
        /^\s+$/.test(part) ? part : <span key={index} style={{ '--i': index / 2 } as CSSProperties}>{part}</span>,
      )}
    </span>
  );
}
export function Icon({ icon: Glyph, size = 15, className = '' }: { icon: LucideIcon; size?: number; className?: string }) {
  return <Glyph size={size} strokeWidth={1.75} aria-hidden="true" className={className} />;
}
const MARKS: Record<string, string> = { claude: claudeMark, codex: codexMark, antigravity: antigravityMark };
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
      {/* A new word swaps in over the old one rather than cutting to it. */}
      <span className="swap" key={typeof children === 'string' ? children : state}>{children ?? capitalized(state)}</span>
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
  disabled = false,
}: {
  label: string;
  placeholder: string;
  onSend: (message: string) => Promise<unknown>;
  actionKey: string;
  once?: boolean;
  draft: string;
  setDraft: (value: string) => void;
  disabled?: boolean;
}) {
  const state = useAction(actionKey);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const locked = state.pending || state.accepted || disabled;
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
 * Native dialogs supply focus containment, Escape, an inert page and focus restoration. A sheet is centered and
 * may grow out of the control that opened it. The detail panel is not modal: the page beside it stays usable, as
 * in the app, and Escape or a press outside it closes it; rows that open a panel are marked `data-opens-panel`
 * so a press on one swaps the panel instead.
 */
export function Dialog({
  label,
  labelId,
  onClose,
  variant = 'sheet',
  origin,
  className,
  style,
  children,
}: {
  label?: string;
  labelId?: string;
  onClose: () => void;
  variant?: 'sheet' | 'detail-panel';
  origin?: DOMRect;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressed = useRef(false);
  const unmounting = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  const modal = variant !== 'detail-panel';
  const leaving = useContext(PanelLeavingContext);
  useEffect(() => {
    if (modal || !leaving) return;
    const dialog = ref.current!;
    // Out of reach while it goes: nothing it shows can be pressed any more.
    dialog.inert = true;
    const exit = dialog.animate(
      [{ translate: '0 0', opacity: 1, filter: 'blur(0px)' }, { translate: '28px 0', opacity: 0, filter: 'blur(6px)' }],
      { duration: PANEL_EXIT_MS, easing: EASE_IN_OUT, fill: 'forwards' },
    );
    return () => {
      exit.cancel();
      dialog.inert = false;
    };
  }, [leaving]);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    unmounting.current = false;
    if (modal) dialog.showModal();
    else dialog.show();
    if (origin) growFrom(dialog, origin);
    if (!modal) dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    return () => {
      unmounting.current = true;
      dialog.close();
      if (modal || dialog.contains(document.activeElement) || document.activeElement === document.body) previous?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (modal) return;
    const dialog = ref.current!;
    const escape = (event: KeyboardEvent) => {
      // A modal opened over the page, or a menu inside the panel, handles its own Escape.
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]:modal')) return;
      close.current();
    };
    const away = (event: PointerEvent) => {
      const target = event.target as Element;
      if (dialog.contains(target) || target.closest?.('[data-opens-panel], dialog, .palette-layer, .menu-list')) return;
      close.current();
    };
    document.addEventListener('keydown', escape);
    document.addEventListener('pointerdown', away);
    return () => {
      document.removeEventListener('keydown', escape);
      document.removeEventListener('pointerdown', away);
    };
  }, [modal]);
  return (
    <dialog
      ref={ref}
      className={`${variant} ${className ?? ''}`}
      style={style}
      aria-label={label}
      aria-labelledby={labelId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={(event) => {
        if (!modal) return;
        // Repeated Escape without user activation closes a dialog natively despite preventDefault.
        // The parent decides: if it still renders this dialog, show it again.
        // A close queued before a remount (StrictMode runs effects twice) arrives with the dialog open again.
        if (unmounting.current || event.currentTarget.open) return;
        onClose();
        const dialog = event.currentTarget;
        requestAnimationFrame(() => {
          if (!unmounting.current && dialog.isConnected && !dialog.open) dialog.showModal();
        });
      }}
      onPointerDown={(event) => {
        pressed.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (!modal || !pressed.current || event.target !== event.currentTarget) return;
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
/** `short` is the label to fall back to where the full one would not leave room; the full one stays its name and tooltip. */
export function CopyButton({ text, short, children }: { text: string; short?: string; children: string }) {
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
        aria-label={short && !copied ? children : undefined}
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
        {copied ? 'Copied' : short ? <><span className="label-long">{children}</span><span className="label-short" aria-hidden="true">{short}</span></> : children}
      </button>
      {failed && <span className="action-message selectable">Could not copy. Select and copy: {text}</span>}
    </>
  );
}
/**
 * A pop-up menu: focus moves to its first item, arrows move between items, and a choice, Escape, a click
 * elsewhere or tabbing away closes it and returns focus to its button.
 */
export function Menu({ label, icon, text, children }: { label: string; icon: LucideIcon; text?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  return (
    <div
      className="menu"
      ref={ref}
      onBlur={(event) => {
        if (open && !ref.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === 'Escape') {
          // Keeps the Escape from also closing a dialog the menu sits in.
          event.stopPropagation();
          event.preventDefault();
          close(true);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const list = items();
          const at = list.indexOf(document.activeElement as HTMLButtonElement);
          list[(at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
        }
      }}
    >
      <button
        ref={button}
        className={text ? 'menu-pill' : 'icon'}
        aria-label={text ? undefined : label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon icon={icon} />
        {text}
        {text && <ChevronDown className="menu-pill-chevron" size={12} aria-hidden="true" />}
      </button>
      {open && (
        <div
          className="menu-list"
          role="menu"
          aria-label={label}
          // Safari and Firefox on macOS do not focus a clicked button; keep focus in the menu so blur does not close it first.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => close(true)}
        >
          {children}
        </div>
      )}
    </div>
  );
}
/** A light, centered empty state. `plain` shows the icon without its tile, for an icon that is its own shape. */
export function EmptyState({ title, icon, detail, plain, children }: { title: string; icon: LucideIcon; detail?: string; plain?: boolean; children?: ReactNode }) {
  return (
    <div className={plain ? 'empty-state plain' : 'empty-state'}>
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
export function useDraft(key: string): [string, (text: string) => void] {
  const text = useSyncExternalStore(drafts.subscribe, () => drafts.get(key));
  return [text, (value: string) => drafts.set(key, value)];
}
/** A context menu with one Copy item, as the app offers on paths, titles and ids. */
export function CopyMenu({ text, label, children }: { text: string; label: string; children: ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const item = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!at) return;
    item.current?.focus();
    const away = (event: Event) => {
      if (!item.current?.contains(event.target as Node)) setAt(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setAt(null);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('blur', away);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', away);
    };
  }, [at]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div
      className="copy-menu"
      onContextMenu={(event) => {
        event.preventDefault();
        setAt({ x: Math.min(event.clientX, innerWidth - 168), y: Math.min(event.clientY, innerHeight - 48) });
      }}
    >
      {children}
      {at && (
        <div className="menu-list context" role="menu" aria-label={label} style={{ left: at.x, top: at.y }}>
          <button
            ref={item}
            role="menuitem"
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {});
              setAt(null);
            }}
          >
            <Icon icon={Copy} />
            {label}
          </button>
        </div>
      )}
      {copied && <span className="toast" role="status"><Icon icon={Check} />Copied</span>}
    </div>
  );
}
/**
 * A ref for one line of text that fades at its end only when it is cut, as the app's fadeTruncated does; text
 * that fits keeps every letter.
 */
export function useFade<T extends HTMLElement>() {
  const observer = useRef<ResizeObserver>(null);
  return (element: T | null) => {
    observer.current?.disconnect();
    if (!element) return;
    const check = () => element.toggleAttribute('data-cut', element.scrollWidth > element.clientWidth + 1);
    observer.current = new ResizeObserver(check);
    observer.current.observe(element);
    check();
  };
}
