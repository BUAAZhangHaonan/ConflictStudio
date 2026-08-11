import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import {
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  Metric,
  PageHeader,
  StatusBadge,
  TableShell,
  useToast,
} from '../components';
import { useExamplePageState } from '../app/useExamplePageState';
import { useMockRepository, useRepositorySnapshot } from '../store';
import { formatCompactDateTime, formatDateTime } from '../time';
import type { DatasetPurpose, DatasetStatus, ExamplePageState, Job } from '../types';
import './WorkspacePage.css';

const copyKey = 'workspaceSettingsStatistics';
const createDatasetErrorId = 'workspace-create-dataset-error';
const renameDatasetErrorId = 'workspace-rename-dataset-error';

function jobStatusKind(status: Job['status']) {
  return status === 'Running' ? 'active' as const : 'problem' as const;
}

function FeatureStateView({
  state,
  title,
  body,
  action,
  className = '',
}: {
  state: Exclude<ExamplePageState, 'ready'>;
  title: ReactNode;
  body: ReactNode;
  action?: { label: ReactNode; onClick: () => void };
  className?: string;
}) {
  return (
    <section
      className={`state-view ${className}`.trim()}
      aria-live={state === 'error' || state === 'conflict' ? 'assertive' : 'polite'}
    >
      {state === 'loading' ? <span className="state-view__progress" aria-hidden="true" /> : null}
      <h2>{title}</h2>
      <p>{body}</p>
      {action ? <Button variant="secondary" onClick={action.onClick}>{action.label}</Button> : null}
    </section>
  );
}

interface RenameTarget {
  id: string;
  name: string;
  note: string;
  revision: number;
}

interface DisableTarget {
  id: string;
  name: string;
  revision: number;
}

function DatasetPurposeInfo({
  purpose,
  tooltipId,
  label,
  description,
}: {
  purpose: DatasetPurpose;
  tooltipId: string;
  label: string;
  description: string;
}) {
  if (purpose === 'General') return null;
  return (
    <span className="workspace-dataset-purpose">
      <button
        type="button"
        className="workspace-dataset-purpose__button"
        aria-label={label}
        aria-describedby={tooltipId}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 7v4M8 4.75v.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <span id={tooltipId} className="workspace-dataset-purpose__tooltip" role="tooltip">
        {description}
      </span>
    </span>
  );
}

