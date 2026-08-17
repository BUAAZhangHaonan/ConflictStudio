import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, ConfirmDialog, Field, Pagination, StatusBadge, TableShell } from '../../components';
import {
  useCancelJobMutation,
  useJobEventsQuery,
  useProductionResultQuery,
  useProductionResultsQuery,
  useResultItemsQuery,
  useResumeJobMutation,
  useRetryFailedItemsMutation,
  useTestResultQuery,
  useTestResultsQuery,
} from '../../api/queries';
import { useJobEventReplay } from '../../api/jobEvents';
import type { JobDetail, JobItem, JobStatus, TestComparisonInput } from '../../api/contracts';
import { formatDateTime } from '../../time';
import {
  categoryLabel,
  collapseProgressEvents,
  GenerationScaffold,
  hideTestResult,
  hiddenTestIds,
  jobFailureMessage,
  jobStatusKind,
  OperationFeedback,
  profileLabel,
  testCopyDraftKey,
  type TestCopyDraft,
  writeSessionDraft,
  useGenerationCopy,
} from './shared';
import type { GenerationKey } from '../../locales/features/generation';

type ResultTab = 'test' | 'production';
type ConfirmAction = 'cancel' | 'resume' | 'retry' | null;

const statuses: JobStatus[] = ['Queued', 'Running', 'Interrupted', 'Completed', 'Failed', 'Cancelled'];

function testCopyDraft(detail: JobDetail, items: readonly JobItem[]): TestCopyDraft | null {
  if (detail.source !== 'PromptTest' && detail.source !== 'VideoTest') return null;
  const first = items[0];
  if (!first) return null;
  const comparisons: TestComparisonInput[] = [];
  if (detail.source === 'VideoTest') {
    for (const item of items) {
      if (item.gpuSlot === null) return null;
      const comparison = {
        model: item.input.model,
        precision: item.input.precision,
        gpuSlot: item.gpuSlot,
      };
      if (!comparisons.some(value =>
        value.model === comparison.model
        && value.precision === comparison.precision
        && value.gpuSlot === comparison.gpuSlot)) comparisons.push(comparison);
    }
    if (comparisons.length === 0 || comparisons.length > 2) return null;
  } else {
    comparisons.push({ model: first.input.model, precision: first.input.precision, gpuSlot: 'GPU0' });
  }
  return {
    kind: detail.source,
    category: first.input.category,
    conflictDirection: first.input.conflictDirection,
    contentScriptId: first.input.contentScriptId,
    sceneId: first.input.sceneId,
    promptTemplateVersionId: first.input.promptTemplateVersionId,
    age: first.input.age,
    gender: first.input.gender,
    ethnicity: first.input.ethnicity,
    seed: first.input.seed,
    model: first.input.model,
    precision: first.input.precision,
    comparisons,
    executionMode: comparisons.length > 1 && new Set(comparisons.map(item => item.gpuSlot)).size === 1
      ? 'Serial'
      : 'Parallel',
  };
}

function matchesSearch(value: { displayName: string; datasetNameSnapshot: string | null; category: string; model: string | null }, search: string): boolean {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  return [value.displayName, value.datasetNameSnapshot ?? '', value.category, value.model ?? '']
    .some(item => item.toLocaleLowerCase().includes(query));
}

