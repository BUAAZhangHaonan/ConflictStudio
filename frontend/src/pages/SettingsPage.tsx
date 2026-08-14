import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { apiErrorMessage } from '../api/client';
import type { GpuSlot, Reviewer } from '../api/contracts';
import {
  useCreateReviewerMutation,
  useDatasetsQuery,
  useGpuSlotsQuery,
  useHealthQuery,
  useRenameReviewerMutation,
  useReviewersQuery,
} from '../api/queries';
import { Button, Dialog, Field, PageHeader, StateView, StatusBadge } from '../components';
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
  const reviewersQuery = useReviewersQuery();
  const healthQuery = useHealthQuery();
  const datasetsQuery = useDatasetsQuery();
  const gpuQuery = useGpuSlotsQuery();
  const createMutation = useCreateReviewerMutation();
  const renameMutation = useRenameReviewerMutation();
  const [newName, setNewName] = useState('');
  const [renameTarget, setRenameTarget] = useState<Reviewer | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [recheckState, setRecheckState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const reviewers = reviewersQuery.data ?? [];
  const currentReviewer = useMemo(
    () => reviewers.find(reviewer => reviewer.id === preferences.currentReviewerId) ?? null,
    [preferences.currentReviewerId, reviewers],
  );
  const locale = preferences.locale;
  const copyKey = 'workspaceSettingsStatistics.settings';

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
      reviewersQuery.refetch(),
    ]);
    setRecheckState(results.some(result => result.error) ? 'error' : 'success');
  };

  const queryError = reviewersQuery.error ?? healthQuery.error ?? datasetsQuery.error ?? gpuQuery.error;
  if (reviewersQuery.isPending || healthQuery.isPending || datasetsQuery.isPending || gpuQuery.isPending) {
    return <div className="page-stack settings-page"><PageHeader title={t('settings.title')} /><StateView state="loading" /></div>;
  }
  if (queryError) {
    return <div className="page-stack settings-page"><PageHeader title={t('settings.title')} /><section className="state-view" role="alert"><h2>{t('state.error.title')}</h2><p>{apiErrorMessage(queryError, locale)}</p><Button variant="secondary" onClick={() => void recheck()}>{t('actions.retry')}</Button></section></div>;
  }

  const health = healthQuery.data;
  const datasets = datasetsQuery.data ?? [];
  const gpuSlots = gpuQuery.data ?? [];
  const mutationError = createMutation.error ?? renameMutation.error;
  return (
    <div className="page-stack settings-page">
      <PageHeader title={t('settings.title')} />
      {mutationError ? <section className="generation-feedback" role="alert"><p>{apiErrorMessage(mutationError, locale)}</p></section> : null}
      <section className="panel settings-section settings-reviewers">
        <div className="section-header"><h2>{t(`${copyKey}.reviewers.title`)}</h2></div>
        {reviewers.length === 0 ? <StateView state="empty" /> : (
          <fieldset className="settings-reviewer-list"><legend>{t(`${copyKey}.reviewers.currentLegend`)}</legend>{reviewers.map(reviewer => <label key={reviewer.id}><input type="radio" name="current-reviewer" checked={reviewer.id === currentReviewer?.id} onChange={() => setCurrentReviewer(reviewer)} /><span>{reviewer.name}</span>{reviewer.id === currentReviewer?.id ? <Button type="button" variant="quiet" onClick={event => { event.preventDefault(); setRenameTarget(reviewer); setRenameValue(reviewer.name); renameMutation.reset(); }}>{t(`${copyKey}.reviewers.renameCurrent`)}</Button> : null}</label>)}</fieldset>
        )}
        <form className="inline-form settings-reviewer-create" onSubmit={createReviewer}>
          <Field label={t(`${copyKey}.reviewers.newLabel`)} htmlFor="new-reviewer-name"><input id="new-reviewer-name" required value={newName} maxLength={80} onChange={event => { setNewName(event.target.value); createMutation.reset(); }} placeholder={t(`${copyKey}.reviewers.newPlaceholder`)} autoComplete="name" /></Field>
          <Button type="submit" variant="secondary" busy={createMutation.isPending}>{t(`${copyKey}.reviewers.add`)}</Button>
        </form>
      </section>
      <section className="panel settings-section settings-language">
        <div className="section-header"><h2>{t(`${copyKey}.language.title`)}</h2></div>
        <div className="segmented-control" role="group" aria-label={t(`${copyKey}.language.groupLabel`)}><Button variant={locale === 'zh-CN' ? 'primary' : 'secondary'} aria-pressed={locale === 'zh-CN'} onClick={() => setLocale('zh-CN')}>{t(`${copyKey}.language.chinese`)}</Button><Button variant={locale === 'en-US' ? 'primary' : 'secondary'} aria-pressed={locale === 'en-US'} onClick={() => setLocale('en-US')}>{t(`${copyKey}.language.english`)}</Button></div>
      </section>
      <section className="panel settings-section settings-services">
        <div className="section-header"><h2>{t(`${copyKey}.services.title`)}</h2></div>
        <p>{t(`${copyKey}.services.readOnlyNotice`)}</p>
        <div className={`settings-services__recheck settings-services__recheck--${recheckState}`} aria-live="polite"><div className="settings-services__recheck-state"><strong>{t(`${copyKey}.services.recheckRegion`)}</strong><p>{t(`${copyKey}.services.recheck.${recheckState}`)}</p></div><Button variant="secondary" onClick={() => void recheck()} busy={recheckState === 'loading'}>{t(`${copyKey}.services.recheckAction`)}</Button></div>
        <dl className="status-list settings-service-list">
          <div><dt>{t(`${copyKey}.services.application`)}</dt><dd><StatusBadge label={t(`${copyKey}.services.applicationStatus.${health?.ok ? 'available' : 'unavailable'}`)} kind={health?.ok ? 'active' : 'problem'} /></dd></div>
          <div><dt>{t(`${copyKey}.services.data`)}</dt><dd>{t(`${copyKey}.services.datasetCount`, { count: datasets.length })}</dd></div>
          <div><dt>{t(`${copyKey}.services.prompt`)}</dt><dd>{t(`${copyKey}.services.promptStatus.${health?.promptServiceConfigured ? 'available' : 'unavailable'}`)}</dd></div>
          <div><dt>{t(`${copyKey}.services.renderer`)}</dt><dd>{t(`${copyKey}.services.rendererStatus.${health?.rendererInstallation ?? 'unknown'}`)}</dd></div>
          {gpuSlots.map(gpu => <div className="settings-gpu-row" key={gpu.slot}><dt><strong>{gpu.slot}</strong><span>{t(`${copyKey}.services.checkedAt`, { value: formatDateTime(gpu.checkedAt) })}</span></dt><dd><StatusBadge label={t(`status.gpu.${gpu.availability}`)} kind={gpuKind(gpu.availability)} /><span>{gpu.activeJobId !== null ? t(`${copyKey}.services.gpuReason.activeJob`) : gpu.availability === 'ExternalOccupied' ? t(`${copyKey}.services.gpuReason.external`) : gpu.serviceStatus === 'notInstalled' ? t(`${copyKey}.services.gpuReason.notInstalled`) : gpu.serviceStatus === 'notConfigured' ? t(`${copyKey}.services.gpuReason.notConfigured`) : gpu.loadedModel ? t(`${copyKey}.services.gpuReason.loaded`, { model: gpu.loadedModel, precision: gpu.loadedPrecision ?? '' }) : t(`${copyKey}.services.gpuReason.ready`)}</span></dd></div>)}
        </dl>
      </section>
      <Dialog open={renameTarget !== null} title={t(`${copyKey}.renameDialog.title`)} closeLabel={t(`${copyKey}.renameDialog.closeLabel`)} onClose={() => setRenameTarget(null)} footer={<><Button variant="secondary" onClick={() => setRenameTarget(null)}>{t(`${copyKey}.renameDialog.cancel`)}</Button><Button type="submit" form="rename-reviewer-form" variant="primary" busy={renameMutation.isPending}>{t(`${copyKey}.renameDialog.save`)}</Button></>}><form id="rename-reviewer-form" onSubmit={renameReviewer}><Field label={t(`${copyKey}.renameDialog.nameLabel`)} htmlFor="rename-reviewer-name"><input id="rename-reviewer-name" required autoFocus maxLength={80} value={renameValue} onChange={event => { setRenameValue(event.target.value); renameMutation.reset(); }} /></Field></form></Dialog>
    </div>
  );
}
