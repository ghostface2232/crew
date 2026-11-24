import { createContext, Fragment, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  AlertBadge16Regular, ArrowUp16Filled, Checkmark16Regular, CheckmarkCircle16Regular, CheckmarkRegular,
  ChevronUpDown16Regular, Circle16Regular, ClockWarning16Regular, CopyRegular, DismissRegular, ErrorCircle16Regular,
  RecordStop16Regular, SpinnerIos16Regular, Warning16Regular,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import { elapsed } from './model.ts';
import { t } from './i18n.ts';
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

/** Open modal sheets, topmost last; only the topmost takes Escape. */
const modals: HTMLDialogElement[] = [];
/** How long a side panel takes to leave, shorter than it takes to arrive. */
export const PANEL_EXIT_MS = 300;
/** How long a sheet takes to leave, likewise. */
export const SHEET_EXIT_MS = 220;
/** True while a side panel or a sheet is still on screen only to play its exit; the Dialog inside reads it. */
export const LeavingContext = createContext(false);
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
export function sameItems<T>(a: readonly T[], b: readonly T[], equal: (a: T, b: T) => boolean = Object.is) {
  return a === b || (a.length === b.length && a.every((item, index) => equal(item, b[index])));
}

export function useStableItems<T>(items: T[], equal?: (a: T, b: T) => boolean) {
  const stabilize = useMemo(() => {
    let previous: T[] = [];
    return (next: T[], compare?: (a: T, b: T) => boolean) => {
      if (!sameItems(previous, next, compare)) previous = next;
      return previous;
    };
  }, []);
  return stabilize(items, equal);
}

const idleSubscribe: (listener: () => void) => () => void = () => () => {};
const initialTime = Date.now();
const ClockContext = createContext({
  getSnapshot: () => initialTime,
  subscribe: idleSubscribe,
});

function createClock() {
  let now = Date.now();
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => now,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    tick() {
      if (document.hidden) return;
      now = Date.now();
      listeners.forEach((listener) => listener());
    },
  };
}

export function useClock<T>(select: (now: number) => T, live = true): T {
  const clock = useContext(ClockContext);
  const getSnapshot = () => select(clock.getSnapshot());
  return useSyncExternalStore(live ? clock.subscribe : idleSubscribe, getSnapshot);
}

export function Elapsed({ start, end, prefix = '', suffix = '' }: { start: number; end?: number | null; prefix?: string; suffix?: string }) {
  const text = useClock((now) => elapsed((end ?? now) - start), end == null);
  return prefix + text + suffix;
}

