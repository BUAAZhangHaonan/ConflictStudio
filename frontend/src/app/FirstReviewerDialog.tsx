import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, Field } from '../components';
import { useMockRepository, useRepositorySnapshot } from '../store';

export function FirstReviewerDialog() {
  const { t } = useTranslation();
  const repository = useMockRepository();
  const snapshot = useRepositorySnapshot();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'existing' | 'new'>(
    snapshot.data.reviewers.length > 0 ? 'existing' : 'new',
  );
  const [selectedReviewerId, setSelectedReviewerId] = useState(
    snapshot.data.reviewers[0]?.id ?? '',
  );
  const [error, setError] = useState(false);
  const open = snapshot.preferences.currentReviewerId === null;
  const hasReviewers = snapshot.data.reviewers.length > 0;
  const availableReviewerId = snapshot.data.reviewers.some(
    reviewer => reviewer.id === selectedReviewerId,
  ) ? selectedReviewerId : snapshot.data.reviewers[0]?.id ?? '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'existing' && availableReviewerId) {
      const result = repository.setCurrentReviewer(availableReviewerId);
      if (!result.ok) {
        setError(true);
        return;
      }
      setError(false);
      return;
    }
    const result = repository.createReviewer(name);
    if (!result.ok) {
      setError(true);
      return;
    }
    setName('');
    setError(false);
  };

  return (
    <Dialog
      open={open}
      title={hasReviewers ? t('app.currentReviewer') : t('reviewer.firstTitle')}
      closeLabel={t('actions.close')}
      onClose={() => undefined}
      dismissible={false}
      footer={
        <Button type="submit" form="first-reviewer-form" variant="primary">
          {t('actions.confirmName')}
        </Button>
      }
    >
      <form id="first-reviewer-form" onSubmit={submit}>
        {hasReviewers ? (
          <fieldset className="choice-list">
            <legend>{t('app.currentReviewer')}</legend>
            {snapshot.data.reviewers.map((reviewer, index) => (
              <label key={reviewer.id}>
                <input
                  type="radio"
                  name="first-reviewer"
                  value={reviewer.id}
                  checked={mode === 'existing' && availableReviewerId === reviewer.id}
                  autoFocus={index === 0}
                  onChange={() => {
                    setMode('existing');
                    setSelectedReviewerId(reviewer.id);
                    setError(false);
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
                  setError(false);
                }}
              />
              <span>{t('actions.addName')}</span>
            </label>
          </fieldset>
        ) : null}
        {!hasReviewers || mode === 'new' ? (
          <>
            <p>{t('reviewer.firstBody')}</p>
            <Field
              label={t('reviewer.nameLabel')}
              htmlFor="first-reviewer-name"
              required
              error={error ? t('reviewer.nameInvalid') : undefined}
            >
              <input
                id="first-reviewer-name"
                autoFocus={!hasReviewers}
                value={name}
                onChange={event => {
                  setName(event.target.value);
                  setError(false);
                }}
                placeholder={t('reviewer.namePlaceholder')}
                autoComplete="name"
              />
            </Field>
          </>
        ) : error ? <p role="alert">{t('state.error.body')}</p> : null}
      </form>
    </Dialog>
  );
}
