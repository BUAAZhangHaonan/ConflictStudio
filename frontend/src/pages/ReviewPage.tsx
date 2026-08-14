import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Button, Field, MediaPanel, PageHeader, StatusBadge } from '../components';
import { useDatasetsQuery, useSamplesQuery, useUpdateSampleReviewMutation } from '../api/queries';
import { apiErrorMessage } from '../api/client';
import type { ReviewDecision, Sample } from '../api/contracts';
import { protocolForCategory, type Category } from '../types';
import { OperationFeedback } from './generate/shared';
import './ReviewPage.css';

type CategoryFilter = 'All' | Category;
type ProtocolFilter = 'All' | 'VA' | 'VT';

const categories: CategoryFilter[] = ['All', 'A-VA', 'A-VT', 'C-VA', 'C-VT'];

function localized(value: Sample, locale: string, field: 'contentPlanName' | 'scene' | 'triggerEvent' | 'psychologicalBackground') {
  const suffix = locale === 'zh-CN' ? 'Zh' : 'En';
  return value[`${field}${suffix}` as keyof Sample] as string;
}

export function ReviewPage() {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const samplesQuery = useSamplesQuery('Pending');
  const datasetsQuery = useDatasetsQuery();
  const reviewMutation = useUpdateSampleReviewMutation();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [datasetId, setDatasetId] = useState<number | 'All'>('All');
  const [category, setCategory] = useState<CategoryFilter>('All');
  const [protocol, setProtocol] = useState<ProtocolFilter>('All');
  const samples = samplesQuery.data ?? [];
  const datasets = datasetsQuery.data ?? [];
  const datasetsById = useMemo(() => new Map(datasets.map(dataset => [dataset.id, dataset])), [datasets]);

  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase(i18n.language);
    return samples.filter(sample => {
      const haystack = `${sample.displayId} ${datasetsById.get(sample.datasetId)?.name ?? ''}`.toLocaleLowerCase(i18n.language);
      return sample.reviewDecision === 'Pending'
        && (datasetId === 'All' || sample.datasetId === datasetId)
        && (category === 'All' || sample.category === category)
        && (protocol === 'All' || protocolForCategory(sample.category) === protocol)
        && (needle === '' || haystack.includes(needle));
    });
  }, [category, datasetId, datasetsById, i18n.language, protocol, samples, search]);

  const selected = visible.find(sample => sample.id === selectedId) ?? visible[0] ?? null;

  useEffect(() => {
    const requested = samples.find(sample => sample.displayId === params.get('sample'));
    if (requested && requested.id !== selectedId) setSelectedId(requested.id);
  }, [params, samples, selectedId]);

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  const choose = (sample: Sample) => {
    setSelectedId(sample.id);
    const next = new URLSearchParams(params);
    next.set('sample', sample.displayId);
    setParams(next, { replace: true });
  };

  const saveDecision = (decision: Exclude<ReviewDecision, 'Pending'>) => {
    if (!selected) return;
    reviewMutation.mutate({
      id: selected.id,
      input: { expectedRevision: selected.revision, decision },
    });
  };

  const clearFilters = () => {
    setSearch('');
    setDatasetId('All');
    setCategory('All');
    setProtocol('All');
  };

  if (samplesQuery.isPending || datasetsQuery.isPending) {
    return <section className="page-stack review-page"><PageHeader title={t('review.title')} /><p role="status">{t('review.loadingBody')}</p></section>;
  }
  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';
  const queryError = samplesQuery.error ?? datasetsQuery.error ?? null;
  if (queryError) {
    return <section className="page-stack review-page"><PageHeader title={t('review.title')} /><section className="generation-feedback" role="alert"><p>{apiErrorMessage(queryError, locale)}</p></section></section>;
  }

  return (
    <section className="page-stack review-page" aria-label={t('review.aria.page')}>
      <PageHeader title={t('review.title')} actions={<span className="review-page__count">{t('review.queueCount', { visible: visible.length, total: samples.length })}</span>} />
      <p className="review-page__subtitle">{t('review.subtitle')}</p>
      {reviewMutation.error ? <OperationFeedback error={reviewMutation.error} onDismiss={() => reviewMutation.reset()} /> : null}
      <section className="panel review-filters" aria-label={t('review.aria.filters')}>
        <div className="section-header"><h2>{t('review.filters')}</h2><Button variant="quiet" onClick={clearFilters}>{t('actions.clearFilters')}</Button></div>
        <div className="review-filters__grid">
          <Field label={t('review.searchLabel')} htmlFor="review-search"><input id="review-search" type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
          <Field label={t('review.datasetFilter')} htmlFor="review-dataset-filter"><select id="review-dataset-filter" value={datasetId} onChange={event => setDatasetId(event.target.value === 'All' ? 'All' : Number(event.target.value))}><option value="All">{t('review.allDatasets')}</option>{datasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></Field>
          <Field label={t('review.protocolFilter')} htmlFor="review-protocol-filter"><select id="review-protocol-filter" value={protocol} onChange={event => setProtocol(event.target.value as ProtocolFilter)}><option value="All">{t('review.allProtocols')}</option><option value="VA">{t('review.protocolVA')}</option><option value="VT">{t('review.protocolVT')}</option></select></Field>
          <Field label={t('review.categoryFilter')} htmlFor="review-category-filter"><select id="review-category-filter" value={category} onChange={event => setCategory(event.target.value as CategoryFilter)}>{categories.map(value => <option key={value} value={value}>{value === 'All' ? t('review.allCategories') : t(`category.${value}`)}</option>)}</select></Field>
        </div>
      </section>
      {samples.length === 0 ? <section className="state-view review-page__state"><h2>{t('review.emptyTitle')}</h2><p>{t('review.emptyBody')}</p></section> : visible.length === 0 ? <section className="state-view review-page__state"><h2>{t('review.filteredTitle')}</h2><p>{t('review.filteredBody')}</p></section> : selected ? (
        <div className="review-grid" data-selected-sample={selected.displayId} data-sample-revision={selected.revision}>
          <section className="panel review-queue" aria-label={t('review.aria.queue')}><div className="section-header"><h2>{t('review.queue')}</h2></div><ul className="review-queue__list">{visible.map(sample => <li key={sample.id} className={sample.id === selected.id ? 'is-active' : undefined} data-sample-id={sample.displayId}><button type="button" className="review-queue__item" onClick={() => choose(sample)} aria-current={sample.id === selected.id ? 'true' : undefined}><span className="review-queue__item-main"><strong>{sample.displayId}</strong><span>{sample.category}</span></span><span className="review-queue__dataset">{datasetsById.get(sample.datasetId)?.name ?? sample.datasetId}</span><StatusBadge label={t('status.review.Pending')} kind="neutral" /></button></li>)}</ul></section>
          <div className="review-detail">
            <section className="panel review-media" aria-label={t('review.aria.media')}><div className="section-header"><h2>{t('review.media')}</h2><div className="review-media__badges"><StatusBadge label={t(`category.${selected.category}`)} kind={selected.category.startsWith('C-') ? 'problem' : 'complete'} /><StatusBadge label={t(protocolForCategory(selected.category) === 'VA' ? 'review.protocolVA' : 'review.protocolVT')} /></div></div><MediaPanel title={t('review.video')} mediaLabel={t('review.primaryMediaAlt', { id: selected.displayId })} src={selected.primaryAssetUrl} muted={protocolForCategory(selected.category) === 'VT'} /></section>
            <section className="panel review-context" aria-label={t('review.aria.details', { id: selected.displayId })}><h3>{t('review.context')}</h3><dl className="review-context__facts review-context__facts--emotion"><div><dt>{t('review.trueEmotion')}</dt><dd>{selected.trueEmotion}</dd></div><div><dt>{t('review.apparentEmotion')}</dt><dd>{selected.apparentEmotion}</dd></div><div><dt>{t('direction.label')}</dt><dd>{selected.conflictDirection ? t(`direction.${selected.conflictDirection}`) : t('review.directionNotRequired')}</dd></div></dl><div className="review-context__copy review-context__copy--primary"><div className="review-context__copy--description"><h3>{t('review.trueEmotionDescription')}</h3><p>{selected.trueEmotionDescription}</p></div></div>{selected.dialogue ? <div className="review-context__copy"><div><h3>{t('review.dialogue')}</h3><p>{selected.dialogue}</p></div></div> : null}{selected.displayText ? <div className="review-context__copy"><div><h3>{t('review.displayText')}</h3><p>{selected.displayText}</p></div></div> : null}<details className="review-context__details"><summary>{t('review.moreDetails')}</summary><dl><div><dt>{t('review.sampleId')}</dt><dd>{selected.displayId}</dd></div><div><dt>{t('fields.dataset')}</dt><dd>{datasetsById.get(selected.datasetId)?.name ?? selected.datasetId}</dd></div><div><dt>{t('review.contentPlan')}</dt><dd>{localized(selected, i18n.language, 'contentPlanName')}</dd></div><div><dt>{t('review.scenario')}</dt><dd>{localized(selected, i18n.language, 'scene')}</dd></div><div><dt>{t('review.triggerEvent')}</dt><dd>{localized(selected, i18n.language, 'triggerEvent')}</dd></div><div><dt>{t('review.psychologicalBackground')}</dt><dd>{localized(selected, i18n.language, 'psychologicalBackground')}</dd></div><div><dt>{t('review.model')}</dt><dd>{selected.model}</dd></div>{selected.generationRecord.precision ? <div><dt>{t('review.precision')}</dt><dd>{selected.generationRecord.precision}</dd></div> : null}<div><dt>{t('review.seed')}</dt><dd>{selected.seed}</dd></div><div className="review-context__details-wide"><dt>{t('review.positivePrompt')}</dt><dd>{selected.videoPrompt}</dd></div><div className="review-context__details-wide"><dt>{t('review.negativePrompt')}</dt><dd>{selected.negativePrompt}</dd></div></dl></details></section>
            <aside className="panel review-decision"><div className="section-header"><h2>{t('review.decision')}</h2><StatusBadge label={t('status.review.Pending')} kind="neutral" /></div><div className="decision-options" role="group" aria-label={t('review.aria.decision')}><Button variant="primary" busy={reviewMutation.isPending} onClick={() => saveDecision('Accepted')}>{t('status.review.Accepted')}</Button><Button variant="secondary" busy={reviewMutation.isPending} onClick={() => saveDecision('Rejected')}>{t('status.review.Rejected')}</Button></div></aside>
          </div>
        </div>
      ) : null}
    </section>
  );
}