export function ClockProvider({ skew, children }: { skew: number; children: ReactNode }) {
  const [clock] = useState(createClock);
  const value = useMemo(() => ({ subscribe: clock.subscribe, getSnapshot: () => clock.getSnapshot() + skew }), [clock, skew]);
  useEffect(() => {
    const timer = setInterval(clock.tick, 1000);
    document.addEventListener('visibilitychange', clock.tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', clock.tick);
    };
  }, [clock]);
  return <ClockContext value={value}>{children}</ClockContext>;
}
/** The motion language: things open on a long, soft ease-out and close quicker, as the reference menus do. */
export const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
export const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)';
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** A count with its noun, singular for one. */
export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
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
export const Icon = memo(function Icon({ icon: Glyph, size = 15, className = '', filled }: { icon: FluentIcon; size?: number; className?: string; filled?: boolean }) {
  return <Glyph fontSize={size} filled={filled} aria-hidden="true" className={className} />;
});
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
const STATUS_ICONS: Record<string, FluentIcon> = {
  waiting: AlertBadge16Regular,
  failed: Warning16Regular,
  error: Warning16Regular,
  stalled: ClockWarning16Regular,
  done: CheckmarkCircle16Regular,
  running: SpinnerIos16Regular,
  working: SpinnerIos16Regular,
  active: SpinnerIos16Regular,
  cancelled: RecordStop16Regular,
  abandoned: RecordStop16Regular,
};
export const statusIcon = (state: string) => STATUS_ICONS[state] ?? Circle16Regular;
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
/** A job's or session's status as its symbol alone, quieter than a chip in a list of them; the word is its name. */
export function StatusIcon({ state, label }: { state: string; label: string }) {
  return (
    <span className="status-icon" data-state={state} role="img" aria-label={label} title={label}>
      <Icon icon={statusIcon(state)} />
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
        <i className="spinner" aria-label={t('Sending')} />
      ) : state.text ? (
        <>
          <Icon icon={state.tone ? ErrorCircle16Regular : Checkmark16Regular} />
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
        aria-label={t('Send {what}', { what: label.toLowerCase() })}
        title={t('Send {what}', { what: label.toLowerCase() })}
        disabled={!draft.trim() || locked}
        onClick={async () => {
          const message = draft.trim();
          const sent = await actions.run(actionKey, () => onSend(message), { once });
          if (sent && draftRef.current.trim() === message) setDraft('');
        }}
      >
        <Icon icon={ArrowUp16Filled} />
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
  const leaving = useContext(LeavingContext);
  useEffect(() => {
    if (!leaving) return;
    const dialog = ref.current!;
    // Out of reach while it goes: nothing it shows can be pressed any more.
    dialog.inert = true;
    // Each leaves the way it came: a panel back toward its edge, a sheet settling down as its backdrop clears.
    const exits = modal
      ? [
        dialog.animate([{ opacity: 1, scale: 1, translate: '0 0' }, { opacity: 0, scale: 0.97, translate: '0 8px' }], { duration: SHEET_EXIT_MS, easing: EASE_IN_OUT, fill: 'forwards' }),
        dialog.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SHEET_EXIT_MS, easing: 'ease-out', fill: 'forwards', pseudoElement: '::backdrop' }),
      ]
      : [dialog.animate(
        [{ translate: '0 0', opacity: 1, filter: 'blur(0px)' }, { translate: '28px 0', opacity: 0, filter: 'blur(6px)' }],
        { duration: PANEL_EXIT_MS, easing: EASE_IN_OUT, fill: 'forwards' },
      )];
    return () => {
      for (const exit of exits) exit.cancel();
      dialog.inert = false;
    };
  }, [leaving]);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    unmounting.current = false;
    if (modal) {
      dialog.showModal();
      modals.push(dialog);
    } else dialog.show();
    if (origin) growFrom(dialog, origin);
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    return () => {
      unmounting.current = true;
      if (modals.includes(dialog)) modals.splice(modals.indexOf(dialog), 1);
      dialog.close();
      if (modal || dialog.contains(document.activeElement) || document.activeElement === document.body) previous?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!modal) return;
    const dialog = ref.current!;
    // Escape is handled here rather than left to the browser, which closes a dialog anyway on a repeated Escape and would
    // then show it again above whatever its parent opened in answer, such as `ask`'s question. It listens on the document,
    // so an Escape still arrives when focus has fallen out of the dialog; only the topmost sheet takes it, and a held key
    // acts once.
    const escape = (event: KeyboardEvent) => {
      // A sheet that is leaving is inert, and has already answered its close.
      if (event.key !== 'Escape' || event.defaultPrevented || modals.at(-1) !== dialog || dialog.inert) return;
      event.preventDefault();
      if (!event.repeat) close.current();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [modal]);
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
      <Icon icon={DismissRegular} />
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
        <Icon icon={copied ? CheckmarkRegular : CopyRegular} />
        {copied ? t('Copied') : short ? <><span className="label-long">{children}</span><span className="label-short" aria-hidden="true">{short}</span></> : children}
      </button>
      {failed && <span className="action-message selectable">{t('Could not copy. Select and copy: {text}', { text })}</span>}
    </>
  );
}
/**
 * A pop-up menu: focus moves to its first item, arrows move between items, and a choice, Escape, a click
 * elsewhere or tabbing away closes it and returns focus to its button.
 */
