import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { apiErrorMessage } from '../api/client';
import type { ArchiveChange } from '../api/contracts';
import {
  useArchivesQuery,
  useDatasetsQuery,
  usePreviewArchiveMutation,
  useReviewSampleListQuery,
  useSyncArchiveMutation,
} from '../api/queries';
import { Button, ConfirmDialog, Metric, PageHeader, Pagination, StatusBadge } from '../components';
import {
  buildArchiveLocation,
  reviewDetailLocation,
} from '../reviewArchive';
import { formatDateTime } from '../time';
import type { Category } from '../types';
import './ArchivePage.css';

const categories: readonly Category[] = ['A-VA', 'C-VA', 'A-VT', 'C-VT'];

export function ArchivePage() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const datasetsQuery = useDatasetsQuery();
  const initial = new URLSearchParams(location.search);
  const requestedPage = Number(initial.get('page'));
  const [page, setPage] = useState(Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
  const archivesQuery = useArchivesQuery();
  const previewMutation = usePreviewArchiveMutation();
  const syncMutation = useSyncArchiveMutation();
  const requestedDataset = Number(initial.get('dataset'));
  const initialCategory = initial.get('category');
  const [datasetId, setDatasetId] = useState<number | null>(Number.isInteger(requestedDataset) && requestedDataset > 0 ? requestedDataset : null);
  const [search, setSearch] = useState(initial.get('search') ?? '');
  const [category, setCategory] = useState<Category | 'All'>(categories.includes(initialCategory as Category) ? initialCategory as Category : 'All');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [previewPage, setPreviewPage] = useState(1);
  const datasets = datasetsQuery.data?.items ?? [];
  const archives = archivesQuery.data?.items ?? [];
  const dataset = datasets.find(item => item.id === datasetId) ?? datasets[0] ?? null;
  const samplesQuery = useReviewSampleListQuery({
    search: null,
    datasetId: dataset?.id ?? null,
    decision: 'All',
    protocol: null,
    relation: null,
    direction: null,
    page,
  });
  const samples = samplesQuery.data?.items ?? [];
  const archive = archives.find(item => item.datasetId === dataset?.id) ?? null;
  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';

  useEffect(() => {
    if (!datasetsQuery.isSuccess) return;
    const nextId = dataset?.id ?? null;
    if (nextId !== datasetId) setDatasetId(nextId);
  }, [dataset?.id, datasetId, datasetsQuery.isSuccess]);

  const rows = useMemo(() => dataset ? samples.filter(sample => sample.datasetId === dataset.id && sample.inArchive) : [], [dataset, samples]);
  const filteredRows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase(locale);
    return rows.filter(sample => (category === 'All' || sample.category === category) && (!needle || `${sample.displayId} ${sample.category}`.toLocaleLowerCase(locale).includes(needle))).sort((left, right) => left.id - right.id);
  }, [category, locale, rows, search]);
  const archiveDataReady = datasetsQuery.isSuccess && samplesQuery.isSuccess && archivesQuery.isSuccess;
  const currentPage = samplesQuery.data?.page ?? page;
  const visibleRows = filteredRows;
  const archiveTotal = archive?.currentCount ?? 0;
  const archiveTotalPages = Math.ceil(archiveTotal / 20);
  const returnTo = buildArchiveLocation({ datasetId: dataset?.id ?? null, search, category, page: currentPage });
  const preview = previewMutation.data ?? null;
  const previewRows: Array<{ sample: ArchiveChange; change: 'added' | 'updated' | 'removed' }> = preview ? [
    ...preview.added.map(sample => ({ sample, change: 'added' as const })),
    ...preview.updated.map(sample => ({ sample, change: 'updated' as const })),
    ...preview.removed.map(sample => ({ sample, change: 'removed' as const })),
  ] : [];
  const previewTotalPages = Math.ceil(previewRows.length / 20);
  const visiblePreviewRows = previewRows.slice((previewPage - 1) * 20, previewPage * 20);

  useEffect(() => {
    if (!archiveDataReady) return;
    if (`${location.pathname}${location.search}` !== returnTo) navigate(returnTo, { replace: true });
  }, [archiveDataReady, location.pathname, location.search, navigate, returnTo]);

  const selectDataset = (value: number) => {
    setDatasetId(value);
    setSearch('');
    setCategory('All');
    setPage(1);
    previewMutation.reset();
    syncMutation.reset();
    setPreviewPage(1);
  };
  const sync = () => {
    if (!preview) return;
    syncMutation.mutate(preview, {
      onSuccess: () => {
        setConfirmOpen(false);
        previewMutation.reset();
      },
    });
  };

  if (datasetsQuery.isPending || samplesQuery.isPending || archivesQuery.isPending) {
    return <div className="page-stack archive-page"><PageHeader title={t('archive.title')} /><section className="archive-state" role="status"><h2>{t('archive.loadingTitle')}</h2><p>{t('archive.loadingBody')}</p></section></div>;
  }
  const queryError = datasetsQuery.error ?? samplesQuery.error ?? archivesQuery.error;
  if (queryError) {
    return <div className="page-stack archive-page"><PageHeader title={t('archive.title')} /><section className="archive-state" role="alert"><h2>{t('archive.errorTitle')}</h2><p>{apiErrorMessage(queryError, locale)}</p></section></div>;
  }

  const actionError = previewMutation.error ?? syncMutation.error;
  const hasFilters = search.trim() !== '' || category !== 'All';
  return (
    <div className="page-stack archive-page" aria-label={t('archive.aria.page')}>
      <PageHeader title={t('archive.title')} />
      {actionError ? <section className="generation-feedback" role="alert"><p>{apiErrorMessage(actionError, locale)}</p></section> : null}
      {datasets.length === 0 ? <section className="panel archive-state"><h2>{t('archive.emptyTitle')}</h2><p>{t('workspaceSettingsStatistics.workspace.datasets.emptyBody')}</p></section> : <>
        <section className="panel archive-toolbar" aria-label={t('archive.aria.toolbar')}><label className="archive-dataset-select"><span>{t('archive.datasetLabel')}</span><select value={dataset?.id ?? ''} onChange={event => selectDataset(Number(event.target.value))}>{datasets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="archive-toolbar__actions"><Button variant="secondary" busy={previewMutation.isPending} onClick={() => { if (dataset) { setPreviewPage(1); previewMutation.mutate({ datasetId: dataset.id }); } }}>{t('actions.previewSync')}</Button>{archive?.manifestAvailable ? <a className="button button--quiet" href={`/api/archives/${archive.datasetId}/manifest`} download="manifest.jsonl">{t('archive.downloadJsonl')}</a> : null}</div></section>
        <section className="panel archive-overview" aria-label={t('archive.aria.overview')}><div className="archive-overview__header"><h2>{t('archive.overview')}</h2><span>{archive?.lastSyncedAt ? t('archive.lastSynced', { date: formatDateTime(archive.lastSyncedAt) }) : t('archive.neverSynced')}</span></div><div className="metric-grid archive-metrics"><Metric label={t('archive.current')} value={archive?.currentCount ?? 0} /><Metric label={t('statistics.needsUpdate')} value={archive?.needsUpdateCount ?? 0} /></div></section>
        {preview ? <section className="panel archive-preview" aria-label={t('archive.aria.preview')}><div className="section-header"><h2>{t('archive.previewTitle')}</h2></div><div className="metric-grid archive-metrics"><Metric label={t('archive.toAdd')} value={preview.added.length} /><Metric label={t('archive.toUpdate')} value={preview.updated.length} /><Metric label={t('archive.toRemove')} value={preview.removed.length} /><Metric label={t('archive.unchanged')} value={preview.unchangedCount} /></div>{previewRows.length ? <><ul className="archive-preview__list">{visiblePreviewRows.map(({ sample, change }) => <li key={`${change}-${sample.sampleId}`}><video className="archive-thumbnail" src={sample.primaryAssetUrl} muted preload="metadata" aria-label={t('archive.thumbnailAlt', { id: sample.displayId })} /><span><Link to={reviewDetailLocation(sample.sampleId, returnTo)}>{sample.displayId}</Link><small>{sample.datasetName} {t(`category.${sample.category}`)}</small></span><StatusBadge label={t(`archive.${change}`)} kind={change === 'removed' ? 'problem' : 'neutral'} /></li>)}</ul><Pagination page={previewPage} totalPages={previewTotalPages} total={previewRows.length} onPageChange={setPreviewPage} /></> : <p>{t('archive.noChangesBody')}</p>}<Button variant="primary" disabled={previewRows.length === 0} onClick={() => setConfirmOpen(true)}>{t('actions.syncArchive')}</Button></section> : null}
        {archiveTotal === 0 ? <section className="panel archive-state"><h2>{t('archive.emptyTitle')}</h2><p>{t('archive.emptyBody')}</p><Button variant="primary" onClick={() => navigate(`/review?${new URLSearchParams({ returnTo }).toString()}`)}>{t('actions.openReview')}</Button></section> : <>
          <section className="panel archive-filters"><label className="archive-filter archive-filter--search"><span>{t('fields.search')}</span><input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} /></label><label className="archive-filter"><span>{t('archive.category')}</span><select value={category} onChange={event => { setCategory(event.target.value as Category | 'All'); setPage(1); }}><option value="All">{t('review.allCategories')}</option>{categories.map(value => <option key={value} value={value}>{t(`category.${value}`)}</option>)}</select></label>{hasFilters ? <Button variant="quiet" onClick={() => { setSearch(''); setCategory('All'); setPage(1); }}>{t('actions.clearFilters')}</Button> : null}</section>
          <section className="panel archive-list-panel"><div className="section-header"><h2>{t('archive.currentArchive')}</h2></div>{filteredRows.length === 0 ? <section className="archive-state"><h2>{t('archive.filteredTitle')}</h2><p>{t('archive.filteredBody')}</p></section> : <div className="table-shell archive-table-shell"><table><caption>{t('table.archiveCaption')}</caption><thead><tr><th>{t('archive.thumbnail')}</th><th>{t('archive.sampleId')}</th><th>{t('archive.category')}</th><th>{t('fields.status')}</th><th>{t('fields.updatedAt')}</th></tr></thead><tbody>{visibleRows.map(sample => <tr key={sample.id}><td><video className="archive-thumbnail" src={sample.primaryMedia.url} muted preload="metadata" aria-label={t('archive.thumbnailAlt', { id: sample.displayId })} /></td><th scope="row"><Link to={reviewDetailLocation(sample.id, returnTo)}>{sample.displayId}</Link></th><td>{t(`category.${sample.category}`)}</td><td><StatusBadge label={t(`status.archive.${sample.archiveSyncStatus}`)} kind={sample.archiveSyncStatus === 'Current' ? 'complete' : 'problem'} /></td><td>{formatDateTime(sample.updatedAt)}</td></tr>)}</tbody></table></div>}<Pagination page={Math.min(currentPage, archiveTotalPages)} totalPages={archiveTotalPages} total={archiveTotal} onPageChange={setPage} /></section>
        </>}
      </>}
      <ConfirmDialog open={confirmOpen} title={t('archive.confirmTitle')} body={<><p>{t('archive.confirmBody', { add: preview?.added.length ?? 0, update: preview?.updated.length ?? 0, remove: preview?.removed.length ?? 0 })}</p><p>{t('archive.confirmWarning')}</p></>} confirmLabel={t('actions.syncArchive')} cancelLabel={t('actions.cancel')} closeLabel={t('actions.close')} busy={syncMutation.isPending} onClose={() => setConfirmOpen(false)} onConfirm={sync} />
    </div>
  );
}
