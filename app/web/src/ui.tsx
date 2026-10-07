// Hand-vendored shadcn-style primitives (MIT, zero deps).
// Rules followed: cn() for conditionals, flex+gap (never space-*), size-*
// for square icons, full Card composition, Dialog/Sheet always with Title,
// Badge variants (never raw colors), Skeleton for loading, Separator, Empty,
// Alert for callouts. Chat bubbles live in ChatView (Bubble equivalent).
import React from 'react';

/** Conditional classes without ternaries. */
export const cn = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(' ');

// ------------------------------------------------------------- Button ---
type BtnVariant = 'default' | 'primary' | 'danger';
type BtnSize = 'default' | 'sm' | 'icon';
export function Button({
  variant = 'default',
  size = 'default',
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant;
  size?: BtnSize;
}) {
  return (
    <button
      className={cn(
        'btn',
        variant === 'primary' && 'btn-primary',
        variant === 'danger' && 'btn-danger',
        size === 'sm' && 'btn-sm',
        size === 'icon' && 'btn-icon',
        className,
      )}
      {...rest}
    />
  );
}

// --------------------------------------------------------------- Card ---
export const Card = ({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('card', className)} {...rest} />
);
export const CardHeader = ({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('card-h', className)} {...rest} />
);
export const CardTitle = ({ className, ...rest }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn('card-t', className)} {...rest} />
);
export const CardDescription = ({ className, ...rest }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('card-d', className)} {...rest} />
);
export const CardContent = ({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('card-c', className)} {...rest} />
);
export const CardFooter = ({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('card-f', className)} {...rest} />
);

// -------------------------------------------------------------- Badge ---
type BadgeVariant = 'default' | 'local' | 'mainnet' | 'danger' | 'warn' | 'ok';
export const Badge = ({
  variant = 'default',
  className,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) => (
  <span
    className={cn(
      'badge',
      variant === 'local' && 'badge-local',
      variant === 'mainnet' && 'badge-mainnet',
      variant === 'danger' && 'badge-danger',
      variant === 'warn' && 'badge-warn',
      variant === 'ok' && 'badge-ok',
      className,
    )}
    {...rest}
  />
);

// -------------------------------------------------------------- Field ---
export const FieldLabel = ({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) => (
  <label className="field-label" htmlFor={htmlFor}>{children}</label>
);
export const FieldHint = ({ children }: { children: React.ReactNode }) => (
  <p className="field-hint">{children}</p>
);
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function Input({ invalid, className, ...rest }, ref) {
  return <input ref={ref} aria-invalid={invalid || undefined} className={cn('input', invalid && 'field-invalid', className)} {...rest} />;
});
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn('textarea', className)} {...rest} />;
});

// ---------------------------------------------------------- Separator ---
export const Separator = () => <hr className="sep" />;

// --------------------------------------------------------------- Alert ---
type AlertVariant = 'default' | 'danger' | 'warn' | 'ok';
export const Alert = ({
  variant = 'default',
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { variant?: AlertVariant }) => (
  <div
    role={variant === 'danger' || variant === 'warn' ? 'alert' : undefined}
    className={cn(
      'alert',
      variant === 'danger' && 'alert-danger',
      variant === 'warn' && 'alert-warn',
      variant === 'ok' && 'alert-ok',
      className,
    )}
    {...rest}
  />
);

// ------------------------------------------------------------ Skeleton ---
export const Skeleton = ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
  <div className={cn('skel', className)} style={style} aria-hidden="true" />
);
export const Spinner = () => <span className="spin" role="status" aria-label="Loading" />;

// --------------------------------------------------------- Empty state ---
export const Empty = ({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) => (
  <div className="empty">
    <h3>{title}</h3>
    {children ? <p>{children}</p> : null}
    {action ? <div style={{ marginTop: 14 }}>{action}</div> : null}
  </div>
);

// -------------------------------------------------------------- Dialog ---
// Focus trap + restore focus to the trigger + aria-describedby.
// Esc and overlay-click still close (behavior unchanged).
function useOverlayFocus(onClose: () => void) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const descId = React.useId();
  const prevFocus = React.useRef<Element | null>(null);
  React.useEffect(() => {
    prevFocus.current = document.activeElement;
    const box = boxRef.current;
    const focusables = () =>
      box
        ? Array.from(
            box.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];
    // Focus the first control so keyboard users land inside the dialog.
    (focusables()[0] ?? box)?.focus?.();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !box) return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        box.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      (prevFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);
  return { boxRef, descId };
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { boxRef, descId } = useOverlayFocus(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={boxRef} tabIndex={-1} className="dialog" role="dialog" aria-modal="true" aria-label={title} aria-describedby={descId}>
        <div className="card-h"><h3 className="card-t">{title}</h3></div>
        <div className="card-c" id={descId}>{children}</div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- Sheet ---
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const { boxRef, descId } = useOverlayFocus(onClose);
  return (
    <div className="sheet-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={boxRef} tabIndex={-1} className="sheet" role="dialog" aria-modal="true" aria-label={title} aria-describedby={descId}>
        <div className="card-h"><h3 className="card-t">{title}</h3></div>
        <div className="card-c" id={descId}>{children}</div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- Icons ---
// Lucide-style stroke icons, inline SVG (no dep). Size via CSS, never classes.
const I = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
export const IconPlus = () => (<I><path d="M12 5v14M5 12h14" /></I>);
export const IconSend = () => (<I><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></I>);
export const IconMenu = () => (<I><path d="M4 6h16M4 12h16M4 18h16" /></I>);
export const IconX = () => (<I><path d="M18 6 6 18M6 6l12 12" /></I>);
export const IconChat = () => (<I><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></I>);
export const IconShield = () => (<I><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></I>);
export const IconTrash = () => (<I><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></I>);
export const IconPrint = () => (<I><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></I>);
export const IconWallet = () => (<I><rect x="2" y="6" width="20" height="14" rx="2" /><path d="M2 10h20" /></I>);
export const IconSearch = () => (<I><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></I>);
export const IconPlay = () => (<I><polygon points="6 3 20 12 6 21 6 3" /></I>);
export const IconCheck = () => (<I><path d="M20 6 9 17l-5-5" /></I>);
export const IconAlert = () => (<I><path d="m12 9-1 4h2l-1-4z" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 17h.01" /></I>);
