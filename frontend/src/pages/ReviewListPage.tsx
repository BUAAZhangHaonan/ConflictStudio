import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiErrorMessage } from '../api/client';
import type { ReviewBatchItemCreate, ReviewDecision, ReviewQueue, ReviewSampleListRead } from '../api/contracts';
import { reviewSampleQueries, useAllDatasetsQuery, useReviewSampleListQuery, useSubmitReviewBatchMutation } from '../api/queries';
import { useReviewGateReviewer } from '../app/ReviewGate';
import { Button, ConfirmDialog, Field, PageHeader, Pagination, StatusBadge, TableShell } from '../components';
import { useDebouncedValue } from './generate/shared';
import {
  buildReviewListLocation,
  currentPageSelection,
  readReviewListLocation,
  restoreReviewListState,
  reviewDetailLocation,
  saveReviewListState,
  type ReviewListLocationState,
} from '../reviewArchive';
import './ReviewListPage.css';

export const REVIEW_LIST_VISIBLE_FIELDS = [
  'displayId',
  'primaryMedia',
  'datasetName',
  'relation',
  'protocol',
  'trueEmotion',
  'apparentEmotion',
  'conflictDirection',
  'reviewDecision',
  'generationCompatibility',
] as const;

function relationCode(value: ReviewSampleListRead['relation']): string {
  return value === 'Aligned' ? 'A' : 'C';
}

function protocolCode(value: ReviewSampleListRead['protocol']): string {
  return value === 'VA' ? 'VA' : 'VT';
}

