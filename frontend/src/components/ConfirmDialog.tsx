import type { ReactNode } from 'react';
import { Dialog } from './Dialog';
import { Button } from './Button';

interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  body: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel: ReactNode;
  closeLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  closeLabel,
  onConfirm,
  onClose,
  busy = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      title={title}
      closeLabel={closeLabel}
      onClose={onClose}
      footer={
        <>
          <Button autoFocus variant="secondary" onClick={onClose}>{cancelLabel}</Button>
          <Button variant="primary" busy={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      {typeof body === 'string' ? <p>{body}</p> : body}
    </Dialog>
  );
}
