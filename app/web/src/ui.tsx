/* Shared UI primitives — shadcn-style composition (cn + Card/Dialog parts),
   hand-written against tokens.css. No inline-script, no native prompts. */

import {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  useEffect,
  useRef,
} from 'react';

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ card */

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card', className)} {...rest} />;
}
export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card-head', className)} {...rest} />;
}
export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('card-title', className)} {...rest} />;
}
export function CardContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card-body', className)} {...rest} />;
}
export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card-foot', className)} {...rest} />;
}

/* ---------------------------------------------------------------- button */

type BtnVariant = 'primary' | 'ghost' | 'danger' | 'quiet';

export function Button({
  className,
  variant = 'ghost',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  return <button type="button" className={cn('btn', `btn-${variant}`, className)} {...rest} />;
}

/* ----------------------------------------------------------------- badge */

export function Badge({
  className,
  tone = 'neutral',
  ...rest
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: 'neutral' | 'ok' | 'caution' | 'danger' | 'info';
}) {
  return <span className={cn('badge', `badge-${tone}`, className)} {...rest} />;
}

/* ---------------------------------------------------------------- switch */

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cn('switch', checked && 'on')}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" aria-hidden="true" />
    </button>
  );
}

/* ----------------------------------------------------------------- field */

export function TextInput({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('input', className)} {...rest} />;
}

/* ---------------------------------------------------------------- dialog */

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement;
    const root = ref.current;
    const first = root?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? root)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      (prevFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="dlg-backdrop" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn('dlg', wide && 'dlg-wide')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dlg-head">
          <h2 className="dlg-title">{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="dlg-body">{children}</div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- icons */

type IconProps = { size?: number };

const svg = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export function ShieldIcon({ size = 16 }: IconProps) {
  return (
    <svg data-icon="shield" {...svg(size)}>
      <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
      <path d="M9.5 12l2 2 3.5-4" />
    </svg>
  );
}

export function WarnIcon({ size = 16 }: IconProps) {
  return (
    <svg data-icon="warn" {...svg(size)}>
      <path d="M12 4L2.5 20h19L12 4z" />
      <path d="M12 10v4M12 17.2v.3" />
    </svg>
  );
}

export function CheckIcon({ size = 16 }: IconProps) {
  return (
    <svg data-icon="check" {...svg(size)}>
      <path d="M4.5 12.5l5 5L19.5 7" />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg data-icon="close" {...svg(size)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function MenuIcon({ size = 18 }: IconProps) {
  return (
    <svg data-icon="menu" {...svg(size)}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function ChevronIcon({ size = 14 }: IconProps) {
  return (
    <svg data-icon="chevron" className="chev" {...svg(size)}>
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

export function SearchIcon({ size = 15 }: IconProps) {
  return (
    <svg data-icon="search" {...svg(size)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </svg>
  );
}

export function SendIcon({ size = 16 }: IconProps) {
  return (
    <svg data-icon="send" {...svg(size)}>
      <path d="M4 12l16-7-5 16-3.5-6.5L4 12z" />
    </svg>
  );
}

export function ExternalIcon({ size = 13 }: IconProps) {
  return (
    <svg data-icon="external" {...svg(size)}>
      <path d="M10 5H5v14h14v-5M14 4h6v6M20 4L11 13" />
    </svg>
  );
}

export function PrintIcon({ size = 15 }: IconProps) {
  return (
    <svg data-icon="print" {...svg(size)}>
      <path d="M7 8V3h10v5M7 17H4v-7h16v7h-3M7 14h10v7H7v-7z" />
    </svg>
  );
}

export function TrashIcon({ size = 14 }: IconProps) {
  return (
    <svg data-icon="trash" {...svg(size)}>
      <path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13" />
    </svg>
  );
}

export function LinkIcon({ size = 13 }: IconProps) {
  return (
    <svg data-icon="link" {...svg(size)}>
      <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1.5 1.5" />
      <path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1.5-1.5" />
    </svg>
  );
}

export function PenIcon({ size = 13 }: IconProps) {
  return (
    <svg data-icon="pen" {...svg(size)}>
      <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z" />
      <path d="M14.5 6.5l3 3" />
    </svg>
  );
}

export function SparkIcon({ size = 16 }: IconProps) {
  return (
    <svg data-icon="spark" {...svg(size)}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18" />
    </svg>
  );
}

/* ---------------------------------------------------------- data scope */

/** Shared-demo namespaces (case-insensitive, any `user-` prefix depth). */
export function isDemoNamespace(id?: string | null): boolean {
  if (id == null) return false;
  let cur = String(id);
  for (let i = 0; i < 12; i++) {
    const l = cur.toLowerCase();
    if (l === 'demo-mom' || l === 'demo-day7' || l === 'demo-day1') return true;
    const nxt = cur.replace(/^user-/i, '');
    if (nxt === cur) return false;
    cur = nxt;
  }
  return false;
}

export type ScopeKind = 'personal' | 'demo' | 'public';

export function ScopeBadge({
  scope,
  user,
}: {
  scope?: ScopeKind;
  user?: string | null;
}) {
  const s: ScopeKind =
    scope ?? (user != null && isDemoNamespace(user) ? 'demo' : 'personal');
  if (s === 'demo') {
    return (
      <Badge
        tone="neutral"
        title="Premade shared profile — nothing here is yours. Anyone can view it; nobody can change it."
      >
        Shared demo
      </Badge>
    );
  }
  if (s === 'public') {
    return (
      <Badge
        tone="info"
        title="Global public record — same for everyone, not tied to your vault."
      >
        Public record
      </Badge>
    );
  }
  return (
    <Badge
      tone="ok"
      title="Private — only your wallet vault can open this."
    >
      Personal vault
    </Badge>
  );
}
