import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useOutletContext } from 'react-router-dom';
import { apiErrorMessage } from '../api/client';
import type { Reviewer } from '../api/contracts';
import { useCreateReviewerMutation } from '../api/queries';
import { Button, Field, PageHeader, Pagination } from '../components';
import { setCurrentReviewer, useReviewerState } from '../preferences';
import './ReviewGate.css';

interface ReviewGateContext {
  reviewer: Reviewer;
}

export function useReviewGateReviewer(): Reviewer {
  return useOutletContext<ReviewGateContext>().reviewer;
}

export function ReviewGate() {
  const { t, i18n } = useTranslation();
  const [reviewerPage, setReviewerPage] = useState(1);
  const reviewerState = useReviewerState(reviewerPage);
  const { reviewersQuery, currentReviewer } = reviewerState;
  const createMutation = useCreateReviewerMutation();
  const reviewers = reviewersQuery.data?.items ?? [];
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [selectedReviewerId, setSelectedReviewerId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';

  useEffect(() => {
    if (reviewers.length === 0) {
      setMode('new');
      setSelectedReviewerId(null);
      return;
    }
    setSelectedReviewerId(current => reviewers.some(reviewer => reviewer.id === current) ? current : reviewers[0].id);
  }, [reviewers]);

  if (currentReviewer !== null) return <Outlet context={{ reviewer: currentReviewer } satisfies ReviewGateContext} />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    createMutation.reset();
    if (mode === 'existing') {
      const reviewer = reviewers.find(item => item.id === selectedReviewerId);
      if (reviewer) setCurrentReviewer(reviewer);
      return;
    }
    createMutation.mutate({ name }, {
      onSuccess: reviewer => {
        setCurrentReviewer(reviewer);
        setName('');
      },
    });
  };

  return (
    <section className="page-stack review-gate" aria-label={t('review.gate.aria')}>
      <PageHeader title={t('review.gate.title')} />
      {reviewerState.isPending ? (
        <section className="state-view" role="status">
          <span className="state-view__progress" aria-hidden="true" />
          <h2>{t('review.gate.loadingTitle')}</h2>
          <p>{t('review.gate.loadingBody')}</p>
        </section>
      ) : reviewerState.error ? (
        <section className="state-view" role="alert">
          <h2>{t('review.gate.errorTitle')}</h2>
          <p>{apiErrorMessage(reviewerState.error, locale)}</p>
          <Button variant="secondary" onClick={() => void reviewerState.retry()}>{t('actions.retry')}</Button>
        </section>
      ) : (
        <form className="panel review-gate__form" onSubmit={submit}>
          <p>{t('review.gate.body')}</p>
          {reviewers.length > 0 ? (
            <fieldset className="choice-list review-gate__choices">
              <legend>{t('review.gate.existing')}</legend>
              {reviewers.map((reviewer, index) => (
                <label key={reviewer.id}>
                  <input
                    type="radio"
                    name="review-gate-reviewer"
                    value={reviewer.id}
                    checked={mode === 'existing' && selectedReviewerId === reviewer.id}
                    autoFocus={index === 0}
                    onChange={() => {
                      setMode('existing');
                      setSelectedReviewerId(reviewer.id);
                      createMutation.reset();
                    }}
                  />
                  <span>{reviewer.name}</span>
                </label>
              ))}
              <label>
                <input
                  type="radio"
                  name="review-gate-reviewer"
                  checked={mode === 'new'}
                  onChange={() => {
                    setMode('new');
                    createMutation.reset();
                  }}
                />
                <span>{t('review.gate.new')}</span>
              </label>
              <Pagination
                page={reviewersQuery.data?.page ?? 1}
                totalPages={reviewersQuery.data?.totalPages ?? 0}
                total={reviewersQuery.data?.total ?? 0}
                onPageChange={setReviewerPage}
              />
            </fieldset>
          ) : null}
          {reviewers.length === 0 || mode === 'new' ? (
            <Field
              label={t('reviewer.nameLabel')}
              htmlFor="review-gate-name"
              required
              error={createMutation.error ? apiErrorMessage(createMutation.error, locale) : undefined}
            >
              <input
                id="review-gate-name"
                autoFocus={reviewers.length === 0}
                required
                maxLength={160}
                value={name}
                onChange={event => {
                  setName(event.target.value);
                  createMutation.reset();
                }}
                placeholder={t('reviewer.namePlaceholder')}
                autoComplete="name"
              />
            </Field>
          ) : null}
          <div className="review-gate__actions">
            <Button type="submit" variant="primary" busy={createMutation.isPending}>
              {mode === 'new' ? t('review.gate.create') : t('review.gate.enter')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
