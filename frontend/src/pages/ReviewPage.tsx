import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiErrorMessage } from '../api/client';
import type { ReviewDecision, Sample } from '../api/contracts';
import {
  useCreateReviewMutation,
  useCreateReviewsBatchMutation,
  useDatasetsQuery,
  useSamplesQuery,
  useUpdateSampleClassificationMutation,
} from '../api/queries';
import { Button, ConfirmDialog, Field, MediaPanel, PageHeader, StatusBadge } from '../components';
import { usePreferences } from '../preferences';
import { safeReviewReturnTarget } from '../reviewArchive';
import { protocolForCategory, type Category, type ConflictDirection } from '../types';
import { OperationFeedback } from './generate/shared';
import './ReviewPage.css';

type CategoryFilter = 'All' | Category;
type ProtocolFilter = 'All' | 'VA' | 'VT';
type SavedScroll = { page: number; queue: number };

const categories: CategoryFilter[] = ['All', 'A-VA', 'A-VT', 'C-VA', 'C-VT'];

function localized(value: Sample, locale: string, field: 'contentPlanName' | 'scene' | 'triggerEvent' | 'psychologicalBackground') {
  const suffix = locale === 'zh-CN' ? 'Zh' : 'En';
  return value[`${field}${suffix}` as keyof Sample] as string;
}

function oppositeCategory(category: Category): Category {
  if (category === 'A-VA') return 'C-VA';
  if (category === 'C-VA') return 'A-VA';
  if (category === 'A-VT') return 'C-VT';
  return 'A-VT';
}

function directionsFor(category: Category): ConflictDirection[] {
  if (category === 'C-VA') return ['Vision', 'Audio'];
  if (category === 'C-VT') return ['Vision', 'Text'];
  return [];
}

