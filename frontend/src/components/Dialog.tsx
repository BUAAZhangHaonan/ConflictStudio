import { useEffect, useId, useRef, type PropsWithChildren, type ReactNode } from 'react';

interface DialogProps extends PropsWithChildren {
  open: boolean;
  title: ReactNode;
  closeLabel: string;
  onClose: () => void;
  footer?: ReactNode;
  dismissible?: boolean;
  size?: 'default' | 'wide' | 'test-confirm';
}

const focusableSelector = [
  'button:not([disabled]):not([tabindex="-1"])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Dialog({
  open,
  title,
  closeLabel,
  onClose,
  footer,
  dismissible = true,
  size = 'default',
  children,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      window.requestAnimationFrame(() => {
        const preferred = dialog.querySelector<HTMLElement>('[autofocus]');
        const first = dialog.querySelector<HTMLElement>(focusableSelector);
        (preferred ?? first ?? dialog).focus();
      });
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!wasOpenRef.current || open) {
      wasOpenRef.current = open;
      return;
    }
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (dismissible) onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        element => !element.hasAttribute('disabled'),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, [dismissible, onClose, open]);

  return (
    <dialog
      ref={dialogRef}
      className={`dialog dialog--${size}`}
      aria-labelledby={titleId}
      aria-modal="true"
      tabIndex={-1}
      onCancel={event => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
    >
      <div className="dialog__header">
        <h2 id={titleId}>{title}</h2>
        {dismissible ? (
          <button type="button" className="icon-button" onClick={onClose} aria-label={closeLabel}>
            <span className="dialog__close-icon" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="dialog__body">{children}</div>
      {footer ? <div className="dialog__footer">{footer}</div> : null}
    </dialog>
  );
}