export function Menu({ label, icon, children }: { label: string; icon: FluentIcon; children: ReactNode }) {
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
        className="icon"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon icon={icon} />
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
/**
 * A pick-one list in place of the system's select, which draws in the platform's own style. Focus stays on the button, which
 * names the active option, while the list is open in the top layer so no scrolling box clips it. It sits beside
 * its button in the DOM, so it stays inside a modal dialog's reach.
 */
export function Select<T extends string>({
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
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const chosen = options.findIndex(([option]) => option === value);
  const typed = useRef({ text: '', at: 0 });
  const show = () => {
    setActive(Math.max(0, chosen));
    setOpen(true);
    // Safari and Firefox on macOS do not focus a clicked button, and the list's keys go to the button.
    button.current?.focus();
  };
  /** The next option whose text starts with what was typed in the last moment, as the system's list finds one. */
  const typeahead = (key: string, from: number) => {
    const now = Date.now();
    typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + key.toLowerCase(), at: now };
    const { text } = typed.current;
    const start = text.length === 1 ? from + 1 : from;
    for (let step = 0; step < options.length; step++) {
      const index = (start + step) % options.length;
      if (options[index][1].toLowerCase().startsWith(text)) return index;
    }
    return -1;
  };
  const choose = (index: number) => {
    setOpen(false);
    const option = options[index];
    if (option && option[0] !== value) onChange(option[0]);
  };
  useLayoutEffect(() => {
    const popup = list.current;
    if (!open || !popup) return;
    popup.showPopover();
    // Below the button, or above it when there is more room there, as the system's list opens.
    const opened = button.current!.getBoundingClientRect();
    const below = innerHeight - opened.bottom - 12;
    const above = opened.top - 12;
    const up = popup.scrollHeight > below && above > below;
    popup.style.minWidth = `${opened.width}px`;
    popup.style.maxHeight = `${up ? above : below}px`;
    popup.toggleAttribute('data-up', up);
    // It follows the button when a box around it scrolls, as a list anchored to it would.
    const place = () => {
      const anchor = button.current!.getBoundingClientRect();
      popup.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - popup.offsetWidth - 8))}px`;
      popup.style.top = `${up ? anchor.top - 4 - popup.offsetHeight : anchor.bottom + 4}px`;
    };
    place();
    popup.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    // A press elsewhere, a resize or leaving the window closes it, as it does the system's.
    const away = (event: Event) => {
      const target = event.target as Node;
      // A press on the button, or on a label around it whose click reaches the button, is left to the button's own toggle.
      const labelled = [...(button.current?.labels ?? [])].some((label) => label.contains(target));
      if (!popup.contains(target) && !button.current?.contains(target) && !labelled) setOpen(false);
    };
    const scrolled = (event: Event) => !popup.contains(event.target as Node) && place();
    const leave = () => setOpen(false);
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', leave);
    window.addEventListener('blur', leave);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', leave);
      window.removeEventListener('blur', leave);
      if (popup.matches(':popover-open')) popup.hidePopover();
    };
  }, [open]);
  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="select"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
          const letter = event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey;
          if (!open) {
            if (move) {
              event.preventDefault();
              show();
            } else if (letter) {
              const found = typeahead(event.key, chosen);
              if (found >= 0) choose(found);
            }
            return;
          }
          if (event.key === 'Tab') {
            // Tab takes the highlighted option and moves on, as the system's list does.
            choose(active);
            return;
          }
          if (letter) {
            const found = typeahead(event.key, active);
            if (found >= 0) setActive(found);
          } else if (move) setActive((active + move + options.length) % options.length);
          else if (event.key === 'Home') setActive(0);
          else if (event.key === 'End') setActive(options.length - 1);
          else if (event.key === 'Enter' || event.key === ' ') choose(active);
          else if (event.key === 'Escape') {
            // Keeps the Escape from also closing a dialog the list sits in.
            event.stopPropagation();
            setOpen(false);
          } else return;
          event.preventDefault();
        }}
      >
        {/* A value no option holds shows the first option, as the system's select does. */}
        <span>{(options[chosen] ?? options[0])?.[1]}</span>
        <Icon icon={ChevronUpDown16Regular} size={13} />
      </button>
      {open && (
        <ul
          ref={list}
          id={id}
          className="select-list"
          role="listbox"
          aria-label={label}
          popover="manual"
          // Keeps focus on the button, and stops a click here from also pressing the button through a label around it.
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => event.preventDefault()}
        >
          {options.map(([option, text], index) => (
            <li
              key={option}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === chosen}
              data-active={index === active || undefined}
              onPointerMove={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <span>{text}</span>
              {index === chosen && <Icon icon={Checkmark16Regular} size={13} />}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
type Question = { title: string; detail?: string; action: string; answer: (yes: boolean) => void };
let asker: ((question: Question) => void) | null = null;
/** Asks before a step that throws work away, in the board's own sheet in place of the system's confirm(). */
export function ask(title: string, action: string, detail?: string) {
  return new Promise<boolean>((answer) => (asker ? asker({ title, detail, action, answer }) : answer(false)));
}
/** Where `ask` shows its question; mounted once. */
export function AskHost() {
  const [question, setQuestion] = useState<Question | null>(null);
  // The open question, so one that is replaced or left by an unmount is still answered, as no.
  const open = useRef<Question>(null);
  useEffect(() => {
    asker = (next) => {
      open.current?.answer(false);
      open.current = next;
      setQuestion(next);
    };
    return () => {
      asker = null;
      open.current?.answer(false);
      open.current = null;
    };
  }, []);
  if (!question) return null;
  const answer = (yes: boolean) => {
    open.current = null;
    setQuestion(null);
    question.answer(yes);
  };
  return (
    <Dialog labelId="ask-title" className="ask" onClose={() => answer(false)}>
      <div className="sheet-body">
        <h2 className="title" id="ask-title">{question.title}</h2>
        {question.detail && <p className="secondary">{question.detail}</p>}
        <div className="ask-actions">
          <button onClick={() => answer(false)}>{t('Cancel')}</button>
          <button className="prominent" onClick={() => answer(true)}>{question.action}</button>
        </div>
      </div>
    </Dialog>
  );
}
/** t() for a sentence whose placeholders are elements, such as a command in <code>, so the words around them can move. */
export function tNodes(text: string, values: Record<string, ReactNode>): ReactNode {
  return t(text).split(/\{(\w+)\}/).map((part, index) => <Fragment key={index}>{index % 2 ? (values[part] ?? `{${part}}`) : part}</Fragment>);
}
/** A light, centered empty state. */
export function EmptyState({ title, icon, detail, children }: { title: string; icon: FluentIcon; detail?: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon icon={icon} />
      <b>{title}</b>
      {detail && <p>{detail}</p>}
      {children}
    </div>
  );
}
export function ContentPanel({ title, icon, children }: { title?: string; icon?: FluentIcon; children: ReactNode }) {
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
            <Icon icon={CopyRegular} />
            {label}
          </button>
        </div>
      )}
      {copied && <span className="toast" role="status"><Icon icon={Checkmark16Regular} />{t('Copied')}</span>}
    </div>
  );
}
/**
 * A ref for one line of text that fades at its end only when it is cut, as the app's fadeTruncated does; text
 * that fits keeps every letter.
 */
export function useFade<T extends HTMLElement>(text: string, current?: boolean) {
  const measurement = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    measurement.current?.();
  }, [text, current]);
  return useCallback((element: T | null) => {
    if (!element) return;
    const check = () => {
      element.toggleAttribute('data-cut', element.scrollWidth > element.clientWidth + 1);
    };
    const observer = new ResizeObserver(check);
    const fonts = document.fonts;
    measurement.current = check;
    observer.observe(element);
    fonts?.addEventListener('loadingdone', check);
    return () => {
      fonts?.removeEventListener('loadingdone', check);
      observer.disconnect();
      measurement.current = null;
    };
  }, []);
}
