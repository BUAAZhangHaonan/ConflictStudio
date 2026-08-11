import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useExamplePageState } from '../app/useExamplePageState';
import { Button, Dialog, Metric, PageHeader, useToast } from '../components';
import {
  ARCHIVE_PAGE_SIZE,
  archiveFileName,
  archiveJsonl,
  clampPage,
  pageCount,
  pageItems,
  reviewLocation,
} from '../reviewArchive';
import { useMockRepository, useRepositorySnapshot } from '../store';
import { formatDateTime } from '../time';
import {
  type ArchivePreview,
  type Category,
  type Sample,
} from '../types';
import './ArchivePage.css';

type ArchiveChange = 'Added' | 'Updated' | 'Removed';
type ArchiveSortKey = 'id' | 'category' | 'updatedAt';
type SortDirection = 'ascending' | 'descending';

interface PreviewState {
  value: ArchivePreview;
}

interface Feedback {
  kind: 'error' | 'conflict';
  retry: 'preview' | 'export';
}

interface ArchiveStateViewProps {
  title: ReactNode;
  body: ReactNode;
  loading?: boolean;
  urgent?: boolean;
  action?: { label: ReactNode; onClick: () => void };
}

const categories: readonly Category[] = ['A-VA', 'C-VA', 'A-VT', 'C-VT'];

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function ArchiveStateView({ title, body, loading = false, urgent = false, action }: ArchiveStateViewProps) {
  return (
    <section
      className="archive-state"
      role={urgent ? 'alert' : 'status'}
      aria-live={urgent ? 'assertive' : 'polite'}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="archive-state__progress" aria-hidden="true" /> : null}
      <h2>{title}</h2>
      <p>{body}</p>
      {action ? <Button onClick={action.onClick}>{action.label}</Button> : null}
    </section>
  );
}

