import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, ConfirmDialog, Field, StatusBadge } from '../../components';
import {
  useCancelJobMutation,
  useDatasetsQuery,
  useGpuSlotsQuery,
  useJobEventsQuery,
  useJobItemsQuery,
  useJobQuery,
  useJobsQuery,
  useKeepTestResultMutation,
} from '../../api/queries';
import { useJobEventReplay } from '../../api/jobEvents';
import type { JobItem, JobStatus } from '../../api/contracts';
import { formatDateTime } from '../../time';
import {
  categoryLabel,
  directionLabel,
  GenerationScaffold,
  jobStatusKind,
  OperationFeedback,
  useGenerationCopy,
} from './shared';

const statuses: JobStatus[] = ['Queued', 'Running', 'Completed', 'Failed', 'Cancelled'];
const terminalStatuses: JobStatus[] = ['Completed', 'Failed', 'Cancelled'];

function progress(completed: number, failed: number, total: number): number {
  return total <= 0 ? 0 : Math.min(100, Math.round(((completed + failed) / total) * 100));
}

function jobProgress(job: { status: JobStatus; preparedCount: number; completedCount: number; failedCount: number; totalCount: number }) {
  return job.status === 'Running' && job.preparedCount < job.totalCount
    ? { stage: 'prompt' as const, value: job.preparedCount }
    : { stage: 'render' as const, value: job.completedCount + job.failedCount };
}

