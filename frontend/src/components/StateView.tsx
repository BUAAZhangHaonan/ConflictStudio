import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';

type StateKind = 'loading' | 'empty' | 'filtered' | 'error' | 'conflict';

interface StateViewProps {
  state: StateKind;
  action?: { label: ReactNode; onClick: () => void };
}

export function StateView({ state, action }: StateViewProps) {
  const { t } = useTranslation();
  return (
    <section className="state-view" aria-live={state === 'error' || state === 'conflict' ? 'assertive' : 'polite'}>
      {state === 'loading' ? <span className="state-view__progress" aria-hidden="true" /> : null}
      <h2>{t(`state.${state}.title`)}</h2>
      <p>{t(`state.${state}.body`)}</p>
      {action ? <Button variant="secondary" onClick={action.onClick}>{action.label}</Button> : null}
    </section>
  );
}
