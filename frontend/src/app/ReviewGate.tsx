import { useTranslation } from 'react-i18next';
import { Link, Outlet, useOutletContext } from 'react-router-dom';
import { apiErrorMessage } from '../api/client';
import type { Reviewer } from '../api/contracts';
import { Button, PageHeader } from '../components';
import { useReviewerState } from '../preferences';
import './ReviewGate.css';

interface ReviewGateContext {
  reviewer: Reviewer | null;
}

export function useReviewGateReviewer(): Reviewer | null {
  return useOutletContext<ReviewGateContext>().reviewer;
}

export function ReviewGate() {
  const { t, i18n } = useTranslation();
  const { currentReviewer, isPending, error, retry } = useReviewerState();
  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';

  if (isPending) {
    return (
      <section className="page-stack review-gate" aria-label={t('review.gate.aria')}>
        <PageHeader title={t('review.gate.loadingTitle')} />
        <section className="state-view" role="status">
          <span className="state-view__progress" aria-hidden="true" />
          <h2>{t('review.gate.loadingTitle')}</h2>
          <p>{t('review.gate.loadingBody')}</p>
        </section>
      </section>
    );
  }

  if (error) {
    return (
      <section className="page-stack review-gate" aria-label={t('review.gate.aria')}>
        <PageHeader title={t('review.gate.errorTitle')} />
        <section className="state-view" role="alert">
          <h2>{t('review.gate.errorTitle')}</h2>
          <p>{apiErrorMessage(error, locale)}</p>
          <Button variant="secondary" onClick={() => { void retry(); }}>{t('actions.retry')}</Button>
        </section>
      </section>
    );
  }

  return (
    <>
      {currentReviewer === null ? (
        <aside className="review-gate__banner" role="status">
          <p>{t('review.gate.guestBody')}</p>
          <Link to="/settings">{t('review.gate.guestSettings')}</Link>
        </aside>
      ) : null}
      <Outlet context={{ reviewer: currentReviewer } satisfies ReviewGateContext} />
    </>
  );
}
