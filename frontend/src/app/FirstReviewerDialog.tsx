import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { apiErrorMessage } from '../api/client';
import { useCreateReviewerMutation, useReviewersQuery } from '../api/queries';
import { Button, Dialog, Field } from '../components';
import { setCurrentReviewer, usePreferences } from '../preferences';

export function FirstReviewerDialog() {
  const { t } = useTranslation();
  const preferences = usePreferences();
  const reviewersQuery = useReviewersQuery();
  const createMutation = useCreateReviewerMutation();
  const reviewers = reviewersQuery.data ?? [];
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [selectedReviewerId, setSelectedReviewerId] = useState<number | null>(null);
  const currentReviewer = useMemo(
    () => reviewers.find(reviewer => reviewer.id === preferences.currentReviewerId) ?? null,
    [preferences.currentReviewerId, reviewers],
  );
  const open = reviewersQuery.isSuccess && currentReviewer === null;

  useEffect(() => {
    if (reviewers.length === 0) {
      setMode('new');
      setSelectedReviewerId(null);
      return;
    }
    if (selectedReviewerId === null || !reviewers.some(reviewer => reviewer.id === selectedReviewerId)) {
      setSelectedReviewerId(reviewers[0].id);
      setMode('existing');
    }
  }, [reviewers, selectedReviewerId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    createMutation.reset();
    if (mode === 'existing' && selectedReviewerId !== null) {
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

  const locale = preferences.locale;
  return (
    <Dialog
      open={open}
      title={reviewers.length > 0 ? t('app.currentReviewer') : t('reviewer.firstTitle')}
      closeLabel={t('actions.close')}
      onClose={() => undefined}
      dismissible={false}
      footer={
        <Button type="submit" form="first-reviewer-form" variant="primary" busy={createMutation.isPending}>
          {t('actions.confirmName')}
        </Button>
      }
    >
      <form id="first-reviewer-form" onSubmit={submit}>
        {reviewers.length > 0 ? (
          <fieldset className="choice-list">
            <legend>{t('app.currentReviewer')}</legend>
            {reviewers.map((reviewer, index) => (
              <label key={reviewer.id}>
                <input
                  type="radio"
                  name="first-reviewer"
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
                name="first-reviewer"
                checked={mode === 'new'}
                onChange={() => {
                  setMode('new');
                  createMutation.reset();
                }}
              />
              <span>{t('actions.addName')}</span>
            </label>
          </fieldset>
        ) : null}
        {reviewers.length === 0 || mode === 'new' ? (
          <>
            <p>{t('reviewer.firstBody')}</p>
            <Field
              label={t('reviewer.nameLabel')}
              htmlFor="first-reviewer-name"
              required
              error={createMutation.error ? apiErrorMessage(createMutation.error, locale) : undefined}
            >
              <input
                id="first-reviewer-name"
                autoFocus={reviewers.length === 0}
                required
                value={name}
                onChange={event => {
                  setName(event.target.value);
                  createMutation.reset();
                }}
                placeholder={t('reviewer.namePlaceholder')}
                autoComplete="name"
              />
            </Field>
          </>
        ) : null}
      </form>
    </Dialog>
  );
}