function emotionKey(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function reviewStatusKind(decision: ReviewDecision): 'neutral' | 'complete' | 'problem' {
  if (decision === 'Accepted') return 'complete';
  if (decision === 'Rejected') return 'problem';
  return 'neutral';
}

const defaultReviewListLocation: ReviewListLocationState = {
  search: null,
  datasetId: null,
  decision: 'All',
  protocol: null,
  relation: null,
  direction: null,
  page: 1,
};

export function ReviewListPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const reviewer = useReviewGateReviewer();
  const reviewerId = reviewer?.id ?? null;
  const queryString = searchParams.toString();
  const locationState = useMemo(() => readReviewListLocation(queryString), [queryString]);
  const returnTo = queryString ? `/review?${queryString}` : '/review';
  const queue = useMemo<ReviewQueue>(() => ({
    search: locationState.search,
    datasetId: locationState.datasetId,
    decision: locationState.decision,
    protocol: locationState.protocol,
    relation: locationState.relation,
    direction: locationState.direction,
  }), [
    locationState.search,
    locationState.datasetId,
    locationState.decision,
    locationState.protocol,
    locationState.relation,
    locationState.direction,
  ]);
  const listQuery = useReviewSampleListQuery({
    ...queue,
    page: locationState.page,
  });
  const datasetsQuery = useAllDatasetsQuery();
  const batchMutation = useSubmitReviewBatchMutation();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchDecision, setBatchDecision] = useState<Exclude<ReviewDecision, 'Pending'>>('Accepted');
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchItems, setBatchItems] = useState<ReviewBatchItemCreate[] | null>(null);
  const [batchPreparing, setBatchPreparing] = useState(false);
  const [batchPrepareError, setBatchPrepareError] = useState<unknown>(null);
  const restoredLocationRef = useRef<string | null>(null);
  const [searchInput, setSearchInput] = useState(locationState.search ?? '');
  const debouncedSearch = useDebouncedValue(searchInput);
  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';
  const emotionLabel = (value: string) => {
    if (!value.trim()) return t('review.list.emotionNotProvided');
    const key = `emotion.${emotionKey(value)}`;
    return i18n.exists(key) ? t(key) : value;
  };
  const samples = listQuery.data?.items ?? [];
  const datasets = datasetsQuery.data ?? [];
  const pageSelection = currentPageSelection(selectedIds, samples.map(sample => sample.id));
  const selectedSamples = samples.filter(sample => pageSelection.has(sample.id));
  const acceptedBlockedCount = batchDecision === 'Accepted'
    ? selectedSamples.filter(sample => sample.generationCompatibility === 'NeedsRegeneration').length
    : 0;
  const activeFilterCount = [
    locationState.search,
    locationState.datasetId,
    locationState.decision === 'All' ? null : locationState.decision,
    locationState.protocol,
    locationState.relation,
    locationState.direction,
  ].filter(value => value !== null).length;

  useEffect(() => {
    setSelectedIds(new Set());
    setBatchConfirmOpen(false);
    setBatchItems(null);
    setBatchPrepareError(null);
  }, [
    locationState.search,
    locationState.datasetId,
    locationState.decision,
    locationState.protocol,
    locationState.relation,
    locationState.direction,
    locationState.page,
  ]);

  useLayoutEffect(() => {
    if (!listQuery.isSuccess || restoredLocationRef.current === returnTo) return;
    restoredLocationRef.current = returnTo;
    const saved = restoreReviewListState(returnTo);
    if (saved === null) return;
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: saved.scrollY, left: 0, behavior: 'auto' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [listQuery.isSuccess, returnTo]);

  const updateLocation = (next: ReviewListLocationState) => {
    navigate(buildReviewListLocation(next), { replace: true });
  };

  const updateFilter = (patch: Partial<Omit<ReviewListLocationState, 'page'>>) => {
    updateLocation({ ...locationState, ...patch, page: 1 });
  };

  useEffect(() => {
    setSearchInput(locationState.search ?? '');
  }, [locationState.search]);

  useEffect(() => {
    const next = debouncedSearch || null;
    if (next === locationState.search) return;
    updateLocation({ ...locationState, search: next, page: 1 });
  }, [debouncedSearch, queryString]);

  const clearFilters = () => updateLocation(defaultReviewListLocation);

  const openDetail = (sample: ReviewSampleListRead) => {
    saveReviewListState({ returnTo, page: locationState.page, scrollY: window.scrollY });
    navigate(reviewDetailLocation(sample.id, returnTo));
  };

  const toggleSample = (sampleId: number, selected: boolean) => {
    if (reviewerId === null) return;
    setSelectedIds(current => {
      const next = currentPageSelection(current, samples.map(sample => sample.id));
      if (selected) next.add(sampleId);
      else next.delete(sampleId);
      return next;
    });
  };

  const togglePage = (selected: boolean) => {
    if (reviewerId === null) return;
    setSelectedIds(selected ? new Set(samples.map(sample => sample.id)) : new Set());
  };

  const prepareBatch = async () => {
    if (reviewerId === null || selectedSamples.length === 0 || acceptedBlockedCount > 0) return;
    setBatchPreparing(true);
    setBatchPrepareError(null);
    batchMutation.reset();
    try {
      const drafts = await Promise.all(selectedSamples.map(sample => (
        queryClient.fetchQuery(reviewSampleQueries.note(sample.id, reviewerId, sample.revision))
      )));
      setBatchItems(selectedSamples.map((sample, index) => ({
        sampleId: sample.id,
        reviewerId,
        decision: batchDecision,
        expectedRevision: sample.revision,
        expectedReviewRevision: sample.reviewRevision,
        expectedNoteDraftRevision: drafts[index].revision,
      })));
      setBatchConfirmOpen(true);
    } catch (error) {
      setBatchPrepareError(error);
    } finally {
      setBatchPreparing(false);
    }
  };

  const submitBatch = () => {
    if (batchItems === null || batchItems.length === 0) return;
    batchMutation.mutate({ items: batchItems }, {
      onSuccess: () => {
        setBatchConfirmOpen(false);
        setBatchItems(null);
        setSelectedIds(new Set());
      },
    });
  };

  const columns = [
    { key: 'selection', label: <span className="visually-hidden">{t('review.selectAllVisible')}</span> },
    { key: 'sample', label: t('review.sampleId') },
    { key: REVIEW_LIST_VISIBLE_FIELDS[2], label: t('fields.dataset') },
    { key: 'type', label: t('review.list.type') },
    { key: 'emotions', label: t('review.list.emotions') },
    { key: REVIEW_LIST_VISIBLE_FIELDS[7], label: t('review.list.directionFilter') },
    { key: 'status', label: t('review.decisionFilter') },
  ];

  return (
    <section className="page-stack review-list-page" aria-label={t('review.aria.page')}>
      <PageHeader
        title={t('review.title')}
        actions={<span className="review-list__count">{t('review.queueCount', { visible: samples.length, total: listQuery.data?.total ?? 0 })}</span>}
      />

      <details className="panel review-list__filters">
        <summary>
          <span>{t('review.filters')}</span>
          <span>{activeFilterCount > 0 ? t('review.activeFilters', { count: activeFilterCount }) : t('review.noActiveFilters')}</span>
        </summary>
        <div className="review-list__filter-body" aria-label={t('review.aria.filters')}>
          <div className="review-list__filter-actions">
            <Button variant="quiet" onClick={clearFilters}>{t('actions.clearFilters')}</Button>
          </div>
          <div className="review-list__filter-grid">
          <Field label={t('review.searchLabel')} htmlFor="review-list-search">
            <input
              id="review-list-search"
              type="search"
              value={searchInput}
              maxLength={160}
              placeholder={t('review.searchPlaceholder')}
              onChange={event => setSearchInput(event.target.value)}
            />
          </Field>
          <Field label={t('fields.dataset')} htmlFor="review-list-dataset">
            <select
              id="review-list-dataset"
              disabled={datasets.length === 0}
              value={datasets.length === 0 ? '' : locationState.datasetId ?? ''}
              onChange={event => updateFilter({ datasetId: event.target.value ? Number(event.target.value) : null })}
            >
              <option value="">{t('review.list.allDatasets')}</option>
              {datasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
            </select>
          </Field>
          <Field label={t('review.decisionFilter')} htmlFor="review-list-decision">
            <select id="review-list-decision" value={locationState.decision} onChange={event => updateFilter({ decision: event.target.value as ReviewListLocationState['decision'] })}>
              <option value="All">{t('review.allDecisions')}</option>
              <option value="Pending">{t('status.review.Pending')}</option>
              <option value="Accepted">{t('status.review.Accepted')}</option>
              <option value="Rejected">{t('status.review.Rejected')}</option>
            </select>
          </Field>
          <Field label={t('review.protocolFilter')} htmlFor="review-list-protocol">
            <select id="review-list-protocol" value={locationState.protocol ?? 'All'} onChange={event => updateFilter({ protocol: event.target.value === 'All' ? null : event.target.value as ReviewListLocationState['protocol'] })}>
              <option value="All">{t('review.allProtocols')}</option>
              <option value="VA">{t('review.protocolVA')}</option>
              <option value="VT">{t('review.protocolVT')}</option>
            </select>
          </Field>
          <Field label={t('review.list.relationFilter')} htmlFor="review-list-relation">
            <select id="review-list-relation" value={locationState.relation ?? 'All'} onChange={event => updateFilter({ relation: event.target.value === 'All' ? null : event.target.value as ReviewListLocationState['relation'] })}>
              <option value="All">{t('review.list.allRelations')}</option>
              <option value="Aligned">{t('review.categoryAligned')}</option>
              <option value="Conflict">{t('review.categoryConflict')}</option>
            </select>
          </Field>
          <Field label={t('review.list.directionFilter')} htmlFor="review-list-direction">
            <select id="review-list-direction" value={locationState.direction ?? 'All'} onChange={event => updateFilter({ direction: event.target.value === 'All' ? null : event.target.value as ReviewListLocationState['direction'] })}>
              <option value="All">{t('review.list.allDirections')}</option>
              <option value="Vision">{t('direction.Vision')}</option>
              <option value="Audio">{t('direction.Audio')}</option>
              <option value="Text">{t('direction.Text')}</option>
            </select>
          </Field>
          </div>
        </div>
      </details>

      {listQuery.error ? (
        <section className="state-view" role="alert">
          <h2>{t('review.errorTitle')}</h2>
          <p>{apiErrorMessage(listQuery.error, locale)}</p>
          <Button variant="secondary" onClick={() => void listQuery.refetch()}>{t('actions.retry')}</Button>
        </section>
      ) : listQuery.isPending ? (
        <section className="state-view" role="status">
          <span className="state-view__progress" aria-hidden="true" />
          <h2>{t('review.loadingTitle')}</h2>
          <p>{t('review.loadingBody')}</p>
        </section>
      ) : samples.length === 0 ? (
        <section className="state-view">
          <h2>{t('review.filteredTitle')}</h2>
          <p>{t('review.filteredBody')}</p>
        </section>
      ) : (
        <section className="panel review-list__results">
          <div className="review-list__selection-bar">
            <label>
              <input
                type="checkbox"
                checked={samples.length > 0 && pageSelection.size === samples.length}
                disabled={reviewerId === null}
                onChange={event => togglePage(event.target.checked)}
              />
              <span>{t('review.selectAllVisible')}</span>
            </label>
            <span>{t('review.selectionCount', { count: pageSelection.size })}</span>
          </div>

          <TableShell caption={t('table.samplesCaption')} columns={columns} busy={listQuery.isFetching}>
            {samples.map(sample => (
              <tr key={sample.id} className={pageSelection.has(sample.id) ? 'is-selected' : undefined}>
                <td className="review-list__select-cell">
                  <input
                    type="checkbox"
                    checked={pageSelection.has(sample.id)}
                    disabled={reviewerId === null}
                    aria-label={t('review.list.selectSample', { id: sample.displayId })}
                    onChange={event => toggleSample(sample.id, event.target.checked)}
                  />
                </td>
                <th scope="row" className="review-list__sample-cell">
                  <button type="button" className="table-link" onClick={() => openDetail(sample)}>{sample.displayId}</button>
                  <video
                    src={sample.primaryMedia.url}
                    muted
                    playsInline
                    preload="metadata"
                    aria-label={t('review.primaryMediaAlt', { id: sample.displayId })}
                  />
                </th>
                <td>{sample.datasetName}</td>
                <td>{t('review.list.typeValue', { relation: relationCode(sample.relation), protocol: protocolCode(sample.protocol) })}</td>
                <td className="review-list__emotion">{emotionLabel(sample.trueEmotion)} <span aria-hidden="true">→</span> {emotionLabel(sample.apparentEmotion)}</td>
                <td>{sample.conflictDirection ? t(`direction.${sample.conflictDirection}`) : t('review.list.directionNotNeeded')}</td>
                <td className="review-list__status-cell">
                  <StatusBadge label={t(`status.review.${sample.reviewDecision}`)} kind={reviewStatusKind(sample.reviewDecision)} />
                  {sample.generationCompatibility === 'NeedsRegeneration' ? <small>{t('review.compatibility.short')}</small> : null}
                </td>
              </tr>
            ))}
          </TableShell>

          <ul className="review-list__cards" aria-label={t('table.samplesCaption')}>
            {samples.map(sample => (
              <li key={sample.id} className={pageSelection.has(sample.id) ? 'is-selected' : undefined}>
                <div className="review-list__card-header">
                  <label>
                    <input
                      type="checkbox"
                      checked={pageSelection.has(sample.id)}
                      disabled={reviewerId === null}
                      aria-label={t('review.list.selectSample', { id: sample.displayId })}
                      onChange={event => toggleSample(sample.id, event.target.checked)}
                    />
                    <span>{sample.displayId}</span>
                  </label>
                  <StatusBadge label={t(`status.review.${sample.reviewDecision}`)} kind={reviewStatusKind(sample.reviewDecision)} />
                </div>
                <video
                  src={sample.primaryMedia.url}
                  muted
                  playsInline
                  preload="metadata"
                  aria-label={t('review.primaryMediaAlt', { id: sample.displayId })}
                />
                <dl>
                  <div><dt>{t('fields.dataset')}</dt><dd>{sample.datasetName}</dd></div>
                  <div><dt>{t('review.list.type')}</dt><dd>{t('review.list.typeValue', { relation: relationCode(sample.relation), protocol: protocolCode(sample.protocol) })}</dd></div>
                  <div><dt>{t('review.list.emotions')}</dt><dd>{emotionLabel(sample.trueEmotion)} <span aria-hidden="true">→</span> {emotionLabel(sample.apparentEmotion)}</dd></div>
                  <div>
                    <dt>{t('review.list.directionFilter')}</dt>
                    <dd>{sample.conflictDirection ? t(`direction.${sample.conflictDirection}`) : t('review.list.directionNotNeeded')}</dd>
                  </div>
                  {sample.generationCompatibility === 'NeedsRegeneration' ? <div><dt>{t('review.compatibility.label')}</dt><dd>{t('review.compatibility.short')}</dd></div> : null}
                </dl>
                <Button variant="secondary" onClick={() => openDetail(sample)}>{t('review.list.openSample')}</Button>
              </li>
            ))}
          </ul>

          <Pagination
            page={listQuery.data.page}
            totalPages={listQuery.data.totalPages}
            total={listQuery.data.total}
            onPageChange={page => updateLocation({ ...locationState, page })}
          />

          <section className="review-list__batch" aria-label={t('review.aria.batch')}>
            <Field label={t('review.batchDecision')} htmlFor="review-list-batch-decision">
              <select
                id="review-list-batch-decision"
                value={batchDecision}
                disabled={reviewerId === null}
                onChange={event => {
                  setBatchDecision(event.target.value as Exclude<ReviewDecision, 'Pending'>);
                  setBatchItems(null);
                  setBatchPrepareError(null);
                }}
              >
                <option value="Accepted">{t('status.review.Accepted')}</option>
                <option value="Rejected">{t('status.review.Rejected')}</option>
              </select>
            </Field>
            <Button
              variant="primary"
              busy={batchPreparing}
              disabled={reviewerId === null || selectedSamples.length === 0 || acceptedBlockedCount > 0}
              onClick={() => void prepareBatch()}
            >
              {t('review.applyBatch')}
            </Button>
            {reviewerId === null ? <p className="field-error" role="status">{t('review.list.batchGuestHint')}</p> : null}
          </section>
          {acceptedBlockedCount > 0 ? <p className="field-error" role="status">{t('review.batchCompatibilityBlocked', { count: acceptedBlockedCount })}</p> : null}
        </section>
      )}

      {batchPrepareError ? <section className="generation-feedback" role="alert"><p>{apiErrorMessage(batchPrepareError, locale)}</p></section> : null}
      {batchMutation.error ? <section className="generation-feedback" role="alert"><p>{apiErrorMessage(batchMutation.error, locale)}</p></section> : null}

      <ConfirmDialog
        open={batchConfirmOpen}
        title={t('review.batchConfirmTitle')}
        body={<><p>{t('review.batchConfirmBody', { decision: t(`status.review.${batchDecision}`), count: selectedSamples.length })}</p><p>{t('review.batchConfirmConsequence')}</p></>}
        confirmLabel={t('review.batchConfirmAction', { decision: t(`status.review.${batchDecision}`) })}
        cancelLabel={t('actions.cancel')}
        closeLabel={t('actions.close')}
        busy={batchMutation.isPending}
        confirmDisabled={batchItems === null || batchItems.length === 0}
        onClose={() => {
          setBatchConfirmOpen(false);
          setBatchItems(null);
        }}
        onConfirm={submitBatch}
      />
    </section>
  );
}