export function WorkspacePage() {
  const { t } = useTranslation();
  const repository = useMockRepository();
  const snapshot = useRepositorySnapshot();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const pageState = useExamplePageState();
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createNote, setCreateNote] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameNote, setRenameNote] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [disableTarget, setDisableTarget] = useState<DisableTarget | null>(null);
  const [datasetSearch, setDatasetSearch] = useState('');
  const [datasetStatus, setDatasetStatus] = useState<DatasetStatus | 'All'>('All');

  const pending = snapshot.data.samples.filter(sample => sample.reviewDecision === 'Pending').length;
  const running = snapshot.data.jobs.filter(job => job.status === 'Running').length;
  const failed = snapshot.data.jobs.filter(job => job.status === 'Failed').length;
  const archivedSampleIds = new Set(snapshot.data.archives.flatMap(archive => archive.currentSampleIds));
  const pendingArchive = snapshot.data.samples.filter(
    sample => sample.reviewDecision === 'Accepted' && !archivedSampleIds.has(sample.id),
  ).length;
  const needsUpdate = snapshot.data.samples.filter(
    sample => sample.reviewDecision === 'Accepted' && archivedSampleIds.has(sample.id) && sample.archiveStatus === 'NeedsUpdate',
  ).length;
  const recentActivities = useMemo(
    () => [...snapshot.data.activities].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 5),
    [snapshot.data.activities],
  );
  const datasetsById = useMemo(
    () => new Map(snapshot.data.datasets.map(dataset => [dataset.id, dataset])),
    [snapshot.data.datasets],
  );
  const runningJobs = useMemo(
    () => snapshot.data.jobs
      .filter(job => job.status === 'Running')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [snapshot.data.jobs],
  );
  const failedJobs = useMemo(
    () => snapshot.data.jobs
      .filter(job => job.status === 'Failed')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [snapshot.data.jobs],
  );
  const filteredDatasets = useMemo(() => {
    const query = datasetSearch.trim().toLocaleLowerCase(snapshot.preferences.locale);
    return snapshot.data.datasets.filter(dataset =>
      (datasetStatus === 'All' || dataset.status === datasetStatus) &&
      (query === '' || dataset.name.toLocaleLowerCase(snapshot.preferences.locale).includes(query)),
    );
  }, [datasetSearch, datasetStatus, snapshot.data.datasets, snapshot.preferences.locale]);
  const hasDatasetFilters = datasetSearch.trim() !== '' || datasetStatus !== 'All';

  const failureMessage = (kind: 'Conflict' | 'NotFound' | 'InvalidInput' | 'Unavailable') =>
    t(`${copyKey}.failure.${kind}`);

  const openCreateDialog = () => {
    setCreateName('');
    setCreateNote('');
    setCreateError(null);
    setCreateOpen(true);
  };

  const closeCreateDialog = () => {
    setCreateOpen(false);
    setCreateName('');
    setCreateNote('');
    setCreateError(null);
  };

  const createDataset = (event: FormEvent) => {
    event.preventDefault();
    if (!createName.trim()) {
      const message = failureMessage('InvalidInput');
      setCreateError(message);
      showToast(message);
      return;
    }
    const result = repository.createDataset(createName, createNote);
    if (!result.ok) {
      const message = failureMessage(result.kind);
      setCreateError(message);
      showToast(message);
      return;
    }
    closeCreateDialog();
    showToast(t(`${copyKey}.workspace.feedback.created`, { name: result.value.name }));
  };

  const openRenameDialog = (target: RenameTarget) => {
    setRenameTarget(target);
    setRenameName(target.name);
    setRenameNote(target.note);
    setRenameError(null);
  };

  const closeRenameDialog = () => {
    setRenameTarget(null);
    setRenameName('');
    setRenameNote('');
    setRenameError(null);
  };

  const renameDataset = (event: FormEvent) => {
    event.preventDefault();
    if (!renameTarget) return;
    if (!renameName.trim()) {
      const message = failureMessage('InvalidInput');
      setRenameError(message);
      showToast(message);
      return;
    }
    const result = repository.updateDatasetDetails(
      renameTarget.id,
      renameName,
      renameNote,
      renameTarget.revision,
    );
    if (!result.ok) {
      const message = failureMessage(result.kind);
      setRenameError(message);
      showToast(message);
      return;
    }
    closeRenameDialog();
    showToast(t(`${copyKey}.workspace.feedback.renamed`, { name: result.value.name }));
  };

  const disableDataset = () => {
    if (!disableTarget) return;
    const result = repository.setDatasetStatus(disableTarget.id, 'Disabled', disableTarget.revision);
    if (!result.ok) {
      showToast(failureMessage(result.kind));
      setDisableTarget(null);
      return;
    }
    setDisableTarget(null);
    showToast(t(`${copyKey}.workspace.feedback.disabled`, { name: result.value.name }));
  };

  const clearDatasetFilters = () => {
    setDatasetSearch('');
    setDatasetStatus('All');
  };

  const openDataset = (datasetId: string) => {
    navigate(`/review?dataset=${encodeURIComponent(datasetId)}`);
  };

  if (pageState !== 'ready') {
    const action = pageState === 'filtered'
      ? { label: t(`${copyKey}.common.clearFilters`), onClick: () => navigate('/workspace', { replace: true }) }
      : pageState === 'error' || pageState === 'conflict'
        ? { label: t(`${copyKey}.common.retry`), onClick: () => navigate('/workspace', { replace: true }) }
        : undefined;
    return (
      <FeatureStateView
        state={pageState}
        title={t(`${copyKey}.common.state.${pageState}.title`)}
        body={t(`${copyKey}.common.state.${pageState}.body`)}
        action={action}
        className="panel"
      />
    );
  }

  const attentionMetrics = [
    {
      key: 'pendingReview',
      label: t(`${copyKey}.workspace.attention.pendingReview`),
      value: pending,
      to: '/review?decision=Pending',
    },
    {
      key: 'runningJobs',
      label: t(`${copyKey}.workspace.attention.runningJobs`),
      value: running,
      to: '/generate/jobs?status=Running',
    },
    {
      key: 'failedJobs',
      label: t(`${copyKey}.workspace.attention.failedJobs`),
      value: failed,
      to: '/generate/jobs?status=Failed',
    },
    {
      key: 'pendingArchive',
      label: t(`${copyKey}.workspace.attention.pendingArchive`),
      value: pendingArchive,
      to: '/archive?change=Added',
    },
    {
      key: 'needsUpdate',
      label: t(`${copyKey}.workspace.attention.needsUpdate`),
      value: needsUpdate,
      to: '/archive?change=Updated',
    },
  ];

  const renderJobList = (jobs: Job[], emptyCopy: ReactNode) => {
    if (jobs.length === 0) return <p className="workspace-jobs__empty">{emptyCopy}</p>;
    return (
      <ul className="workspace-jobs__list">
        {jobs.map(job => {
          const datasetName = job.datasetId ? datasetsById.get(job.datasetId)?.name : null;
          const displayName = `${job.category}-${formatCompactDateTime(job.createdAt)}`;
          return (
            <li key={job.id}>
              <Link
                className="workspace-job-card"
                to={`/generate/jobs?status=${job.status}&job=${encodeURIComponent(job.id)}`}
                aria-label={t(`${copyKey}.workspace.jobs.openAriaLabel`, { name: displayName })}
              >
                <span className="workspace-job-card__header">
                  <strong>{displayName}</strong>
                  <StatusBadge
                    label={t(`${copyKey}.status.job.${job.status}`)}
                    kind={jobStatusKind(job.status)}
                  />
                </span>
                <dl className="workspace-job-card__details">
                  <div>
                    <dt>{t(`${copyKey}.workspace.jobs.dataset`)}</dt>
                    <dd>{datasetName ?? t(`${copyKey}.workspace.jobs.noDataset`)}</dd>
                  </div>
                  <div>
                    <dt>{t(`${copyKey}.workspace.jobs.model`)}</dt>
                    <dd>{job.model}</dd>
                  </div>
                  <div>
                    <dt>{t(`${copyKey}.workspace.jobs.gpu`)}</dt>
                    <dd>{job.gpus.join(', ')}</dd>
                  </div>
                </dl>
                {job.failureReason ? (
                  <p className="workspace-job-card__failure">
                    <strong>{t(`${copyKey}.workspace.jobs.failureLabel`)}</strong>
                    <span>{t(`${copyKey}.workspace.jobs.failureReason.${job.failureReason}`)}</span>
                  </p>
                ) : null}
                <span className="workspace-job-card__footer">
                  <span>{t(`${copyKey}.workspace.jobs.progress`, { value: job.progress })}</span>
                  <time dateTime={job.updatedAt}>
                    {t(`${copyKey}.workspace.jobs.updatedAt`, {
                      value: formatDateTime(job.updatedAt),
                    })}
                  </time>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="page-stack workspace-page">
      <PageHeader
        title={t(`${copyKey}.workspace.title`)}
        actions={
          <Button variant="primary" onClick={openCreateDialog}>
            {t(`${copyKey}.workspace.create.action`)}
          </Button>
        }
      />

      <section className="workspace-attention" aria-labelledby="workspace-attention-title">
        <div className="section-header">
          <h2 id="workspace-attention-title">{t(`${copyKey}.workspace.attention.title`)}</h2>
        </div>
        <div className="metric-grid metric-grid--five workspace-attention__metrics">
          {attentionMetrics.map(metric => (
            <Link
              key={metric.key}
              className="workspace-metric-link"
              to={metric.to}
              aria-label={t(`${copyKey}.workspace.attention.openAriaLabel`, {
                label: metric.label,
                count: metric.value,
              })}
            >
              <Metric label={metric.label} value={metric.value} />
            </Link>
          ))}
        </div>
      </section>

      <section className="panel workspace-datasets" aria-labelledby="workspace-datasets-title">
        <div className="section-header">
          <h2 id="workspace-datasets-title">{t(`${copyKey}.workspace.datasets.title`)}</h2>
          <Button type="button" variant="quiet" onClick={clearDatasetFilters} disabled={!hasDatasetFilters}>
            {t(`${copyKey}.common.clearFilters`)}
          </Button>
        </div>
        <div className="workspace-datasets__filters">
          <Field label={t(`${copyKey}.workspace.datasets.searchLabel`)} htmlFor="workspace-dataset-search">
            <input
              id="workspace-dataset-search"
              type="search"
              value={datasetSearch}
              onChange={event => setDatasetSearch(event.target.value)}
              placeholder={t(`${copyKey}.workspace.datasets.searchPlaceholder`)}
            />
          </Field>
          <Field label={t(`${copyKey}.workspace.datasets.statusFilterLabel`)} htmlFor="workspace-dataset-status">
            <select
              id="workspace-dataset-status"
              value={datasetStatus}
              onChange={event => setDatasetStatus(event.target.value as DatasetStatus | 'All')}
            >
              <option value="All">{t(`${copyKey}.workspace.datasets.allStatuses`)}</option>
              <option value="Active">{t(`${copyKey}.status.dataset.Active`)}</option>
              <option value="Disabled">{t(`${copyKey}.status.dataset.Disabled`)}</option>
            </select>
          </Field>
        </div>
        {snapshot.data.datasets.length === 0 ? (
          <FeatureStateView
            state="empty"
            title={t(`${copyKey}.workspace.datasets.emptyTitle`)}
            body={t(`${copyKey}.workspace.datasets.emptyBody`)}
            action={{ label: t(`${copyKey}.workspace.create.action`), onClick: openCreateDialog }}
            className="workspace-datasets__state"
          />
        ) : filteredDatasets.length === 0 ? (
          <FeatureStateView
            state="filtered"
            title={t(`${copyKey}.workspace.datasets.filteredTitle`)}
            body={t(`${copyKey}.workspace.datasets.filteredBody`)}
            action={{ label: t(`${copyKey}.common.clearFilters`), onClick: clearDatasetFilters }}
            className="workspace-datasets__state"
          />
        ) : (
          <TableShell
            caption={t(`${copyKey}.workspace.datasets.caption`)}
            columns={[
              { key: 'name', label: t(`${copyKey}.workspace.datasets.name`) },
              { key: 'status', label: t(`${copyKey}.workspace.datasets.status`) },
              { key: 'samples', label: t(`${copyKey}.workspace.datasets.samples`), align: 'right' },
              { key: 'pending', label: t(`${copyKey}.workspace.datasets.pending`), align: 'right' },
              { key: 'accepted', label: t(`${copyKey}.workspace.datasets.accepted`), align: 'right' },
              { key: 'rejected', label: t(`${copyKey}.workspace.datasets.rejected`), align: 'right' },
              { key: 'updated', label: t(`${copyKey}.workspace.datasets.updatedAt`) },
              { key: 'actions', label: t(`${copyKey}.workspace.datasets.actions`) },
            ]}
          >
            {filteredDatasets.map(dataset => {
              const counts = repository.getDatasetCounts(dataset.id);
              const openLabel = t(`${copyKey}.workspace.datasets.openAriaLabel`, { name: dataset.name });
              return (
                <tr
                  key={dataset.id}
                  className="workspace-datasets__row"
                >
                  <th scope="row" data-label={t(`${copyKey}.workspace.datasets.name`)}>
                    <div className="workspace-dataset-name">
                      <span className="workspace-dataset-name__title">
                        <button
                          type="button"
                          className="table-link"
                          onClick={() => openDataset(dataset.id)}
                          aria-label={openLabel}
                        >
                          {dataset.name}
                        </button>
                        <DatasetPurposeInfo
                          purpose={dataset.purpose}
                          tooltipId={`dataset-purpose-${dataset.id}`}
                          label={t(`${copyKey}.workspace.datasets.purpose.openLabel`, {
                            name: dataset.name,
                            description: t(`${copyKey}.workspace.datasets.purpose.${dataset.purpose}`),
                          })}
                          description={t(`${copyKey}.workspace.datasets.purpose.${dataset.purpose}`)}
                        />
                      </span>
                      {dataset.note ? <span className="workspace-dataset-name__note">{dataset.note}</span> : null}
                    </div>
                  </th>
                  <td data-label={t(`${copyKey}.workspace.datasets.status`)}>
                    <StatusBadge
                      label={t(`${copyKey}.status.dataset.${dataset.status}`)}
                      kind={dataset.status === 'Active' ? 'active' : 'neutral'}
                    />
                  </td>
                  <td className="is-numeric" data-label={t(`${copyKey}.workspace.datasets.samples`)}>{counts.sampleCount}</td>
                  <td className="is-numeric" data-label={t(`${copyKey}.workspace.datasets.pending`)}>{counts.pendingCount}</td>
                  <td className="is-numeric" data-label={t(`${copyKey}.workspace.datasets.accepted`)}>{counts.acceptedCount}</td>
                  <td className="is-numeric" data-label={t(`${copyKey}.workspace.datasets.rejected`)}>{counts.rejectedCount}</td>
                  <td data-label={t(`${copyKey}.workspace.datasets.updatedAt`)}>
                    <time dateTime={dataset.updatedAt}>
                      {formatDateTime(dataset.updatedAt)}
                    </time>
                  </td>
                  <td data-label={t(`${copyKey}.workspace.datasets.actions`)}>
                    <div className="workspace-datasets__actions">
                      <Button
                        variant="quiet"
                        onClick={() => openRenameDialog({
                          id: dataset.id,
                          name: dataset.name,
                          note: dataset.note,
                          revision: dataset.revision,
                        })}
                        aria-label={t(`${copyKey}.workspace.rename.ariaLabel`, { name: dataset.name })}
                      >
                        {t(`${copyKey}.workspace.rename.action`)}
                      </Button>
                      {dataset.status === 'Active' ? (
                        <Button
                          variant="quiet"
                          onClick={() => setDisableTarget({ id: dataset.id, name: dataset.name, revision: dataset.revision })}
                          aria-label={t(`${copyKey}.workspace.disable.ariaLabel`, { name: dataset.name })}
                        >
                          {t(`${copyKey}.workspace.disable.action`)}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </TableShell>
        )}
      </section>

      <section className="panel workspace-jobs" aria-labelledby="workspace-jobs-title">
        <div className="section-header">
          <h2 id="workspace-jobs-title">{t(`${copyKey}.workspace.jobs.title`)}</h2>
        </div>
        <div className="workspace-jobs__grid">
          <section className="workspace-jobs__group" aria-labelledby="workspace-running-jobs-title">
            <h3 id="workspace-running-jobs-title">{t(`${copyKey}.workspace.jobs.runningTitle`)}</h3>
            {renderJobList(runningJobs, t(`${copyKey}.workspace.jobs.runningEmpty`))}
          </section>
          <section className="workspace-jobs__group" aria-labelledby="workspace-failed-jobs-title">
            <h3 id="workspace-failed-jobs-title">{t(`${copyKey}.workspace.jobs.failedTitle`)}</h3>
            {renderJobList(failedJobs, t(`${copyKey}.workspace.jobs.failedEmpty`))}
          </section>
        </div>
      </section>

      <section className="panel workspace-activity" aria-labelledby="workspace-activity-title">
        <div className="section-header">
          <h2 id="workspace-activity-title">{t(`${copyKey}.workspace.activity.title`)}</h2>
        </div>
        {recentActivities.length === 0 ? (
          <FeatureStateView
            state="empty"
            title={t(`${copyKey}.common.state.empty.title`)}
            body={t(`${copyKey}.common.state.empty.body`)}
            className="workspace-activity__state"
          />
        ) : (
          <ol className="workspace-activity__list">
            {recentActivities.map(activity => {
              const reviewer = snapshot.data.reviewers.find(item => item.id === activity.reviewerId);
              const actor = reviewer?.name ?? activity.reviewerId ?? t(`${copyKey}.workspace.activity.system`);
              return (
                <li className="workspace-activity__item" key={activity.id}>
                  <span className="workspace-activity__content">
                    {t(`${copyKey}.workspace.activity.actions.${activity.action}`, {
                      object: activity.objectLabel,
                    })}
                  </span>
                  <span className="workspace-activity__meta">
                    <span>{actor}</span>
                    <time dateTime={activity.occurredAt}>
                      {formatDateTime(activity.occurredAt)}
                    </time>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <Dialog
        open={createOpen}
        title={t(`${copyKey}.workspace.create.title`)}
        closeLabel={t(`${copyKey}.common.close`)}
        onClose={closeCreateDialog}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={closeCreateDialog}>
              {t(`${copyKey}.common.cancel`)}
            </Button>
            <Button type="submit" form="create-dataset-form" variant="primary">
              {t(`${copyKey}.workspace.create.submit`)}
            </Button>
          </>
        }
      >
        <form id="create-dataset-form" className="workspace-dialog-form" onSubmit={createDataset} noValidate>
          <Field
            label={t(`${copyKey}.workspace.datasetName.label`)}
            htmlFor="create-dataset-name"
            required
          >
            <input
              id="create-dataset-name"
              autoFocus
              value={createName}
              onChange={event => {
                setCreateName(event.target.value);
                if (createError) setCreateError(null);
              }}
              placeholder={t(`${copyKey}.workspace.datasetName.placeholder`)}
              aria-invalid={createError ? true : undefined}
              aria-describedby={createError ? createDatasetErrorId : undefined}
            />
            {createError ? (
              <span id={createDatasetErrorId} className="field__error" role="alert">
                {createError}
              </span>
            ) : null}
          </Field>
          <Field label={t(`${copyKey}.workspace.datasetNote.label`)} htmlFor="create-dataset-note">
            <textarea
              id="create-dataset-note"
              value={createNote}
              onChange={event => setCreateNote(event.target.value)}
              placeholder={t(`${copyKey}.workspace.datasetNote.placeholder`)}
              rows={3}
            />
          </Field>
        </form>
      </Dialog>

      <Dialog
        open={renameTarget !== null}
        title={t(`${copyKey}.workspace.rename.title`)}
        closeLabel={t(`${copyKey}.common.close`)}
        onClose={closeRenameDialog}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={closeRenameDialog}>
              {t(`${copyKey}.common.cancel`)}
            </Button>
            <Button type="submit" form="rename-dataset-form" variant="primary">
              {t(`${copyKey}.workspace.rename.submit`)}
            </Button>
          </>
        }
      >
        <form id="rename-dataset-form" className="workspace-dialog-form" onSubmit={renameDataset} noValidate>
          <Field
            label={t(`${copyKey}.workspace.datasetName.label`)}
            htmlFor="rename-dataset-name"
            required
          >
            <input
              id="rename-dataset-name"
              autoFocus
              value={renameName}
              onChange={event => {
                setRenameName(event.target.value);
                if (renameError) setRenameError(null);
              }}
              placeholder={t(`${copyKey}.workspace.datasetName.placeholder`)}
              aria-invalid={renameError ? true : undefined}
              aria-describedby={renameError ? renameDatasetErrorId : undefined}
            />
            {renameError ? (
              <span id={renameDatasetErrorId} className="field__error" role="alert">
                {renameError}
              </span>
            ) : null}
          </Field>
          <Field label={t(`${copyKey}.workspace.datasetNote.label`)} htmlFor="rename-dataset-note">
            <textarea
              id="rename-dataset-note"
              value={renameNote}
              onChange={event => setRenameNote(event.target.value)}
              placeholder={t(`${copyKey}.workspace.datasetNote.placeholder`)}
              rows={3}
            />
          </Field>
        </form>
      </Dialog>

      <ConfirmDialog
        open={disableTarget !== null}
        title={t(`${copyKey}.workspace.disable.title`)}
        body={t(`${copyKey}.workspace.disable.body`, { name: disableTarget?.name ?? '' })}
        confirmLabel={t(`${copyKey}.workspace.disable.confirm`)}
        cancelLabel={t(`${copyKey}.common.cancel`)}
        closeLabel={t(`${copyKey}.common.close`)}
        onConfirm={disableDataset}
        onClose={() => setDisableTarget(null)}
      />
    </div>
  );
}
