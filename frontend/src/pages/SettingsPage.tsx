import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, Field, PageHeader, StateView, StatusBadge, useToast } from '../components';
import { PageStateBoundary } from '../app/PageStateBoundary';
import { useMockRepository, useRepositorySnapshot } from '../store';
import type { GpuAvailability, Locale, RepositoryFailure, Reviewer } from '../types';
import './SettingsPage.css';

const copyKey = 'workspaceSettingsStatistics.settings';
const newReviewerErrorId = 'settings-new-reviewer-error';
const reviewerSelectionErrorId = 'settings-reviewer-selection-error';
const renameReviewerErrorId = 'settings-rename-reviewer-error';
const recheckStatusId = 'settings-example-status';

function gpuStatusKind(availability: GpuAvailability) {
  if (availability === 'Available') return 'complete' as const;
  if (availability === 'Reserved') return 'active' as const;
  if (availability === 'ExternalOccupied') return 'problem' as const;
  return 'neutral' as const;
}

function formatUtcDateTime(value: string, locale: Locale): string {
  return new Date(value).toLocaleString(locale, {
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const repository = useMockRepository();
  const snapshot = useRepositorySnapshot();
  const { showToast } = useToast();
  const recheckTimerRef = useRef<number | null>(null);
  const newReviewerInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [newReviewerError, setNewReviewerError] = useState<string | null>(null);
  const [reviewerSelectionError, setReviewerSelectionError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Reviewer | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [recheckState, setRecheckState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [recheckedAt, setRecheckedAt] = useState<string | null>(null);
  const currentReviewer = snapshot.data.reviewers.find(
    reviewer => reviewer.id === snapshot.preferences.currentReviewerId,
  );

  useEffect(() => () => {
    if (recheckTimerRef.current !== null) {
      window.clearTimeout(recheckTimerRef.current);
    }
  }, []);

  const repositoryFailureMessage = (failure: RepositoryFailure): string => {
    if (failure.kind === 'Conflict') {
      return t(`${copyKey}.errors.conflict`, { revision: failure.currentRevision });
    }
    if (failure.kind === 'NotFound') return t(`${copyKey}.errors.notFound`);
    if (failure.kind === 'Unavailable') return t(`${copyKey}.errors.unavailable`);
    return t(`${copyKey}.errors.invalidInput`);
  };

  const validateReviewerName = (value: string, reviewerId?: string): string | null => {
    const cleanName = value.trim();
    if (!cleanName) return t(`${copyKey}.errors.nameRequired`);
    const duplicate = snapshot.data.reviewers.some(
      reviewer =>
        reviewer.id !== reviewerId &&
        reviewer.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase(),
    );
    return duplicate ? t(`${copyKey}.errors.nameDuplicate`) : null;
  };

  const selectReviewer = (reviewerId: string) => {
    const result = repository.setCurrentReviewer(reviewerId);
    if (!result.ok) {
      setReviewerSelectionError(repositoryFailureMessage(result));
      return;
    }
    setReviewerSelectionError(null);
    showToast(t(`${copyKey}.toasts.reviewerSelected`, { name: result.value.name }));
  };

  const addName = (event: FormEvent) => {
    event.preventDefault();
    const validationError = validateReviewerName(name);
    if (validationError) {
      setNewReviewerError(validationError);
      return;
    }
    const result = repository.createReviewer(name);
    if (!result.ok) {
      setNewReviewerError(repositoryFailureMessage(result));
      return;
    }
    setName('');
    setNewReviewerError(null);
    setReviewerSelectionError(null);
    showToast(t(`${copyKey}.toasts.reviewerAdded`, { name: result.value.name }));
  };

  const openRenameDialog = () => {
    if (!currentReviewer) return;
    setRenameTarget(currentReviewer);
    setRenameValue(currentReviewer.name);
    setRenameError(null);
  };

  const closeRenameDialog = () => {
    setRenameTarget(null);
    setRenameValue('');
    setRenameError(null);
  };

  const renameReviewer = (event: FormEvent) => {
    event.preventDefault();
    if (!renameTarget) return;
    const validationError = validateReviewerName(renameValue, renameTarget.id);
    if (validationError) {
      setRenameError(validationError);
      return;
    }
    const result = repository.renameReviewer(
      renameTarget.id,
      renameValue,
      renameTarget.revision,
    );
    if (!result.ok) {
      setRenameError(repositoryFailureMessage(result));
      return;
    }
    closeRenameDialog();
    showToast(t(`${copyKey}.toasts.reviewerRenamed`, { name: result.value.name }));
  };

  const recheckExampleStatus = () => {
    if (recheckTimerRef.current !== null) {
      window.clearTimeout(recheckTimerRef.current);
      recheckTimerRef.current = null;
    }
    setRecheckState('loading');
    recheckTimerRef.current = window.setTimeout(() => {
      recheckTimerRef.current = null;
      if (snapshot.data.gpuStates.length === 0) {
        setRecheckState('error');
        return;
      }
      const refreshedAt = new Date().toISOString();
      setRecheckedAt(refreshedAt);
      setRecheckState('success');
      showToast(t(`${copyKey}.services.recheckSuccess`, {
        value: formatUtcDateTime(refreshedAt, snapshot.preferences.locale),
      }));
    }, 700);
  };

  const setLocale = async (locale: Locale) => {
    if (locale === snapshot.preferences.locale) return;
    await i18n.changeLanguage(locale);
    repository.setLocale(locale);
    showToast(i18n.t(`${copyKey}.toasts.languageChanged`));
  };

  return (
    <PageStateBoundary>
      <div className="page-stack page-stack--narrow settings-page">
        <PageHeader title={t(`${copyKey}.title`)} />

        <section className="panel settings-section settings-reviewers">
          <div className="section-header"><h2>{t(`${copyKey}.reviewers.title`)}</h2></div>
          <fieldset
            className="choice-list settings-reviewer-list"
            aria-describedby={reviewerSelectionError ? reviewerSelectionErrorId : undefined}
            aria-invalid={reviewerSelectionError ? true : undefined}
          >
            <legend>{t(`${copyKey}.reviewers.currentLegend`)}</legend>
            {snapshot.data.reviewers.length === 0 ? (
              <StateView
                state="empty"
                action={{
                  label: t(`${copyKey}.reviewers.add`),
                  onClick: () => newReviewerInputRef.current?.focus(),
                }}
              />
            ) : (
              snapshot.data.reviewers.map(reviewer => (
                <label key={reviewer.id}>
                  <input
                    type="radio"
                    name="reviewer"
                    value={reviewer.id}
                    checked={reviewer.id === snapshot.preferences.currentReviewerId}
                    onChange={() => selectReviewer(reviewer.id)}
                  />
                  <span>{reviewer.name}</span>
                </label>
              ))
            )}
          </fieldset>
          {reviewerSelectionError ? (
            <p id={reviewerSelectionErrorId} className="field__error" role="alert">
              {reviewerSelectionError}
            </p>
          ) : null}
          <div className="settings-reviewer-actions">
            <Button type="button" variant="secondary" disabled={!currentReviewer} onClick={openRenameDialog}>
              {t(`${copyKey}.reviewers.renameCurrent`)}
            </Button>
            {!currentReviewer ? <span>{t(`${copyKey}.reviewers.noCurrent`)}</span> : null}
          </div>
          <form className="inline-form settings-reviewer-form" onSubmit={addName} noValidate>
            <Field label={t(`${copyKey}.reviewers.newLabel`)} htmlFor="new-reviewer-name" required>
              <input
                ref={newReviewerInputRef}
                id="new-reviewer-name"
                required
                value={name}
                onChange={event => {
                  setName(event.target.value);
                  if (newReviewerError) setNewReviewerError(null);
                }}
                placeholder={t(`${copyKey}.reviewers.newPlaceholder`)}
                autoComplete="name"
                aria-invalid={newReviewerError ? true : undefined}
                aria-describedby={newReviewerError ? newReviewerErrorId : undefined}
              />
              {newReviewerError ? (
                <span id={newReviewerErrorId} className="field__error" role="alert">
                  {newReviewerError}
                </span>
              ) : null}
            </Field>
            <Button type="submit" variant="secondary">{t(`${copyKey}.reviewers.add`)}</Button>
          </form>
        </section>

        <section className="panel settings-section settings-language">
          <div className="section-header"><h2>{t(`${copyKey}.language.title`)}</h2></div>
          <div className="segmented-control" role="group" aria-label={t(`${copyKey}.language.groupLabel`)}>
            <Button
              type="button"
              variant={snapshot.preferences.locale === 'zh-CN' ? 'primary' : 'secondary'}
              aria-pressed={snapshot.preferences.locale === 'zh-CN'}
              onClick={() => void setLocale('zh-CN')}
            >
              {t(`${copyKey}.language.chinese`)}
            </Button>
            <Button
              type="button"
              variant={snapshot.preferences.locale === 'en-US' ? 'primary' : 'secondary'}
              aria-pressed={snapshot.preferences.locale === 'en-US'}
              onClick={() => void setLocale('en-US')}
            >
              {t(`${copyKey}.language.english`)}
            </Button>
          </div>
        </section>

        <section className="panel settings-section settings-services">
          <div className="section-header"><h2>{t(`${copyKey}.services.title`)}</h2></div>
          <p>{t(`${copyKey}.services.readOnlyNotice`)}</p>
          <div
            className={`settings-services__recheck settings-services__recheck--${recheckState}`}
            id={recheckStatusId}
            aria-live={recheckState === 'error' ? 'assertive' : 'polite'}
            aria-atomic="true"
          >
            <div
              className="settings-services__recheck-state"
              role={recheckState === 'error' ? 'alert' : 'status'}
            >
              <strong>{t(`${copyKey}.services.recheckRegion`)}</strong>
              <p>
                {recheckState === 'idle'
                  ? t(`${copyKey}.services.recheckIdle`)
                  : recheckState === 'loading'
                    ? t(`${copyKey}.services.rechecking`)
                    : recheckState === 'success'
                      ? t(`${copyKey}.services.recheckSuccess`, {
                        value: formatUtcDateTime(recheckedAt ?? new Date().toISOString(), snapshot.preferences.locale),
                      })
                      : t(`${copyKey}.services.recheckError`)}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={recheckExampleStatus}
              disabled={recheckState === 'loading'}
            >
              {recheckState === 'loading' ? t(`${copyKey}.services.rechecking`) : t(`${copyKey}.services.recheck`)}
            </Button>
          </div>
          <dl className="status-list settings-service-list">
            <div>
              <dt>{t(`${copyKey}.services.application`)}</dt>
              <dd>{t(`${copyKey}.services.applicationValue`)}</dd>
            </div>
            <div>
              <dt>{t(`${copyKey}.services.data`)}</dt>
              <dd>
                {t(`${copyKey}.services.dataValue`, {
                  version: snapshot.data.version,
                  datasets: snapshot.data.datasets.length,
                  reviewers: snapshot.data.reviewers.length,
                })}
              </dd>
            </div>
            <div>
              <dt>{t(`${copyKey}.services.gpu`)}</dt>
              <dd>{t(`${copyKey}.services.gpuValue`, { count: snapshot.data.gpuStates.length })}</dd>
            </div>
            {snapshot.data.gpuStates.map(gpu => (
              <div className="settings-gpu-row" key={gpu.slot}>
                <dt>
                  <strong>{gpu.slot}</strong>
                  <span>
                    {t(`${copyKey}.services.checkedAt`, {
                      value: formatUtcDateTime(recheckedAt ?? gpu.checkedAt, snapshot.preferences.locale),
                    })}
                  </span>
                </dt>
                <dd>
                  <StatusBadge
                    label={t(`status.gpu.${gpu.availability}`)}
                    kind={gpuStatusKind(gpu.availability)}
                  />
                  {gpu.loadedModel ? (
                    <span>{t(`${copyKey}.services.loadedModel`, { model: gpu.loadedModel })}</span>
                  ) : null}
                  {gpu.activeJobId ? (
                    <span>{t(`${copyKey}.services.activeJob`, { id: gpu.activeJobId })}</span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <Dialog
          open={renameTarget !== null}
          title={t(`${copyKey}.renameDialog.title`)}
          closeLabel={t(`${copyKey}.renameDialog.closeLabel`)}
          onClose={closeRenameDialog}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={closeRenameDialog}>
                {t(`${copyKey}.renameDialog.cancel`)}
              </Button>
              <Button type="submit" form="rename-reviewer-form" variant="primary">
                {t(`${copyKey}.renameDialog.save`)}
              </Button>
            </>
          }
        >
          <form id="rename-reviewer-form" onSubmit={renameReviewer} noValidate>
            <Field label={t(`${copyKey}.renameDialog.nameLabel`)} htmlFor="rename-reviewer-name" required>
              <input
                id="rename-reviewer-name"
                required
                value={renameValue}
                onChange={event => {
                  setRenameValue(event.target.value);
                  if (renameError) setRenameError(null);
                }}
                placeholder={t(`${copyKey}.renameDialog.namePlaceholder`)}
                autoComplete="name"
                autoFocus
                aria-invalid={renameError ? true : undefined}
                aria-describedby={renameError ? renameReviewerErrorId : undefined}
              />
              {renameError ? (
                <span id={renameReviewerErrorId} className="field__error" role="alert">
                  {renameError}
                </span>
              ) : null}
            </Field>
          </form>
        </Dialog>
      </div>
    </PageStateBoundary>
  );
}
