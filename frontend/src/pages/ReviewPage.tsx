import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useExamplePageState } from '../app/useExamplePageState';
import { Button, Dialog, Field, MediaPanel, PageHeader, StatusBadge, useToast } from '../components';
import {
  allowedDirections,
  protocolForCategory,
  type Category,
  type ConflictDirection,
  type ExamplePageState,
  type RepositoryFailureKind,
  type ReviewDecision,
  type Sample,
} from '../types';
import { directionForTransfer, nextCategory, useMockRepository, useRepositorySnapshot } from '../store';
import { archiveReturnTarget } from '../reviewArchive';
import './ReviewPage.css';

type FinalDecision = Exclude<ReviewDecision, 'Pending'>;
type DecisionFilter = 'All' | ReviewDecision;
type CategoryFilter = 'All' | 'A' | 'C' | Category;
type ProtocolFilter = 'All' | 'VA' | 'VT';
type OperationMessage = { kind: 'error' | 'conflict' };

const finalDecisions: FinalDecision[] = ['Accepted', 'Rejected'];
const decisionFilters: DecisionFilter[] = ['All', 'Pending', 'Accepted', 'Rejected'];
const categoryFilters: CategoryFilter[] = ['All', 'A', 'C', 'A-VA', 'C-VA', 'A-VT', 'C-VT'];

function matchesCategory(category: Category, filter: CategoryFilter): boolean {
  if (filter === 'All') return true;
  if (filter === 'A' || filter === 'C') return category.startsWith(`${filter}-`);
  return category === filter;
}

function reviewStatusKind(decision: ReviewDecision) {
  if (decision === 'Accepted') return 'complete' as const;
  if (decision === 'Rejected') return 'problem' as const;
  return 'neutral' as const;
}

function isShortcutBlockedTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function ReviewState({
  state,
  action,
}: {
  state: Exclude<ExamplePageState, 'ready'>;
  action?: { label: ReactNode; onClick: () => void };
}) {
  const { t } = useTranslation();
  return (
    <section
      className="state-view review-page__state"
      aria-live={state === 'error' || state === 'conflict' ? 'assertive' : 'polite'}
    >
      {state === 'loading' ? <span className="state-view__progress" aria-hidden="true" /> : null}
      <h2>{t(`review.${state}Title`)}</h2>
      <p>{t(`review.${state}Body`)}</p>
      {action ? <Button variant="secondary" onClick={action.onClick}>{action.label}</Button> : null}
    </section>
  );
}

function latestReviewNote(sampleId: string, reviews: ReturnType<typeof useRepositorySnapshot>['data']['reviews']): string {
  return reviews
    .filter(review => review.sampleId === sampleId)
    .reduce<(typeof reviews)[number] | null>(
      (latest, review) => (!latest || review.revision > latest.revision ? review : latest),
      null,
    )?.note ?? '';
}

