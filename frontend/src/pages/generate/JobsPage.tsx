import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, ConfirmDialog, Dialog, Field, StatusBadge, useToast } from '../../components';
import { canKeepTestResult, useMockRepository, useRepositorySnapshot } from '../../store';
import { formatDateTime } from '../../time';
import { formatCompactDateTime } from '../../time';
import type { GpuSlot, Job, JobSource, JobStatus, Sample } from '../../types';
import {
  GenerationScaffold,
  OperationFeedback,
  categoryLabel,
  directionLabel,
  jobStatusKind,
  modelSpecLabel,
  parseSeed,
  useGenerationCopy,
} from './shared';

const jobStatuses: Array<JobStatus | 'All'> = ['All', 'Queued', 'Running', 'Completed', 'Failed', 'Cancelled'];
const jobSources: Array<JobSource | 'All'> = ['All', 'Production', 'Test', 'Rerender'];

function isCancellable(status: JobStatus) {
  return status === 'Queued' || status === 'Running';
}

function isRetryable(status: JobStatus) {
  return status === 'Failed' || status === 'Cancelled';
}

function jobName(job: Pick<Job, 'category' | 'createdAt'>): string {
  return `${job.category}-${formatCompactDateTime(job.createdAt)}`;
}

interface ResultEdit {
  dialogue: string;
  displayText: string;
  videoPrompt: string;
  explanation: string;
  note: string;
}

function sampleResultEdit(
  sample: Sample,
): ResultEdit {
  return {
    dialogue: sample.dialogue ?? '',
    displayText: sample.displayText ?? '',
    videoPrompt: sample.videoPrompt,
    explanation: sample.explanation,
    note: sample.generationNote,
  };
}