export function JobsPage() {
  const g = useGenerationCopy();
  const [params, setParams] = useSearchParams();
  const jobsQuery = useJobsQuery();
  const gpuQuery = useGpuSlotsQuery();
  const datasetsQuery = useDatasetsQuery();
  const requestedId = Number(params.get('job'));
  const [selectedId, setSelectedId] = useState<number | null>(Number.isInteger(requestedId) && requestedId > 0 ? requestedId : null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<JobStatus | 'All'>(() => statuses.includes(params.get('status') as JobStatus) ? params.get('status') as JobStatus : 'All');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [keepTarget, setKeepTarget] = useState<JobItem | null>(null);
  const [keepDatasetId, setKeepDatasetId] = useState<number | null>(null);
  const jobQuery = useJobQuery(selectedId);
  const itemsQuery = useJobItemsQuery(selectedId);
  const eventsQuery = useJobEventsQuery(selectedId);
  const cancelMutation = useCancelJobMutation();
  const keepMutation = useKeepTestResultMutation();
  const jobs = jobsQuery.data ?? [];
  const selectedSummary = jobs.find(item => item.id === selectedId) ?? null;
  const selected = jobQuery.data ?? selectedSummary;
  const events = eventsQuery.data ?? jobQuery.data?.events ?? [];
  const replay = useJobEventReplay(
    selectedId,
    selected ? terminalStatuses.includes(selected.status) : true,
    events,
  );

  useEffect(() => {
    if (jobs.length === 0) return;
    if (!jobs.some(item => item.id === selectedId)) setSelectedId(jobs[0].id);
  }, [jobs, selectedId]);

  const filtered = useMemo(() => {
    const value = search.trim().toLocaleLowerCase();
    return jobs.filter(job =>
      (status === 'All' || job.status === status)
      && (value === '' || `${job.displayName} ${job.model ?? job.source}`.toLocaleLowerCase().includes(value)),
    );
  }, [jobs, search, status]);

  const choose = (id: number) => {
    setSelectedId(id);
    const next = new URLSearchParams(params);
    next.set('job', String(id));
    setParams(next, { replace: true });
  };

  const cancel = async () => {
    if (!selected) return;
    try {
      await cancelMutation.mutateAsync({ id: selected.id, expectedRevision: selected.revision });
      setCancelOpen(false);
    } catch {
      setCancelOpen(false);
    }
  };

  const productionDatasets = (datasetsQuery.data ?? []).filter(dataset => dataset.status === 'Active' && dataset.purpose === 'Production');
  const openKeep = (item: JobItem) => {
    setKeepTarget(item);
    setKeepDatasetId(productionDatasets[0]?.id ?? null);
  };
  const keep = async () => {
    if (!keepTarget || keepDatasetId === null) return;
    try {
      await keepMutation.mutateAsync({
        itemId: keepTarget.id,
        input: { datasetId: keepDatasetId, expectedRevision: keepTarget.revision },
      });
      setKeepTarget(null);
    } catch {
      setKeepTarget(null);
    }
  };

  if (jobsQuery.isPending) return <GenerationScaffold title="jobs.title" subtitle="jobs.subtitle"><p role="status">{g('state.loadingBody')}</p></GenerationScaffold>;
  if (jobsQuery.isError) return <GenerationScaffold title="jobs.title" subtitle="jobs.subtitle"><OperationFeedback error={jobsQuery.error} onDismiss={() => void jobsQuery.refetch()} /></GenerationScaffold>;

  const detailError = jobQuery.error ?? itemsQuery.error ?? eventsQuery.error ?? gpuQuery.error ?? datasetsQuery.error ?? cancelMutation.error ?? keepMutation.error ?? null;
  const items = itemsQuery.data ?? jobQuery.data?.items ?? [];
  return (
    <GenerationScaffold title="jobs.title" subtitle="jobs.subtitle">
      {detailError ? <OperationFeedback error={detailError} onDismiss={() => { cancelMutation.reset(); keepMutation.reset(); void Promise.all([jobQuery.refetch(), itemsQuery.refetch(), eventsQuery.refetch(), gpuQuery.refetch(), datasetsQuery.refetch()]); }} /> : null}
      {replay.disconnected ? <section className="generation-feedback" role="alert"><div><h2>{g('jobs.streamDisconnectedTitle')}</h2><p>{g('jobs.streamDisconnectedBody')}</p></div><Button variant="secondary" onClick={replay.reconnect}>{g('jobs.reconnect')}</Button></section> : null}
      <div className="generation-layout generation-layout--jobs generation-jobs">
        <section className="panel generation-list" aria-labelledby="jobs-list-title">
          <div className="section-header"><h2 id="jobs-list-title">{g('jobs.list')}</h2><span aria-live="polite">{g('jobs.count', { count: filtered.length })}</span></div>
          <div className="generation-filters">
            <Field label={g('jobs.searchLabel')} htmlFor="job-search"><input id="job-search" type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
            <Field label={g('jobs.statusFilter')} htmlFor="job-status"><select id="job-status" value={status} onChange={event => setStatus(event.target.value as JobStatus | 'All')}><option value="All">{g('common.all')}</option>{statuses.map(value => <option key={value} value={value}>{g(`jobs.status.${value}`)}</option>)}</select></Field>
          </div>
          {filtered.length === 0 ? <p className="generation-empty-note">{g(jobs.length === 0 ? 'jobs.empty' : 'jobs.filtered')}</p> : <ul className="generation-job-list" aria-label={g('jobs.tableCaption')}>{filtered.map(job => { const current = jobProgress(job); return <li key={job.id}><button type="button" className={job.id === selectedId ? 'generation-job-row is-selected' : 'generation-job-row'} aria-pressed={job.id === selectedId} onClick={() => choose(job.id)}><span className="generation-job-row__header"><strong>{job.displayName}</strong><StatusBadge label={g(`jobs.status.${job.status}`)} kind={jobStatusKind(job.status)} /></span><span className="generation-job-row__meta">{categoryLabel(g, job.category)} / {job.model ?? g('jobs.source.Test')}{job.precision ? ` ${job.precision}` : ''}</span><span className="generation-job-row__progress">{g(`jobs.stage.${current.stage}`)} {current.value}/{job.totalCount} / {progress(current.value, 0, job.totalCount)}%</span></button></li>; })}</ul>}
        </section>
        <section className="panel generation-job-detail" aria-label={g('jobs.detailRegion')}>
          {!selected ? <p className="generation-empty-note">{g('jobs.empty')}</p> : <>
            <div className="section-header generation-job-header"><div><h2>{selected.displayName}</h2><StatusBadge label={g(`jobs.status.${selected.status}`)} kind={jobStatusKind(selected.status)} /></div>{selected.status === 'Queued' || selected.status === 'Running' ? <Button className="button--danger" onClick={() => setCancelOpen(true)}>{g('jobs.cancel')}</Button> : null}</div>
            {(() => { const current = jobProgress(selected); return <section className="generation-job-progress" aria-labelledby="job-progress-title"><h3 id="job-progress-title">{g('jobs.progress')}</h3><p>{g(`jobs.stage.${current.stage}`)}</p><progress value={current.value} max={selected.totalCount} aria-label={g('jobs.countProgressLabel', { completed: current.value, total: selected.totalCount })} /><p>{current.value}/{selected.totalCount}</p></section>; })()}
            <dl className="generation-job-meta"><div><dt>{g('jobs.category')}</dt><dd>{categoryLabel(g, selected.category)}</dd></div><div><dt>{g('jobs.direction')}</dt><dd>{directionLabel(g, selected.conflictDirection)}</dd></div><div><dt>{g('jobs.model')}</dt><dd>{selected.model ?? g('jobs.source.Test')}</dd></div>{selected.precision ? <div><dt>{g('jobs.precision')}</dt><dd>{selected.precision}</dd></div> : null}<div><dt>{g('jobs.created')}</dt><dd><time dateTime={selected.createdAt}>{formatDateTime(selected.createdAt)}</time></dd></div></dl>
            {selected.failureReason ? <section className="generation-job-failure" role="alert"><h3>{g('jobs.failureTitle')}</h3><p>{selected.failureReason}</p></section> : null}
            <section className="generation-job-section" aria-labelledby="job-gpu-title"><h3 id="job-gpu-title">{g('jobs.gpu')}</h3><ul>{(gpuQuery.data ?? []).map(gpu => <li key={gpu.slot}>{gpu.slot}: {g(`gpu.${gpu.availability}`)}{gpu.activeJobId === selected.id ? ` / ${g('jobs.currentJobGpu')}` : ''}</li>)}</ul></section>
            <section className="generation-job-section" aria-labelledby="job-items-title"><h3 id="job-items-title">{g('jobs.items')}</h3>{items.length === 0 ? <p>{g('jobs.noCurrentInput')}</p> : <div className="generation-result-cards">{items.map(item => <article className="generation-result-card" key={item.id}><div className="generation-result-card__header"><div><h3>{item.sequence}/{selected.totalCount}</h3><p>{item.input.model}{item.input.precision ? ` ${item.input.precision}` : ''} / {item.gpuSlot}</p></div><StatusBadge label={g(`jobs.status.${item.status}`)} kind={jobStatusKind(item.status)} /></div><div className="generation-result-card__asset">{item.primaryAssetUrl ? <video controls muted={item.input.deriveSilentPrimary} src={item.primaryAssetUrl}>{g('test.videoUnsupported')}</video> : <span>{g('test.mediaPlaceholder')}</span>}</div>{item.sourceAssetUrl ? <a href={item.sourceAssetUrl}>{g('jobs.audio')}</a> : null}<dl className="generation-current-input"><div><dt>{g('jobs.person')}</dt><dd>{g(`demographic.age.${item.input.age}`)} / {g(`demographic.gender.${item.input.gender}`)} / {g(`demographic.ethnicity.${item.input.ethnicity}`)}</dd></div><div><dt>{g('jobs.seed')}</dt><dd>{item.input.seed}</dd></div>{item.failureReason ? <div><dt>{g('jobs.failureTitle')}</dt><dd>{item.failureReason}</dd></div> : null}<div><dt>{g('promptPreview.positive')}</dt><dd><pre>{item.promptResult?.finalPositivePrompt ?? item.input.fixedPositivePrompt ?? item.input.userInput}</pre></dd></div><div><dt>{g('promptPreview.negative')}</dt><dd><pre>{item.promptResult?.finalNegativePrompt ?? item.input.finalNegativePrompt}</pre></dd></div></dl><details className="generation-attempts"><summary>{g('jobs.attemptHistory')}</summary>{item.attempts.length === 0 ? <p>{g('jobs.noResults')}</p> : <ol className="generation-attempt-list">{item.attempts.map(attempt => <li key={attempt.id}><div><strong>{g('jobs.attempt', { number: attempt.attemptNumber })}</strong><span>{attempt.model}{attempt.precision ? ` ${attempt.precision}` : ''} / {attempt.gpuSlot} / {g(`jobs.status.${attempt.status}`)}</span>{attempt.failureReason ? <span>{attempt.failureReason}</span> : null}</div><div>{attempt.primaryAssetUrl ? <a href={attempt.primaryAssetUrl}>{g('jobs.openAttempt', { number: attempt.attemptNumber })}</a> : null}{attempt.sourceAssetUrl ? <a href={attempt.sourceAssetUrl}>{g('jobs.audio')}</a> : null}</div></li>)}</ol>}</details>{selected.source === 'Test' && item.status === 'Completed' && item.primaryAssetId !== null ? <div className="generation-result-card__actions"><Button variant="primary" disabled={item.sampleId !== null || productionDatasets.length === 0} onClick={() => openKeep(item)}>{item.sampleId === null ? g('jobs.keep') : g('jobs.kept')}</Button></div> : null}</article>)}</div>}</section>
            <section className="generation-job-section" aria-labelledby="job-events-title"><h3 id="job-events-title">{g('jobs.events')}</h3>{events.length === 0 ? <p>{g('jobs.noLogs')}</p> : <ol className="generation-log-list">{events.map(event => <li key={event.id}><span>{g(`jobs.event.${event.eventType}`)}</span><time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time></li>)}</ol>}</section>
          </>}
        </section>
      </div>
      <ConfirmDialog open={cancelOpen} title={g('jobs.cancelTitle')} body={g('jobs.cancelBody')} confirmLabel={g('jobs.cancel')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => void cancel()} onClose={() => setCancelOpen(false)} />
      <ConfirmDialog open={keepTarget !== null} title={g('jobs.keepTitle')} body={<><p>{g('jobs.keepBody')}</p><Field label={g('jobs.keepDataset')} htmlFor="keep-result-dataset"><select id="keep-result-dataset" value={keepDatasetId ?? ''} onChange={event => setKeepDatasetId(Number(event.target.value))}>{productionDatasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></Field></>} confirmLabel={g('jobs.keep')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => void keep()} onClose={() => setKeepTarget(null)} />
    </GenerationScaffold>
  );
}
