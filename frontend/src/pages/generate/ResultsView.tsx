import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button,
  ConfirmDialog,
  Field,
  Pagination,
  StatusBadge,
  TableShell,
} from '../../components';
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
import type { JobStatus } from '../../api/contracts';
import { formatDateTime } from '../../time';
import type { GenerationKey } from '../../locales/features/generation';
import {
  categoryLabel,
  collapseProgressEvents,
  GenerationScaffold,
  jobFailureMessage,
  jobStatusKind,
  OperationFeedback,
  testCopyDraftKey,
  useGenerationCopy,
  useGenerationLocale,
  writeSessionDraft,
} from './shared';
import {
  buildTestDraft,
  completedProgress,
  controlVisibility,
  failedItemRevisions,
  profilesText,
  resultKind,
  resultListState,
  resultTaskName,
  type ResultListState,
} from './resultsModel';
import { ResultsOutputList } from './ResultsOutputList';

type ConfirmAction = 'cancel' | 'resume' | 'retry' | null;

const statuses: JobStatus[] = [
  'Queued',
  'Running',
  'Interrupted',
  'Completed',
  'Failed',
  'Cancelled',
];

function ResultsStatePanel({
  state,
  onRetry,
}: {
  state: Exclude<ResultListState, 'ready'>;
  onRetry: () => void;
}) {
  const g = useGenerationCopy();
  const copy: Record<Exclude<ResultListState, 'ready'>, {
    title: GenerationKey;
    body: GenerationKey;
  }> = {
    loading: { title: 'results.state.loadingTitle', body: 'results.state.loadingBody' },
    networkError: { title: 'results.state.networkTitle', body: 'results.state.networkBody' },
    serviceError: { title: 'results.state.serviceTitle', body: 'results.state.serviceBody' },
    filteredEmpty: { title: 'results.state.filteredTitle', body: 'results.state.filteredBody' },
    empty: { title: 'results.state.emptyTitle', body: 'results.state.emptyBody' },
  };
  const value = copy[state];
  const error = state === 'networkError' || state === 'serviceError';
  return (
    <section
      className="generation-results-state"
      aria-live={error ? 'assertive' : 'polite'}
      role={error ? 'alert' : 'status'}
    >
      <h3>{g(value.title)}</h3>
      <p>{g(value.body)}</p>
      {error ? <Button variant="secondary" onClick={onRetry}>{g('results.retryLoad')}</Button> : null}
    </section>
  );
}