export function JobsPage() {
  const g = useGenerationCopy();
  const repository = useMockRepository();
  const snapshot = useRepositorySnapshot();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const locale = snapshot.preferences.locale;
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<JobStatus | 'All'>(() => {
    const value = searchParams.get('status');
    return jobStatuses.includes(value as JobStatus) ? value as JobStatus : 'All';
  });
  const [sourceFilter, setSourceFilter] = useState<JobSource | 'All'>('All');
  const [selectedId, setSelectedId] = useState(() => {
    const requested = searchParams.get('job');
    return snapshot.data.jobs.find(job => job.id === requested)?.id
      ?? snapshot.data.jobs.find(job => job.status === 'Running')?.id
      ?? snapshot.data.jobs[0]?.id
      ?? '';
  });
  const [mobileDetail, setMobileDetail] = useState(() =>
    window.matchMedia('(max-width: 768px)').matches && searchParams.has('job'),
  );
  const [failure, setFailure] = useState<null | 'Conflict' | 'NotFound' | 'InvalidInput' | 'Unavailable'>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [retryOpen, setRetryOpen] = useState(false);
  const [keepOpen, setKeepOpen] = useState(false);
  const [retryGpu, setRetryGpu] = useState<GpuSlot | ''>('');
  const [retrySeed, setRetrySeed] = useState('');
  const [keepDatasetId, setKeepDatasetId] = useState('');
  const [editSampleId, setEditSampleId] = useState('');
  const [editDraft, setEditDraft] = useState<ResultEdit | null>(null);
  const [rerenderConfirmOpen, setRerenderConfirmOpen] = useState(false);
  const [rerenderGpu, setRerenderGpu] = useState<GpuSlot | null>(null);

  const datasetsById = useMemo(
    () => new Map(snapshot.data.datasets.map(dataset => [dataset.id, dataset])),
    [snapshot.data.datasets],
  );
  const samplesById = useMemo(
    () => new Map(snapshot.data.samples.map(sample => [sample.id, sample])),
    [snapshot.data.samples],
  );
  const contentById = useMemo(
    () => new Map(snapshot.data.contentItems.map(item => [item.id, item])),
    [snapshot.data.contentItems],
  );
  const presetsById = useMemo(
    () => new Map(snapshot.data.presets.map(item => [item.id, item])),
    [snapshot.data.presets],
  );
  const activeDatasets = snapshot.data.datasets.filter(dataset => dataset.status === 'Active');
  const availableGpuSlots = snapshot.data.gpuStates
    .filter(gpu => gpu.availability === 'Available')
    .map(gpu => gpu.slot);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(locale);
    return snapshot.data.jobs.filter(job => {
      const datasetName = job.datasetId ? datasetsById.get(job.datasetId)?.name ?? job.datasetId : '';
      const matchesQuery = query === '' || [
        job.id,
        datasetName,
        job.model,
        job.gpus.join(' '),
        g(`jobs.source.${job.source}`),
      ].join(' ').toLocaleLowerCase(locale).includes(query);
      const matchesStatus = statusFilter === 'All' || job.status === statusFilter;
      const matchesSource = sourceFilter === 'All' || job.source === sourceFilter;
      return matchesQuery && matchesStatus && matchesSource;
    });
  }, [datasetsById, g, locale, search, snapshot.data.jobs, sourceFilter, statusFilter]);

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId('');
      return;
    }
    if (!filtered.some(job => job.id === selectedId)) setSelectedId(filtered[0].id);
  }, [filtered, selectedId]);

  useEffect(() => {
    if (retryGpu !== '' && availableGpuSlots.includes(retryGpu)) return;
    setRetryGpu(availableGpuSlots[0] ?? '');
  }, [availableGpuSlots, retryGpu]);

  useEffect(() => {
    if (keepDatasetId !== '' && activeDatasets.some(dataset => dataset.id === keepDatasetId)) return;
    setKeepDatasetId(activeDatasets[0]?.id ?? '');
  }, [activeDatasets, keepDatasetId]);

  useEffect(() => {
    const requestedStatus = searchParams.get('status');
    if (jobStatuses.includes(requestedStatus as JobStatus | 'All')) {
      setStatusFilter(requestedStatus as JobStatus | 'All');
    }
    const requestedJob = searchParams.get('job');
    if (requestedJob && snapshot.data.jobs.some(job => job.id === requestedJob)) {
      setSelectedId(requestedJob);
    }
  }, [searchParams, snapshot.data.jobs]);

  const selected = snapshot.data.jobs.find(job => job.id === selectedId) ?? null;
  const attemptHistory = useMemo(() => {
    if (!selected) return [];
    const byId = new Map(snapshot.data.jobs.map(job => [job.id, job]));
    let root = selected;
    while (root.parentJobId) {
      const parent = byId.get(root.parentJobId);
      if (!parent) break;
      root = parent;
    }
    const related: Job[] = [];
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.shift()!;
      related.push(current);
      queue.push(...snapshot.data.jobs.filter(job => job.parentJobId === current.id));
    }
    return related.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }, [selected, snapshot.data.jobs]);
  const hasFilters = search !== '' || statusFilter !== 'All' || sourceFilter !== 'All';
  const isLatestSelectedAttempt = attemptHistory[attemptHistory.length - 1]?.id === selected?.id;
  const runningCount = snapshot.data.jobs.filter(job => job.status === 'Running').length;
  const queuedCount = snapshot.data.jobs.filter(job => job.status === 'Queued').length;
  const selectedRunningItems = selected?.items.filter(item => item.status === 'Running') ?? [];
  const selectedInputItems = selectedRunningItems.length > 0
    ? selectedRunningItems
    : selected?.testInput && selected.items[0]
      ? [selected.items[0]]
      : [];
  const selectedCurrentInputs = selectedInputItems.map(item => {
    const allocation = selected?.batchInput?.allocations[item.sequence - 1] ?? null;
    return { item, allocation };
  });

  const clearFilters = () => {
    setSearch('');
    setStatusFilter('All');
    setSourceFilter('All');
    setSearchParams({}, { replace: true });
  };

  const selectJob = (job: Job) => {
    setSelectedId(job.id);
    setFailure(null);
    setCancelOpen(false);
    setRetryOpen(false);
    setKeepOpen(false);
    setEditSampleId('');
    setEditDraft(null);
    setSearchParams({ job: job.id }, { replace: true });
    if (window.matchMedia('(max-width: 768px)').matches) setMobileDetail(true);
  };

  const revealJob = (job: Job) => {
    setSearch('');
    setStatusFilter('All');
    setSourceFilter('All');
    setSelectedId(job.id);
    setSearchParams({ job: job.id }, { replace: true });
    if (window.matchMedia('(max-width: 768px)').matches) setMobileDetail(true);
  };

  const openRetryDialog = () => {
    if (!selected) return;
    const selectedGpu = selected.gpus[0];
    setRetryGpu(selectedGpu && availableGpuSlots.includes(selectedGpu) ? selectedGpu : (availableGpuSlots[0] ?? ''));
    setRetrySeed(selected.seed == null ? '' : String(selected.seed));
    setRetryOpen(true);
  };

  const openKeepDialog = () => {
    if (!selected) return;
    setKeepDatasetId(
      selected.datasetId && activeDatasets.some(dataset => dataset.id === selected.datasetId)
        ? selected.datasetId
        : (activeDatasets[0]?.id ?? ''),
    );
    setKeepOpen(true);
  };

  const cancelJob = () => {
    if (!selected || !isCancellable(selected.status)) return;
    const result = repository.cancelJob(selected.id, selected.revision);
    setCancelOpen(false);
    if (!result.ok) {
      setFailure(result.kind);
      return;
    }
    setFailure(null);
    showToast(g('jobs.cancelled'));
  };

  const retryJob = () => {
    if (!selected || !isRetryable(selected.status) || retryGpu === '') return;
    const result = repository.retryJob(selected.id, retryGpu, parseSeed(retrySeed), selected.revision);
    if (!result.ok) {
      setFailure(result.kind);
      return;
    }
    setRetryOpen(false);
    setFailure(null);
    revealJob(result.value);
    showToast(g('jobs.retried'));
  };

  const keepResult = () => {
    if (!selected || !canKeepTestResult(selected) || keepDatasetId === '') return;
    const result = repository.keepTestResult(selected.id, keepDatasetId, selected.revision);
    if (!result.ok) {
      setFailure(result.kind);
      return;
    }
    setKeepOpen(false);
    setFailure(null);
    showToast(g('jobs.kept'));
  };

  const openResultEditor = (sample: Sample) => {
    if (
      !selected ||
      !isLatestSelectedAttempt ||
      selected.status !== 'Completed' ||
      sample.reviewDecision === 'Rejected' ||
      selected.resultSampleIds[selected.resultSampleIds.length - 1] !== sample.id
    ) return;
    setEditSampleId(sample.id);
    setEditDraft(sampleResultEdit(sample));
  };

  const closeResultEditor = () => {
    setEditSampleId('');
    setEditDraft(null);
    setRerenderConfirmOpen(false);
    setRerenderGpu(null);
  };

  const applyResultEdit = (rerender: boolean) => {
    const sample = samplesById.get(editSampleId);
    if (!selected || !sample || !editDraft) return;
    const result = repository.updateJobResult({
      jobId: selected.id,
      sampleId: sample.id,
      dialogue: sample.category.endsWith('-VA') ? editDraft.dialogue : null,
      displayText: sample.category.endsWith('-VT') ? editDraft.displayText : null,
      videoPrompt: editDraft.videoPrompt,
      explanation: editDraft.explanation,
      generationNote: editDraft.note,
      rerenderGpu: rerender ? rerenderGpu : null,
      expectedJobRevision: selected.revision,
      expectedSampleRevision: sample.revision,
    });
    if (!result.ok) {
      setRerenderConfirmOpen(false);
      setFailure(result.kind);
      return;
    }
    const rerenderJob = result.value.rerenderJob;
    closeResultEditor();
    setFailure(null);
    if (rerenderJob) revealJob(rerenderJob);
    showToast(g(rerenderJob ? 'jobs.rerenderCreated' : 'jobs.resultSaved'));
  };

  const requestResultSave = () => {
    const sample = samplesById.get(editSampleId);
    if (!sample || !editDraft) return;
    const saved = sampleResultEdit(sample);
    const needsRerender = editDraft.videoPrompt !== saved.videoPrompt
      || (sample.category.endsWith('-VA') && editDraft.dialogue !== saved.dialogue);
    if (needsRerender) {
      const selectedGpu = selected?.gpus[0];
      const nextGpu = selectedGpu && availableGpuSlots.includes(selectedGpu)
        ? selectedGpu
        : availableGpuSlots[0] ?? null;
      if (!nextGpu) {
        setFailure('Unavailable');
        return;
      }
      setRerenderGpu(nextGpu);
      setRerenderConfirmOpen(true);
      return;
    }
    applyResultEdit(false);
  };

  const resultChanged = editDraft && samplesById.get(editSampleId)
    ? JSON.stringify(editDraft) !== JSON.stringify(sampleResultEdit(samplesById.get(editSampleId)!))
    : false;
  const rerenderGpuState = snapshot.data.gpuStates.find(gpu => gpu.slot === rerenderGpu) ?? null;
  const retryGpuState = snapshot.data.gpuStates.find(gpu => gpu.slot === retryGpu) ?? null;
  const rerenderBody = rerenderGpu && selected
    ? rerenderGpuState?.loadedModel && rerenderGpuState.loadedModel !== selected.model
      ? g('jobs.rerenderSwitchBody', {
          gpu: g(`gpu.${rerenderGpu}`),
          currentModel: g(`model.${rerenderGpuState.loadedModel}`),
          nextModel: g(`model.${selected.model}`),
        })
      : g('jobs.rerenderEditBody', { gpu: g(`gpu.${rerenderGpu}`) })
    : g('jobs.rerenderUnavailable');

  return (
    <GenerationScaffold title={'jobs.title'} subtitle={'jobs.subtitle'}>
      {failure ? <OperationFeedback kind={failure} onDismiss={() => setFailure(null)} /> : null}
      <div className={`generation-layout generation-layout--jobs generation-jobs ${mobileDetail ? 'generation-layout--job-detail' : ''}`}>
        <section className="panel generation-list" aria-labelledby="jobs-list-title">
          <div className="section-header">
            <div>
              <h2 id="jobs-list-title">{g('jobs.list')}</h2>
              <p className="generation-jobs__count" aria-live="polite">
                {g('jobs.activeSummary', { running: runningCount, queued: queuedCount })}
              </p>
            </div>
            {hasFilters ? <Button variant="quiet" onClick={clearFilters}>{g('common.clearFilters')}</Button> : null}
          </div>
          <div className="generation-filters">
            <Field label={g('common.search')} htmlFor="jobs-search">
              <input
                id="jobs-search"
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder={g('jobs.searchPlaceholder')}
              />
            </Field>
            <Field label={g('jobs.statusFilter')} htmlFor="jobs-status-filter">
              <select
                id="jobs-status-filter"
                value={statusFilter}
                onChange={event => setStatusFilter(event.target.value as JobStatus | 'All')}
              >
                <option value="All">{g('common.all')}</option>
                {jobStatuses.filter(value => value !== 'All').map(value => (
                  <option key={value} value={value}>{g(`jobs.status.${value}`)}</option>
                ))}
              </select>
            </Field>
            <Field label={g('jobs.sourceFilter')} htmlFor="jobs-source-filter">
              <select
                id="jobs-source-filter"
                value={sourceFilter}
                onChange={event => setSourceFilter(event.target.value as JobSource | 'All')}
              >
                <option value="All">{g('common.all')}</option>
                {jobSources.filter(value => value !== 'All').map(value => (
                  <option key={value} value={value}>{g(`jobs.source.${value}`)}</option>
                ))}
              </select>
            </Field>
          </div>
          {snapshot.data.jobs.length === 0 || filtered.length === 0 ? (
            <div className="generation-list__empty">
              <p>{g(snapshot.data.jobs.length === 0 ? 'jobs.empty' : 'jobs.filtered')}</p>
            </div>
          ) : (
            <ul className="generation-job-list" aria-label={g('jobs.tableCaption')}>
              {filtered.map(job => (
                <li key={job.id}>
                  <button
                    type="button"
                    className={job.id === selectedId ? 'generation-job-row is-selected' : 'generation-job-row'}
                    aria-label={g('jobs.selectLabel', { id: jobName(job) })}
                    aria-controls="generation-job-detail"
                    aria-pressed={job.id === selectedId}
                    onClick={() => selectJob(job)}
                  >
                    <span className="generation-job-row__header">
                      <strong>{jobName(job)}</strong>
                      <StatusBadge label={g(`jobs.status.${job.status}`)} kind={jobStatusKind(job.status)} />
                    </span>
                    <span className="generation-job-row__meta">
                      <span>{g(`model.${job.model}`)}</span>
                      <span>{job.gpus.map(slot => g(`gpu.${slot}`)).join(', ')}</span>
                      <span>{g(`jobs.source.${job.source}`)}</span>
                    </span>
                    <span className="generation-job-row__progress">
                      <progress value={job.completedCount} max={job.quantity} aria-label={g('jobs.countProgressLabel', { completed: job.completedCount, total: job.quantity })} />
                      <span>{job.completedCount}/{job.quantity}</span>
                    </span>
                    {job.failureReason ? <span className="generation-job-row__failure">{g(`jobs.failure.${job.failureReason}`)}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {selected ? (
          <section
            id="generation-job-detail"
            className="panel generation-job-detail"
            aria-label={g('jobs.detailRegion')}
          >
            <div className="section-header generation-job-header">
              <div>
                <span className="generation-job-header__status">
                  <Button className="generation-job-back" variant="quiet" onClick={() => setMobileDetail(false)}>{g('jobs.backToList')}</Button>
                  <h2>{jobName(selected)}</h2>
                  <StatusBadge label={g(`jobs.status.${selected.status}`)} kind={jobStatusKind(selected.status)} />
                </span>
                <p>{g(`jobs.source.${selected.source}`)}, {g(`model.${selected.model}`)}, {selected.gpus.map(slot => g(`gpu.${slot}`)).join(', ')}</p>
              </div>
              <div className="generation-detail-actions">
                {isLatestSelectedAttempt && isCancellable(selected.status) ? (
                  <Button variant="secondary" onClick={() => setCancelOpen(true)}>{g('jobs.cancel')}</Button>
                ) : null}
                {isLatestSelectedAttempt && isRetryable(selected.status) ? (
                  <Button variant="secondary" onClick={openRetryDialog} disabled={availableGpuSlots.length === 0}>
                    {g('jobs.retry')}
                  </Button>
                ) : null}
                {isLatestSelectedAttempt && canKeepTestResult(selected) ? (
                  <Button variant="primary" onClick={openKeepDialog} disabled={activeDatasets.length === 0}>
                    {g('jobs.keep')}
                  </Button>
                ) : null}
              </div>
            </div>

            <section className="generation-job-progress" aria-labelledby="job-progress-title">
              <div>
                <h3 id="job-progress-title">{g('jobs.progress')}</h3>
                <strong>{selected.completedCount}/{selected.quantity}</strong>
              </div>
              <progress value={selected.completedCount} max={selected.quantity} aria-label={g('jobs.countProgressLabel', { completed: selected.completedCount, total: selected.quantity })} />
            </section>

            <dl className="generation-job-meta">
              <div><dt>{g('jobs.dataset')}</dt><dd>{selected.datasetId ? (datasetsById.get(selected.datasetId)?.name ?? selected.datasetId) : g('common.none')}</dd></div>
              <div><dt>{g('jobs.category')}</dt><dd>{categoryLabel(g, selected.category)}</dd></div>
              <div><dt>{g('batches.direction')}</dt><dd>{directionLabel(g, selected.conflictDirection)}</dd></div>
              <div><dt>{g('jobs.created')}</dt><dd>{formatDateTime(selected.createdAt)}</dd></div>
              <div><dt>{g('batches.outputProfile')}</dt><dd>{modelSpecLabel(g, selected.model)}</dd></div>
              <div><dt>{g('jobs.seed')}</dt><dd>{selected.seed ?? g('common.none')}</dd></div>
            </dl>

            <div className="generation-job-sections">
              <section className="generation-job-section" aria-labelledby="job-inputs-title">
                <h3 id="job-inputs-title">{g(selectedRunningItems.length > 0 ? 'jobs.currentInput' : 'jobs.submittedInput')}</h3>
                {selectedCurrentInputs.length > 0 ? (
                  <div className="generation-current-inputs">
                    {selectedCurrentInputs.map(({ item, allocation }) => (
                      <dl className="generation-current-input" key={item.sequence} data-current-video={item.sequence}>
                        <div><dt>{g('jobs.currentNumber')}</dt><dd>{item.sequence}/{selected.quantity}</dd></div>
                        <div><dt>{g('jobs.gpu')}</dt><dd>{item.gpuId ? g(`gpu.${item.gpuId}`) : g('jobs.notAssigned')}</dd></div>
                        <div><dt>{g('batches.content')}</dt><dd>{allocation?.contentItemName ?? selected.testInput?.contentItemName ?? g('jobs.linkUnavailable')}</dd></div>
                        <div><dt>{g('batches.preset')}</dt><dd>{allocation?.presetName ?? selected.testInput?.presetName ?? g('jobs.linkUnavailable')}</dd></div>
                        {allocation || selected.testInput ? (
                          <div><dt>{g('jobs.person')}</dt><dd>{g(`demographic.age.${allocation?.age ?? selected.testInput!.age}`)}, {g(`demographic.gender.${allocation?.gender ?? selected.testInput!.gender}`)}, {g(`demographic.ethnicity.${allocation?.ethnicity ?? selected.testInput!.ethnicity}`)}</dd></div>
                        ) : null}
                        <div><dt>{g('jobs.seed')}</dt><dd>{allocation?.seed ?? selected.testInput?.seed ?? selected.seed ?? g('common.none')}</dd></div>
                        <div><dt>{g('promptPreview.positive')}</dt><dd className="generation-current-input__prompt">{allocation?.finalPositivePrompt ?? selected.testInput?.finalPositivePrompt ?? g('jobs.linkUnavailable')}</dd></div>
                        <div><dt>{g('promptPreview.negative')}</dt><dd className="generation-current-input__prompt">{allocation?.finalNegativePrompt ?? selected.testInput?.finalNegativePrompt ?? g('jobs.linkUnavailable')}</dd></div>
                      </dl>
                    ))}
                  </div>
                ) : <p className="generation-empty-note">{g('jobs.noCurrentInput')}</p>}
              </section>

              <section className="generation-job-section" aria-labelledby="job-items-title">
                <h3 id="job-items-title">{g('jobs.items')}</h3>
                <ol className="generation-item-list">
                  {selected.items.map(item => {
                    const allocation = selected.batchInput?.allocations[item.sequence - 1];
                    return (
                    <li key={item.sequence} className={item.status === 'Running' ? 'is-current' : undefined}>
                      <strong>{item.sequence}</strong>
                      <span>{allocation?.contentItemName ?? (item.contentItemId ? contentById.get(item.contentItemId)?.name ?? g('jobs.linkUnavailable') : g('common.none'))}</span>
                      <span>{item.gpuId ? g(`gpu.${item.gpuId}`) : g('jobs.notAssigned')}</span>
                      <StatusBadge label={g(`jobs.status.${item.status}`)} kind={jobStatusKind(item.status)} />
                    </li>
                    );
                  })}
                </ol>
              </section>

              {selected.failureReason ? (
                <section className="generation-job-section generation-job-failure" aria-labelledby="job-failure-title">
                  <h3 id="job-failure-title">{g('jobs.failureTitle')}</h3>
                  <p>{g(`jobs.failure.${selected.failureReason}`)}</p>
                </section>
              ) : null}

              <section className="generation-job-section" aria-labelledby="job-steps-title">
                <h3 id="job-steps-title">{g('jobs.steps')}</h3>
                <ul className="generation-step-list">
                  {selected.steps.map(step => (
                    <li key={step.id}>
                      <span>{step.order}. {g(`jobs.step.${step.name}`)}</span>
                      <StatusBadge label={g(`jobs.stepStatus.${step.status}`)} kind={jobStatusKind(step.status)} />
                    </li>
                  ))}
                </ul>
              </section>

              <section className="generation-job-section" aria-labelledby="job-logs-title">
                <h3 id="job-logs-title">{g('jobs.logs')}</h3>
                {selected.logs.length === 0 ? (
                  <p className="generation-empty-note">{g('jobs.noLogs')}</p>
                ) : (
                  <ul className="generation-log-list">
                    {selected.logs.map(log => (
                      <li key={`${log.stepId}-${log.sequence}`}>
                        <span>{g(log.messageKey as Parameters<typeof g>[0])}</span>
                        <time dateTime={log.occurredAt}>{formatDateTime(log.occurredAt)}</time>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="generation-job-section" aria-labelledby="job-results-title">
                <h3 id="job-results-title">{g('jobs.results')}</h3>
                {selected.resultSampleIds.length === 0 ? (
                  <p className="generation-empty-note">{g('jobs.noResults')}</p>
                ) : (
                  <ul className="generation-result-list">
                    {selected.resultSampleIds.map((sampleId, index) => {
                      const sample = samplesById.get(sampleId);
                      const datasetName = sample ? (datasetsById.get(sample.datasetId)?.name ?? sample.datasetId) : g('common.none');
                      const isCurrentAttempt = index === selected.resultSampleIds.length - 1;
                      return (
                        <li key={sampleId}>
                          {sample ? (
                            <video controls preload="metadata" aria-label={g('jobs.resultMediaLabel', { id: sample.displayId })}>
                              <source src={sample.primaryAssetUrl} type="video/webm" />
                              {g('test.videoUnsupported')}
                            </video>
                          ) : null}
                          <div className="generation-result-meta">
                            <strong>{g('jobs.attempt', { number: index + 1 })}: {sample?.displayId ?? sampleId}</strong>
                            <span>{datasetName}</span>
                          </div>
                          <div className="generation-result-actions">
                            {isCurrentAttempt ? <StatusBadge label={g('jobs.currentAttempt')} kind="active" /> : null}
                            {isLatestSelectedAttempt && isCurrentAttempt && sample && sample.reviewDecision !== 'Rejected' && selected.status === 'Completed' ? (
                              <Button variant="quiet" onClick={() => openResultEditor(sample)}>{g('jobs.editResult')}</Button>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <details className="generation-attempts">
                  <summary>{g('jobs.attemptHistory')}</summary>
                  <ol className="generation-attempt-list">
                    {attemptHistory.map((attempt, index) => {
                      const latest = index === attemptHistory.length - 1;
                      return (
                        <li key={attempt.id}>
                          <div>
                            <strong>{g('jobs.attempt', { number: index + 1 })}</strong>
                            <span>{formatDateTime(attempt.createdAt)}</span>
                          </div>
                          <StatusBadge label={g(`jobs.status.${attempt.status}`)} kind={jobStatusKind(attempt.status)} />
                          {latest ? <StatusBadge label={g('jobs.latestAttempt')} kind="active" /> : null}
                          {attempt.id !== selected.id ? (
                            <Button variant="quiet" onClick={() => selectJob(attempt)}>
                              {g('jobs.openAttempt', { number: index + 1 })}
                            </Button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ol>
                </details>
              </section>
            </div>
          </section>
        ) : null}
      </div>

      <ConfirmDialog
        open={cancelOpen}
        title={g('jobs.cancelTitle')}
        body={g('jobs.cancelBody')}
        confirmLabel={g('jobs.cancel')}
        cancelLabel={g('common.cancel')}
        closeLabel={g('common.close')}
        onConfirm={cancelJob}
        onClose={() => setCancelOpen(false)}
      />

      <Dialog
        open={retryOpen}
        title={g('jobs.retryTitle')}
        closeLabel={g('common.close')}
        onClose={() => setRetryOpen(false)}
        footer={
          <>
            <Button onClick={() => setRetryOpen(false)}>{g('common.cancel')}</Button>
            <Button variant="primary" onClick={retryJob} disabled={retryGpu === ''}>
              {g('jobs.retry')}
            </Button>
          </>
        }
      >
        <div className="generation-dialog-form">
          <p>{g('jobs.retryBody')}</p>
          {selected && retryGpuState?.loadedModel && retryGpuState.loadedModel !== selected.model ? (
            <p>{g('test.initialModelSwitch', {
              gpu: g(`gpu.${retryGpuState.slot}`),
              currentModel: g(`model.${retryGpuState.loadedModel}`),
              nextModel: g(`model.${selected.model}`),
            })}</p>
          ) : null}
          <Field label={g('jobs.retryGpu')} htmlFor="job-retry-gpu" required>
            <select id="job-retry-gpu" value={retryGpu} onChange={event => setRetryGpu(event.target.value as GpuSlot | '')}>
              {availableGpuSlots.length === 0 ? <option value="">{g('feedback.errorTitle')}</option> : null}
              {availableGpuSlots.map(slot => <option key={slot} value={slot}>{g(`gpu.${slot}`)}</option>)}
            </select>
          </Field>
          <Field label={g('jobs.retrySeed')} htmlFor="job-retry-seed">
            <input id="job-retry-seed" inputMode="numeric" value={retrySeed} onChange={event => setRetrySeed(event.target.value)} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={editDraft !== null}
        title={g('jobs.editResultTitle')}
        closeLabel={g('common.close')}
        onClose={closeResultEditor}
        size="wide"
        footer={
          <>
            <Button onClick={closeResultEditor}>{g('common.cancel')}</Button>
            <Button variant="primary" onClick={requestResultSave} disabled={!resultChanged}>{g('common.save')}</Button>
          </>
        }
      >
        {editDraft ? (
          <div className="generation-dialog-form generation-result-editor">
            {samplesById.get(editSampleId)?.category.endsWith('-VA') ? (
              <Field label={g('test.dialogue')} htmlFor="job-result-dialogue">
                <textarea id="job-result-dialogue" value={editDraft.dialogue} onChange={event => setEditDraft(current => current ? { ...current, dialogue: event.target.value } : current)} />
              </Field>
            ) : (
              <Field label={g('test.displayText')} htmlFor="job-result-display-text">
                <textarea id="job-result-display-text" value={editDraft.displayText} onChange={event => setEditDraft(current => current ? { ...current, displayText: event.target.value } : current)} />
              </Field>
            )}
            <Field label={g('test.videoPrompt')} htmlFor="job-result-video-prompt">
              <textarea id="job-result-video-prompt" value={editDraft.videoPrompt} onChange={event => setEditDraft(current => current ? { ...current, videoPrompt: event.target.value } : current)} />
            </Field>
            <Field label={g('test.explanation')} htmlFor="job-result-explanation">
              <textarea id="job-result-explanation" value={editDraft.explanation} onChange={event => setEditDraft(current => current ? { ...current, explanation: event.target.value } : current)} />
            </Field>
            <Field label={g('jobs.note')} htmlFor="job-result-note">
              <textarea id="job-result-note" value={editDraft.note} onChange={event => setEditDraft(current => current ? { ...current, note: event.target.value } : current)} />
            </Field>
            <p className="generation-empty-note">{g('jobs.resultEditHint')}</p>
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={rerenderConfirmOpen}
        title={g('jobs.rerenderEditTitle')}
        body={rerenderBody}
        confirmLabel={g('jobs.applyRerenderEdit')}
        cancelLabel={g('common.cancel')}
        closeLabel={g('common.close')}
        onConfirm={() => applyResultEdit(true)}
        onClose={() => setRerenderConfirmOpen(false)}
      />

      <Dialog
        open={keepOpen}
        title={g('jobs.keepTitle')}
        closeLabel={g('common.close')}
        onClose={() => setKeepOpen(false)}
        footer={
          <>
            <Button onClick={() => setKeepOpen(false)}>{g('common.cancel')}</Button>
            <Button variant="primary" onClick={keepResult} disabled={keepDatasetId === ''}>
              {g('jobs.keep')}
            </Button>
          </>
        }
      >
        <div className="generation-dialog-form">
          <p>{g('jobs.keepBody')}</p>
          <Field label={g('jobs.keepDataset')} htmlFor="job-keep-dataset" required>
            <select id="job-keep-dataset" value={keepDatasetId} onChange={event => setKeepDatasetId(event.target.value)}>
              {activeDatasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
            </select>
          </Field>
        </div>
      </Dialog>
    </GenerationScaffold>
  );
}
