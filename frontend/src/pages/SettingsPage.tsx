import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { apiErrorMessage } from '../api/client';
import type { GpuSlot, Reviewer } from '../api/contracts';
import {
  useCreateReviewerMutation,
  useDatasetsQuery,
  useGpuSlotsQuery,
  useHealthQuery,
  useRenameReviewerMutation,
  useReviewerQuery,
  useReviewersQuery,
} from '../api/queries';
import { Button, Dialog, Field, PageHeader, Pagination, StateView, StatusBadge } from '../components';
import { gpuStatusReason } from '../gpuStatus';
import { setCurrentReviewer, setPreferredLocale, usePreferences } from '../preferences';
import { formatDateTime } from '../time';
import './SettingsPage.css';

function gpuKind(availability: GpuSlot['availability']): 'active' | 'problem' | 'neutral' {
  if (availability === 'Available') return 'active';
  if (availability === 'Reserved' || availability === 'Busy') return 'active';
  if (availability === 'ExternalOccupied') return 'problem';
  return 'neutral';
}

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const preferences = usePreferences();
  const [reviewerPage, setReviewerPage] = useState(1);
  const reviewersQuery = useReviewersQuery(reviewerPage);
  const currentReviewerQuery = useReviewerQuery(preferences.currentReviewerId);
  const healthQuery = useHealthQuery();
  const datasetsQuery = useDatasetsQuery();
  const gpuQuery = useGpuSlotsQuery();
  const createMutation = useCreateReviewerMutation();
  const renameMutation = useRenameReviewerMutation();
  const [newName, setNewName] = useState('');
  const [renameTarget, setRenameTarget] = useState<Reviewer | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [recheckState, setRecheckState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const reviewers = reviewersQuery.data?.items ?? [];
  const currentReviewer = preferences.currentReviewerId === null ? null : currentReviewerQuery.data ?? null;
  const locale = preferences.locale;
  const copyKey = 'workspaceSettingsStatistics.settings';

  useEffect(() => {
    if (currentReviewer && currentReviewer.name !== preferences.currentReviewerName) {
      setCurrentReviewer(currentReviewer);
    }
  }, [currentReviewer, preferences.currentReviewerName]);

  const createReviewer = (event: FormEvent) => {
    event.preventDefault();
    createMutation.mutate({ name: newName }, {
      onSuccess: reviewer => {
        setCurrentReviewer(reviewer);
        setNewName('');
      },
    });
  };

  const renameReviewer = (event: FormEvent) => {
    event.preventDefault();
    if (!renameTarget) return;
    renameMutation.mutate({ id: renameTarget.id, input: { name: renameValue, expectedRevision: renameTarget.revision } }, {
      onSuccess: reviewer => {
        if (preferences.currentReviewerId === reviewer.id) setCurrentReviewer(reviewer);
        setRenameTarget(null);
      },
    });
  };

  const setLocale = (nextLocale: 'zh-CN' | 'en-US') => {
    setPreferredLocale(nextLocale);
    void i18n.changeLanguage(nextLocale);
  };

  const recheck = async () => {
    setRecheckState('loading');
    const results = await Promise.all([
      healthQuery.refetch(),
      datasetsQuery.refetch(),
      gpuQuery.refetch(),
    ]);
    setRecheckState(results.some(result => result.error) ? 'error' : 'success');
  };

  const retryReviewers = () => Promise.all([
    reviewersQuery.refetch(),
    ...(preferences.currentReviewerId === null ? [] : [currentReviewerQuery.refetch()]),
  ]);

  const health = healthQuery.data;
  const datasets = datasetsQuery.data?.items ?? [];
  const gpuSlots = gpuQuery.data ?? [];
  const mutationError = createMutation.error ?? renameMutation.error;
  const reviewerPending = reviewersQuery.isPending || (preferences.currentReviewerId !== null && currentReviewerQuery.isPending);
  const reviewerError = reviewersQuery.error ?? (preferences.currentReviewerId === null ? null : currentReviewerQuery.error);
  const servicesPending = healthQuery.isPending || datasetsQuery.isPending || gpuQuery.isPending;
  const servicesError = healthQuery.error ?? datasetsQuery.error ?? gpuQuery.error;
  return (
    <div className="page-stack settings-page">
      <PageHeader title={t('settings.title')} />
      <section className="panel settings-section settings-reviewers">
        <div className="section-header"><h2>{t(`${copyKey}.reviewers.title`)}</h2></div>
        {reviewerPending ? <StateView state="loading" /> : reviewerError ? (
          <section className="state-view" role="alert"><h2>{t('state.error.title')}</h2><p>{apiErrorMessage(reviewerError, locale)}</p><Button variant="secondary" onClick={() => void retryReviewers()}>{t('actions.retry')}</Button></section>
        ) : <>
          {mutationError ? <section className="generation-feedback" role="alert"><p>{apiErrorMessage(mutationError, locale)}</p></section> : null}
          {currentReviewer ? <div className="settings-current-reviewer"><span>{t(`${copyKey}.reviewers.currentLegend`)}</span><strong>{currentReviewer.name}</strong><Button type="button" variant="quiet" onClick={() => { setRenameTarget(currentReviewer); setRenameValue(currentReviewer.name); renameMutation.reset(); }}>{t(`${copyKey}.reviewers.renameCurrent`)}</Button></div> : <p>{t(`${copyKey}.reviewers.noCurrent`)}</p>}
          {reviewers.length === 0 ? <StateView state="empty" /> : (
            <fieldset className="settings-reviewer-list"><legend>{t(`${copyKey}.reviewers.availableLegend`)}</legend>{reviewers.map(reviewer => <label className="settings-reviewer-choice" key={reviewer.id}><input type="radio" name="current-reviewer" checked={reviewer.id === preferences.currentReviewerId} onChange={() => setCurrentReviewer(reviewer)} /><span>{reviewer.name}</span></label>)}</fieldset>
          )}
          <Pagination page={reviewersQuery.data?.page ?? 1} totalPages={reviewersQuery.data?.totalPages ?? 0} total={reviewersQuery.data?.total ?? 0} onPageChange={setReviewerPage} />
          <form className="inline-form settings-reviewer-create" onSubmit={createReviewer}>
            <Field label={t(`${copyKey}.reviewers.newLabel`)} htmlFor="new-reviewer-name"><input id="new-reviewer-name" required value={newName} maxLength={80} onChange={event => { setNewName(event.target.value); createMutation.reset(); }} placeholder={t(`${copyKey}.reviewers.newPlaceholder`)} autoComplete="name" /></Field>
            <Button type="submit" variant="secondary" busy={createMutation.isPending}>{t(`${copyKey}.reviewers.add`)}</Button>
          </form>
        </>}
      </section>
      <section className="panel settings-section settings-language">
        <div className="section-header"><h2>{t(`${copyKey}.language.title`)}</h2></div>
        <div className="segmented-control" role="group" aria-label={t(`${copyKey}.language.groupLabel`)}><Button variant={locale === 'zh-CN' ? 'primary' : 'secondary'} aria-pressed={locale === 'zh-CN'} onClick={() => setLocale('zh-CN')}>{t(`${copyKey}.language.chinese`)}</Button><Button variant={locale === 'en-US' ? 'primary' : 'secondary'} aria-pressed={locale === 'en-US'} onClick={() => setLocale('en-US')}>{t(`${copyKey}.language.english`)}</Button></div>
      </section>
      <section className="panel settings-section settings-services">
        <div className="section-header"><h2>{t(`${copyKey}.services.title`)}</h2></div>
        <p>{t(`${copyKey}.services.readOnlyNotice`)}</p>
        <div className={`settings-services__recheck settings-services__recheck--${recheckState}`} aria-live="polite"><div className="settings-services__recheck-state"><strong>{t(`${copyKey}.services.recheckRegion`)}</strong><p>{t(`${copyKey}.services.recheck.${recheckState}`)}</p></div><Button variant="secondary" onClick={() => void recheck()} busy={recheckState === 'loading'}>{t(`${copyKey}.services.recheckAction`)}</Button></div>
        {servicesPending ? <StateView state="loading" /> : servicesError ? (
          <section className="state-view" role="alert"><h2>{t('state.error.title')}</h2><p>{apiErrorMessage(servicesError, locale)}</p><Button variant="secondary" onClick={() => void recheck()}>{t('actions.retry')}</Button></section>
        ) : <dl className="status-list settings-service-list">
            <div><dt>{t(`${copyKey}.services.application`)}</dt><dd><StatusBadge label={t(`${copyKey}.services.applicationStatus.${health?.ok ? 'available' : 'unavailable'}`)} kind={health?.ok ? 'active' : 'problem'} /></dd></div>
            <div><dt>{t(`${copyKey}.services.data`)}</dt><dd>{t(`${copyKey}.services.datasetCount`, { count: datasetsQuery.data?.total ?? datasets.length })}</dd></div>
            <div><dt>{t(`${copyKey}.services.prompt`)}</dt><dd>{t(`${copyKey}.services.promptStatus.${health?.promptServiceConfigured ? 'available' : 'unavailable'}`)}</dd></div>
            <div><dt>{t(`${copyKey}.services.renderer`)}</dt><dd>{t(`${copyKey}.services.rendererStatus.${health?.rendererInstallation ?? 'unknown'}`)}</dd></div>
            {gpuSlots.map(gpu => <div className="settings-gpu-row" key={gpu.slot}><dt><strong>{gpu.slot}</strong><span>{t(`${copyKey}.services.checkedAt`, { value: formatDateTime(gpu.checkedAt) })}</span></dt><dd><StatusBadge label={t(`status.gpu.${gpu.availability}`)} kind={gpuKind(gpu.availability)} /><span>{t(`${copyKey}.services.gpuReason.${gpuStatusReason(gpu)}`, { model: gpu.loadedModel ?? '', precision: gpu.loadedPrecision ?? '' })}</span></dd></div>)}
          </dl>}
      </section>
      <Dialog open={renameTarget !== null} title={t(`${copyKey}.renameDialog.title`)} closeLabel={t(`${copyKey}.renameDialog.closeLabel`)} onClose={() => setRenameTarget(null)} footer={<><Button variant="secondary" onClick={() => setRenameTarget(null)}>{t(`${copyKey}.renameDialog.cancel`)}</Button><Button type="submit" form="rename-reviewer-form" variant="primary" busy={renameMutation.isPending}>{t(`${copyKey}.renameDialog.save`)}</Button></>}><form id="rename-reviewer-form" onSubmit={renameReviewer}><Field label={t(`${copyKey}.renameDialog.nameLabel`)} htmlFor="rename-reviewer-name"><input id="rename-reviewer-name" required autoFocus maxLength={80} value={renameValue} onChange={event => { setRenameValue(event.target.value); renameMutation.reset(); }} /></Field></form></Dialog>
    </div>
  );
}
