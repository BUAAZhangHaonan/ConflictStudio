import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiErrorMessage } from '../api/client';
import type { ReviewDecision, Sample } from '../api/contracts';
import {
  useCreateReviewMutation,
  useCreateReviewsBatchMutation,
  useContentScenesQuery,
  useContentScriptQuery,
  useDatasetQuery,
  useDatasetsQuery,
  useSampleQuery,
  useSamplesQuery,
  useUpdateSampleClassificationMutation,
} from '../api/queries';
import { Button, ConfirmDialog, Field, MediaPanel, PageHeader, Pagination, StatusBadge } from '../components';
import { usePreferences } from '../preferences';
import { buildCorrectedSampleBatchPrefill, type CorrectedSampleBatchNavigationState } from '../generationPrefill';
import { safeReviewReturnTarget } from '../reviewArchive';
import { protocolForCategory, type Category, type ConflictDirection } from '../types';
import { OperationFeedback } from './generate/shared';
import './ReviewPage.css';

type CategoryFilter = 'All' | Category;
type ProtocolFilter = 'All' | 'VA' | 'VT';
type SavedScroll = { page: number; queue: number };

const categories: CategoryFilter[] = ['All', 'A-VA', 'A-VT', 'C-VA', 'C-VT'];

function localized(value: Sample, locale: string, field: 'triggerEvent' | 'psychologicalBackground') {
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
  const [samplePage, setSamplePage] = useState(1);
  const [datasetPage, setDatasetPage] = useState(1);
  const [datasetSearch, setDatasetSearch] = useState('');
  const [search, setSearch] = useState('');
  const [datasetId, setDatasetId] = useState<number | 'All'>('All');
  const [category, setCategory] = useState<CategoryFilter>('All');
  const [protocol, setProtocol] = useState<ProtocolFilter>('All');
  const sampleFilter = {
    decision: 'Pending' as const,
    ...(datasetId === 'All' ? {} : { datasetId }),
    ...(category === 'All' ? {} : { category }),
    ...(protocol === 'All' ? {} : { protocol }),
    ...(search.trim() ? { search } : {}),
  };
  const samplesQuery = useSamplesQuery(sampleFilter, samplePage);
  const allPendingQuery = useSamplesQuery({ decision: 'Pending' });
  const datasetsQuery = useDatasetsQuery(datasetPage, datasetSearch.trim() ? { search: datasetSearch } : {});
  const selectedDatasetQuery = useDatasetQuery(datasetId === 'All' ? null : datasetId);
  const requestedId = Number(params.get('sampleId'));
  const selectedId = Number.isInteger(requestedId) && requestedId > 0 ? requestedId : null;
  const selectedQuery = useSampleQuery(selectedId);
  const reviewMutation = useCreateReviewMutation();
  const batchMutation = useCreateReviewsBatchMutation();
  const classificationMutation = useUpdateSampleClassificationMutation();
  const queueRef = useRef<HTMLElement>(null);
  const queueListRef = useRef<HTMLUListElement>(null);
  const savedScrollRef = useRef<SavedScroll>({ page: 0, queue: 0 });
  const restoreScrollRef = useRef(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [note, setNote] = useState('');
  const [batchNote, setBatchNote] = useState('');
  const [batchDecision, setBatchDecision] = useState<Exclude<ReviewDecision, 'Pending'>>('Accepted');
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [classificationOpen, setClassificationOpen] = useState(false);
  const [targetDirection, setTargetDirection] = useState<ConflictDirection>('Vision');
  const [targetApparentEmotion, setTargetApparentEmotion] = useState('');
  const [targetDescription, setTargetDescription] = useState('');
  const samples = samplesQuery.data?.items ?? [];
  const datasets = datasetsQuery.data?.items ?? [];
  const selectedDataset = selectedDatasetQuery.data ?? null;
  const datasetOptions = selectedDataset && !datasets.some(dataset => dataset.id === selectedDataset.id)
    ? [selectedDataset, ...datasets]
    : datasets;
  const selected = selectedQuery.data ?? null;
  const compatibilityQuery = useContentScenesQuery(
    selected?.generationCompatibility === 'NeedsRegeneration'
      ? selected.actualContentSummary.id
      : null,
  );
  const compatibleContentQuery = useContentScriptQuery(
    selected?.generationCompatibility === 'NeedsRegeneration'
      ? selected.actualContentSummary.id
      : null,
  );
  const returnTarget = safeReviewReturnTarget(params.get('returnTo'));
  const mobileDetail = selected !== null;
  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';

  const visible = samples;

  useEffect(() => {
    setNote(selected?.currentReview?.note ?? '');
    if (selected) {
      const target = oppositeCategory(selected.category);
      setTargetDirection(directionsFor(target)[0] ?? 'Vision');
      setTargetApparentEmotion('');
      setTargetDescription(selected.trueEmotionDescription);
    }
    setClassificationOpen(false);
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
    next.set('sampleId', String(sample.id));
    setParams(next, { replace: true });
  };

  const backToQueue = () => {
    restoreScrollRef.current = true;
    const next = new URLSearchParams(params);
    next.delete('sampleId');
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
    if (decision === 'Accepted' && selected.generationCompatibility === 'NeedsRegeneration') return;
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
    if (batchDecision === 'Accepted' && selectedSamples.some(sample => sample.generationCompatibility === 'NeedsRegeneration')) return;
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
    const conflictTarget = targetCategory.startsWith('C-');
    classificationMutation.mutate({
      id: selected.id,
      input: {
        expectedRevision: selected.revision,
        targetCategory,
        conflictDirection: conflictTarget ? targetDirection : null,
        ...(conflictTarget ? { apparentEmotion: targetApparentEmotion.trim() } : {}),
        trueEmotionDescription: targetDescription.trim(),
      },
    }, { onSuccess: () => setClassificationOpen(false) });
  };

  const openClassification = () => {
    if (!selected) return;
    const target = oppositeCategory(selected.category);
    setTargetDirection(directionsFor(target)[0] ?? 'Vision');
    setTargetApparentEmotion('');
    setTargetDescription(selected.trueEmotionDescription);
    classificationMutation.reset();
    setClassificationOpen(true);
  };

  const regenerateWithCompatibleScene = () => {
    const content = compatibleContentQuery.data;
    const scene = compatibilityQuery.data?.scenes[0];
    if (!selected || !content || !scene || compatibilityQuery.data?.scenes.length !== 1) return;
    const state: CorrectedSampleBatchNavigationState = {
      correctedSampleBatch: buildCorrectedSampleBatchPrefill(selected, {
        id: content.id,
        nameZh: content.nameZh,
        nameEn: content.nameEn,
        revision: content.revision,
        mode: content.mode,
      }, scene),
    };
    navigate('/generate/batches', { state });
  };

  const clearFilters = () => {
    setSearch('');
    setDatasetSearch('');
    setDatasetId('All');
    setCategory('All');
    setProtocol('All');
    setDatasetPage(1);
    setSamplePage(1);
    setSelectedIds(new Set());
  };

  if (samplesQuery.isPending || allPendingQuery.isPending || datasetsQuery.isPending || (datasetId !== 'All' && selectedDatasetQuery.isPending) || (selectedId !== null && selectedQuery.isPending)) {
    return <section className="page-stack review-page"><PageHeader title={t('review.title')} /><p role="status">{t('review.loadingBody')}</p></section>;
  }
  const queryError = samplesQuery.error ?? allPendingQuery.error ?? datasetsQuery.error ?? selectedDatasetQuery.error ?? selectedQuery.error ?? null;
  if (queryError) {
    return <section className="page-stack review-page"><PageHeader title={t('review.title')} /><section className="generation-feedback" role="alert"><p>{apiErrorMessage(queryError, locale)}</p></section></section>;
  }

  const mutationError = reviewMutation.error ?? batchMutation.error ?? classificationMutation.error;
  const selectedVisibleCount = visible.filter(sample => selectedIds.has(sample.id)).length;
  const batchAcceptBlocked = batchDecision === 'Accepted' && visible.some(
    sample => selectedIds.has(sample.id) && sample.generationCompatibility === 'NeedsRegeneration',
  );
  const selectedNeedsRegeneration = selected?.generationCompatibility === 'NeedsRegeneration';
  const compatibleSceneCount = compatibilityQuery.data?.scenes.length;
  const targetCategory = selected ? oppositeCategory(selected.category) : null;
  const targetIsConflict = targetCategory?.startsWith('C-') ?? false;
  const apparentEmotionKey = targetApparentEmotion.trim().toLocaleLowerCase('en-US');
  const trueEmotionKey = selected?.trueEmotion.trim().toLocaleLowerCase('en-US') ?? '';
  const matchingEmotion = targetIsConflict && apparentEmotionKey !== '' && apparentEmotionKey === trueEmotionKey;
  const classificationValid = Boolean(
    selected
      && targetCategory
      && targetDescription.trim()
      && targetDescription.trim().length <= 2000
      && (
        !targetIsConflict
        || (
          targetApparentEmotion.trim()
          && targetApparentEmotion.trim().length <= 120
          && !matchingEmotion
          && directionsFor(targetCategory).includes(targetDirection)
        )
      ),
  );
  return (
    <section className={`page-stack review-page${mobileDetail ? ' review-page--mobile-detail' : ''}`} aria-label={t('review.aria.page')}>
      <PageHeader title={t('review.title')} actions={<span className="review-page__count">{t('review.queueCount', { visible: visible.length, total: samplesQuery.data?.total ?? 0 })}</span>} />
      <p className="review-page__subtitle">{t('review.subtitle')}</p>
      {preferences.currentReviewerId === null ? <section className="generation-feedback" role="status"><p>{t('reviewer.readOnlyHint')}</p></section> : null}
      {mutationError ? <OperationFeedback error={mutationError} onDismiss={() => { reviewMutation.reset(); batchMutation.reset(); classificationMutation.reset(); }} /> : null}
      <section className="panel review-filters" aria-label={t('review.aria.filters')}>
        <div className="section-header"><h2>{t('review.filters')}</h2><Button variant="quiet" onClick={clearFilters}>{t('actions.clearFilters')}</Button></div>
        <div className="review-filters__grid">
          <Field label={t('review.searchLabel')} htmlFor="review-search"><input id="review-search" type="search" value={search} onChange={event => { setSearch(event.target.value); setSamplePage(1); setSelectedIds(new Set()); }} /></Field>
          <div className="review-dataset-picker">
            <Field label={t('review.datasetSearchLabel')} htmlFor="review-dataset-search"><input id="review-dataset-search" type="search" value={datasetSearch} onChange={event => { setDatasetSearch(event.target.value); setDatasetPage(1); }} /></Field>
            <Field label={t('review.datasetFilter')} htmlFor="review-dataset-filter"><select id="review-dataset-filter" value={datasetId} onChange={event => { setDatasetId(event.target.value === 'All' ? 'All' : Number(event.target.value)); setSamplePage(1); setSelectedIds(new Set()); }}><option value="All">{t('review.allDatasets')}</option>{datasetOptions.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></Field>
            <Pagination page={datasetsQuery.data?.page ?? 1} totalPages={datasetsQuery.data?.totalPages ?? 0} total={datasetsQuery.data?.total ?? 0} onPageChange={setDatasetPage} />
          </div>
          <Field label={t('review.protocolFilter')} htmlFor="review-protocol-filter"><select id="review-protocol-filter" value={protocol} onChange={event => { setProtocol(event.target.value as ProtocolFilter); setSamplePage(1); setSelectedIds(new Set()); }}><option value="All">{t('review.allProtocols')}</option><option value="VA">{t('review.protocolVA')}</option><option value="VT">{t('review.protocolVT')}</option></select></Field>
          <Field label={t('review.categoryFilter')} htmlFor="review-category-filter"><select id="review-category-filter" value={category} onChange={event => { setCategory(event.target.value as CategoryFilter); setSamplePage(1); setSelectedIds(new Set()); }}>{categories.map(value => <option key={value} value={value}>{value === 'All' ? t('review.allCategories') : t(`category.${value}`)}</option>)}</select></Field>
        </div>
      </section>
      {(allPendingQuery.data?.total ?? 0) === 0 && !selected ? <section className="state-view review-page__state"><h2>{t('review.emptyTitle')}</h2><p>{t('review.emptyBody')}</p></section> : visible.length === 0 && !selected ? <section className="state-view review-page__state"><h2>{t('review.filteredTitle')}</h2><p>{t('review.filteredBody')}</p></section> : (
        <div className={`review-grid${mobileDetail ? ' review-grid--mobile-detail' : ''}`} data-selected-sample={selected?.displayId} data-sample-revision={selected?.revision}>
          <section ref={queueRef} tabIndex={-1} className="panel review-queue" aria-label={t('review.aria.queue')}>
            <div className="section-header"><h2>{t('review.queue')}</h2><span>{t('review.selectionCount', { count: selectedVisibleCount })}</span></div>
            <div className="review-queue__selection"><label><input type="checkbox" checked={visible.length > 0 && selectedVisibleCount === visible.length} onChange={event => setSelectedIds(event.target.checked ? new Set(visible.map(sample => sample.id)) : new Set())} />{t('review.selectAllVisible')}</label>{selectedVisibleCount ? <Button variant="quiet" onClick={() => setSelectedIds(new Set())}>{t('review.clearSelection')}</Button> : null}</div>
            <ul ref={queueListRef} className="review-queue__list">{visible.map(sample => <li key={sample.id} className={sample.id === selected?.id ? 'is-active' : undefined} data-sample-id={sample.displayId}><label className="review-queue__check"><input type="checkbox" checked={selectedIds.has(sample.id)} aria-label={t('review.aria.queueItem', { id: sample.displayId, category: sample.category, decision: t(`status.review.${sample.reviewDecision}`) })} onChange={event => setSelectedIds(current => { const next = new Set(current); if (event.target.checked) next.add(sample.id); else next.delete(sample.id); return next; })} /></label><button type="button" className="review-queue__item" onClick={() => choose(sample)} aria-current={sample.id === selected?.id ? 'true' : undefined}><span className="review-queue__item-main"><strong>{sample.displayId}</strong><span>{sample.category}</span></span><span className="review-queue__dataset">{sample.datasetName}</span><StatusBadge label={t('status.review.Pending')} kind="neutral" /></button></li>)}</ul>
            <Pagination page={samplesQuery.data?.page ?? 1} totalPages={samplesQuery.data?.totalPages ?? 0} total={samplesQuery.data?.total ?? 0} onPageChange={page => { setSamplePage(page); setSelectedIds(new Set()); }} />
            {selectedVisibleCount ? <section className="review-batch" aria-label={t('review.aria.batch')}><h3>{t('review.batch')}</h3><Field label={t('review.batchDecision')} htmlFor="review-batch-decision"><select id="review-batch-decision" value={batchDecision} onChange={event => setBatchDecision(event.target.value as Exclude<ReviewDecision, 'Pending'>)}><option value="Accepted">{t('status.review.Accepted')}</option><option value="Rejected">{t('status.review.Rejected')}</option></select></Field>{batchAcceptBlocked ? <p className="field__error" role="alert">{t('review.batchIncompatible')}</p> : null}<Field label={t('fields.note')} htmlFor="review-batch-note"><textarea id="review-batch-note" value={batchNote} maxLength={2000} onChange={event => setBatchNote(event.target.value)} placeholder={t('review.batchNotePlaceholder')} /></Field><Button variant="secondary" disabled={preferences.currentReviewerId === null || batchAcceptBlocked} onClick={() => setBatchConfirmOpen(true)}>{t('review.applyBatch')}</Button></section> : null}
          </section>
          {selected ? <div className="review-detail">
            <nav className="panel review-detail__navigation" aria-label={t('review.aria.detailNavigation')}><Button variant="quiet" onClick={backToQueue}>{t('review.backToQueue')}</Button>{returnTarget ? <Button variant="quiet" onClick={returnToSource}>{t('review.returnToSource')}</Button> : null}</nav>
            <section className="panel review-media" aria-label={t('review.aria.media')}><div className="section-header"><h2>{t('review.media')}</h2><div className="review-media__badges"><StatusBadge label={t(`category.${selected.category}`)} kind={selected.category.startsWith('C-') ? 'problem' : 'complete'} /><StatusBadge label={t(protocolForCategory(selected.category) === 'VA' ? 'review.protocolVA' : 'review.protocolVT')} /></div></div><MediaPanel title={t('review.video')} mediaLabel={t('review.primaryMediaAlt', { id: selected.displayId })} src={selected.primaryAssetUrl} muted={protocolForCategory(selected.category) === 'VT'} /></section>
            <section className="panel review-context" aria-label={t('review.aria.details', { id: selected.displayId })}><h2>{t('review.context')}</h2><dl className="review-context__facts review-context__facts--emotion"><div><dt>{t('review.trueEmotion')}</dt><dd>{selected.trueEmotion}</dd></div><div><dt>{t('review.apparentEmotion')}</dt><dd>{selected.apparentEmotion}</dd></div><div><dt>{t('direction.label')}</dt><dd>{selected.conflictDirection ? t(`direction.${selected.conflictDirection}`) : t('review.directionNotRequired')}</dd></div></dl><dl className="review-context__facts review-context__facts--generation"><div><dt>{t('review.contentScript')}</dt><dd>{locale === 'zh-CN' ? selected.actualContentSummary.nameZh : selected.actualContentSummary.nameEn}</dd></div><div><dt>{t('review.actualScene')}</dt><dd>{locale === 'zh-CN' ? selected.actualSceneSummary.nameZh : selected.actualSceneSummary.nameEn}</dd></div></dl><div className="review-context__copy review-context__copy--primary"><div className="review-context__copy--description"><h3>{t('review.trueEmotionDescription')}</h3><p>{selected.trueEmotionDescription}</p></div></div>{selected.dialogue ? <div className="review-context__copy"><div><h3>{t('review.dialogue')}</h3><p>{selected.dialogue}</p></div></div> : null}{selected.displayText ? <div className="review-context__copy"><div><h3>{t('review.displayText')}</h3><p>{selected.displayText}</p></div></div> : null}<details className="review-context__details"><summary>{t('review.moreDetails')}</summary><dl><div><dt>{t('review.sampleId')}</dt><dd>{selected.displayId}</dd></div><div><dt>{t('fields.dataset')}</dt><dd>{selected.datasetName}</dd></div><div><dt>{t('review.triggerEvent')}</dt><dd>{localized(selected, locale, 'triggerEvent')}</dd></div><div><dt>{t('review.psychologicalBackground')}</dt><dd>{localized(selected, locale, 'psychologicalBackground')}</dd></div><div><dt>{t('review.model')}</dt><dd>{selected.model}</dd></div><div className="review-context__details-wide"><dt>{t('review.positivePrompt')}</dt><dd>{selected.videoPrompt}</dd></div><div className="review-context__details-wide"><dt>{t('review.negativePrompt')}</dt><dd>{selected.negativePrompt}</dd></div></dl></details></section>
            <section className="panel review-generation-record" aria-labelledby="review-generation-record-title"><h2 id="review-generation-record-title">{t('review.generationRecord')}</h2><dl><div><dt>{t('review.model')}</dt><dd>{selected.generationRecord.model}</dd></div><div><dt>{t('review.precision')}</dt><dd>{selected.generationRecord.precision ?? t('review.notApplicable')}</dd></div><div><dt>{t('review.gpu')}</dt><dd>{selected.generationRecord.gpuSlot}</dd></div><div><dt>{t('review.seed')}</dt><dd>{selected.generationRecord.seed}</dd></div><div><dt>{t('review.attemptRevision')}</dt><dd>{selected.generationRecord.attemptNumber}</dd></div></dl></section>
            <aside className="panel review-decision"><div className="section-header"><h2>{t('review.decision')}</h2><StatusBadge label={t(`status.review.${selected.reviewDecision}`)} kind="neutral" /></div>{selectedNeedsRegeneration ? <section className="review-compatibility-warning" role="alert"><h3>{t('review.incompatibleTitle')}</h3><p>{compatibleSceneCount === undefined ? t('review.incompatibleChecking') : compatibleSceneCount === 0 ? t('review.incompatibleNoScene') : compatibleSceneCount === 1 ? t('review.incompatibleOneScene') : t('review.incompatibleMultipleScenes')}</p>{compatibleSceneCount === 1 ? <Button variant="secondary" disabled={!compatibleContentQuery.data} onClick={regenerateWithCompatibleScene}>{t('review.regenerateAction')}</Button> : null}</section> : null}<Field label={t('fields.note')} htmlFor="review-note"><textarea id="review-note" value={note} maxLength={2000} onChange={event => setNote(event.target.value)} placeholder={t('review.notePlaceholder')} /></Field><div className="decision-options" role="group" aria-label={t('review.aria.decision')}><Button variant="primary" busy={reviewMutation.isPending} disabled={preferences.currentReviewerId === null || selectedNeedsRegeneration} onClick={() => saveDecision('Accepted')}>{t('status.review.Accepted')}</Button><Button variant="secondary" busy={reviewMutation.isPending} disabled={preferences.currentReviewerId === null} onClick={() => saveDecision('Rejected')}>{t('status.review.Rejected')}</Button></div>{targetCategory ? <section className="review-secondary-action"><h3>{t('review.transfer')}</h3><p>{t('review.transferEntryHelp')}</p><Button variant="secondary" disabled={preferences.currentReviewerId === null} onClick={openClassification}>{t('review.transferAction')}</Button></section> : null}</aside>
          </div> : null}
        </div>
      )}
      <ConfirmDialog open={batchConfirmOpen} title={t('review.batchConfirmTitle')} body={<><p>{t('review.batchConfirmBody', { decision: t(`status.review.${batchDecision}`), count: selectedVisibleCount })}</p><p>{t('review.batchConfirmConsequence')}</p></>} confirmLabel={t('review.batchConfirmAction', { decision: t(`status.review.${batchDecision}`) })} cancelLabel={t('actions.cancel')} closeLabel={t('actions.close')} busy={batchMutation.isPending} onClose={() => setBatchConfirmOpen(false)} onConfirm={applyBatch} />
      <ConfirmDialog
        open={classificationOpen && selected !== null && targetCategory !== null}
        title={t('review.transferConfirmTitle')}
        body={selected && targetCategory ? <section className="review-transfer">
          <p>{t(targetIsConflict ? 'review.transferConflictHelp' : 'review.transferAlignedHelp')}</p>
          <dl className="review-transfer__categories"><div><dt>{t('review.currentCategory')}</dt><dd>{t(`category.${selected.category}`)}</dd></div><div><dt>{t('review.targetCategory')}</dt><dd>{t(`category.${targetCategory}`)}</dd></div></dl>
          <div className="review-transfer__fixed"><span>{t('review.preservedTrueEmotion')}</span><strong>{selected.trueEmotion}</strong><small>{t('review.preservedTrueEmotionHelp')}</small></div>
          {targetIsConflict ? <>
            <Field label={t('review.newApparentEmotion')} htmlFor="review-target-apparent-emotion" required error={matchingEmotion ? t('review.emotionMustDiffer') : undefined}><input id="review-target-apparent-emotion" value={targetApparentEmotion} maxLength={120} onChange={event => setTargetApparentEmotion(event.target.value)} /></Field>
            <Field label={t('review.conflictDirection')} htmlFor="review-target-direction" required hint={t('review.conflictDirectionHelp')}><select id="review-target-direction" value={targetDirection} onChange={event => setTargetDirection(event.target.value as ConflictDirection)}>{directionsFor(targetCategory).map(direction => <option key={direction} value={direction}>{t(`direction.${direction}`)}</option>)}</select></Field>
          </> : <div className="review-transfer__fixed"><span>{t('review.alignedApparentEmotion')}</span><strong>{selected.trueEmotion}</strong><small>{t('review.alignedApparentEmotionHelp')}</small></div>}
          <Field label={t('review.descriptionAfterTransfer')} htmlFor="review-target-description" required hint={t('review.descriptionAfterTransferHelp')}><textarea id="review-target-description" value={targetDescription} maxLength={2000} onChange={event => setTargetDescription(event.target.value)} /></Field>
          <p className="review-transfer__summary">{t(targetIsConflict ? 'review.transferConflictSummary' : 'review.transferAlignedSummary', { emotion: selected.trueEmotion, apparentEmotion: targetApparentEmotion.trim(), direction: targetIsConflict ? t(`direction.${targetDirection}`) : '' })}</p>
          <p>{t('review.transferConfirmConsequence')}</p>
          {classificationMutation.error ? <p className="review-transfer__error" role="alert">{apiErrorMessage(classificationMutation.error, locale)}</p> : null}
        </section> : null}
        confirmLabel={t('review.transferConfirmAction')}
        cancelLabel={t('actions.cancel')}
        closeLabel={t('actions.close')}
        busy={classificationMutation.isPending}
        confirmDisabled={preferences.currentReviewerId === null || !classificationValid}
        onClose={() => setClassificationOpen(false)}
        onConfirm={changeClassification}
      />
    </section>
  );
}