export function ResultsPage() {
  const g = useGenerationCopy();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab: ResultTab = params.get('tab') === 'production' ? 'production' : 'test';
  const selectedIdValue = Number(params.get('job'));
  const selectedId = Number.isInteger(selectedIdValue) && selectedIdValue > 0 ? selectedIdValue : null;
  const statusValue = params.get('status');
  const status = statuses.includes(statusValue as JobStatus) ? statusValue as JobStatus : null;
  const pageValue = Number(params.get('page'));
  const page = Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1;
  const [search, setSearch] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [hiddenIds, setHiddenIds] = useState(hiddenTestIds);
  const [itemPage, setItemPage] = useState(1);
  const [eventPage, setEventPage] = useState(1);
  const [selectedFailures, setSelectedFailures] = useState<number[]>([]);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  const testListQuery = useTestResultsQuery(page, { ...(status ? { statuses: [status] } : {}) });
  const productionListQuery = useProductionResultsQuery(page, { ...(status ? { statuses: [status] } : {}) });
  const testDetailQuery = useTestResultQuery(tab === 'test' ? selectedId : null);
  const productionDetailQuery = useProductionResultQuery(tab === 'production' ? selectedId : null);
  const itemsQuery = useResultItemsQuery(tab, selectedId, itemPage);
  const eventsQuery = useJobEventsQuery(selectedId, eventPage);
  const cancelMutation = useCancelJobMutation();
  const resumeMutation = useResumeJobMutation();
  const retryMutation = useRetryFailedItemsMutation();

  const listQuery = tab === 'test' ? testListQuery : productionListQuery;
  const detailQuery = tab === 'test' ? testDetailQuery : productionDetailQuery;
  const detail = detailQuery.data;
  const terminal = detail ? ['Interrupted', 'Completed', 'Failed', 'Cancelled'].includes(detail.status) : true;
  const replay = useJobEventReplay(selectedId, terminal, eventsQuery.data?.items ?? []);
  const visibleItems = itemsQuery.data?.items ?? [];
  const failedItems = visibleItems.filter(item => item.status === 'Failed');
  const completedItems = visibleItems.filter(item => item.status === 'Completed' && item.primaryAssetUrl);
  const events = collapseProgressEvents(eventsQuery.data?.items ?? []);
  const pageItems = (listQuery.data?.items ?? [])
    .filter(item => tab === 'production' || showHidden || !hiddenIds.includes(item.id))
    .filter(item => matchesSearch(item, search));
  const queryError = listQuery.error ?? detailQuery.error ?? itemsQuery.error ?? eventsQuery.error;
  const mutationError = cancelMutation.error ?? resumeMutation.error ?? retryMutation.error;
  const copiedSettings = tab === 'test' && detail ? testCopyDraft(detail, visibleItems) : null;

  useEffect(() => {
    setItemPage(1);
    setEventPage(1);
    setSelectedFailures([]);
    replay.clearNewEvents();
  }, [selectedId, tab]);

  useEffect(() => {
    setSelectedFailures([]);
  }, [itemPage]);

  const updateParams = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next);
  };

  const selectTab = (next: ResultTab) => {
    setSearch('');
    setShowHidden(false);
    updateParams({ tab: next, page: null, job: null, status: null });
  };

  const runControl = async () => {
    if (!detail || confirmAction === null) return;
    try {
      if (confirmAction === 'cancel') {
        await cancelMutation.mutateAsync({ id: detail.id, expectedRevision: detail.revision });
      } else if (confirmAction === 'resume') {
        await resumeMutation.mutateAsync({ id: detail.id, expectedRevision: detail.revision });
      } else {
        const revisions = Object.fromEntries(
          failedItems.filter(item => selectedFailures.includes(item.id)).map(item => [item.id, item.revision]),
        );
        await retryMutation.mutateAsync({
          id: detail.id,
          expectedRevision: detail.revision,
          itemRevisions: revisions,
        });
        setSelectedFailures([]);
      }
    } finally {
      setConfirmAction(null);
    }
  };

  const copyAndTest = () => {
    if (copiedSettings === null) return;
    writeSessionDraft(testCopyDraftKey, copiedSettings);
    navigate('/generate/test');
  };

  const hide = (id: number) => {
    setHiddenIds(hideTestResult(id));
    if (selectedId === id) updateParams({ job: null });
  };

  const confirmTitle = confirmAction === 'cancel'
    ? g('results.cancelTitle')
    : confirmAction === 'resume'
      ? g('results.resumeTitle')
      : g('results.retryTitle');
  const confirmBody = confirmAction === 'cancel'
    ? g('results.cancelBody')
    : confirmAction === 'resume'
      ? g('results.resumeBody')
      : g('results.retryBody', { count: selectedFailures.length });
  const confirmLabel = confirmAction === 'cancel'
    ? g('results.cancel')
    : confirmAction === 'resume'
      ? g('results.resume')
      : g('results.retry');

  return (
    <GenerationScaffold title="results.title" subtitle="results.subtitle">
      <div className="generation-result-tabs" role="tablist" aria-label={g('results.title')}>
        <Button variant={tab === 'test' ? 'primary' : 'secondary'} onClick={() => selectTab('test')}>{g('results.tests')}</Button>
        <Button variant={tab === 'production' ? 'primary' : 'secondary'} onClick={() => selectTab('production')}>{g('results.production')}</Button>
      </div>
      {tab === 'test' ? <p className="generation-isolation-note">{g('results.testNotice')}</p> : null}
      {queryError ? <OperationFeedback error={queryError} onDismiss={() => void Promise.all([
        listQuery.refetch(),
        detailQuery.refetch(),
        itemsQuery.refetch(),
        eventsQuery.refetch(),
      ])} /> : null}
      {mutationError ? <OperationFeedback error={mutationError} onDismiss={() => {
        cancelMutation.reset();
        resumeMutation.reset();
        retryMutation.reset();
      }} /> : null}

      <section className="panel generation-results-list" aria-labelledby="results-list-title">
        <div className="section-header"><h2 id="results-list-title">{g(tab === 'test' ? 'results.tests' : 'results.production')}</h2></div>
        <div className="generation-results-filters">
          <Field label={g('results.search')} htmlFor="results-search" hint={g('results.pageSearchLimit')}><input id="results-search" type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
          <Field label={g('results.status')} htmlFor="results-status"><select id="results-status" value={status ?? ''} onChange={event => updateParams({ status: event.target.value || null, page: null })}><option value="">{g('common.all')}</option>{statuses.map(value => <option key={value} value={value}>{g(('job.' + value) as GenerationKey)}</option>)}</select></Field>
          {tab === 'test' ? <label className="generation-inline-check"><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />{g('results.hiddenFilter')}</label> : null}
        </div>
        {pageItems.length === 0 ? <p>{search.trim() ? g('state.filtered') : g('state.empty')}</p> : (
          <TableShell caption={g(tab === 'test' ? 'results.tests' : 'results.production')} columns={[
            { key: 'name', label: tab === 'test' ? g('results.testType') : g('production.name') },
            ...(tab === 'production' ? [{ key: 'dataset', label: g('results.dataset') }] : []),
            { key: 'category', label: g('results.taskType') },
            { key: 'model', label: g('results.model') },
            { key: 'progress', label: g('results.progress') },
            { key: 'status', label: g('results.status') },
            { key: 'updated', label: g('results.updated') },
            { key: 'actions', label: g('results.actions') },
          ]}>{pageItems.map(job => <tr key={job.id}>
            <th scope="row">{tab === 'test' ? g(('source.' + job.source) as GenerationKey) : job.displayName}</th>
            {tab === 'production' ? <td>{job.datasetNameSnapshot ?? g('common.none')}</td> : null}
            <td>{categoryLabel(g, job.category)}</td>
            <td>{profileLabel(job.model, job.precision)}</td>
            <td><div className="generation-progress"><progress max={job.totalCount || 1} value={job.completedCount + job.failedCount} /><span>{job.completedCount + job.failedCount}/{job.totalCount}</span></div></td>
            <td><StatusBadge label={g(('job.' + job.status) as GenerationKey)} kind={jobStatusKind(job.status)} /></td>
            <td><time dateTime={job.updatedAt}>{formatDateTime(job.updatedAt)}</time></td>
            <td><div className="generation-row-actions"><Button variant="quiet" onClick={() => updateParams({ job: String(job.id) })}>{g('common.view')}</Button>{tab === 'test' ? <Button variant="quiet" onClick={() => hide(job.id)}>{g('results.hide')}</Button> : null}</div></td>
          </tr>)}</TableShell>
        )}
        <Pagination page={listQuery.data?.page ?? page} totalPages={listQuery.data?.totalPages ?? 0} total={listQuery.data?.total ?? 0} onPageChange={value => updateParams({ page: String(value), job: null })} />
      </section>

      {selectedId !== null ? (
        <section className="panel generation-result-detail" aria-labelledby="result-detail-title">
          <div className="section-header">
            <div><h2 id="result-detail-title">{g('results.detail')}</h2>{detail ? <p>{detail.displayName}</p> : null}</div>
            <Button variant="quiet" onClick={() => updateParams({ job: null })}>{g('common.close')}</Button>
          </div>
          {detailQuery.isPending ? <p role="status">{g('common.loading')}</p> : null}
          {detail ? <>
            <dl className="generation-result-summary">
              <div><dt>{g('results.taskType')}</dt><dd>{categoryLabel(g, detail.category)}</dd></div>
              <div><dt>{g('results.model')}</dt><dd>{profileLabel(detail.model, detail.precision)}</dd></div>
              <div><dt>{g('results.status')}</dt><dd><StatusBadge label={g(('job.' + detail.status) as GenerationKey)} kind={jobStatusKind(detail.status)} /></dd></div>
              <div><dt>{g('results.progress')}</dt><dd>{detail.completedCount + detail.failedCount}/{detail.totalCount}</dd></div>
              {tab === 'production' ? <div><dt>{g('results.dataset')}</dt><dd>{detail.datasetNameSnapshot ?? g('common.none')}</dd></div> : null}
            </dl>
            {detail.failureCode ? <p className="generation-failure" role="alert">{jobFailureMessage(detail.failureCode, g)}</p> : null}
            <div className="generation-detail-actions">
              {(detail.status === 'Running' || detail.status === 'Queued') ? <Button variant="secondary" onClick={() => setConfirmAction('cancel')}>{g('results.cancel')}</Button> : null}
              {detail.status === 'Interrupted' ? <Button variant="primary" onClick={() => setConfirmAction('resume')}>{g('results.resume')}</Button> : null}
              {tab === 'test' ? <><Button variant="secondary" disabled={copiedSettings === null} onClick={copyAndTest}>{g('test.copy')}</Button><Button variant="quiet" onClick={() => hide(detail.id)}>{g('results.hide')}</Button></> : null}
            </div>

            {replay.disconnected ? <div className="generation-connection" role="status"><p>{g('results.disconnected')}</p><Button variant="quiet" onClick={replay.reconnect}>{g('results.reconnect')}</Button></div> : null}

            <section className="generation-detail-section" aria-labelledby="result-events-title">
              <h3 id="result-events-title">{g('results.events')}</h3>
              {events.length === 0 ? <p>{g('results.noEvents')}</p> : <ol className="generation-event-list">{events.map(event => <li key={event.id}><time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time><span>{g(('results.event.' + event.eventType) as GenerationKey)}</span>{event.payload.sequence !== null ? <span>{event.payload.sequence}/{event.payload.totalCount ?? detail.totalCount}</span> : null}</li>)}</ol>}
              <Pagination page={eventsQuery.data?.page ?? eventPage} totalPages={eventsQuery.data?.totalPages ?? 0} total={eventsQuery.data?.total ?? 0} onPageChange={setEventPage} />
            </section>

            <section className="generation-detail-section" aria-labelledby="result-failures-title">
              <div className="section-header"><h3 id="result-failures-title">{g('results.failedItems')}</h3>{selectedFailures.length > 0 ? <Button variant="secondary" onClick={() => setConfirmAction('retry')}>{g('results.retry')}</Button> : null}</div>
              {failedItems.length === 0 ? <p>{g('results.noFailure')}</p> : <ul className="generation-failed-list">{failedItems.map(item => <li key={item.id}><label><input type="checkbox" checked={selectedFailures.includes(item.id)} onChange={() => setSelectedFailures(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])} /><span><strong>{item.sequence}</strong>{g(('stage.' + item.stage) as GenerationKey)} {jobFailureMessage(item.failureCode, g)}</span></label></li>)}</ul>}
            </section>

            <section className="generation-detail-section" aria-labelledby="result-output-title">
              <h3 id="result-output-title">{g('results.output')}</h3>
              {completedItems.length === 0 ? <p>{g('results.noOutput')}</p> : <div className="generation-output-grid">{completedItems.map(item => <article key={item.id}><video controls preload="metadata" src={item.primaryAssetUrl ?? undefined} /><dl><div><dt>{g('production.sequence')}</dt><dd>{item.sequence}</dd></div><div><dt>{g('results.actualGpu')}</dt><dd>{item.gpuSlot ? g(('gpu.' + item.gpuSlot) as GenerationKey) : g('common.none')}</dd></div><div><dt>{g('results.status')}</dt><dd>{g(('job.' + item.status) as GenerationKey)}</dd></div></dl></article>)}</div>}
              <Pagination page={itemsQuery.data?.page ?? itemPage} totalPages={itemsQuery.data?.totalPages ?? 0} total={itemsQuery.data?.total ?? 0} onPageChange={setItemPage} />
            </section>
          </> : null}
        </section>
      ) : null}

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmTitle}
        body={confirmBody}
        confirmLabel={confirmLabel}
        cancelLabel={g('common.cancel')}
        closeLabel={g('common.close')}
        onConfirm={() => void runControl()}
        onClose={() => setConfirmAction(null)}
        busy={cancelMutation.isPending || resumeMutation.isPending || retryMutation.isPending}
      />
    </GenerationScaffold>
  );
}
