import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useExamplePageState } from '../app/useExamplePageState';
import { Button, Dialog, Metric, PageHeader, StatusBadge, useToast } from '../components';
import { useMockRepository, useRepositorySnapshot } from '../store';
import {
  protocolForCategory,
  type ArchivePreview,
  type Category,
  type Sample,
} from '../types';
import './ArchivePage.css';

type ArchiveChange = 'Added' | 'Updated' | 'Removed' | 'Unchanged';
type ArchiveSortKey = 'id' | 'category' | 'updatedAt';
type SortDirection = 'ascending' | 'descending';

interface ArchiveRow {
  sample: Sample;
  change: ArchiveChange;
}

interface PreviewState {
  value: ArchivePreview;
  unchangedSampleIds: string[];
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
const changes: readonly ArchiveChange[] = ['Added', 'Updated', 'Removed', 'Unchanged'];

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function archiveJsonl(samples: readonly Sample[]): string {
  return `${samples
    .map(sample => {
      const media = [
        {
          asset_id: sample.primaryAssetId,
          type: 'video',
          role: 'primary',
          url: sample.primaryAssetId,
        },
        sample.sourceAssetId
          ? {
              asset_id: sample.sourceAssetId,
              type: 'video',
              role: 'source',
              url: sample.sourceAssetId,
            }
          : null,
        sample.thumbnailAssetId
          ? {
              asset_id: sample.thumbnailAssetId,
              type: 'image',
              role: 'thumbnail',
              url: sample.thumbnailAssetId,
            }
          : null,
      ].filter(item => item !== null);

      return JSON.stringify({
        dataset_id: sample.datasetId,
        source_id: sample.displayId,
        sample_id: sample.id,
        protocol: protocolForCategory(sample.category),
        relation: sample.category.startsWith('A-') ? 'Aligned' : 'Conflict',
        conflict_direction: sample.conflictDirection,
        decision: sample.reviewDecision,
        media,
        model: sample.model,
        dialogue: sample.dialogue,
        display_text: sample.displayText,
        video_prompt: sample.videoPrompt,
        explanation: sample.explanation,
        emotion: sample.emotion,
        seed: sample.seed,
        updated_at: sample.updatedAt,
      });
    })
    .join('\n')}\n`;
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
  const detailId = useId();
  const archiveDatasets = useMemo(
    () => snapshot.data.datasets,
    [snapshot.data.datasets],
  );
  const initialParams = new URLSearchParams(location.search);
  const requestedDataset = initialParams.get('dataset');
  const requestedChange = initialParams.get('change');
  const [datasetId, setDatasetId] = useState(() =>
    archiveDatasets.some(item => item.id === requestedDataset) ? requestedDataset! : archiveDatasets[0]?.id ?? '',
  );
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<Category | 'All'>('All');
  const [changeFilter, setChangeFilter] = useState<ArchiveChange | 'All'>(() =>
    changes.includes(requestedChange as ArchiveChange) ? requestedChange as ArchiveChange : 'All',
  );
  const [sortKey, setSortKey] = useState<ArchiveSortKey>('id');
  const [sortDirection, setSortDirection] = useState<SortDirection>('ascending');
  const [selectedSampleId, setSelectedSampleId] = useState('');
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

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const nextDataset = params.get('dataset');
    const nextChange = params.get('change');
    if (nextDataset && archiveDatasets.some(item => item.id === nextDataset)) setDatasetId(nextDataset);
    if (changes.includes(nextChange as ArchiveChange)) setChangeFilter(nextChange as ArchiveChange);
  }, [archiveDatasets, location.search]);

  const currentPreview = useMemo(
    () => (dataset ? repository.previewArchive(dataset.id) : null),
    [currentArchive?.revision, dataset, repository, snapshot.data.samples],
  );

  const rows = useMemo<ArchiveRow[]>(() => {
    if (!dataset || !currentPreview?.ok) return [];
    const currentIds = new Set(currentArchive?.currentSampleIds ?? []);
    const addedIds = new Set(currentPreview.value.addedSampleIds);
    const updatedIds = new Set(currentPreview.value.updatedSampleIds);
    const removedIds = new Set(currentPreview.value.removedSampleIds);
    const rowIds = new Set([
      ...currentIds,
      ...snapshot.data.samples
        .filter(sample => sample.datasetId === dataset.id && sample.reviewDecision === 'Accepted')
        .map(sample => sample.id),
    ]);

    return [...rowIds].flatMap(id => {
      const sample = sampleById.get(id);
      if (!sample || sample.datasetId !== dataset.id) return [];
      let change: ArchiveChange = 'Unchanged';
      if (addedIds.has(id)) change = 'Added';
      else if (updatedIds.has(id)) change = 'Updated';
      else if (removedIds.has(id)) change = 'Removed';
      return [{ sample, change }];
    });
  }, [currentArchive?.currentSampleIds, currentPreview, dataset, sampleById, snapshot.data.samples]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(snapshot.preferences.locale);
    const matches = rows.filter(({ sample, change }) => {
      const searchText = [sample.displayId, sample.id, dataset?.name, sample.category, sample.model]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase(snapshot.preferences.locale);
      return (
        (!query || searchText.includes(query)) &&
        (categoryFilter === 'All' || sample.category === categoryFilter) &&
        (changeFilter === 'All' || change === changeFilter)
      );
    });
    const direction = sortDirection === 'ascending' ? 1 : -1;
    return [...matches].sort((left, right) => {
      let result = 0;
      if (sortKey === 'id') result = compareText(left.sample.displayId, right.sample.displayId);
      if (sortKey === 'category') result = compareText(left.sample.category, right.sample.category);
      if (sortKey === 'updatedAt') result = compareText(left.sample.updatedAt, right.sample.updatedAt);
      return direction * (result || compareText(left.sample.id, right.sample.id));
    });
  }, [categoryFilter, changeFilter, dataset?.name, rows, search, snapshot.preferences.locale, sortDirection, sortKey]);

  const selectedRow = filteredRows.find(row => row.sample.id === selectedSampleId) ?? filteredRows[0] ?? null;
  const archivedSamples = useMemo(
    () =>
      (currentArchive?.currentSampleIds ?? [])
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
        unchanged: currentPreview.value.unchangedCount,
      }
    : { added: 0, updated: 0, removed: 0, unchanged: 0 };
  const hasFilters = search.trim() !== '' || categoryFilter !== 'All' || changeFilter !== 'All';
  const previewChangeCount = previewState
    ? previewState.value.addedSampleIds.length +
      previewState.value.updatedSampleIds.length +
      previewState.value.removedSampleIds.length
    : 0;

  const changeLabel = (change: ArchiveChange): string => {
    if (change === 'Added') return t('archive.added');
    if (change === 'Updated') return t('archive.updated');
    if (change === 'Removed') return t('archive.removed');
    return t('archive.unchangedRows');
  };

  const changeKind = (change: ArchiveChange): 'active' | 'complete' | 'problem' => {
    if (change === 'Added') return 'active';
    if (change === 'Unchanged') return 'complete';
    return 'problem';
  };

  const clearFilters = () => {
    setSearch('');
    setCategoryFilter('All');
    setChangeFilter('All');
    navigate('/archive', { replace: true });
  };

  const resetForDataset = (nextDatasetId: string) => {
    setDatasetId(nextDatasetId);
    clearFilters();
    setSelectedSampleId('');
    setPreviewState(null);
    setFeedback(null);
    setLiveMessage('');
  };

  const requestSort = (nextKey: ArchiveSortKey) => {
    if (nextKey === sortKey) {
      setSortDirection(current => (current === 'ascending' ? 'descending' : 'ascending'));
      return;
    }
    setSortKey(nextKey);
    setSortDirection(nextKey === 'updatedAt' ? 'descending' : 'ascending');
  };

  const buildPreview = () => {
    if (!dataset) return;
    const result = repository.previewArchive(dataset.id);
    if (!result.ok) {
      setFeedback({ kind: result.kind === 'Conflict' ? 'conflict' : 'error', retry: 'preview' });
      setLiveMessage(t(result.kind === 'Conflict' ? 'archive.aria.conflict' : 'archive.aria.error'));
      return;
    }
    const changedIds = new Set([
      ...result.value.addedSampleIds,
      ...result.value.updatedSampleIds,
      ...result.value.removedSampleIds,
    ]);
    const currentIds = new Set(currentArchive?.currentSampleIds ?? []);
    const unchangedSampleIds = snapshot.data.samples
      .filter(
        sample =>
          sample.datasetId === dataset.id &&
          sample.reviewDecision === 'Accepted' &&
          currentIds.has(sample.id) &&
          !changedIds.has(sample.id),
      )
      .map(sample => sample.id)
      .sort(compareText);
    setPreviewState({ value: result.value, unchangedSampleIds });
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
      const blob = new Blob([archiveJsonl(archivedSamples)], {
        type: 'application/x-ndjson;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${dataset.id}-archive.jsonl`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      const message = t('archive.exportReady', { format: 'JSONL' });
      setLiveMessage(t('archive.aria.exportReady', { format: 'JSONL' }));
      showToast(message);
    } catch {
      setFeedback({ kind: 'error', retry: 'export' });
      setLiveMessage(t('archive.aria.error'));
    }
  };

  const clearExampleState = () => navigate(location.pathname, { replace: true });
  const regenerateFromExampleConflict = () => {
    buildPreview();
    clearExampleState();
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
      <PageHeader
        title={t('archive.title')}
        actions={
          <Button
            variant="primary"
            onClick={buildPreview}
            disabled={!dataset}
            title={t('archive.previewTitle')}
            aria-label={t('actions.previewSync')}
          >
            {t('actions.previewSync')}
          </Button>
        }
      />
      <p className="archive-subtitle">{t('archive.subtitle')}</p>
    </>
  );

  if (exampleState !== 'ready') {
    const stateView = (() => {
      if (exampleState === 'loading') {
        return <ArchiveStateView loading title={t('archive.loadingTitle')} body={t('archive.loadingBody')} />;
      }
      if (exampleState === 'empty') {
        return <ArchiveStateView title={t('archive.emptyTitle')} body={t('archive.emptyBody')} />;
      }
      if (exampleState === 'filtered') {
        return (
          <ArchiveStateView
            title={t('archive.filteredTitle')}
            body={t('archive.filteredBody')}
            action={{ label: t('actions.clearFilters'), onClick: clearExampleState }}
          />
        );
      }
      if (exampleState === 'conflict') {
        return (
          <ArchiveStateView
            urgent
            title={t('archive.conflictTitle')}
            body={t('archive.conflictBody')}
            action={{ label: t('actions.previewSync'), onClick: regenerateFromExampleConflict }}
          />
        );
      }
      return (
        <ArchiveStateView
          urgent
          title={t('archive.errorTitle')}
          body={t('archive.errorBody')}
          action={{ label: t('actions.retry'), onClick: clearExampleState }}
        />
      );
    })();
    return (
      <div className="page-stack archive-page" role="region" aria-label={t('archive.aria.page')}>
        {pageHeader}
        <section className="panel">{stateView}</section>
      </div>
    );
  }

  const previewGroups = previewState
    ? [
        { change: 'Added' as const, ids: previewState.value.addedSampleIds },
        { change: 'Updated' as const, ids: previewState.value.updatedSampleIds },
        { change: 'Removed' as const, ids: previewState.value.removedSampleIds },
        { change: 'Unchanged' as const, ids: previewState.unchangedSampleIds },
      ]
    : [];

  return (
    <div className="page-stack archive-page" role="region" aria-label={t('archive.aria.page')}>
      {pageHeader}
      {feedback ? (
        <section className={`archive-feedback archive-feedback--${feedback.kind}`} role="alert">
          <div>
            <h2>{t(feedback.kind === 'conflict' ? 'archive.conflictTitle' : 'archive.errorTitle')}</h2>
            <p>{t(feedback.kind === 'conflict' ? 'archive.conflictBody' : 'archive.errorBody')}</p>
          </div>
          <Button onClick={feedback.kind === 'conflict' ? buildPreview : retryFeedback}>
            {t(feedback.kind === 'conflict' ? 'actions.previewSync' : 'actions.retry')}
          </Button>
        </section>
      ) : null}
      <span className="archive-live" role="status" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </span>

      {archiveDatasets.length === 0 ? (
        <section className="panel">
          <ArchiveStateView title={t('archive.emptyTitle')} body={t('archive.emptyBody')} />
        </section>
      ) : (
        <>
          <section className="panel archive-overview" aria-label={t('archive.aria.overview')}>
            <div className="archive-overview__header">
              <div>
                <h2>{t('archive.overview')}</h2>
                <p>
                  {currentArchive?.lastSyncedAt
                    ? t('archive.lastSynced', {
                        date: new Date(currentArchive.lastSyncedAt).toLocaleString(snapshot.preferences.locale),
                      })
                    : t('archive.neverSynced')}
                </p>
              </div>
              <label className="archive-dataset-select">
                <span>{t('archive.datasetLabel')}</span>
                <select
                  value={dataset?.id ?? ''}
                  onChange={event => resetForDataset(event.target.value)}
                  aria-label={t('archive.aria.dataset')}
                  title={t('archive.aria.dataset')}
                >
                  {archiveDatasets.map(item => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="metric-grid archive-metrics">
              <Metric label={t('archive.current')} value={currentArchive?.currentSampleIds.length ?? 0} />
              <Metric label={t('archive.toAdd')} value={counts.added} />
              <Metric label={t('archive.toUpdate')} value={counts.updated} />
              <Metric label={t('archive.toRemove')} value={counts.removed} />
              <Metric label={t('archive.unchanged')} value={counts.unchanged} />
            </div>
          </section>

          {rows.length === 0 ? (
            <section className="panel">
              <ArchiveStateView title={t('archive.emptyTitle')} body={t('archive.emptyBody')} />
            </section>
          ) : (
            <>
              <section className="panel archive-filters" aria-label={t('archive.currentArchive')}>
                <label className="archive-filter archive-filter--search">
                  <span>{t('fields.search')}</span>
                  <input
                    type="search"
                    value={search}
                    onChange={event => setSearch(event.target.value)}
                    placeholder={t('fields.searchPlaceholder')}
                    title={t('fields.search')}
                    aria-label={t('fields.search')}
                  />
                </label>
                <label className="archive-filter">
                  <span>{t('archive.category')}</span>
                  <select
                    value={categoryFilter}
                    onChange={event => setCategoryFilter(event.target.value as Category | 'All')}
                    aria-label={t('archive.category')}
                    title={t('archive.category')}
                  >
                    <option value="All">{t('review.allCategories')}</option>
                    {categories.map(category => (
                      <option key={category} value={category}>{t(`category.${category}`)}</option>
                    ))}
                  </select>
                </label>
                <label className="archive-filter">
                  <span>{t('archive.change')}</span>
                  <select
                    value={changeFilter}
                    onChange={event => setChangeFilter(event.target.value as ArchiveChange | 'All')}
                    aria-label={t('archive.change')}
                    title={t('archive.change')}
                  >
                    <option value="All">{t('archive.allChanges')}</option>
                    {changes.map(change => (
                      <option key={change} value={change}>{changeLabel(change)}</option>
                    ))}
                  </select>
                </label>
              </section>

              <div className={`archive-workspace ${selectedRow ? '' : 'archive-workspace--single'}`.trim()}>
                <section className="panel archive-list-panel">
                  <div className="section-header">
                    <h2>{t('archive.currentArchive')}</h2>
                    {hasFilters ? (
                      <Button variant="quiet" onClick={clearFilters} title={t('actions.clearFilters')}>
                        {t('actions.clearFilters')}
                      </Button>
                    ) : null}
                  </div>
                  {filteredRows.length === 0 ? (
                    <ArchiveStateView
                      title={t('archive.filteredTitle')}
                      body={t('archive.filteredBody')}
                      action={{ label: t('actions.clearFilters'), onClick: clearFilters }}
                    />
                  ) : (
                    <div className="table-shell archive-table-shell">
                      <table aria-label={t('archive.aria.currentTable')}>
                        <caption>{t('table.archiveCaption')}</caption>
                        <thead>
                          <tr>
                            <th scope="col" aria-sort={sortKey === 'id' ? sortDirection : 'none'}>
                              <button
                                type="button"
                                onClick={() => requestSort('id')}
                                title={t('archive.sampleId')}
                                aria-label={t('archive.sampleId')}
                              >
                                <span>{t('archive.sampleId')}</span>
                                <span aria-hidden="true">{sortKey === 'id' ? (sortDirection === 'ascending' ? '↑' : '↓') : '↕'}</span>
                              </button>
                            </th>
                            <th scope="col" aria-sort={sortKey === 'category' ? sortDirection : 'none'}>
                              <button
                                type="button"
                                onClick={() => requestSort('category')}
                                title={t('archive.category')}
                                aria-label={t('archive.category')}
                              >
                                <span>{t('archive.category')}</span>
                                <span aria-hidden="true">{sortKey === 'category' ? (sortDirection === 'ascending' ? '↑' : '↓') : '↕'}</span>
                              </button>
                            </th>
                            <th scope="col">{t('archive.change')}</th>
                            <th scope="col" aria-sort={sortKey === 'updatedAt' ? sortDirection : 'none'}>
                              <button
                                type="button"
                                onClick={() => requestSort('updatedAt')}
                                title={t('fields.updatedAt')}
                                aria-label={t('fields.updatedAt')}
                              >
                                <span>{t('fields.updatedAt')}</span>
                                <span aria-hidden="true">{sortKey === 'updatedAt' ? (sortDirection === 'ascending' ? '↑' : '↓') : '↕'}</span>
                              </button>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredRows.map(row => {
                            const selected = row.sample.id === selectedRow?.sample.id;
                            return (
                              <tr key={row.sample.id} className={selected ? 'is-selected' : undefined}>
                                <th scope="row">
                                  <button
                                    type="button"
                                    className="table-link"
                                    aria-pressed={selected}
                                    aria-expanded={selected}
                                    aria-controls={detailId}
                                    title={selectedRow?.sample.id === row.sample.id ? row.sample.displayId : `${row.sample.displayId} — ${t('archive.currentArchive')}`}
                                    aria-label={row.sample.displayId}
                                    onClick={() => setSelectedSampleId(row.sample.id)}
                                  >
                                    {row.sample.displayId}
                                  </button>
                                </th>
                                <td>{t(`category.${row.sample.category}`)}</td>
                                <td><StatusBadge label={changeLabel(row.change)} kind={changeKind(row.change)} /></td>
                                <td>{new Date(row.sample.updatedAt).toLocaleString(snapshot.preferences.locale)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {selectedRow ? (
                  <aside id={detailId} className="panel archive-detail" aria-labelledby={`${detailId}-title`}>
                    <div className="section-header">
                      <h2 id={`${detailId}-title`}>{selectedRow.sample.displayId}</h2>
                      <StatusBadge label={changeLabel(selectedRow.change)} kind={changeKind(selectedRow.change)} />
                    </div>
                    <dl className="archive-detail__list">
                      <div><dt>{t('archive.category')}</dt><dd>{t(`category.${selectedRow.sample.category}`)}</dd></div>
                      <div><dt>{t('review.protocolFilter')}</dt><dd>{t(protocolForCategory(selectedRow.sample.category) === 'VA' ? 'review.protocolVA' : 'review.protocolVT')}</dd></div>
                      <div>
                        <dt>{t('direction.label')}</dt>
                        <dd>{selectedRow.sample.conflictDirection ? t(`direction.${selectedRow.sample.conflictDirection}`) : t('review.directionNotRequired')}</dd>
                      </div>
                      <div><dt>{t('archive.archiveStatus')}</dt><dd><StatusBadge label={t(`status.archive.${selectedRow.sample.archiveStatus}`)} kind={selectedRow.sample.archiveStatus === 'Current' ? 'complete' : 'problem'} /></dd></div>
                      <div><dt>{t('review.model')}</dt><dd>{selectedRow.sample.model}</dd></div>
                      <div><dt>{t('review.seed')}</dt><dd>{selectedRow.sample.seed}</dd></div>
                      <div><dt>{t('review.updatedAt')}</dt><dd>{new Date(selectedRow.sample.updatedAt).toLocaleString(snapshot.preferences.locale)}</dd></div>
                      <div className="archive-detail__wide">
                        <dt>{t(protocolForCategory(selectedRow.sample.category) === 'VA' ? 'review.dialogue' : 'review.displayText')}</dt>
                        <dd>{protocolForCategory(selectedRow.sample.category) === 'VA' ? selectedRow.sample.dialogue ?? '—' : selectedRow.sample.displayText ?? '—'}</dd>
                      </div>
                      <div className="archive-detail__wide"><dt>{t('review.prompt')}</dt><dd>{selectedRow.sample.videoPrompt}</dd></div>
                      <div className="archive-detail__wide"><dt>{t('review.explanation')}</dt><dd>{selectedRow.sample.explanation}</dd></div>
                      <div className="archive-detail__wide"><dt>{t('review.primaryMedia')}</dt><dd>{t('review.playableMedia')}</dd></div>
                      {protocolForCategory(selectedRow.sample.category) === 'VT' ? (
                        <div className="archive-detail__wide"><dt>{t('review.generationRecord')}</dt><dd>{selectedRow.sample.sourceAssetId ? t('review.sourceRecord') : '—'}</dd></div>
                      ) : null}
                    </dl>
                  </aside>
                ) : null}
              </div>
            </>
          )}

          <section className="panel archive-export" aria-label={t('archive.aria.exports')}>
            <div className="section-header"><h2>{t('archive.exportTitle')}</h2></div>
            <p className="archive-export__description">{t('archive.exportDescription')}</p>
            <div className="archive-export__options">
              <div className="archive-export__option">
                <div>
                  <strong>{t('archive.downloadJsonl')}</strong>
                  <p>{t('archive.jsonlDescription')}</p>
                </div>
                <Button
                  onClick={downloadJsonl}
                  disabled={archivedSamples.length === 0}
                  aria-label={t('archive.aria.jsonlDownload')}
                  title={t('archive.aria.jsonlDownload')}
                >
                  {t('archive.downloadJsonl')}
                </Button>
              </div>
            </div>
          </section>
        </>
      )}

      <Dialog
        open={previewState !== null}
        title={t('archive.previewTitle')}
        closeLabel={t('actions.close')}
        onClose={() => setPreviewState(null)}
        size="wide"
        footer={
          <>
            <Button autoFocus onClick={() => setPreviewState(null)}>{t('actions.cancel')}</Button>
            <Button
              variant="primary"
              busy={syncing}
              disabled={previewChangeCount === 0}
              onClick={() => setSyncConfirmOpen(true)}
            >
              {t('actions.syncArchive')}
            </Button>
          </>
        }
      >
        {previewState ? (
          <div className="archive-preview" aria-label={t('archive.aria.preview')}>
            <p>{t('archive.previewIntro')}</p>
            <p>
              {t('archive.previewSummary', {
                add: previewState.value.addedSampleIds.length,
                update: previewState.value.updatedSampleIds.length,
                remove: previewState.value.removedSampleIds.length,
                unchanged: previewState.value.unchangedCount,
              })}
            </p>
            {previewChangeCount === 0 ? (
              <div className="archive-preview__current">
                <h3>{t('archive.noChangesTitle')}</h3>
                <p>{t('archive.noChangesBody')}</p>
              </div>
            ) : null}
            <div className="archive-preview__groups" aria-label={t('archive.aria.previewTable')}>
              {previewGroups.map(group => (
                <section key={group.change} className="archive-preview__group">
                  <h3>
                    <span>{changeLabel(group.change)}</span>
                    <span>{group.ids.length}</span>
                  </h3>
                  {group.ids.length > 0 ? (
                    <ul>
                      {group.ids.map(id => {
                        const sample = sampleById.get(id);
                        return (
                          <li key={id}>
                            <span>{sample?.displayId ?? id}</span>
                            <span>{sample ? t(`category.${sample.category}`) : '—'}</span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : <span className="archive-preview__zero">0</span>}
                </section>
              ))}
            </div>
            <p className="archive-preview__warning">{t('archive.confirmWarning')}</p>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={syncConfirmOpen}
        title={t('archive.confirmTitle')}
        closeLabel={t('actions.close')}
        onClose={() => setSyncConfirmOpen(false)}
        footer={<><Button onClick={() => setSyncConfirmOpen(false)}>{t('actions.cancel')}</Button><Button variant="primary" busy={syncing} onClick={syncArchive}>{t('actions.syncArchive')}</Button></>}
      >
        <p>{t('archive.confirmBody', { add: previewState?.value.addedSampleIds.length ?? 0, update: previewState?.value.updatedSampleIds.length ?? 0, remove: previewState?.value.removedSampleIds.length ?? 0 })}</p>
        <p>{t('archive.confirmWarning')}</p>
      </Dialog>
    </div>
  );
}
