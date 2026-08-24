import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';

type StateKind = 'loading' | 'empty' | 'filtered' | 'error' | 'conflict';

interface StateViewProps {
  state: StateKind;
  title?: string;
  body?: string;
  action?: { label: ReactNode; onClick: () => void };
}

export function StateView({ state, title, body, action }: StateViewProps) {
  const { t } = useTranslation();
  return (
    <section className="state-view" aria-live={state === 'error' || state === 'conflict' ? 'assertive' : 'polite'}>
      {state === 'loading' ? <span className="state-view__progress" aria-hidden="true" /> : null}
      <h2>{title ?? t(`state.${state}.title`)}</h2>
      <p>{body ?? t(`state.${state}.body`)}</p>
      {action ? <Button variant="secondary" onClick={action.onClick}>{action.label}</Button> : null}
    </section>
  );
}
