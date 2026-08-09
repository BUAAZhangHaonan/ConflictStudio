import type { ReactNode } from 'react';

export type StatusKind = 'neutral' | 'active' | 'complete' | 'problem';

const icons: Record<StatusKind, string> = {
  neutral: '○',
  active: '●',
  complete: '✓',
  problem: '!',
};

export function StatusBadge({ label, kind = 'neutral' }: { label: ReactNode; kind?: StatusKind }) {
  return (
    <span className={`status-badge status-badge--${kind}`}>
      <span className="status-badge__icon" aria-hidden="true">{icons[kind]}</span>
      <span>{label}</span>
    </span>
  );
}
