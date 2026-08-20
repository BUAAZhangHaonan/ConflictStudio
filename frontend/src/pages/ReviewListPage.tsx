import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiErrorMessage } from '../api/client';
import type { ReviewDecision, ReviewQueue, ReviewSampleListRead } from '../api/contracts';
import { useReviewSampleListQuery, useSubmitReviewBatchMutation } from '../api/queries';
import { Button, ConfirmDialog, Field, PageHeader, Pagination, StatusBadge, TableShell } from '../components';
import { usePreferences } from '../preferences';
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
  'gender',
  'reviewDecision',
] as const;

function relationCode(value: ReviewSampleListRead['relation']): string {
  return value === 'Aligned' ? 'A' : 'C';
}

function protocolCode(value: ReviewSampleListRead['protocol']): string {
  return value === 'VA' ? 'VA' : 'VT';
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
  const [searchParams] = useSearchParams();
  const preferences = usePreferences();
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
  const batchMutation = useSubmitReviewBatchMutation();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchDecision, setBatchDecision] = useState<Exclude<ReviewDecision, 'Pending'>>('Accepted');
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const restoredLocationRef = useRef<string | null>(null);
  const canReview = preferences.currentReviewerId !== null;
  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';
  const samples = listQuery.data?.items ?? [];
  const pageSelection = currentPageSelection(selectedIds, samples.map(sample => sample.id));
  const selectedSamples = samples.filter(sample => pageSelection.has(sample.id));

  useEffect(() => {
    setSelectedIds(new Set());
    setBatchConfirmOpen(false);
  }, [
    locationState.search,
    locationState.datasetId,
    locationState.decision,
    locationState.protocol,
    locationState.relation,
    locationState.direction,
    locationState.page,
  ]);

  useEffect(() => {
    if (canReview) return;
    setSelectedIds(new Set());
    setBatchConfirmOpen(false);
  }, [canReview]);

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

  const clearFilters = () => updateLocation(defaultReviewListLocation);

  const openDetail = (sample: ReviewSampleListRead) => {
    saveReviewListState({ returnTo, page: locationState.page, scrollY: window.scrollY });
    navigate(reviewDetailLocation(sample.id));
  };

  const toggleSample = (sampleId: number, selected: boolean) => {
    if (!canReview) return;
    setSelectedIds(current => {
      const next = currentPageSelection(current, samples.map(sample => sample.id));
      if (selected) next.add(sampleId);
      else next.delete(sampleId);
      return next;
    });
  };

  const togglePage = (selected: boolean) => {
    if (!canReview) return;
    setSelectedIds(selected ? new Set(samples.map(sample => sample.id)) : new Set());
  };

  const submitBatch = () => {
    if (preferences.currentReviewerId === null || selectedSamples.length === 0) return;
    batchMutation.mutate({
      items: selectedSamples.map(sample => ({
        sampleId: sample.id,
        reviewerId: preferences.currentReviewerId as number,
        decision: batchDecision,
        expectedRevision: sample.revision,
        expectedReviewRevision: sample.reviewRevision,
        expectedNoteDraftRevision: 0,
      })),
    }, {
      onSuccess: () => {
        setBatchConfirmOpen(false);
        setSelectedIds(new Set());
      },
    });
  };

  const columns = [
    { key: 'selection', label: <span className="visually-hidden">{t('review.selectAllVisible')}</span> },
    { key: REVIEW_LIST_VISIBLE_FIELDS[0], label: t('review.sampleId') },
    { key: REVIEW_LIST_VISIBLE_FIELDS[1], label: t('review.video') },
    { key: REVIEW_LIST_VISIBLE_FIELDS[2], label: t('fields.dataset') },
    { key: REVIEW_LIST_VISIBLE_FIELDS[3], label: t('review.list.relationFilter') },
    { key: REVIEW_LIST_VISIBLE_FIELDS[4], label: t('review.protocolFilter') },
    { key: REVIEW_LIST_VISIBLE_FIELDS[5], label: t('review.trueEmotion') },
    { key: REVIEW_LIST_VISIBLE_FIELDS[6], label: t('review.apparentEmotion') },
    { key: REVIEW_LIST_VISIBLE_FIELDS[7], label: t('review.list.directionFilter') },
    { key: REVIEW_LIST_VISIBLE_FIELDS[8], label: t('review.list.gender') },
    { key: REVIEW_LIST_VISIBLE_FIELDS[9], label: t('review.decisionFilter') },
  ];

  return (
    <section className="page-stack review-list-page" aria-label={t('review.aria.page')}>
      <PageHeader
        title={t('review.title')}
        actions={<span className="review-list__count">{t('review.queueCount', { visible: samples.length, total: listQuery.data?.total ?? 0 })}</span>}
      />

      {!canReview ? <section className="generation-feedback" role="status"><p>{t('reviewer.readOnlyHint')}</p></section> : null}

      <section className="panel review-list__filters" aria-label={t('review.aria.filters')}>
        <div className="section-header">
          <h2>{t('review.filters')}</h2>
          <Button variant="quiet" onClick={clearFilters}>{t('actions.clearFilters')}</Button>
        </div>
        <div className="review-list__filter-grid">
          <Field label={t('review.searchLabel')} htmlFor="review-list-search">
            <input
              id="review-list-search"
              type="search"
              value={locationState.search ?? ''}
              maxLength={160}
              placeholder={t('review.searchPlaceholder')}
              onChange={event => updateFilter({ search: event.target.value || null })}
            />
          </Field>
          <Field label={t('review.list.datasetNumber')} htmlFor="review-list-dataset">
            <input
              id="review-list-dataset"
              type="number"
              min={1}
              step={1}
              value={locationState.datasetId ?? ''}
              onChange={event => {
                const value = Number(event.target.value);
                updateFilter({ datasetId: Number.isInteger(value) && value > 0 ? value : null });
              }}
            />
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
      </section>

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
                disabled={!canReview}
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
                    disabled={!canReview}
                    aria-label={t('review.list.selectSample', { id: sample.displayId })}
                    onChange={event => toggleSample(sample.id, event.target.checked)}
                  />
                </td>
                <th scope="row"><button type="button" className="table-link" onClick={() => openDetail(sample)}>{sample.displayId}</button></th>
                <td className="review-list__media-cell">
                  <video
                    src={sample.primaryMedia.url}
                    muted
                    playsInline
                    preload="metadata"
                    aria-label={t('review.primaryMediaAlt', { id: sample.displayId })}
                  />
                </td>
                <td>{sample.datasetName}</td>
                <td>{relationCode(sample.relation)}</td>
                <td>{protocolCode(sample.protocol)}</td>
                <td className="review-list__emotion">{sample.trueEmotion}</td>
                <td className="review-list__emotion">{sample.apparentEmotion}</td>
                <td>{sample.conflictDirection ? t(`direction.${sample.conflictDirection}`) : t('review.list.directionNotNeeded')}</td>
                <td>{t(`review.gender.${sample.gender}`)}</td>
                <td><StatusBadge label={t(`status.review.${sample.reviewDecision}`)} kind={reviewStatusKind(sample.reviewDecision)} /></td>
              </tr>
            ))}
          </TableShell>

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
                disabled={!canReview}
                onChange={event => setBatchDecision(event.target.value as Exclude<ReviewDecision, 'Pending'>)}
              >
                <option value="Accepted">{t('status.review.Accepted')}</option>
                <option value="Rejected">{t('status.review.Rejected')}</option>
              </select>
            </Field>
            <Button
              variant="primary"
              disabled={!canReview || selectedSamples.length === 0}
              onClick={() => setBatchConfirmOpen(true)}
            >
              {t('review.applyBatch')}
            </Button>
          </section>
        </section>
      )}

      {batchMutation.error ? <section className="generation-feedback" role="alert"><p>{apiErrorMessage(batchMutation.error, locale)}</p></section> : null}

      <ConfirmDialog
        open={batchConfirmOpen}
        title={t('review.batchConfirmTitle')}
        body={<><p>{t('review.batchConfirmBody', { decision: t(`status.review.${batchDecision}`), count: selectedSamples.length })}</p><p>{t('review.batchConfirmConsequence')}</p></>}
        confirmLabel={t('review.batchConfirmAction', { decision: t(`status.review.${batchDecision}`) })}
        cancelLabel={t('actions.cancel')}
        closeLabel={t('actions.close')}
        busy={batchMutation.isPending}
        confirmDisabled={!canReview || selectedSamples.length === 0}
        onClose={() => setBatchConfirmOpen(false)}
        onConfirm={submitBatch}
      />
    </section>
  );
}