export function ResultsView() {
  const g = useGenerationCopy();
  const locale = useGenerationLocale();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const kind = resultKind(params.get('tab'));
  const selectedValue = Number(params.get('job'));
  const selectedId = Number.isInteger(selectedValue) && selectedValue > 0 ? selectedValue : null;
  const statusValue = params.get('status');
  const status = statuses.includes(statusValue as JobStatus) ? statusValue as JobStatus : null;
  const pageValue = Number(params.get('page'));
  const page = Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1;
  const [itemPage, setItemPage] = useState(1);
  const [eventPage, setEventPage] = useState(1);
  const [selectedFailures, setSelectedFailures] = useState<number[]>([]);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  const filter = status ? { statuses: [status] } : {};
  const testListQuery = useTestResultsQuery(page, filter);
  const productionListQuery = useProductionResultsQuery(page, filter);
  const testDetailQuery = useTestResultQuery(kind === 'test' ? selectedId : null);
  const productionDetailQuery = useProductionResultQuery(kind === 'production' ? selectedId : null);
  const listQuery = kind === 'test' ? testListQuery : productionListQuery;
  const detailQuery = kind === 'test' ? testDetailQuery : productionDetailQuery;
  const itemsQuery = useResultItemsQuery(kind, selectedId, itemPage);
  const eventsQuery = useJobEventsQuery(selectedId, eventPage);
  const cancelMutation = useCancelJobMutation();
  const resumeMutation = useResumeJobMutation();
  const retryMutation = useRetryFailedItemsMutation();

  const detail = detailQuery.data;
  const jobs = listQuery.data?.items ?? [];
  const items = itemsQuery.data?.items ?? [];
  const events = collapseProgressEvents(eventsQuery.data?.items ?? []);
  const terminal = detail
    ? ['Interrupted', 'Completed', 'Failed', 'Cancelled'].includes(detail.status)
    : true;
  const replay = useJobEventReplay(selectedId, terminal, eventsQuery.data?.items ?? []);
  const listState = resultListState({
    pending: listQuery.isPending,
    error: listQuery.error,
    total: listQuery.data?.total ?? 0,
    statusFiltered: status !== null,
  });
  const detailError = detailQuery.error ?? itemsQuery.error ?? eventsQuery.error;
  const mutationError = cancelMutation.error ?? resumeMutation.error ?? retryMutation.error;
  const testDraft = useMemo(
    () => detail && kind === 'test' ? buildTestDraft(detail, items) : null,
    [detail, items, kind],
  );
  const controls = controlVisibility(detail?.status ?? 'Completed', selectedFailures.length);
  const resultsReturnTo = '/generate/results' + (params.toString() ? '?' + params.toString() : '');

  useEffect(() => {
    setItemPage(1);
    setEventPage(1);
    setSelectedFailures([]);
    replay.clearNewEvents();
  }, [selectedId, kind]);

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

  const selectKind = (value: string) => {
    updateParams({
      tab: value === 'production' ? 'production' : 'test',
      page: null,
      job: null,
      status: null,
    });
  };

  const runControl = async () => {
    if (!detail || confirmAction === null) return;
    try {
      if (confirmAction === 'cancel') {
        await cancelMutation.mutateAsync({
          id: detail.id,
          expectedRevision: detail.revision,
        });
      } else if (confirmAction === 'resume') {
        await resumeMutation.mutateAsync({
          id: detail.id,
          expectedRevision: detail.revision,
        });
      } else {
        await retryMutation.mutateAsync({
          id: detail.id,
          expectedRevision: detail.revision,
          itemRevisions: failedItemRevisions(items, selectedFailures),
        });
        setSelectedFailures([]);
      }
    } finally {
      setConfirmAction(null);
    }
  };

  const openTestDraft = () => {
    if (!testDraft) return;
    writeSessionDraft(testCopyDraftKey, testDraft);
    navigate('/generate/test');
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

  const sourceLabels = {
    Production: g('source.Production'),
    PromptTest: g('source.PromptTest'),
    VideoTest: g('source.VideoTest'),
  };

  return (
    <GenerationScaffold title="results.title" subtitle="results.subtitle">
      <section className="panel generation-results-list" aria-labelledby="results-list-title">
        <div className="section-header">
          <h2 id="results-list-title">{g('results.tasks')}</h2>
        </div>
        <div className="generation-results-filters">
          <Field label={g('results.kind')} htmlFor="results-kind">
            <select id="results-kind" value={kind} onChange={event => selectKind(event.target.value)}>
              <option value="test">{g('results.tests')}</option>
              <option value="production">{g('results.production')}</option>
            </select>
          </Field>
          <Field label={g('results.status')} htmlFor="results-status">
            <select
              id="results-status"
              value={status ?? ''}
              onChange={event => updateParams({
                status: event.target.value || null,
                page: null,
                job: null,
              })}
            >
              <option value="">{g('common.all')}</option>
              {statuses.map(value => (
                <option key={value} value={value}>
                  {g(('job.' + value) as GenerationKey)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {listState !== 'ready' ? (
          <ResultsStatePanel state={listState} onRetry={() => void listQuery.refetch()} />
        ) : (
          <>
            <TableShell
              caption={g('results.tasks')}
              columns={[
                { key: 'name', label: g('results.name') },
                { key: 'kind', label: g('results.kind') },
                { key: 'category', label: g('results.taskType') },
                { key: 'profile', label: g('results.model') },
                { key: 'progress', label: g('results.progress') },
                { key: 'status', label: g('results.status') },
                { key: 'failure', label: g('results.failure') },
                { key: 'updated', label: g('results.updated') },
                { key: 'actions', label: g('results.actions') },
              ]}
            >
              {jobs.map(job => {
                const progress = completedProgress(job);
                return (
                  <tr key={job.id}>
                    <th scope="row">
                      <span className="generation-task-name">
                        {resultTaskName(job.source, job.createdAt, sourceLabels)}
                      </span>
                    </th>
                    <td>{sourceLabels[job.source]}</td>
                    <td>{categoryLabel(g, job.category)}</td>
                    <td>{profilesText(job.profiles, job.model, job.precision)}</td>
                    <td>
                      <div className="generation-progress">
                        <progress
                          max={progress.total || 1}
                          value={progress.current}
                          aria-label={g('results.progressLabel', {
                            current: progress.current,
                            total: progress.total,
                          })}
                        />
                        <span>{progress.current}/{progress.total}</span>
                      </div>
                    </td>
                    <td>
                      <StatusBadge
                        label={g(('job.' + job.status) as GenerationKey)}
                        kind={jobStatusKind(job.status)}
                      />
                    </td>
                    <td>{job.failureCode || job.status === 'Failed' ? jobFailureMessage(job.failureCode, g) : g('results.noFailureShort')}</td>
                    <td><time dateTime={job.updatedAt}>{formatDateTime(job.updatedAt)}</time></td>
                    <td>
                      <Button
                        variant="quiet"
                        onClick={() => updateParams({ job: String(job.id) })}
                      >
                        {g('common.view')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </TableShell>
            <ul className="generation-results-cards" aria-label={g('results.tasks')}>
              {jobs.map(job => {
                const progress = completedProgress(job);
                const failure = job.failureCode || job.status === 'Failed'
                  ? jobFailureMessage(job.failureCode, g)
                  : null;
                return (
                  <li key={job.id}>
                    <h3>{resultTaskName(job.source, job.createdAt, sourceLabels)}</h3>
                    <dl>
                      <div><dt>{g('results.taskType')}</dt><dd>{categoryLabel(g, job.category)}</dd></div>
                      <div><dt>{g('results.status')}</dt><dd><StatusBadge label={g(('job.' + job.status) as GenerationKey)} kind={jobStatusKind(job.status)} /></dd></div>
                      <div><dt>{g('results.progress')}</dt><dd>{progress.current}/{progress.total}</dd></div>
                      <div><dt>{g('results.model')}</dt><dd>{profilesText(job.profiles, job.model, job.precision)}</dd></div>
                      <div><dt>{g('results.updated')}</dt><dd><time dateTime={job.updatedAt}>{formatDateTime(job.updatedAt)}</time></dd></div>
                      <div><dt>{g('results.kind')}</dt><dd>{sourceLabels[job.source]}</dd></div>
                      {failure ? <div className="generation-results-card__failure"><dt>{g('results.failure')}</dt><dd>{failure}</dd></div> : null}
                    </dl>
                    <Button variant="secondary" onClick={() => updateParams({ job: String(job.id) })}>
                      {g('common.view')}
                    </Button>
                  </li>
                );
              })}
            </ul>
            <Pagination
              page={listQuery.data?.page ?? page}
              totalPages={listQuery.data?.totalPages ?? 0}
              total={listQuery.data?.total ?? 0}
              onPageChange={value => updateParams({
                page: String(value),
                job: null,
              })}
            />
          </>
        )}
      </section>

      {selectedId !== null ? (
        <section className="panel generation-result-detail" aria-labelledby="result-detail-title">
          <div className="section-header">
            <h2 id="result-detail-title">{g('results.detail')}</h2>
            <Button variant="quiet" onClick={() => updateParams({ job: null })}>
              {g('common.close')}
            </Button>
          </div>

          {detailError ? (
            <ResultsStatePanel
              state={resultListState({
                pending: false,
                error: detailError,
                total: 1,
                statusFiltered: false,
              }) as 'networkError' | 'serviceError'}
              onRetry={() => {
                void detailQuery.refetch();
                void itemsQuery.refetch();
                void eventsQuery.refetch();
              }}
            />
          ) : detailQuery.isPending || !detail ? (
            <ResultsStatePanel state="loading" onRetry={() => void detailQuery.refetch()} />
          ) : (
            <>
              {mutationError ? (
                <OperationFeedback
                  error={mutationError}
                  onDismiss={() => {
                    cancelMutation.reset();
                    resumeMutation.reset();
                    retryMutation.reset();
                  }}
                />
              ) : null}
              <section className="generation-result-output" aria-labelledby="result-output-title">
                <div className="section-header">
                  <h3 id="result-output-title">{g('results.output')}</h3>
                  {controls.retry ? (
                    <Button variant="secondary" disabled={retryMutation.isPending} onClick={() => setConfirmAction('retry')}>
                      {g('results.retry')}
                    </Button>
                  ) : null}
                </div>
                {itemsQuery.isPending ? <p role="status">{g('common.loading')}</p> : (
                  <ResultsOutputList
                    items={items}
                    jobStatus={detail.status}
                    page={itemsQuery.data?.page ?? itemPage}
                    totalPages={itemsQuery.data?.totalPages ?? 0}
                    total={itemsQuery.data?.total ?? 0}
                    locale={locale}
                    kind={kind}
                    returnTo={resultsReturnTo}
                    selectedFailures={selectedFailures}
                    onToggleFailure={id => setSelectedFailures(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id])}
                    onPageChange={setItemPage}
                    g={g}
                  />
                )}
              </section>

              <div className="generation-result-actions">
                {controls.cancel ? <Button variant="secondary" disabled={cancelMutation.isPending} onClick={() => setConfirmAction('cancel')}>{g('results.cancel')}</Button> : null}
                {controls.resume ? <Button variant="secondary" disabled={resumeMutation.isPending} onClick={() => setConfirmAction('resume')}>{g('results.resume')}</Button> : null}
                {kind === 'test' ? <div className="generation-test-draft-action"><Button variant="secondary" disabled={testDraft === null} onClick={openTestDraft}>{g('results.testDraft')}</Button><p>{g('results.testDraftHint')}</p></div> : null}
              </div>

              <details className="generation-result-technical">
                <summary>{g('results.technicalDetails')}</summary>
              <div className="generation-result-summary">
                <dl>
                  <div><dt>{g('results.kind')}</dt><dd>{sourceLabels[detail.source]}</dd></div>
                  <div><dt>{g('results.taskType')}</dt><dd>{categoryLabel(g, detail.category)}</dd></div>
                  <div><dt>{g('results.model')}</dt><dd>{profilesText(detail.profiles, detail.model, detail.precision)}</dd></div>
                  <div><dt>{g('results.status')}</dt><dd>{g(('job.' + detail.status) as GenerationKey)}</dd></div>
                  <div>
                    <dt>{g('results.progress')}</dt>
                    <dd>{g('results.progressLabel', {
                      current: completedProgress(detail).current,
                      total: completedProgress(detail).total,
                    })}</dd>
                  </div>
                  <div>
                    <dt>{g('results.dataset')}</dt>
                    <dd>{detail.datasetNameSnapshot ?? g('common.none')}</dd>
                  </div>
                  <div>
                    <dt>{g('results.updated')}</dt>
                    <dd><time dateTime={detail.updatedAt}>{formatDateTime(detail.updatedAt)}</time></dd>
                  </div>
                </dl>
                {detail.failureCode || detail.status === 'Failed' ? (
                  <p className="generation-failure" role="alert">
                    {jobFailureMessage(detail.failureCode, g)}
                  </p>
                ) : null}
              </div>

              {replay.disconnected ? (
                <div className="generation-live-disconnected" role="status">
                  <p>{g('results.disconnected')}</p>
                  <Button variant="quiet" onClick={replay.reconnect}>{g('results.reconnect')}</Button>
                </div>
              ) : null}
              {replay.newEventCount > 0 ? (
                <p className="generation-new-events" role="status">
                  {g('results.newEvents', { count: replay.newEventCount })}
                </p>
              ) : null}

              <section className="generation-result-events" aria-labelledby="result-events-title">
                <div className="section-header">
                  <h3 id="result-events-title">{g('results.events')}</h3>
                </div>
                {eventsQuery.isPending ? (
                  <p role="status">{g('common.loading')}</p>
                ) : events.length === 0 ? (
                  <p className="generation-empty-note">{g('results.noEvents')}</p>
                ) : (
                  <ol
                    className="generation-event-list"
                    tabIndex={0}
                    aria-label={g('results.events')}
                  >
                    {events.map(event => (
                      <li key={event.id}>
                        <div>
                          <strong>{g(('results.event.' + event.eventType) as GenerationKey)}</strong>
                          {event.payload.sequence !== null ? (
                            <span>{g('results.eventItem', { number: event.payload.sequence })}</span>
                          ) : null}
                          {event.payload.progressValue !== null && event.payload.progressMaximum !== null ? (
                            <span>{g('results.eventProgress', {
                              current: event.payload.progressValue,
                              total: event.payload.progressMaximum,
                            })}</span>
                          ) : null}
                        </div>
                        <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
                      </li>
                    ))}
                  </ol>
                )}
                <Pagination
                  page={eventsQuery.data?.page ?? eventPage}
                  totalPages={eventsQuery.data?.totalPages ?? 0}
                  total={eventsQuery.data?.total ?? 0}
                  onPageChange={setEventPage}
                />
              </section>
              </details>
            </>
          )}
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
