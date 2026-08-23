import { useEffect, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useOutletContext } from 'react-router-dom';
import { apiErrorMessage } from '../api/client';
import type { Reviewer } from '../api/contracts';
import { useCreateReviewerMutation, useReviewerByNameQuery } from '../api/queries';
import { Button, PageHeader } from '../components';
import { setCurrentReviewer, usePreferences } from '../preferences';
import './ReviewGate.css';

export const FIXED_REVIEWER_NAME = 'zhanghaonan';

interface ReviewGateContext {
  reviewer: Reviewer;
}

export function useReviewGateReviewer(): Reviewer {
  return useOutletContext<ReviewGateContext>().reviewer;
}

export function ReviewGate() {
  const { t, i18n } = useTranslation();
  const preferences = usePreferences();
  const reviewerQuery = useReviewerByNameQuery(FIXED_REVIEWER_NAME);
  const createMutation = useCreateReviewerMutation();
  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';
  const fixedReviewer = reviewerQuery.data ?? null;
  const reviewerReady = fixedReviewer !== null
    && preferences.currentReviewerId === fixedReviewer.id
    && preferences.currentReviewerName === fixedReviewer.name;

  useEffect(() => {
    if (!reviewerQuery.isSuccess) return;
    if (
      preferences.currentReviewerId !== null
      && preferences.currentReviewerId !== fixedReviewer?.id
    ) {
      setCurrentReviewer(null);
      return;
    }
    if (fixedReviewer !== null && !reviewerReady) setCurrentReviewer(fixedReviewer);
  }, [fixedReviewer, preferences.currentReviewerId, reviewerQuery.isSuccess, reviewerReady]);

  if (reviewerReady) return <Outlet context={{ reviewer: fixedReviewer } satisfies ReviewGateContext} />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    createMutation.reset();
    createMutation.mutate({ name: FIXED_REVIEWER_NAME }, { onSuccess: setCurrentReviewer });
  };

  const resolvingReviewer = reviewerQuery.isPending
    || (reviewerQuery.isSuccess && (fixedReviewer !== null || preferences.currentReviewerId !== null));

  return (
    <section className="page-stack review-gate" aria-label={t('review.gate.aria')}>
      <PageHeader title={t('review.gate.title')} />
      {resolvingReviewer ? (
        <section className="state-view" role="status">
          <span className="state-view__progress" aria-hidden="true" />
          <h2>{t('review.gate.loadingTitle')}</h2>
          <p>{t('review.gate.loadingBody', { name: FIXED_REVIEWER_NAME })}</p>
        </section>
      ) : reviewerQuery.error ? (
        <section className="state-view" role="alert">
          <h2>{t('review.gate.errorTitle')}</h2>
          <p>{apiErrorMessage(reviewerQuery.error, locale)}</p>
          <Button variant="secondary" onClick={() => void reviewerQuery.refetch()}>{t('actions.retry')}</Button>
        </section>
      ) : (
        <form className="panel review-gate__form" onSubmit={submit}>
          <p>{t('review.gate.body', { name: FIXED_REVIEWER_NAME })}</p>
          {createMutation.error ? <p className="field-error" role="alert">{apiErrorMessage(createMutation.error, locale)}</p> : null}
          <div className="review-gate__actions">
            <Button type="submit" variant="primary" busy={createMutation.isPending}>
              {t('review.gate.create', { name: FIXED_REVIEWER_NAME })}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
