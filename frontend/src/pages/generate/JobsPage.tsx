import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, ConfirmDialog, Field, StatusBadge } from '../../components';
import {
  useCancelJobMutation,
  useGpuSlotsQuery,
  useJobEventsQuery,
  useJobItemsQuery,
  useJobQuery,
  useJobsQuery,
} from '../../api/queries';
import { useJobEventReplay } from '../../api/jobEvents';
import type { JobStatus } from '../../api/contracts';
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
  const requestedId = Number(params.get('job'));
  const [selectedId, setSelectedId] = useState<number | null>(Number.isInteger(requestedId) && requestedId > 0 ? requestedId : null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<JobStatus | 'All'>(() => statuses.includes(params.get('status') as JobStatus) ? params.get('status') as JobStatus : 'All');
  const [cancelOpen, setCancelOpen] = useState(false);
  const jobQuery = useJobQuery(selectedId);
  const itemsQuery = useJobItemsQuery(selectedId);
  const eventsQuery = useJobEventsQuery(selectedId);
  const cancelMutation = useCancelJobMutation();
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
      && (value === '' || `${job.displayName} ${job.model}`.toLocaleLowerCase().includes(value)),
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

  if (jobsQuery.isPending) return <GenerationScaffold title="jobs.title" subtitle="jobs.subtitle"><p role="status">{g('state.loadingBody')}</p></GenerationScaffold>;
  if (jobsQuery.isError) return <GenerationScaffold title="jobs.title" subtitle="jobs.subtitle"><OperationFeedback error={jobsQuery.error} onDismiss={() => void jobsQuery.refetch()} /></GenerationScaffold>;

  const detailError = jobQuery.error ?? itemsQuery.error ?? eventsQuery.error ?? gpuQuery.error ?? cancelMutation.error ?? null;
  const items = itemsQuery.data ?? jobQuery.data?.items ?? [];
  return (
    <GenerationScaffold title="jobs.title" subtitle="jobs.subtitle">
      {detailError ? <OperationFeedback error={detailError} onDismiss={() => { cancelMutation.reset(); void Promise.all([jobQuery.refetch(), itemsQuery.refetch(), eventsQuery.refetch(), gpuQuery.refetch()]); }} /> : null}
      {replay.disconnected ? <section className="generation-feedback" role="alert"><div><h2>{g('jobs.streamDisconnectedTitle')}</h2><p>{g('jobs.streamDisconnectedBody')}</p></div><Button variant="secondary" onClick={replay.reconnect}>{g('jobs.reconnect')}</Button></section> : null}
      <div className="generation-layout generation-layout--jobs generation-jobs">
        <section className="panel generation-list" aria-labelledby="jobs-list-title">
          <div className="section-header"><h2 id="jobs-list-title">{g('jobs.list')}</h2><span aria-live="polite">{g('jobs.count', { count: filtered.length })}</span></div>
          <div className="generation-filters">
            <Field label={g('jobs.searchLabel')} htmlFor="job-search"><input id="job-search" type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
            <Field label={g('jobs.statusFilter')} htmlFor="job-status"><select id="job-status" value={status} onChange={event => setStatus(event.target.value as JobStatus | 'All')}><option value="All">{g('common.all')}</option>{statuses.map(value => <option key={value} value={value}>{g(`jobs.status.${value}`)}</option>)}</select></Field>
          </div>
          {filtered.length === 0 ? <p className="generation-empty-note">{g(jobs.length === 0 ? 'jobs.empty' : 'jobs.filtered')}</p> : <ul className="generation-job-list" aria-label={g('jobs.tableCaption')}>{filtered.map(job => { const current = jobProgress(job); return <li key={job.id}><button type="button" className={job.id === selectedId ? 'generation-job-row is-selected' : 'generation-job-row'} aria-pressed={job.id === selectedId} onClick={() => choose(job.id)}><span className="generation-job-row__header"><strong>{job.displayName}</strong><StatusBadge label={g(`jobs.status.${job.status}`)} kind={jobStatusKind(job.status)} /></span><span className="generation-job-row__meta">{categoryLabel(g, job.category)} / {job.model}</span><span className="generation-job-row__progress">{g(`jobs.stage.${current.stage}`)} {current.value}/{job.totalCount} / {progress(current.value, 0, job.totalCount)}%</span></button></li>; })}</ul>}
        </section>
        <section className="panel generation-job-detail" aria-label={g('jobs.detailRegion')}>
          {!selected ? <p className="generation-empty-note">{g('jobs.empty')}</p> : <>
            <div className="section-header generation-job-header"><div><h2>{selected.displayName}</h2><StatusBadge label={g(`jobs.status.${selected.status}`)} kind={jobStatusKind(selected.status)} /></div>{selected.status === 'Queued' || selected.status === 'Running' ? <Button className="button--danger" onClick={() => setCancelOpen(true)}>{g('jobs.cancel')}</Button> : null}</div>
            {(() => { const current = jobProgress(selected); return <section className="generation-job-progress" aria-labelledby="job-progress-title"><h3 id="job-progress-title">{g('jobs.progress')}</h3><p>{g(`jobs.stage.${current.stage}`)}</p><progress value={current.value} max={selected.totalCount} aria-label={g('jobs.countProgressLabel', { completed: current.value, total: selected.totalCount })} /><p>{current.value}/{selected.totalCount}</p></section>; })()}
            <dl className="generation-job-meta"><div><dt>{g('jobs.category')}</dt><dd>{categoryLabel(g, selected.category)}</dd></div><div><dt>{g('jobs.direction')}</dt><dd>{directionLabel(g, selected.conflictDirection)}</dd></div><div><dt>{g('jobs.model')}</dt><dd>{selected.model}</dd></div><div><dt>{g('jobs.created')}</dt><dd><time dateTime={selected.createdAt}>{formatDateTime(selected.createdAt)}</time></dd></div></dl>
            {selected.failureReason ? <section className="generation-job-failure" role="alert"><h3>{g('jobs.failureTitle')}</h3><p>{selected.failureReason}</p></section> : null}
            <section className="generation-job-section" aria-labelledby="job-gpu-title"><h3 id="job-gpu-title">{g('jobs.gpu')}</h3><ul>{(gpuQuery.data ?? []).map(gpu => <li key={gpu.slot}>{gpu.slot}: {g(`gpu.${gpu.availability}`)}{gpu.activeJobId === selected.id ? ` / ${g('jobs.currentJobGpu')}` : ''}</li>)}</ul></section>
            <section className="generation-job-section" aria-labelledby="job-items-title"><h3 id="job-items-title">{g('jobs.items')}</h3>{items.length === 0 ? <p>{g('jobs.noCurrentInput')}</p> : <ol className="generation-item-list">{items.map(item => <li key={item.id}><details><summary>{item.sequence}/{selected.totalCount} / {g(`jobs.stage.${item.stage}`)} / {g(`jobs.status.${item.status}`)} / {item.gpuSlot}</summary><dl className="generation-current-input"><div><dt>{g('jobs.person')}</dt><dd>{g(`demographic.age.${item.input.age}`)} / {g(`demographic.gender.${item.input.gender}`)} / {g(`demographic.ethnicity.${item.input.ethnicity}`)}</dd></div><div><dt>{g('jobs.seed')}</dt><dd>{item.input.seed}</dd></div>{item.failureReason ? <div><dt>{g('jobs.failureTitle')}</dt><dd>{item.failureReason}</dd></div> : null}<div><dt>{g('promptPreview.positive')}</dt><dd><pre>{item.promptResult?.finalPositivePrompt ?? item.input.fixedPositivePrompt ?? item.input.userInput}</pre></dd></div><div><dt>{g('promptPreview.negative')}</dt><dd><pre>{item.promptResult?.finalNegativePrompt ?? item.input.finalNegativePrompt}</pre></dd></div></dl></details></li>)}</ol>}</section>
            <section className="generation-job-section" aria-labelledby="job-events-title"><h3 id="job-events-title">{g('jobs.events')}</h3>{events.length === 0 ? <p>{g('jobs.noLogs')}</p> : <ol className="generation-log-list">{events.map(event => <li key={event.id}><span>{g(`jobs.event.${event.eventType}`)}</span><time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time></li>)}</ol>}</section>
          </>}
        </section>
      </div>
      <ConfirmDialog open={cancelOpen} title={g('jobs.cancelTitle')} body={g('jobs.cancelBody')} confirmLabel={g('jobs.cancel')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => void cancel()} onClose={() => setCancelOpen(false)} />
    </GenerationScaffold>
  );
}
