import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, Field } from '../components';
import { useMockRepository, useRepositorySnapshot } from '../store';

export function FirstReviewerDialog() {
  const { t } = useTranslation();
  const repository = useMockRepository();
  const snapshot = useRepositorySnapshot();
  const [name, setName] = useState('');
  const [error, setError] = useState(false);
  const open = snapshot.preferences.currentReviewerId === null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
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
      title={t('reviewer.firstTitle')}
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
        <p>{t('reviewer.firstBody')}</p>
        <Field
          label={t('reviewer.nameLabel')}
          htmlFor="first-reviewer-name"
          required
          error={error ? t('reviewer.nameInvalid') : undefined}
        >
          <input
            id="first-reviewer-name"
            autoFocus
            value={name}
            onChange={event => {
              setName(event.target.value);
              setError(false);
            }}
            placeholder={t('reviewer.namePlaceholder')}
            autoComplete="name"
          />
        </Field>
      </form>
    </Dialog>
  );
}
