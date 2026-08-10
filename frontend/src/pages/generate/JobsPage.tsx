import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, ConfirmDialog, Dialog, Field, StatusBadge, TableShell, useToast } from '../../components';
import { useMockRepository, useRepositorySnapshot } from '../../store';
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

function isKeepable(job: Job) {
  return job.status === 'Completed' && job.source === 'Test' && job.resultSampleIds.length === 0;
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
        job.gpu,
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
  };

  const revealJob = (job: Job) => {
    setSearch('');
    setStatusFilter('All');
    setSourceFilter('All');
    setSelectedId(job.id);
    setSearchParams({ job: job.id }, { replace: true });
  };

  const openRetryDialog = () => {
    if (!selected) return;
    setRetryGpu(availableGpuSlots.includes(selected.gpu) ? selected.gpu : (availableGpuSlots[0] ?? ''));
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
    if (!selected || !isKeepable(selected) || keepDatasetId === '') return;
    const result = repository.keepJobResult(selected.id, keepDatasetId, selected.revision);
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
      const nextGpu = availableGpuSlots.includes(selected?.gpu as GpuSlot)
        ? selected!.gpu
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
      <div className="generation-layout generation-layout--editor generation-jobs">
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
            <div className="generation-jobs__table">
              <TableShell
                caption={g('jobs.tableCaption')}
                columns={[
                  { key: 'job', label: g('jobs.id') },
                  { key: 'source', label: g('jobs.source') },
                  { key: 'model', label: g('jobs.model') },
                  { key: 'gpu', label: g('jobs.gpu') },
                  { key: 'status', label: g('jobs.status') },
                  { key: 'progress', label: g('jobs.progress') },
                ]}
              >
                {filtered.map(job => (
                  <tr key={job.id} className={job.id === selectedId ? 'is-selected' : undefined}>
                    <th scope="row">
                      <button
                        type="button"
                        className="table-link"
                        aria-label={g('jobs.selectLabel', { id: job.id })}
                        aria-controls="generation-job-detail"
                        aria-pressed={job.id === selectedId}
                        onClick={() => selectJob(job)}
                      >
                        {job.id}
                      </button>
                    </th>
                    <td>{g(`jobs.source.${job.source}`)}</td>
                    <td>{g(`model.${job.model}`)}</td>
                    <td>{g(`gpu.${job.gpu}`)}</td>
                    <td>
                      <StatusBadge label={g(`jobs.status.${job.status}`)} kind={jobStatusKind(job.status)} />
                    </td>
                    <td>
                      <div className="generation-progress">
                        <progress value={job.progress} max={100} aria-label={g('jobs.progressLabel', { progress: job.progress })} />
                        <span>{job.progress}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </TableShell>
            </div>
          )}
        </section>

        {selected ? (
          <section
            id="generation-job-detail"
            className="panel generation-job-detail generation-editor"
            aria-label={g('jobs.detailRegion')}
          >
            <div className="section-header">
              <h2>{g('jobs.details')}</h2>
              <div className="generation-detail-actions">
                {isLatestSelectedAttempt && isCancellable(selected.status) ? (
                  <Button variant="secondary" onClick={() => setCancelOpen(true)}>{g('jobs.cancel')}</Button>
                ) : null}
                {isLatestSelectedAttempt && isRetryable(selected.status) ? (
                  <Button variant="secondary" onClick={openRetryDialog} disabled={availableGpuSlots.length === 0}>
                    {g('jobs.retry')}
                  </Button>
                ) : null}
                {isLatestSelectedAttempt && isKeepable(selected) ? (
                  <Button variant="primary" onClick={openKeepDialog} disabled={activeDatasets.length === 0}>
                    {g('jobs.keep')}
                  </Button>
                ) : null}
              </div>
            </div>

            <dl className="generation-job-summary">
              <div>
                <dt>{g('jobs.status')}</dt>
                <dd><StatusBadge label={g(`jobs.status.${selected.status}`)} kind={jobStatusKind(selected.status)} /></dd>
              </div>
              <div>
                <dt>{g('jobs.source')}</dt>
                <dd>{g(`jobs.source.${selected.source}`)}</dd>
              </div>
              <div>
                <dt>{g('jobs.category')}</dt>
                <dd>{categoryLabel(g, selected.category)}</dd>
              </div>
              <div>
                <dt>{g('batches.direction')}</dt>
                <dd>{directionLabel(g, selected.conflictDirection)}</dd>
              </div>
              <div>
                <dt>{g('jobs.model')}</dt>
                <dd>{g(`model.${selected.model}`)}</dd>
              </div>
              <div>
                <dt>{g('jobs.gpu')}</dt>
                <dd>{g(`gpu.${selected.gpu}`)}</dd>
              </div>
              <div>
                <dt>{g('jobs.dataset')}</dt>
                <dd>{selected.datasetId ? (datasetsById.get(selected.datasetId)?.name ?? selected.datasetId) : g('common.none')}</dd>
              </div>
              <div>
                <dt>{g('jobs.seed')}</dt>
                <dd>{selected.seed ?? g('common.none')}</dd>
              </div>
              <div>
                <dt>{g('jobs.quantity')}</dt>
                <dd>{selected.quantity}</dd>
              </div>
              <div>
                <dt>{g('batches.outputProfile')}</dt>
                <dd>{modelSpecLabel(g, selected.model)}</dd>
              </div>
              <div>
                <dt>{g('jobs.created')}</dt>
                <dd>{new Date(selected.createdAt).toLocaleString(locale)}</dd>
              </div>
              <div>
                <dt>{g('common.updated')}</dt>
                <dd>{new Date(selected.updatedAt).toLocaleString(locale)}</dd>
              </div>
              <div>
                <dt>{g('jobs.progress')}</dt>
                <dd>
                  <div className="generation-progress">
                    <progress value={selected.progress} max={100} aria-label={g('jobs.progressLabel', { progress: selected.progress })} />
                    <span>{selected.progress}%</span>
                  </div>
                </dd>
              </div>
            </dl>

            <div className="generation-job-sections">
              <section className="generation-job-section generation-job-section--wide" aria-labelledby="job-inputs-title">
                <h3 id="job-inputs-title">{g('jobs.inputs')}</h3>
                {selected.batchInput ? (
                  <div className="generation-job-inputs">
                    <dl>
                      <div><dt>{g('batches.preset')}</dt><dd>{presetsById.get(selected.batchInput.draft.presetId)?.name ?? `${g('jobs.linkUnavailable')} (${selected.batchInput.draft.presetId})`}</dd></div>
                      <div><dt>{g('batches.content')}</dt><dd>{selected.batchInput.draft.contentItemIds.map(id => contentById.get(id)?.name ?? `${g('jobs.linkUnavailable')} (${id})`).join(', ')}</dd></div>
                    </dl>
                    <ol className="generation-allocation-list">
                      {selected.batchInput.allocations.map(row => (
                        <li key={row.sequence}>
                          <strong>{g('batches.sequence')} {row.sequence}</strong>
                          <span>{row.contentItemName}</span>
                          <span>{g(`demographic.age.${row.age}`)} · {g(`demographic.gender.${row.gender}`)} · {g(`demographic.ethnicity.${row.ethnicity}`)}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : selected.testInput ? (
                  <dl className="generation-job-inputs">
                    <div><dt>{g('test.content')}</dt><dd>{contentById.get(selected.testInput.contentItemId)?.name ?? `${g('jobs.linkUnavailable')} (${selected.testInput.contentItemId})`}</dd></div>
                    <div><dt>{g('test.preset')}</dt><dd>{presetsById.get(selected.testInput.presetId)?.name ?? `${g('jobs.linkUnavailable')} (${selected.testInput.presetId})`}</dd></div>
                    <div><dt>{g('test.age')}</dt><dd>{g(`demographic.age.${selected.testInput.age}`)}</dd></div>
                    <div><dt>{g('test.gender')}</dt><dd>{g(`demographic.gender.${selected.testInput.gender}`)}</dd></div>
                    <div><dt>{g('test.ethnicity')}</dt><dd>{g(`demographic.ethnicity.${selected.testInput.ethnicity}`)}</dd></div>
                  </dl>
                ) : <p className="generation-empty-note">{g('jobs.noInputs')}</p>}
              </section>

              <section className="generation-job-section" aria-labelledby="job-attempts-title">
                <h3 id="job-attempts-title">{g('jobs.attemptHistory')}</h3>
                <ol className="generation-attempt-list">
                  {attemptHistory.map((attempt, index) => {
                    const latest = index === attemptHistory.length - 1;
                    return (
                      <li key={attempt.id}>
                        <div>
                          <strong>{g('jobs.attempt', { number: index + 1 })}</strong>
                          <span>{new Date(attempt.createdAt).toLocaleString(locale)}</span>
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
              </section>

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
                        <time dateTime={log.occurredAt}>{new Date(log.occurredAt).toLocaleString(locale)}</time>
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
                              <source src={sample.primaryAssetId} type="video/mp4" />
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