export function ReviewPage() {
  const { t } = useTranslation();
  const repository = useMockRepository();
  const snapshot = useRepositorySnapshot();
  const { showToast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const exampleState = useExamplePageState();
  const initialParams = new URLSearchParams(location.search);
  const requestedSample = snapshot.data.samples.find(sample => sample.displayId === initialParams.get('sample'));
  const initialDataset = requestedSample?.datasetId ?? initialParams.get('dataset');
  const initialDecision = initialParams.get('decision');

  const [search, setSearch] = useState('');
  const [datasetFilter, setDatasetFilter] = useState(() =>
    snapshot.data.datasets.some(dataset => dataset.id === initialDataset) ? initialDataset! : 'All',
  );
  const [protocolFilter, setProtocolFilter] = useState<ProtocolFilter>('All');
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>(() =>
    decisionFilters.includes(initialDecision as DecisionFilter) ? initialDecision as DecisionFilter : 'All',
  );
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('All');
  const [selectedId, setSelectedId] = useState(requestedSample?.id ?? snapshot.data.samples[0]?.id ?? '');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [decision, setDecision] = useState<ReviewDecision>('Pending');
  const [note, setNote] = useState('');
  const [batchDecision, setBatchDecision] = useState<FinalDecision>('Accepted');
  const [batchNote, setBatchNote] = useState('');
  const [transferDirection, setTransferDirection] = useState<ConflictDirection | null>(null);
  const [directionDraft, setDirectionDraft] = useState<ConflictDirection | null>(requestedSample?.conflictDirection ?? null);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [transferConfirmOpen, setTransferConfirmOpen] = useState(false);
  const [directionConfirmOpen, setDirectionConfirmOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [operationMessage, setOperationMessage] = useState<OperationMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const queueButtons = useRef(new Map<string, HTMLButtonElement>());
  const selectAllRef = useRef<HTMLInputElement>(null);
  const reviewVideoRef = useRef<HTMLVideoElement>(null);
  const mobileBackButtonRef = useRef<HTMLButtonElement>(null);
  const returnTarget = archiveReturnTarget(initialParams.get('returnTo'));

  const datasetsById = useMemo(
    () => new Map(snapshot.data.datasets.map(dataset => [dataset.id, dataset])),
    [snapshot.data.datasets],
  );

  const visibleSamples = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase(snapshot.preferences.locale);
    return snapshot.data.samples.filter(sample => {
      const dataset = datasetsById.get(sample.datasetId);
      const searchText = [sample.displayId, dataset?.name ?? '']
        .join(' ')
        .toLocaleLowerCase(snapshot.preferences.locale);
      return (
        (datasetFilter === 'All' || sample.datasetId === datasetFilter) &&
        (protocolFilter === 'All' || protocolForCategory(sample.category) === protocolFilter) &&
        (decisionFilter === 'All' || sample.reviewDecision === decisionFilter) &&
        matchesCategory(sample.category, categoryFilter) &&
        (normalizedSearch === '' || searchText.includes(normalizedSearch))
      );
    });
  }, [categoryFilter, datasetFilter, datasetsById, decisionFilter, protocolFilter, search, snapshot.data.samples, snapshot.preferences.locale]);

  const selected = visibleSamples.find(sample => sample.id === selectedId) ?? visibleSamples[0];
  const targetCategory = selected ? nextCategory(selected.category) : null;
  const targetDirections = targetCategory ? allowedDirections(targetCategory) : [];
  const selectedVisibleIds = visibleSamples.filter(sample => selectedIds.has(sample.id)).map(sample => sample.id);
  const allVisibleSelected = visibleSamples.length > 0 && selectedVisibleIds.length === visibleSamples.length;
  const hasActiveFilters = search !== '' || datasetFilter !== 'All' || protocolFilter !== 'All' || decisionFilter !== 'All' || categoryFilter !== 'All';
  const batchCategoryDistribution = useMemo(() => {
    const counts = new Map<Category, number>();
    visibleSamples.filter(sample => selectedIds.has(sample.id)).forEach(sample => {
      counts.set(sample.category, (counts.get(sample.category) ?? 0) + 1);
    });
    return [...counts.entries()];
  }, [selectedIds, visibleSamples]);

  const clearFilters = useCallback(() => {
    setSearch('');
    setDatasetFilter('All');
    setProtocolFilter('All');
    setDecisionFilter('All');
    setCategoryFilter('All');
    navigate('/review', { replace: true });
  }, [navigate]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const requestedSampleId = params.get('sample');
    const nextSample = snapshot.data.samples.find(sample => sample.displayId === requestedSampleId);
    const requestedDataset = params.get('dataset');
    const requestedDecision = params.get('decision');
    if (nextSample) {
      setDatasetFilter(nextSample.datasetId);
      setSelectedId(nextSample.id);
      if (window.matchMedia('(max-width: 768px)').matches) setMobileDetail(true);
    }
    if (requestedDataset && snapshot.data.datasets.some(dataset => dataset.id === requestedDataset)) {
      setDatasetFilter(requestedDataset);
    }
    if (decisionFilters.includes(requestedDecision as DecisionFilter)) {
      setDecisionFilter(requestedDecision as DecisionFilter);
    }
  }, [location.search, snapshot.data.datasets]);

  useEffect(() => {
    if (visibleSamples.length > 0 && !visibleSamples.some(sample => sample.id === selectedId)) {
      setSelectedId(visibleSamples[0].id);
    }
  }, [selectedId, visibleSamples]);

  useEffect(() => {
    const visibleIds = new Set(visibleSamples.map(sample => sample.id));
    setSelectedIds(current => {
      const next = new Set([...current].filter(id => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visibleSamples]);

  useEffect(() => {
    if (!selected) {
      setDecision('Pending');
      setNote('');
      return;
    }
    setDecision(selected.reviewDecision);
    setNote(latestReviewNote(selected.id, snapshot.data.reviews));
    setDirectionDraft(selected.conflictDirection);
    setOperationMessage(null);
  }, [selected?.id]);

  useEffect(() => {
    const video = reviewVideoRef.current;
    if (!video || !selected) return;
    video.pause();
    video.currentTime = 0;
    video.muted = protocolForCategory(selected.category) === 'VT';
    video.load();
  }, [selected?.category, selected?.id]);

  useEffect(() => {
    if (!targetCategory) {
      setTransferDirection(null);
      return;
    }
    setTransferDirection(directionForTransfer(targetCategory, selected?.conflictDirection ?? null));
  }, [selected?.category, selected?.conflictDirection, targetCategory]);

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate = selectedVisibleIds.length > 0 && !allVisibleSelected;
  }, [allVisibleSelected, selectedVisibleIds.length]);

  const reportFailure = useCallback((kind: RepositoryFailureKind) => {
    const conflict = kind === 'Conflict';
    setOperationMessage({ kind: conflict ? 'conflict' : 'error' });
    setAnnouncement(t(conflict ? 'review.aria.conflict' : 'review.aria.error'));
  }, [t]);

  const chooseDecision = useCallback((value: FinalDecision) => {
    setDecision(value);
    if (selected) {
      setAnnouncement(t('review.aria.decisionChanged', {
        id: selected.displayId,
        decision: t(`status.review.${value}`),
      }));
    }
  }, [selected, t]);

  const activateSample = useCallback((sample: Sample, focus = false) => {
    setSelectedId(sample.id);
    setOperationMessage(null);
    const params = new URLSearchParams(location.search);
    params.set('sample', sample.displayId);
    navigate({ pathname: '/review', search: `?${params.toString()}` }, { replace: true });
    const position = visibleSamples.findIndex(item => item.id === sample.id) + 1;
    setAnnouncement(t('review.aria.selectionChanged', {
      id: sample.displayId,
      position,
      count: visibleSamples.length,
    }));
    if (focus) {
      window.requestAnimationFrame(() => queueButtons.current.get(sample.id)?.focus());
    }
  }, [location.search, navigate, t, visibleSamples]);

  const openMobileDetail = useCallback((sample: Sample) => {
    activateSample(sample);
    if (!window.matchMedia('(max-width: 768px)').matches) return;
    setMobileDetail(true);
    const position = visibleSamples.findIndex(item => item.id === sample.id) + 1;
    setAnnouncement(`${t('review.aria.media')}. ${t('review.aria.selectionChanged', {
      id: sample.displayId,
      position,
      count: visibleSamples.length,
    })}`);
    window.requestAnimationFrame(() => mobileBackButtonRef.current?.focus());
  }, [activateSample, t, visibleSamples]);

  const closeMobileDetail = useCallback(() => {
    const sampleId = selected?.id;
    setMobileDetail(false);
    setAnnouncement(t('review.aria.queue'));
    window.requestAnimationFrame(() => {
      if (sampleId) queueButtons.current.get(sampleId)?.focus();
    });
  }, [selected?.id, t]);

  const save = useCallback(() => {
    if (!selected || decision === 'Pending' || busy) return;
    const reviewerId = snapshot.preferences.currentReviewerId;
    if (!reviewerId) {
      reportFailure('NotFound');
      return;
    }
    setBusy(true);
    setOperationMessage(null);
    setAnnouncement(t('review.aria.saving'));
    const result = repository.saveReview({
      sampleId: selected.id,
      reviewerId,
      decision,
      note,
      expectedSampleRevision: selected.revision,
      expectedReviewRevision: selected.reviewRevision,
    });
    setBusy(false);
    if (!result.ok) {
      reportFailure(result.kind);
      return;
    }
    setDecision(result.value.reviewDecision);
    const currentIndex = visibleSamples.findIndex(sample => sample.id === selected.id);
    const next = visibleSamples[(currentIndex + 1) % visibleSamples.length];
    if (next && next.id !== selected.id) activateSample(next);
    setAnnouncement(t('review.aria.saved'));
    showToast(t('review.success'));
  }, [activateSample, busy, decision, note, reportFailure, repository, selected, showToast, snapshot.preferences.currentReviewerId, t, visibleSamples]);

  const applyBatch = useCallback(() => {
    if (selectedVisibleIds.length === 0 || busy) {
      setAnnouncement(t('review.nothingSelected'));
      return;
    }
    const reviewerId = snapshot.preferences.currentReviewerId;
    if (!reviewerId) {
      reportFailure('NotFound');
      return;
    }
    const items = visibleSamples
      .filter(sample => selectedIds.has(sample.id))
      .map(sample => ({
        sampleId: sample.id,
        expectedSampleRevision: sample.revision,
        expectedReviewRevision: sample.reviewRevision,
      }));
    setBusy(true);
    setOperationMessage(null);
    setAnnouncement(t('review.aria.saving'));
    const result = repository.batchReview({ reviewerId, decision: batchDecision, note: batchNote, items });
    setBusy(false);
    if (!result.ok) {
      reportFailure(result.kind);
      return;
    }
    if (selected && result.value.some(sample => sample.id === selected.id)) setDecision(batchDecision);
    setSelectedIds(new Set());
    setBatchNote('');
    setAnnouncement(t('review.aria.saved'));
    showToast(t('review.batchSuccess', { count: result.value.length }));
  }, [batchDecision, batchNote, busy, reportFailure, repository, selected, selectedIds, selectedVisibleIds.length, showToast, snapshot.preferences.currentReviewerId, t, visibleSamples]);

  const requestBatch = () => {
    if (selectedVisibleIds.length === 0) {
      setAnnouncement(t('review.nothingSelected'));
      return;
    }
    setBatchConfirmOpen(true);
  };

  const transfer = useCallback(() => {
    if (!selected || !targetCategory || busy) return;
    setBusy(true);
    setOperationMessage(null);
    const result = repository.transferCategory({
      sampleId: selected.id,
      targetCategory,
      conflictDirection: targetDirections.length === 0 ? null : transferDirection,
      expectedRevision: selected.revision,
    });
    setBusy(false);
    if (!result.ok) {
      reportFailure(result.kind);
      return;
    }
    setDecision('Pending');
    setNote('');
    setAnnouncement(t('review.transferSuccess'));
    showToast(t('review.transferSuccess'));
  }, [busy, reportFailure, repository, selected, showToast, t, targetCategory, targetDirections.length, transferDirection]);

  const requestTransfer = () => {
    if (!targetCategory || (targetDirections.length > 0 && transferDirection === null)) return;
    setTransferConfirmOpen(true);
  };

  const updateDirection = useCallback(() => {
    if (!selected || directionDraft === null || directionDraft === selected.conflictDirection || busy) return;
    setBusy(true);
    setOperationMessage(null);
    const result = repository.updateConflictDirection({
      sampleId: selected.id,
      conflictDirection: directionDraft,
      expectedRevision: selected.revision,
    });
    setBusy(false);
    setDirectionConfirmOpen(false);
    if (!result.ok) {
      reportFailure(result.kind);
      return;
    }
    setDecision('Pending');
    setNote('');
    setDirectionDraft(result.value.conflictDirection);
    setAnnouncement(t('review.directionUpdated'));
    showToast(t('review.directionUpdated'));
  }, [busy, directionDraft, reportFailure, repository, selected, showToast, t]);

  const requestDirectionUpdate = () => {
    if (!selected || directionDraft === null || directionDraft === selected.conflictDirection) return;
    setDirectionConfirmOpen(true);
  };

  const moveSelection = useCallback((offset: -1 | 1) => {
    if (visibleSamples.length === 0) return;
    const currentIndex = Math.max(0, visibleSamples.findIndex(sample => sample.id === selected?.id));
    const nextIndex = Math.min(visibleSamples.length - 1, Math.max(0, currentIndex + offset));
    activateSample(visibleSamples[nextIndex], true);
  }, [activateSample, selected?.id, visibleSamples]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.repeat ||
        document.querySelector('dialog[open]')
      ) return;
      const key = event.key.toLocaleLowerCase();
      const saveCommand = key === 'enter' && (event.ctrlKey || event.metaKey);
      if (saveCommand) {
        if (event.target instanceof HTMLElement && event.target.closest('[data-review-batch]')) return;
        event.preventDefault();
        save();
        return;
      }
      if (isShortcutBlockedTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code === 'Space') {
        const context = event.target instanceof HTMLElement ? event.target.closest('.review-media') : null;
        if (!context && event.target !== document.body) return;
        const video = reviewVideoRef.current;
        if (!video) return;
        event.preventDefault();
        if (video.paused) void video.play();
        else video.pause();
        return;
      }
      if (key === 'j') {
        event.preventDefault();
        moveSelection(1);
      } else if (key === 'k') {
        event.preventDefault();
        moveSelection(-1);
      } else if (key === '1') {
        event.preventDefault();
        chooseDecision('Accepted');
      } else if (key === '2') {
        event.preventDefault();
        chooseDecision('Rejected');
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [chooseDecision, moveSelection, save]);

  const toggleSelected = (sampleId: string) => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(sampleId)) next.delete(sampleId);
      else next.add(sampleId);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (allVisibleSelected) visibleSamples.forEach(sample => next.delete(sample.id));
      else visibleSamples.forEach(sample => next.add(sample.id));
      return next;
    });
  };

  const resetOperation = () => {
    setOperationMessage(null);
    if (!selected) return;
    setDecision(selected.reviewDecision);
    setNote(latestReviewNote(selected.id, snapshot.data.reviews));
  };

  if (exampleState !== 'ready') {
    const resetPageState = () => navigate(location.pathname, { replace: true });
    const action = exampleState === 'filtered'
      ? { label: t('actions.clearFilters'), onClick: resetPageState }
      : exampleState === 'error' || exampleState === 'conflict'
        ? { label: t('actions.retry'), onClick: resetPageState }
        : undefined;
    return (
      <div className="page-stack review-page">
        <PageHeader title={t('review.title')} />
        <ReviewState state={exampleState} action={action} />
      </div>
    );
  }

  return (
    <section className={`page-stack review-page ${mobileDetail ? 'review-page--mobile-detail' : ''}`} aria-label={t('review.aria.page')}>
      <PageHeader
        title={t('review.title')}
        actions={<div className="review-page__header-actions">{returnTarget ? <Button variant="secondary" onClick={() => navigate(returnTarget)}>{t('review.returnToArchive')}</Button> : null}<span className="review-page__count">{t('review.queueCount', { visible: visibleSamples.length, total: snapshot.data.samples.length })}</span></div>}
      />
      <p className="review-page__subtitle">{t('review.subtitle')}</p>

      <section className="panel review-filters" aria-label={t('review.aria.filters')}>
        <div className="section-header">
          <h2>{t('review.filters')}</h2>
          <Button variant="quiet" onClick={clearFilters} disabled={!hasActiveFilters}>{t('actions.clearFilters')}</Button>
        </div>
        <div className="review-filters__grid">
          <Field label={t('review.searchLabel')} htmlFor="review-search">
            <input
              id="review-search"
              type="search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder={t('review.searchPlaceholder')}
              title={t('review.searchPlaceholder')}
            />
          </Field>
          <Field label={t('review.datasetFilter')} htmlFor="review-dataset-filter">
            <select id="review-dataset-filter" value={datasetFilter} onChange={event => setDatasetFilter(event.target.value)}>
              <option value="All">{t('review.allDatasets')}</option>
              {snapshot.data.datasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
            </select>
          </Field>
          <Field label={t('review.protocolFilter')} htmlFor="review-protocol-filter">
            <select id="review-protocol-filter" value={protocolFilter} onChange={event => setProtocolFilter(event.target.value as ProtocolFilter)}>
              <option value="All">{t('review.allProtocols')}</option>
              <option value="VA">{t('review.protocolVA')}</option>
              <option value="VT">{t('review.protocolVT')}</option>
            </select>
          </Field>
          <Field label={t('review.categoryFilter')} htmlFor="review-category-filter">
            <select id="review-category-filter" value={categoryFilter} onChange={event => setCategoryFilter(event.target.value as CategoryFilter)}>
              {categoryFilters.map(value => (
                <option key={value} value={value}>
                  {value === 'All'
                    ? t('review.allCategories')
                    : value === 'A'
                      ? t('review.categoryAligned')
                      : value === 'C'
                        ? t('review.categoryConflict')
                        : t(`category.${value}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('review.decisionFilter')} htmlFor="review-decision-filter">
            <select id="review-decision-filter" value={decisionFilter} onChange={event => setDecisionFilter(event.target.value as DecisionFilter)}>
              {decisionFilters.map(value => (
                <option key={value} value={value}>{value === 'All' ? t('review.allDecisions') : t(`status.review.${value}`)}</option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      {operationMessage ? (
        <section className={`review-operation review-operation--${operationMessage.kind}`} role="alert">
          <div>
            <strong>{t(`review.${operationMessage.kind}Title`)}</strong>
            <p>{t(`review.${operationMessage.kind}Body`)}</p>
          </div>
          <Button variant="secondary" onClick={resetOperation}>{t('actions.retry')}</Button>
        </section>
      ) : null}

      {snapshot.data.samples.length === 0 ? (
        <ReviewState state="empty" />
      ) : visibleSamples.length === 0 ? (
        <ReviewState state="filtered" action={{ label: t('actions.clearFilters'), onClick: clearFilters }} />
      ) : selected ? (
        <div
          className={`review-grid ${mobileDetail ? 'review-grid--mobile-detail' : ''}`.trim()}
          data-selected-sample={selected.displayId}
          data-sample-revision={selected.revision}
        >
          <section className="panel review-queue" aria-label={t('review.aria.queue')}>
            <div className="section-header">
              <h2>{t('review.queue')}</h2>
              <span>{t('review.selectionCount', { count: selectedVisibleIds.length })}</span>
            </div>
            <div className="review-queue__selection">
              <label>
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                  aria-label={t('review.selectAllVisible')}
                />
                <span>{t('review.selectAllVisible')}</span>
              </label>
              <Button variant="quiet" onClick={() => setSelectedIds(new Set())} disabled={selectedVisibleIds.length === 0}>
                {t('review.clearSelection')}
              </Button>
            </div>
            <ul className="review-queue__list">
              {visibleSamples.map(sample => {
                const dataset = datasetsById.get(sample.datasetId);
                const active = sample.id === selected.id;
                const categoryLabel = t(`category.${sample.category}`);
                const queueItemLabel = t('review.aria.queueItem', {
                  id: sample.displayId,
                  category: categoryLabel,
                  decision: t(`status.review.${sample.reviewDecision}`),
                });
                return (
                  <li key={sample.id} className={active ? 'is-active' : undefined} data-sample-id={sample.displayId}>
                    <label className="review-queue__check">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(sample.id)}
                        onChange={() => toggleSelected(sample.id)}
                        aria-label={queueItemLabel}
                      />
                    </label>
                    <button
                      ref={node => {
                        if (node) queueButtons.current.set(sample.id, node);
                        else queueButtons.current.delete(sample.id);
                      }}
                      type="button"
                      className="review-queue__item"
                      onClick={() => openMobileDetail(sample)}
                      aria-current={active ? 'true' : undefined}
                      aria-label={queueItemLabel}
                      title={queueItemLabel}
                      >
                      <span className="review-queue__item-main">
                        <strong>{sample.displayId}</strong>
                        <span>{sample.category}</span>
                      </span>
                      <span className="review-queue__dataset">{dataset?.name ?? sample.datasetId}</span>
                      <StatusBadge label={t(`status.review.${sample.reviewDecision}`)} kind={reviewStatusKind(sample.reviewDecision)} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <div className="review-detail">
          <section className="panel review-media" aria-label={t('review.aria.media')}>
            <div className="section-header">
              <div className="review-media__heading"><Button ref={mobileBackButtonRef} className="review-media__back" variant="quiet" onClick={returnTarget ? () => navigate(returnTarget) : closeMobileDetail}>{t(returnTarget ? 'review.returnToArchive' : 'review.backToQueue')}</Button><h2>{t('review.media')}</h2></div>
              <div className="review-media__badges" aria-label={t('fields.category')}>
                <StatusBadge label={t(`category.${selected.category}`)} kind={selected.category.startsWith('C-') ? 'problem' : 'complete'} />
                <StatusBadge label={t(protocolForCategory(selected.category) === 'VA' ? 'review.protocolVA' : 'review.protocolVT')} />
              </div>
            </div>
            <div className="review-media__previews">
              <MediaPanel
                title={t('review.video')}
                mediaLabel={t('review.primaryMediaAlt', { id: selected.displayId })}
                src={selected.primaryAssetUrl}
                muted={protocolForCategory(selected.category) === 'VT'}
                videoRef={reviewVideoRef}
              />
            </div>
            <div className="review-media__navigation" aria-label={t('review.aria.sampleNavigation')}>
              <Button variant="secondary" onClick={() => moveSelection(-1)} disabled={visibleSamples[0]?.id === selected.id}>{t('review.previousSample')}</Button>
              <span>{t('review.samplePosition', { position: visibleSamples.findIndex(sample => sample.id === selected.id) + 1, count: visibleSamples.length })}</span>
              <Button variant="secondary" onClick={() => moveSelection(1)} disabled={visibleSamples[visibleSamples.length - 1]?.id === selected.id}>{t('review.nextSample')}</Button>
            </div>
          </section>

            <section className="panel review-context" aria-label={t('review.aria.details', { id: selected.displayId })}>
              <h3>{t('review.context')}</h3>
              <dl className="review-context__facts review-context__facts--emotion">
                <div><dt>{t('review.trueEmotion')}</dt><dd>{t(`emotion.${selected.trueEmotion}`, { defaultValue: selected.trueEmotion })}</dd></div>
                <div><dt>{t('review.apparentEmotion')}</dt><dd>{t(`emotion.${selected.apparentEmotion}`, { defaultValue: selected.apparentEmotion })}</dd></div>
                <div><dt>{t('direction.label')}</dt><dd>{selected.conflictDirection ? t(`direction.${selected.conflictDirection}`) : t('review.directionNotRequired')}</dd></div>
              </dl>
              <div className="review-context__copy review-context__copy--primary">
                <div className="review-context__copy--description" aria-readonly="true"><h3>{t('review.trueEmotionDescription')}</h3><p>{selected.trueEmotionDescription}</p></div>
              </div>
              <div className="review-context__copy review-context__copy--protocol-row">
                {protocolForCategory(selected.category) === 'VA' && selected.dialogue ? (
                  <div className="review-context__copy--protocol"><h3>{t('review.dialogue')}</h3><p>{selected.dialogue}</p></div>
                ) : null}
                {protocolForCategory(selected.category) === 'VT' && selected.displayText ? (
                  <div className="review-context__copy--protocol"><h3>{t('review.displayText')}</h3><p>{selected.displayText}</p></div>
                ) : null}
              </div>
              <details className="review-context__details">
                <summary>{t('review.moreDetails')}</summary>
                <dl>
                  <div><dt>{t('review.sampleId')}</dt><dd>{selected.displayId}</dd></div>
                  <div><dt>{t('fields.dataset')}</dt><dd>{datasetsById.get(selected.datasetId)?.name ?? selected.datasetId}</dd></div>
                  <div><dt>{t('fields.category')}</dt><dd>{t(`category.${selected.category}`)}</dd></div>
                  <div><dt>{t('review.protocolFilter')}</dt><dd>{t(protocolForCategory(selected.category) === 'VA' ? 'review.protocolVA' : 'review.protocolVT')}</dd></div>
                  <div><dt>{t('review.contentPlan')}</dt><dd>{selected.contentPlanName}</dd></div>
                  <div><dt>{t('review.scenario')}</dt><dd>{selected.scenario}</dd></div>
                  <div><dt>{t('review.triggerEvent')}</dt><dd>{selected.triggerEvent}</dd></div>
                  <div><dt>{t('review.psychologicalBackground')}</dt><dd>{selected.psychologicalBackground}</dd></div>
                  <div><dt>{t('review.demographics')}</dt><dd>{t(`review.gender.${selected.gender}`)} {selected.age} {t(`review.ethnicity.${selected.ethnicity}`)}</dd></div>
                  <div><dt>{t('review.model')}</dt><dd>{selected.model}</dd></div>
                  <div><dt>{t('review.seed')}</dt><dd>{selected.seed}</dd></div>
                  <div><dt>{t('review.contentVersion')}</dt><dd>{selected.contentVersion}</dd></div>
                  <div className="review-context__details-wide"><dt>{t('review.positivePrompt')}</dt><dd>{selected.videoPrompt}</dd></div>
                  <div className="review-context__details-wide"><dt>{t('review.negativePrompt')}</dt><dd>{selected.negativePrompt}</dd></div>
                </dl>
              </details>
            </section>

          <aside className="panel review-decision">
            <div className="section-header">
              <h2>{t('review.decision')}</h2>
              <StatusBadge label={t(`status.review.${decision}`)} kind={reviewStatusKind(decision)} />
            </div>
            <div className="decision-options" role="group" aria-label={t('review.aria.decision')}>
              {finalDecisions.map((value, index) => (
                <Button
                  key={value}
                  variant={decision === value ? 'primary' : 'secondary'}
                  className="review-decision__choice"
                  onClick={() => chooseDecision(value)}
                  aria-pressed={decision === value}
                  aria-keyshortcuts={String(index + 1)}
                >
                  <span className="review-decision__choice-label">{t(`status.review.${value}`)}</span>
                  <span className="review-decision__choice-help">{t(`review.decisionDescription.${value}`)}</span>
                </Button>
              ))}
            </div>
            {selected.category.startsWith('C-') ? (
              <section className="review-direction" aria-label={t('review.aria.direction')}>
                <Field label={t('direction.label')} htmlFor="review-direction">
                  <select
                    id="review-direction"
                    value={directionDraft ?? ''}
                    onChange={event => setDirectionDraft(event.target.value as ConflictDirection)}
                  >
                    {allowedDirections(selected.category).map(value => (
                      <option key={value} value={value}>{t(`direction.${value}`)}</option>
                    ))}
                  </select>
                </Field>
                <Button
                  variant="secondary"
                  onClick={requestDirectionUpdate}
                  disabled={directionDraft === null || directionDraft === selected.conflictDirection}
                >
                  {t('review.saveDirection')}
                </Button>
              </section>
            ) : null}
            <Field label={t('fields.note')} htmlFor="review-note">
              <textarea
                id="review-note"
                value={note}
                onChange={event => setNote(event.target.value)}
                placeholder={t('review.notePlaceholder')}
              />
            </Field>
            <Button
              variant="primary"
              onClick={save}
              busy={busy}
              disabled={!selected || decision === 'Pending'}
              aria-keyshortcuts="Control+Enter Meta+Enter"
            >
              {t('actions.saveDecision')}
            </Button>

            <details className="review-secondary-action" open={transferOpen} onToggle={event => setTransferOpen(event.currentTarget.open)}>
              <summary>{t('review.transfer')}</summary>
              <section className="review-transfer" aria-label={t('review.aria.transfer')}>
                <p>{t('review.transferHelp')}</p>
                <dl>
                  <div><dt>{t('review.currentCategory')}</dt><dd>{t(`category.${selected.category}`)}</dd></div>
                  {targetCategory ? <div><dt>{t('review.targetCategory')}</dt><dd>{t(`category.${targetCategory}`)}</dd></div> : null}
                </dl>
                {targetDirections.length > 0 ? (
                  <Field label={t('review.conflictDirection')} htmlFor="review-transfer-direction">
                    <select
                      id="review-transfer-direction"
                      value={transferDirection ?? ''}
                      onChange={event => setTransferDirection(event.target.value as ConflictDirection)}
                    >
                      {targetDirections.map(value => <option key={value} value={value}>{t(`direction.${value}`)}</option>)}
                    </select>
                  </Field>
                ) : <p>{t('review.directionNotRequired')}</p>}
                <Button
                  variant="secondary"
                  onClick={requestTransfer}
                  busy={busy}
                  disabled={!targetCategory || (targetDirections.length > 0 && transferDirection === null)}
                >
                  {t('review.transferAction')}
                </Button>
              </section>
            </details>

            <details className="review-secondary-action" open={batchOpen} onToggle={event => setBatchOpen(event.currentTarget.open)} data-review-batch>
              <summary>{t('review.batch')}</summary>
              <section className="review-batch" aria-label={t('review.aria.batch')}>
                <p>{selectedVisibleIds.length > 0 ? t('review.selectionCount', { count: selectedVisibleIds.length }) : t('review.nothingSelected')}</p>
                <Field label={t('review.batchDecision')} htmlFor="review-batch-decision">
                  <select id="review-batch-decision" value={batchDecision} onChange={event => setBatchDecision(event.target.value as FinalDecision)}>
                    {finalDecisions.map(value => <option key={value} value={value}>{t(`status.review.${value}`)}</option>)}
                  </select>
                </Field>
                <Field label={t('fields.note')} htmlFor="review-batch-note">
                  <textarea
                    id="review-batch-note"
                    value={batchNote}
                    onChange={event => setBatchNote(event.target.value)}
                    placeholder={t('review.batchNotePlaceholder')}
                  />
                </Field>
                <Button variant="secondary" onClick={requestBatch} busy={busy} disabled={selectedVisibleIds.length === 0}>
                  {t('review.applyBatch')}
                </Button>
              </section>
            </details>

            <details className="review-shortcuts">
              <summary>{t('review.shortcuts')}</summary>
              <ul aria-label={t('review.aria.shortcuts')}>
                <li>{t('review.shortcutPrevious')}</li>
                <li>{t('review.shortcutNext')}</li>
                <li>{t('review.shortcutAccept')}</li>
                <li>{t('review.shortcutReject')}</li>
                <li>{t('review.shortcutSave')}</li>
              </ul>
              <p>{t('review.shortcutIme')}</p>
            </details>
          </aside>
          </div>
        </div>
      ) : null}

      <Dialog
        open={batchConfirmOpen}
        title={t('review.batchConfirmTitle')}
        closeLabel={t('actions.close')}
        onClose={() => setBatchConfirmOpen(false)}
        footer={<><Button onClick={() => setBatchConfirmOpen(false)}>{t('actions.cancel')}</Button><Button variant="primary" busy={busy} onClick={() => { setBatchConfirmOpen(false); applyBatch(); }}>{t('review.batchConfirmAction', { decision: t(`status.review.${batchDecision}`) })}</Button></>}
      >
        <p>{t('review.batchConfirmBody', { count: selectedVisibleIds.length, decision: t(`status.review.${batchDecision}`) })}</p>
        <ul className="review-confirm__distribution">{batchCategoryDistribution.map(([category, count]) => <li key={category}>{t(`category.${category}`)}: {count}</li>)}</ul>
        <p>{t('review.batchConfirmConsequence')}</p>
      </Dialog>

      <Dialog
        open={transferConfirmOpen}
        title={t('review.transferConfirmTitle')}
        closeLabel={t('actions.close')}
        onClose={() => setTransferConfirmOpen(false)}
        footer={<><Button onClick={() => setTransferConfirmOpen(false)}>{t('actions.cancel')}</Button><Button variant="primary" busy={busy} onClick={() => { setTransferConfirmOpen(false); transfer(); }}>{t('review.transferAction')}</Button></>}
      >
        {selected && targetCategory ? <><p>{t('review.transferConfirmBody', { from: t(`category.${selected.category}`), to: t(`category.${targetCategory}`) })}</p>{targetDirections.length > 0 ? <p>{t('review.transferConfirmDirection', { direction: t(`direction.${transferDirection}`) })}</p> : null}<p>{t('review.transferConfirmConsequence')}</p></> : null}
      </Dialog>

      <Dialog
        open={directionConfirmOpen}
        title={t('review.directionConfirmTitle')}
        closeLabel={t('actions.close')}
        onClose={() => setDirectionConfirmOpen(false)}
        footer={<><Button onClick={() => setDirectionConfirmOpen(false)}>{t('actions.cancel')}</Button><Button variant="primary" busy={busy} onClick={updateDirection}>{t('review.saveDirection')}</Button></>}
      >
        {selected && directionDraft ? (
          <>
            <p>{t('review.directionConfirmBody', { from: t(`direction.${selected.conflictDirection}`), to: t(`direction.${directionDraft}`) })}</p>
            <p>{t('review.directionConfirmRevision', { revision: selected.revision })}</p>
            <p>{t('review.directionConfirmConsequence')}</p>
          </>
        ) : null}
      </Dialog>

      <p className="review-page__sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    </section>
  );
}
