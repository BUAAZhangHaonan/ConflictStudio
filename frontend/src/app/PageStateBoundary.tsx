import type { PropsWithChildren, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../components';
import { useExamplePageState } from './useExamplePageState';

function BoundaryStateView({
  state,
  title,
  body,
  action,
}: {
  state: 'loading' | 'empty' | 'filtered' | 'error' | 'conflict';
  title: ReactNode;
  body: ReactNode;
  action?: { label: ReactNode; onClick: () => void };
}) {
  return (
    <section
      className="state-view"
      aria-live={state === 'error' || state === 'conflict' ? 'assertive' : 'polite'}
    >
      <h1>{title}</h1>
      <p>{body}</p>
      {action ? <Button variant="secondary" onClick={action.onClick}>{action.label}</Button> : null}
    </section>
  );
}

export function PageStateBoundary({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const state = useExamplePageState();
  if (state === 'ready') return <>{children}</>;

  const action = state === 'loading'
    ? undefined
    : state === 'empty'
    ? { label: t('actions.goWorkspace'), onClick: () => navigate('/workspace') }
    : state === 'filtered'
      ? { label: t('actions.clearFilters'), onClick: () => navigate(location.pathname, { replace: true }) }
      : { label: t('actions.retry'), onClick: () => navigate(location.pathname, { replace: true }) };

  return (
    <BoundaryStateView
      state={state}
      title={t(`state.${state}.title`)}
      body={t(`state.${state}.body`)}
      action={action}
    />
  );
}