export function ReviewPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const preferences = usePreferences();
  const samplesQuery = useSamplesQuery();
  const datasetsQuery = useDatasetsQuery();
  const reviewMutation = useCreateReviewMutation();
  const batchMutation = useCreateReviewsBatchMutation();
  const classificationMutation = useUpdateSampleClassificationMutation();
  const queueRef = useRef<HTMLElement>(null);
  const queueListRef = useRef<HTMLUListElement>(null);
  const savedScrollRef = useRef<SavedScroll>({ page: 0, queue: 0 });
  const restoreScrollRef = useRef(false);
  const [search, setSearch] = useState('');
  const [datasetId, setDatasetId] = useState<number | 'All'>('All');
  const [category, setCategory] = useState<CategoryFilter>('All');
  const [protocol, setProtocol] = useState<ProtocolFilter>('All');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [note, setNote] = useState('');
  const [batchNote, setBatchNote] = useState('');
  const [batchDecision, setBatchDecision] = useState<Exclude<ReviewDecision, 'Pending'>>('Accepted');
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [targetDirection, setTargetDirection] = useState<ConflictDirection>('Vision');
  const samples = samplesQuery.data ?? [];
  const datasets = datasetsQuery.data ?? [];
  const pendingSamples = useMemo(() => samples.filter(sample => sample.reviewDecision === 'Pending'), [samples]);
  const datasetsById = useMemo(() => new Map(datasets.map(dataset => [dataset.id, dataset])), [datasets]);
  const requestedDisplayId = params.get('sample');
  const selected = requestedDisplayId ? samples.find(sample => sample.displayId === requestedDisplayId) ?? null : null;
  const returnTarget = safeReviewReturnTarget(params.get('returnTo'));
  const mobileDetail = selected !== null;
  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';

  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase(locale);
    return pendingSamples.filter(sample => {
      const haystack = `${sample.displayId} ${datasetsById.get(sample.datasetId)?.name ?? ''}`.toLocaleLowerCase(locale);
      return (datasetId === 'All' || sample.datasetId === datasetId)
        && (category === 'All' || sample.category === category)
        && (protocol === 'All' || protocolForCategory(sample.category) === protocol)
        && (needle === '' || haystack.includes(needle));
    });
  }, [category, datasetId, datasetsById, locale, pendingSamples, protocol, search]);

  useEffect(() => {
    setNote(selected?.currentReview?.note ?? '');
    if (selected) {
      const target = oppositeCategory(selected.category);
      setTargetDirection(directionsFor(target)[0] ?? 'Vision');
    }
  }, [selected]);

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (selected) {
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        return;
      }
      if (!restoreScrollRef.current) return;
      restoreScrollRef.current = false;
      if (queueListRef.current) queueListRef.current.scrollTop = savedScrollRef.current.queue;
      window.scrollTo({ top: savedScrollRef.current.page, left: 0, behavior: 'auto' });
      queueRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selected?.id]);

  const choose = (sample: Sample) => {
    savedScrollRef.current = {
      page: window.scrollY,
      queue: queueListRef.current?.scrollTop ?? 0,
    };
    const next = new URLSearchParams(params);
    next.set('sample', sample.displayId);
    setParams(next, { replace: true });
  };

  const backToQueue = () => {
    restoreScrollRef.current = true;
    const next = new URLSearchParams(params);
    next.delete('sample');
    next.delete('returnTo');
    setParams(next, { replace: true });
  };

  const returnToSource = () => {
    if (returnTarget) navigate(returnTarget, { replace: true });
  };

  const chooseNext = (sampleId: number) => {
    const index = visible.findIndex(item => item.id === sampleId);
    const next = visible[index + 1] ?? visible[index - 1] ?? null;
    if (next) choose(next);
    else backToQueue();
  };

  const saveDecision = (decision: Exclude<ReviewDecision, 'Pending'>) => {
    if (!selected || preferences.currentReviewerId === null) return;
    reviewMutation.mutate({
      sampleId: selected.id,
      reviewerId: preferences.currentReviewerId,
      decision,
      note,
      expectedRevision: selected.revision,
      expectedReviewRevision: selected.reviewRevision,
    }, { onSuccess: () => chooseNext(selected.id) });
  };

  const applyBatch = () => {
    if (preferences.currentReviewerId === null) return;
    const selectedSamples = visible.filter(sample => selectedIds.has(sample.id));
    batchMutation.mutate({
      items: selectedSamples.map(sample => ({
        sampleId: sample.id,
        reviewerId: preferences.currentReviewerId as number,
        decision: batchDecision,
        note: batchNote,
        expectedRevision: sample.revision,
        expectedReviewRevision: sample.reviewRevision,
      })),
    }, {
      onSuccess: () => {
        setBatchConfirmOpen(false);
        setSelectedIds(new Set());
        setBatchNote('');
      },
    });
  };

  const changeClassification = () => {
    if (!selected) return;
    const targetCategory = oppositeCategory(selected.category);
    classificationMutation.mutate({
      id: selected.id,
      input: {
        expectedRevision: selected.revision,
        targetCategory,
        conflictDirection: targetCategory.startsWith('C-') ? targetDirection : null,
      },
    });
  };

  const clearFilters = () => {
    setSearch('');
    setDatasetId('All');
    setCategory('All');
    setProtocol('All');
    setSelectedIds(new Set());
  };

  if (samplesQuery.isPending || datasetsQuery.isPending) {
    return <section className="page-stack review-page"><PageHeader title={t('review.title')} /><p role="status">{t('review.loadingBody')}</p></section>;
  }
  const queryError = samplesQuery.error ?? datasetsQuery.error ?? null;
  if (queryError) {
    return <section className="page-stack review-page"><PageHeader title={t('review.title')} /><section className="generation-feedback" role="alert"><p>{apiErrorMessage(queryError, locale)}</p></section></section>;
  }

  const mutationError = reviewMutation.error ?? batchMutation.error ?? classificationMutation.error;
  const selectedVisibleCount = visible.filter(sample => selectedIds.has(sample.id)).length;
  const targetCategory = selected ? oppositeCategory(selected.category) : null;
  return (
    <section className={`page-stack review-page${mobileDetail ? ' review-page--mobile-detail' : ''}`} aria-label={t('review.aria.page')}>
      <PageHeader title={t('review.title')} actions={<span className="review-page__count">{t('review.queueCount', { visible: visible.length, total: pendingSamples.length })}</span>} />
      <p className="review-page__subtitle">{t('review.subtitle')}</p>
      {mutationError ? <OperationFeedback error={mutationError} onDismiss={() => { reviewMutation.reset(); batchMutation.reset(); classificationMutation.reset(); }} /> : null}
      <section className="panel review-filters" aria-label={t('review.aria.filters')}>
        <div className="section-header"><h2>{t('review.filters')}</h2><Button variant="quiet" onClick={clearFilters}>{t('actions.clearFilters')}</Button></div>
        <div className="review-filters__grid">
          <Field label={t('review.searchLabel')} htmlFor="review-search"><input id="review-search" type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
          <Field label={t('review.datasetFilter')} htmlFor="review-dataset-filter"><select id="review-dataset-filter" value={datasetId} onChange={event => setDatasetId(event.target.value === 'All' ? 'All' : Number(event.target.value))}><option value="All">{t('review.allDatasets')}</option>{datasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></Field>
          <Field label={t('review.protocolFilter')} htmlFor="review-protocol-filter"><select id="review-protocol-filter" value={protocol} onChange={event => setProtocol(event.target.value as ProtocolFilter)}><option value="All">{t('review.allProtocols')}</option><option value="VA">{t('review.protocolVA')}</option><option value="VT">{t('review.protocolVT')}</option></select></Field>
          <Field label={t('review.categoryFilter')} htmlFor="review-category-filter"><select id="review-category-filter" value={category} onChange={event => setCategory(event.target.value as CategoryFilter)}>{categories.map(value => <option key={value} value={value}>{value === 'All' ? t('review.allCategories') : t(`category.${value}`)}</option>)}</select></Field>
        </div>
      </section>
      {pendingSamples.length === 0 && !selected ? <section className="state-view review-page__state"><h2>{t('review.emptyTitle')}</h2><p>{t('review.emptyBody')}</p></section> : visible.length === 0 && !selected ? <section className="state-view review-page__state"><h2>{t('review.filteredTitle')}</h2><p>{t('review.filteredBody')}</p></section> : (
        <div className={`review-grid${mobileDetail ? ' review-grid--mobile-detail' : ''}`} data-selected-sample={selected?.displayId} data-sample-revision={selected?.revision}>
          <section ref={queueRef} tabIndex={-1} className="panel review-queue" aria-label={t('review.aria.queue')}>
            <div className="section-header"><h2>{t('review.queue')}</h2><span>{t('review.selectionCount', { count: selectedVisibleCount })}</span></div>
            <div className="review-queue__selection"><label><input type="checkbox" checked={visible.length > 0 && selectedVisibleCount === visible.length} onChange={event => setSelectedIds(event.target.checked ? new Set(visible.map(sample => sample.id)) : new Set())} />{t('review.selectAllVisible')}</label>{selectedVisibleCount ? <Button variant="quiet" onClick={() => setSelectedIds(new Set())}>{t('review.clearSelection')}</Button> : null}</div>
            <ul ref={queueListRef} className="review-queue__list">{visible.map(sample => <li key={sample.id} className={sample.id === selected?.id ? 'is-active' : undefined} data-sample-id={sample.displayId}><label className="review-queue__check"><input type="checkbox" checked={selectedIds.has(sample.id)} aria-label={t('review.aria.queueItem', { id: sample.displayId, category: sample.category, decision: t(`status.review.${sample.reviewDecision}`) })} onChange={event => setSelectedIds(current => { const next = new Set(current); if (event.target.checked) next.add(sample.id); else next.delete(sample.id); return next; })} /></label><button type="button" className="review-queue__item" onClick={() => choose(sample)} aria-current={sample.id === selected?.id ? 'true' : undefined}><span className="review-queue__item-main"><strong>{sample.displayId}</strong><span>{sample.category}</span></span><span className="review-queue__dataset">{datasetsById.get(sample.datasetId)?.name ?? sample.datasetId}</span><StatusBadge label={t('status.review.Pending')} kind="neutral" /></button></li>)}</ul>
            {selectedVisibleCount ? <section className="review-batch" aria-label={t('review.aria.batch')}><h3>{t('review.batch')}</h3><Field label={t('review.batchDecision')} htmlFor="review-batch-decision"><select id="review-batch-decision" value={batchDecision} onChange={event => setBatchDecision(event.target.value as Exclude<ReviewDecision, 'Pending'>)}><option value="Accepted">{t('status.review.Accepted')}</option><option value="Rejected">{t('status.review.Rejected')}</option></select></Field><Field label={t('fields.note')} htmlFor="review-batch-note"><textarea id="review-batch-note" value={batchNote} maxLength={2000} onChange={event => setBatchNote(event.target.value)} placeholder={t('review.batchNotePlaceholder')} /></Field><Button variant="secondary" onClick={() => setBatchConfirmOpen(true)}>{t('review.applyBatch')}</Button></section> : null}
          </section>
          {selected ? <div className="review-detail">
            <nav className="panel review-detail__navigation" aria-label={t('review.aria.detailNavigation')}><Button variant="quiet" onClick={backToQueue}>{t('review.backToQueue')}</Button>{returnTarget ? <Button variant="quiet" onClick={returnToSource}>{t('review.returnToSource')}</Button> : null}</nav>
            <section className="panel review-media" aria-label={t('review.aria.media')}><div className="section-header"><h2>{t('review.media')}</h2><div className="review-media__badges"><StatusBadge label={t(`category.${selected.category}`)} kind={selected.category.startsWith('C-') ? 'problem' : 'complete'} /><StatusBadge label={t(protocolForCategory(selected.category) === 'VA' ? 'review.protocolVA' : 'review.protocolVT')} /></div></div><MediaPanel title={t('review.video')} mediaLabel={t('review.primaryMediaAlt', { id: selected.displayId })} src={selected.primaryAssetUrl} muted={protocolForCategory(selected.category) === 'VT'} /></section>
            <section className="panel review-context" aria-label={t('review.aria.details', { id: selected.displayId })}><h2>{t('review.context')}</h2><dl className="review-context__facts review-context__facts--emotion"><div><dt>{t('review.trueEmotion')}</dt><dd>{selected.trueEmotion}</dd></div><div><dt>{t('review.apparentEmotion')}</dt><dd>{selected.apparentEmotion}</dd></div><div><dt>{t('direction.label')}</dt><dd>{selected.conflictDirection ? t(`direction.${selected.conflictDirection}`) : t('review.directionNotRequired')}</dd></div></dl><div className="review-context__copy review-context__copy--primary"><div className="review-context__copy--description"><h3>{t('review.trueEmotionDescription')}</h3><p>{selected.trueEmotionDescription}</p></div></div>{selected.dialogue ? <div className="review-context__copy"><div><h3>{t('review.dialogue')}</h3><p>{selected.dialogue}</p></div></div> : null}{selected.displayText ? <div className="review-context__copy"><div><h3>{t('review.displayText')}</h3><p>{selected.displayText}</p></div></div> : null}<details className="review-context__details"><summary>{t('review.moreDetails')}</summary><dl><div><dt>{t('review.sampleId')}</dt><dd>{selected.displayId}</dd></div><div><dt>{t('fields.dataset')}</dt><dd>{datasetsById.get(selected.datasetId)?.name ?? selected.datasetId}</dd></div><div><dt>{t('review.contentPlan')}</dt><dd>{localized(selected, locale, 'contentPlanName')}</dd></div><div><dt>{t('review.scenario')}</dt><dd>{localized(selected, locale, 'scene')}</dd></div><div><dt>{t('review.triggerEvent')}</dt><dd>{localized(selected, locale, 'triggerEvent')}</dd></div><div><dt>{t('review.psychologicalBackground')}</dt><dd>{localized(selected, locale, 'psychologicalBackground')}</dd></div><div><dt>{t('review.model')}</dt><dd>{selected.model}</dd></div><div className="review-context__details-wide"><dt>{t('review.positivePrompt')}</dt><dd>{selected.videoPrompt}</dd></div><div className="review-context__details-wide"><dt>{t('review.negativePrompt')}</dt><dd>{selected.negativePrompt}</dd></div></dl></details></section>
            <section className="panel review-generation-record" aria-labelledby="review-generation-record-title"><h2 id="review-generation-record-title">{t('review.generationRecord')}</h2><dl><div><dt>{t('review.model')}</dt><dd>{selected.generationRecord.model}</dd></div><div><dt>{t('review.precision')}</dt><dd>{selected.generationRecord.precision ?? t('review.notApplicable')}</dd></div><div><dt>{t('review.gpu')}</dt><dd>{selected.generationRecord.gpuSlot}</dd></div><div><dt>{t('review.seed')}</dt><dd>{selected.generationRecord.seed}</dd></div><div><dt>{t('review.attemptRevision')}</dt><dd>{selected.generationRecord.attemptNumber}</dd></div></dl></section>
            <aside className="panel review-decision"><div className="section-header"><h2>{t('review.decision')}</h2><StatusBadge label={t(`status.review.${selected.reviewDecision}`)} kind="neutral" /></div><Field label={t('fields.note')} htmlFor="review-note"><textarea id="review-note" value={note} maxLength={2000} onChange={event => setNote(event.target.value)} placeholder={t('review.notePlaceholder')} /></Field><div className="decision-options" role="group" aria-label={t('review.aria.decision')}><Button variant="primary" busy={reviewMutation.isPending} disabled={preferences.currentReviewerId === null} onClick={() => saveDecision('Accepted')}>{t('status.review.Accepted')}</Button><Button variant="secondary" busy={reviewMutation.isPending} disabled={preferences.currentReviewerId === null} onClick={() => saveDecision('Rejected')}>{t('status.review.Rejected')}</Button></div>{targetCategory ? <details className="review-secondary-action"><summary>{t('review.transfer')}</summary><section className="review-transfer"><dl><div><dt>{t('review.currentCategory')}</dt><dd>{t(`category.${selected.category}`)}</dd></div><div><dt>{t('review.targetCategory')}</dt><dd>{t(`category.${targetCategory}`)}</dd></div></dl>{directionsFor(targetCategory).length ? <Field label={t('review.conflictDirection')} htmlFor="review-target-direction"><select id="review-target-direction" value={targetDirection} onChange={event => setTargetDirection(event.target.value as ConflictDirection)}>{directionsFor(targetCategory).map(direction => <option key={direction} value={direction}>{t(`direction.${direction}`)}</option>)}</select></Field> : null}<p>{t('review.transferHelp')}</p><Button variant="secondary" busy={classificationMutation.isPending} onClick={changeClassification}>{t('review.transferAction')}</Button></section></details> : null}</aside>
          </div> : null}
        </div>
      )}
      <ConfirmDialog open={batchConfirmOpen} title={t('review.batchConfirmTitle')} body={<><p>{t('review.batchConfirmBody', { decision: t(`status.review.${batchDecision}`), count: selectedVisibleCount })}</p><p>{t('review.batchConfirmConsequence')}</p></>} confirmLabel={t('review.batchConfirmAction', { decision: t(`status.review.${batchDecision}`) })} cancelLabel={t('actions.cancel')} closeLabel={t('actions.close')} busy={batchMutation.isPending} onClose={() => setBatchConfirmOpen(false)} onConfirm={applyBatch} />
    </section>
  );
}