export function ArchivePage() {
  const { t } = useTranslation();
  const repository = useMockRepository();
  const snapshot = useRepositorySnapshot();
  const { showToast } = useToast();
  const exampleState = useExamplePageState();
  const location = useLocation();
  const navigate = useNavigate();
  const initialParams = new URLSearchParams(location.search);
  const archiveDatasets = useMemo(() => snapshot.data.datasets, [snapshot.data.datasets]);
  const initialDataset = initialParams.get('dataset');
  const initialCategory = initialParams.get('category');
  const initialPage = Number(initialParams.get('page'));
  const [datasetId, setDatasetId] = useState(() =>
    archiveDatasets.some(item => item.id === initialDataset) ? initialDataset! : archiveDatasets[0]?.id ?? '',
  );
  const [search, setSearch] = useState(initialParams.get('search') ?? '');
  const [categoryFilter, setCategoryFilter] = useState<Category | 'All'>(() =>
    categories.includes(initialCategory as Category) ? initialCategory as Category : 'All',
  );
  const [page, setPage] = useState(Number.isInteger(initialPage) && initialPage > 0 ? initialPage : 1);
  const [sortKey, setSortKey] = useState<ArchiveSortKey>('id');
  const [sortDirection, setSortDirection] = useState<SortDirection>('ascending');
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncConfirmOpen, setSyncConfirmOpen] = useState(false);
  const [liveMessage, setLiveMessage] = useState('');

  const dataset = archiveDatasets.find(item => item.id === datasetId) ?? archiveDatasets[0];
  const currentArchive = snapshot.data.archives.find(item => item.datasetId === dataset?.id);
  const sampleById = useMemo(
    () => new Map(snapshot.data.samples.map(sample => [sample.id, sample])),
    [snapshot.data.samples],
  );

  useEffect(() => {
    if (dataset && dataset.id !== datasetId) setDatasetId(dataset.id);
    if (!dataset && datasetId) setDatasetId('');
  }, [dataset, datasetId]);

  const currentPreview = useMemo(
    () => (dataset ? repository.previewArchive(dataset.id) : null),
    [currentArchive?.revision, dataset, repository, snapshot.data.samples],
  );

  const rows = useMemo<Sample[]>(() => {
    if (!dataset || !currentPreview?.ok) return [];
    const rowIds = new Set([
      ...(currentArchive?.currentSampleIds ?? []),
      ...snapshot.data.samples
        .filter(sample => sample.datasetId === dataset.id && sample.reviewDecision === 'Accepted')
        .map(sample => sample.id),
    ]);
    return [...rowIds].flatMap(id => {
      const sample = sampleById.get(id);
      return sample && sample.datasetId === dataset.id ? [sample] : [];
    });
  }, [currentArchive?.currentSampleIds, currentPreview, dataset, sampleById, snapshot.data.samples]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(snapshot.preferences.locale);
    const matches = rows.filter(sample => {
      const searchText = [sample.displayId, dataset?.name, sample.category, sample.model]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase(snapshot.preferences.locale);
      return (!query || searchText.includes(query)) &&
        (categoryFilter === 'All' || sample.category === categoryFilter);
    });
    const direction = sortDirection === 'ascending' ? 1 : -1;
    return [...matches].sort((left, right) => {
      let result = 0;
      if (sortKey === 'id') result = compareText(left.displayId, right.displayId);
      if (sortKey === 'category') result = compareText(left.category, right.category);
      if (sortKey === 'updatedAt') result = compareText(left.updatedAt, right.updatedAt);
      return direction * (result || compareText(left.id, right.id));
    });
  }, [categoryFilter, dataset?.name, rows, search, snapshot.preferences.locale, sortDirection, sortKey]);

  const totalPages = pageCount(filteredRows.length);
  const currentPage = clampPage(page, filteredRows.length);
  const visibleRows = pageItems(filteredRows, currentPage);
  const archivedSamples = useMemo(
    () => (currentArchive?.currentSampleIds ?? [])
      .map(id => sampleById.get(id))
      .filter((sample): sample is Sample => sample !== undefined && sample.datasetId === dataset?.id)
      .sort((left, right) => compareText(left.displayId, right.displayId) || compareText(left.id, right.id)),
    [currentArchive?.currentSampleIds, dataset?.id, sampleById],
  );
  const counts = currentPreview?.ok
    ? {
        added: currentPreview.value.addedSampleIds.length,
        updated: currentPreview.value.updatedSampleIds.length,
        removed: currentPreview.value.removedSampleIds.length,
      }
    : { added: 0, updated: 0, removed: 0 };
  const hasFilters = search.trim() !== '' || categoryFilter !== 'All';
  const previewChangeCount = previewState
    ? previewState.value.addedSampleIds.length +
      previewState.value.updatedSampleIds.length +
      previewState.value.removedSampleIds.length
    : 0;

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [currentPage, page]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (datasetId) params.set('dataset', datasetId);
    if (search.trim()) params.set('search', search.trim());
    if (categoryFilter !== 'All') params.set('category', categoryFilter);
    if (currentPage > 1) params.set('page', String(currentPage));
    const nextSearch = params.toString();
    if (nextSearch !== location.search.slice(1)) {
      navigate({ pathname: '/archive', search: nextSearch ? `?${nextSearch}` : '' }, { replace: true });
    }
  }, [categoryFilter, currentPage, datasetId, location.search, navigate, search]);

  const requestSort = (nextKey: ArchiveSortKey) => {
    if (nextKey === sortKey) {
      setSortDirection(current => current === 'ascending' ? 'descending' : 'ascending');
      return;
    }
    setSortKey(nextKey);
    setSortDirection(nextKey === 'updatedAt' ? 'descending' : 'ascending');
  };

  const clearFilters = () => {
    setSearch('');
    setCategoryFilter('All');
    setPage(1);
  };

  const resetForDataset = (nextDatasetId: string) => {
    setDatasetId(nextDatasetId);
    clearFilters();
    setPreviewState(null);
    setFeedback(null);
    setLiveMessage('');
  };

  const buildPreview = () => {
    if (!dataset) return;
    const result = repository.previewArchive(dataset.id);
    if (!result.ok) {
      setFeedback({ kind: result.kind === 'Conflict' ? 'conflict' : 'error', retry: 'preview' });
      setLiveMessage(t(result.kind === 'Conflict' ? 'archive.aria.conflict' : 'archive.aria.error'));
      return;
    }
    setPreviewState({ value: result.value });
    setFeedback(null);
    setLiveMessage('');
  };

  const syncArchive = () => {
    if (!previewState || previewChangeCount === 0) return;
    setSyncing(true);
    setLiveMessage(t('archive.aria.syncing'));
    const result = repository.syncArchive(previewState.value);
    setSyncing(false);
    if (!result.ok) {
      const kind = result.kind === 'Conflict' ? 'conflict' : 'error';
      setPreviewState(null);
      setFeedback({ kind, retry: 'preview' });
      setLiveMessage(t(kind === 'conflict' ? 'archive.aria.conflict' : 'archive.aria.error'));
      return;
    }
    setPreviewState(null);
    setSyncConfirmOpen(false);
    setFeedback(null);
    setLiveMessage(t('archive.aria.synced'));
    showToast(t('archive.success'));
  };

  const downloadJsonl = () => {
    if (!dataset || archivedSamples.length === 0) return;
    try {
      const blob = new Blob([archiveJsonl(dataset.name, archivedSamples)], { type: 'application/x-ndjson;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = archiveFileName(dataset.name);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setLiveMessage(t('archive.aria.exportReady', { format: 'JSONL' }));
      showToast(t('archive.exportReady', { format: 'JSONL' }));
    } catch {
      setFeedback({ kind: 'error', retry: 'export' });
      setLiveMessage(t('archive.aria.error'));
    }
  };

  const retryFeedback = () => {
    if (!feedback) return;
    if (feedback.retry === 'export') {
      setFeedback(null);
      downloadJsonl();
      return;
    }
    buildPreview();
  };

  const openReview = (sample: Sample) => {
    const params = new URLSearchParams();
    if (datasetId) params.set('dataset', datasetId);
    if (search.trim()) params.set('search', search.trim());
    if (categoryFilter !== 'All') params.set('category', categoryFilter);
    if (currentPage > 1) params.set('page', String(currentPage));
    navigate(reviewLocation(sample.displayId, `/archive?${params.toString()}`));
  };

  useEffect(() => {
    const handlePreviewShortcut = (event: KeyboardEvent) => {
      if (!previewState || previewChangeCount === 0 || syncConfirmOpen || event.isComposing || event.keyCode === 229) return;
      if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
      event.preventDefault();
      setSyncConfirmOpen(true);
    };
    document.addEventListener('keydown', handlePreviewShortcut);
    return () => document.removeEventListener('keydown', handlePreviewShortcut);
  }, [previewChangeCount, previewState, syncConfirmOpen]);

  const pageHeader = (
    <>
      <PageHeader title={t('archive.title')} />
      <p className="archive-subtitle">{t('archive.subtitle')}</p>
    </>
  );

  if (exampleState !== 'ready') {
    const clearExampleState = () => navigate(location.pathname, { replace: true });
    const stateView = exampleState === 'loading'
      ? <ArchiveStateView loading title={t('archive.loadingTitle')} body={t('archive.loadingBody')} />
      : exampleState === 'empty'
        ? <ArchiveStateView title={t('archive.emptyTitle')} body={t('archive.emptyBody')} />
        : exampleState === 'filtered'
          ? <ArchiveStateView title={t('archive.filteredTitle')} body={t('archive.filteredBody')} action={{ label: t('actions.clearFilters'), onClick: clearExampleState }} />
          : exampleState === 'conflict'
            ? <ArchiveStateView urgent title={t('archive.conflictTitle')} body={t('archive.conflictBody')} action={{ label: t('actions.previewSync'), onClick: clearExampleState }} />
            : <ArchiveStateView urgent title={t('archive.errorTitle')} body={t('archive.errorBody')} action={{ label: t('actions.retry'), onClick: clearExampleState }} />;
    return <div className="page-stack archive-page" role="region" aria-label={t('archive.aria.page')}>{pageHeader}<section className="panel">{stateView}</section></div>;
  }

  const previewGroups = (previewState ? [
    { change: 'Added' as const, ids: previewState.value.addedSampleIds },
    { change: 'Updated' as const, ids: previewState.value.updatedSampleIds },
    { change: 'Removed' as const, ids: previewState.value.removedSampleIds },
  ] : []).filter(group => group.ids.length > 0);
  const changeLabel = (change: ArchiveChange): string => {
    if (change === 'Added') return t('archive.added');
    if (change === 'Updated') return t('archive.updated');
    return t('archive.removed');
  };

  return (
    <div className="page-stack archive-page" role="region" aria-label={t('archive.aria.page')}>
      {pageHeader}
      {feedback ? (
        <section className={`archive-feedback archive-feedback--${feedback.kind}`} role="alert">
          <div><h2>{t(feedback.kind === 'conflict' ? 'archive.conflictTitle' : 'archive.errorTitle')}</h2><p>{t(feedback.kind === 'conflict' ? 'archive.conflictBody' : 'archive.errorBody')}</p></div>
          <Button onClick={feedback.kind === 'conflict' ? buildPreview : retryFeedback}>{t(feedback.kind === 'conflict' ? 'actions.previewSync' : 'actions.retry')}</Button>
        </section>
      ) : null}
      <span className="archive-live" role="status" aria-live="polite" aria-atomic="true">{liveMessage}</span>

      {archiveDatasets.length === 0 ? (
        <section className="panel"><ArchiveStateView title={t('archive.emptyTitle')} body={t('archive.emptyBody')} /></section>
      ) : (
        <>
          <section className="panel archive-toolbar" aria-label={t('archive.aria.toolbar')}>
            <label className="archive-dataset-select">
              <span>{t('archive.datasetLabel')}</span>
              <select value={dataset?.id ?? ''} onChange={event => resetForDataset(event.target.value)} aria-label={t('archive.aria.dataset')}>
                {archiveDatasets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <div className="archive-toolbar__actions">
              <Button variant="primary" onClick={buildPreview} disabled={!dataset}>{t('actions.previewSync')}</Button>
              <Button onClick={downloadJsonl} disabled={archivedSamples.length === 0}>{t('archive.downloadJsonl')}</Button>
            </div>
          </section>

          <section className="panel archive-overview" aria-label={t('archive.aria.overview')}>
            <div className="archive-overview__header">
              <div><h2>{t('archive.overview')}</h2><p>{currentArchive?.lastSyncedAt ? t('archive.lastSynced', { date: formatDateTime(currentArchive.lastSyncedAt) }) : t('archive.neverSynced')}</p></div>
            </div>
            <div className="metric-grid archive-metrics">
              <Metric label={t('archive.current')} value={currentArchive?.currentSampleIds.length ?? 0} />
              <Metric label={t('archive.toAdd')} value={counts.added} />
              <Metric label={t('archive.toUpdate')} value={counts.updated} />
              <Metric label={t('archive.toRemove')} value={counts.removed} />
            </div>
          </section>

          {rows.length === 0 ? (
            <section className="panel"><ArchiveStateView title={t('archive.emptyTitle')} body={t('archive.emptyBody')} /></section>
          ) : (
            <>
              <section className="panel archive-filters" aria-label={t('archive.currentArchive')}>
                <label className="archive-filter archive-filter--search">
                  <span>{t('fields.search')}</span>
                  <input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder={t('fields.searchPlaceholder')} aria-label={t('fields.search')} />
                </label>
                <label className="archive-filter">
                  <span>{t('archive.category')}</span>
                  <select value={categoryFilter} onChange={event => { setCategoryFilter(event.target.value as Category | 'All'); setPage(1); }} aria-label={t('archive.category')}>
                    <option value="All">{t('review.allCategories')}</option>
                    {categories.map(category => <option key={category} value={category}>{t(`category.${category}`)}</option>)}
                  </select>
                </label>
                {hasFilters ? <Button variant="quiet" onClick={clearFilters}>{t('actions.clearFilters')}</Button> : null}
              </section>

              <section className="panel archive-list-panel">
                <div className="section-header"><h2>{t('archive.currentArchive')}</h2><span>{t('archive.pageSize', { count: ARCHIVE_PAGE_SIZE })}</span></div>
                {filteredRows.length === 0 ? (
                  <ArchiveStateView title={t('archive.filteredTitle')} body={t('archive.filteredBody')} action={{ label: t('actions.clearFilters'), onClick: clearFilters }} />
                ) : (
                  <>
                    <div className="table-shell archive-table-shell">
                      <table aria-label={t('archive.aria.currentTable')} data-page-size={ARCHIVE_PAGE_SIZE}>
                        <caption>{t('table.archiveCaption')}</caption>
                        <thead><tr>
                          <th scope="col">{t('archive.thumbnail')}</th>
                          <th scope="col" aria-sort={sortKey === 'id' ? sortDirection : 'none'}><button type="button" onClick={() => requestSort('id')}><span>{t('archive.sampleId')}</span><span aria-hidden="true">{sortKey === 'id' ? sortDirection === 'ascending' ? '↑' : '↓' : '↕'}</span></button></th>
                          <th scope="col" aria-sort={sortKey === 'category' ? sortDirection : 'none'}><button type="button" onClick={() => requestSort('category')}><span>{t('archive.category')}</span><span aria-hidden="true">{sortKey === 'category' ? sortDirection === 'ascending' ? '↑' : '↓' : '↕'}</span></button></th>
                          <th scope="col" aria-sort={sortKey === 'updatedAt' ? sortDirection : 'none'}><button type="button" onClick={() => requestSort('updatedAt')}><span>{t('fields.updatedAt')}</span><span aria-hidden="true">{sortKey === 'updatedAt' ? sortDirection === 'ascending' ? '↑' : '↓' : '↕'}</span></button></th>
                        </tr></thead>
                        <tbody>{visibleRows.map(sample => (
                          <tr key={sample.id} data-sample-id={sample.displayId}>
                            <td><video className="archive-thumbnail" src={sample.primaryAssetUrl} muted preload="metadata" aria-label={t('archive.thumbnailAlt', { id: sample.displayId })} /></td>
                            <th scope="row">
                              <button type="button" className="table-link" onClick={() => openReview(sample)}>{sample.displayId}</button>
                              <span className="archive-sample-meta">{t(`category.${sample.category}`)}<br />{formatDateTime(sample.updatedAt)}</span>
                            </th>
                            <td>{t(`category.${sample.category}`)}</td>
                            <td>{formatDateTime(sample.updatedAt)}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                    <nav className="archive-pagination" aria-label={t('archive.aria.pagination')}>
                      <Button variant="secondary" onClick={() => setPage(current => Math.max(1, current - 1))} disabled={currentPage === 1}>{t('archive.previousPage')}</Button>
                      <label><span>{t('archive.page')}</span><select value={currentPage} onChange={event => setPage(Number(event.target.value))}>{Array.from({ length: totalPages }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select><span>{t('archive.pageTotal', { count: totalPages })}</span></label>
                      <Button variant="secondary" onClick={() => setPage(current => Math.min(totalPages, current + 1))} disabled={currentPage === totalPages}>{t('archive.nextPage')}</Button>
                    </nav>
                  </>
                )}
              </section>
            </>
          )}
        </>
      )}

      <Dialog open={previewState !== null} title={t('archive.previewTitle')} closeLabel={t('actions.close')} onClose={() => setPreviewState(null)} size="wide" footer={<><Button autoFocus onClick={() => setPreviewState(null)}>{t('actions.cancel')}</Button><Button variant="primary" busy={syncing} disabled={previewChangeCount === 0} onClick={() => setSyncConfirmOpen(true)}>{t('actions.syncArchive')}</Button></>}>
        {previewState ? (
          <div className="archive-preview" aria-label={t('archive.aria.preview')}>
            <p>{t('archive.previewIntro')}</p>
            <p>{t('archive.previewSummary', { add: previewState.value.addedSampleIds.length, update: previewState.value.updatedSampleIds.length, remove: previewState.value.removedSampleIds.length })}</p>
            {previewChangeCount === 0 ? <div className="archive-preview__current"><h3>{t('archive.noChangesTitle')}</h3><p>{t('archive.noChangesBody')}</p></div> : null}
            <div className="archive-preview__groups" aria-label={t('archive.aria.previewTable')}>
              {previewGroups.map(group => <section key={group.change} className="archive-preview__group"><h3><span>{changeLabel(group.change)}</span><span>{group.ids.length}</span></h3><ul>{group.ids.map(id => { const sample = sampleById.get(id); return <li key={id}><span>{sample?.displayId ?? id}</span><span>{sample ? t(`category.${sample.category}`) : t('state.empty.title')}</span></li>; })}</ul></section>)}
            </div>
            <p className="archive-preview__warning">{t('archive.confirmWarning')}</p>
          </div>
        ) : null}
      </Dialog>

      <Dialog open={syncConfirmOpen} title={t('archive.confirmTitle')} closeLabel={t('actions.close')} onClose={() => setSyncConfirmOpen(false)} footer={<><Button onClick={() => setSyncConfirmOpen(false)}>{t('actions.cancel')}</Button><Button variant="primary" busy={syncing} onClick={syncArchive}>{t('actions.syncArchive')}</Button></>}>
        <p>{t('archive.confirmBody', { add: previewState?.value.addedSampleIds.length ?? 0, update: previewState?.value.updatedSampleIds.length ?? 0, remove: previewState?.value.removedSampleIds.length ?? 0 })}</p>
        <p>{t('archive.confirmWarning')}</p>
      </Dialog>
    </div>
  );
}
