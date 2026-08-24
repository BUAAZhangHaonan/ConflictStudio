import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useOutletContext } from 'react-router-dom';
import { ApiError, apiErrorMessage } from '../api/client';
import type { Reviewer } from '../api/contracts';
import { useCreateReviewerMutation } from '../api/queries';
import { Button, Field, PageHeader } from '../components';
import { setCurrentReviewer, useReviewerState } from '../preferences';
import './ReviewGate.css';

interface ReviewGateContext {
  reviewer: Reviewer | null;
}

export function useReviewGateReviewer(): Reviewer | null {
  return useOutletContext<ReviewGateContext>().reviewer;
}

function ReviewerSwitcherPanel({ reviewersQuery }: { reviewersQuery: ReturnType<typeof useReviewerState>['reviewersQuery'] }) {
  const { t, i18n } = useTranslation();
  const createMutation = useCreateReviewerMutation();
  const [newName, setNewName] = useState('');
  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';
  const reviewers = reviewersQuery.data?.items ?? [];
  const hasMorePages = (reviewersQuery.data?.totalPages ?? 1) > 1;
  const createError = createMutation.error;
  const nameConflict = createError instanceof ApiError && createError.code === 'reviewer_name_conflict';

  const createReviewer = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (name === '' || name.length > 80) return;
    createMutation.mutate({ name }, {
      onSuccess: reviewer => {
        setCurrentReviewer(reviewer);
        setNewName('');
      },
    });
  };

  return (
    <div className="review-gate__switcher-panel">
      {reviewers.length === 0 ? <p>{t('review.gate.noReviewers')}</p> : (
        <ul className="review-gate__reviewer-list">
          {reviewers.map(reviewer => (
            <li key={reviewer.id}>
              <Button type="button" variant="secondary" onClick={() => setCurrentReviewer(reviewer)}>{reviewer.name}</Button>
            </li>
          ))}
        </ul>
      )}
      {hasMorePages ? <p><Link to="/settings">{t('review.gate.moreInSettings')}</Link></p> : null}
      <form className="inline-form review-gate__create" onSubmit={createReviewer}>
        <Field label={t('review.gate.newLabel')} htmlFor="gate-new-reviewer-name">
          <input
            id="gate-new-reviewer-name"
            required
            value={newName}
            maxLength={80}
            onChange={event => { setNewName(event.target.value); createMutation.reset(); }}
            placeholder={t('review.gate.newPlaceholder')}
            autoComplete="name"
          />
        </Field>
        <Button type="submit" variant="secondary" busy={createMutation.isPending}>{t('review.gate.create')}</Button>
      </form>
      {createError ? (
        <p className="review-gate__create-error" role="alert">
          {nameConflict ? t('review.gate.nameConflict') : apiErrorMessage(createError, locale)}
        </p>
      ) : null}
    </div>
  );
}

export function ReviewGate() {
  const { t, i18n } = useTranslation();
  const { currentReviewer, isPending, error, retry, reviewersQuery } = useReviewerState();

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
          <p>{apiErrorMessage(error, i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US')}</p>
          <Button variant="secondary" onClick={() => { void retry(); }}>{t('actions.retry')}</Button>
        </section>
      </section>
    );
  }

  return (
    <>
      <aside className="review-gate__banner" role="status">
        <p>{currentReviewer === null ? t('review.gate.guestBody') : t('review.gate.signedInAs', { name: currentReviewer.name })}</p>
        {currentReviewer !== null ? (
          <Button type="button" variant="quiet" onClick={() => setCurrentReviewer(null)}>{t('review.gate.signOut')}</Button>
        ) : null}
        <details className="review-gate__switcher">
          <summary>{currentReviewer === null ? t('review.gate.chooseReviewer') : t('review.gate.switchReviewer')}</summary>
          <ReviewerSwitcherPanel reviewersQuery={reviewersQuery} />
        </details>
        <Link to="/settings">{t('review.gate.guestSettings')}</Link>
      </aside>
      <Outlet context={{ reviewer: currentReviewer } satisfies ReviewGateContext} />
    </>
  );
}
