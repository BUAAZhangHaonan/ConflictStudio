import type { ReactNode } from 'react';

export function Metric({ label, value, detail }: { label: ReactNode; value: ReactNode; detail?: ReactNode }) {
  return (
    <section className="metric">
      <span className="metric__label">{label}</span>
      <strong className="metric__value">{value}</strong>
      {detail ? <span className="metric__detail">{detail}</span> : null}
    </section>
  );
}
