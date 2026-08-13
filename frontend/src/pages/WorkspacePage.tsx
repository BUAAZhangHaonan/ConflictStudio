import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button, ConfirmDialog, Dialog, Field, Metric, PageHeader, StatusBadge, TableShell, useToast } from '../components';
import {
  useCreateDatasetMutation,
  useDatasetsQuery,
  useJobsQuery,
  useSamplesQuery,
  useUpdateDatasetMutation,
} from '../api/queries';
import type { DatasetPurpose, JobSummary, ResourceStatus } from '../api/contracts';
import { apiErrorMessage } from '../api/client';
import { formatDateTime } from '../time';
import './WorkspacePage.css';

const copyKey = 'workspaceSettingsStatistics';

interface DatasetTarget {
  id: number;
  name: string;
  note: string;
  revision: number;
}

function jobStatusKind(status: JobSummary['status']) {
  if (status === 'Running') return 'active' as const;
  if (status === 'Failed') return 'problem' as const;
  return 'neutral' as const;
}

export function WorkspacePage() {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const datasetsQuery = useDatasetsQuery();
  const jobsQuery = useJobsQuery();
  const samplesQuery = useSamplesQuery();
  const createMutation = useCreateDatasetMutation();
  const updateMutation = useUpdateDatasetMutation();
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createNote, setCreateNote] = useState('');
  const [createPurpose, setCreatePurpose] = useState<DatasetPurpose>('Production');
  const [renameTarget, setRenameTarget] = useState<DatasetTarget | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameNote, setRenameNote] = useState('');
  const [disableTarget, setDisableTarget] = useState<DatasetTarget | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ResourceStatus | 'All'>('All');
  const datasets = datasetsQuery.data ?? [];
  const jobs = jobsQuery.data ?? [];
  const samples = samplesQuery.data ?? [];
  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';
  const queryError = datasetsQuery.error ?? jobsQuery.error ?? samplesQuery.error ?? null;
  const mutationError = createMutation.error ?? updateMutation.error ?? null;
  const pendingReview = samples.filter(sample => sample.reviewDecision === 'Pending').length;
  const pendingArchive = samples.filter(sample => sample.reviewDecision === 'Accepted').length;
  const runningJobs = jobs.filter(job => job.status === 'Running');
  const failedJobs = jobs.filter(job => job.status === 'Failed');
  const filtered = useMemo(() => {
    const value = search.trim().toLocaleLowerCase(locale);
    return datasets.filter(dataset =>
      (status === 'All' || dataset.status === status)
      && (value === '' || dataset.name.toLocaleLowerCase(locale).includes(value)),
    );
  }, [datasets, locale, search, status]);

  const resetCreate = () => {
    setCreateOpen(false);
    setCreateName('');
    setCreateNote('');
    setCreatePurpose('Production');
    createMutation.reset();
  };

  const createDataset = async (event: FormEvent) => {
    event.preventDefault();
    if (!createName.trim()) return;
    try {
      const value = await createMutation.mutateAsync({ name: createName, note: createNote, purpose: createPurpose });
      resetCreate();
      showToast(t(`${copyKey}.workspace.feedback.created`, { name: value.name }));
    } catch {
      // The safe error message is rendered in the dialog and page.
    }
  };

  const openRename = (target: DatasetTarget) => {
    setRenameTarget(target);
    setRenameName(target.name);
    setRenameNote(target.note);
    updateMutation.reset();
  };

  const renameDataset = async (event: FormEvent) => {
    event.preventDefault();
    if (!renameTarget || !renameName.trim()) return;
    try {
      const value = await updateMutation.mutateAsync({
        id: renameTarget.id,
        input: { expectedRevision: renameTarget.revision, name: renameName, note: renameNote },
      });
      setRenameTarget(null);
      showToast(t(`${copyKey}.workspace.feedback.renamed`, { name: value.name }));
    } catch {
      // The safe error message is rendered in the dialog and page.
    }
  };

  const disableDataset = async () => {
    if (!disableTarget) return;
    try {
      const value = await updateMutation.mutateAsync({
        id: disableTarget.id,
        input: { expectedRevision: disableTarget.revision, status: 'Disabled' },
      });
      setDisableTarget(null);
      showToast(t(`${copyKey}.workspace.feedback.disabled`, { name: value.name }));
    } catch {
      setDisableTarget(null);
    }
  };

  const renderJobs = (values: JobSummary[], emptyKey: 'runningEmpty' | 'failedEmpty') => values.length === 0
    ? <p className="workspace-jobs__empty">{t(`${copyKey}.workspace.jobs.${emptyKey}`)}</p>
    : <ul className="workspace-jobs__list">{values.map(job => <li key={job.id}><Link className="workspace-job-card" to={`/generate/jobs?job=${job.id}`}><span className="workspace-job-card__header"><strong>{job.displayName}</strong><StatusBadge label={t(`${copyKey}.status.job.${job.status}`)} kind={jobStatusKind(job.status)} /></span><dl className="workspace-job-card__details"><div><dt>{t(`${copyKey}.workspace.jobs.model`)}</dt><dd>{job.model}</dd></div><div><dt>{t(`${copyKey}.workspace.jobs.progress`, { value: Math.round(((job.completedCount + job.failedCount) / job.totalCount) * 100) })}</dt><dd>{job.completedCount + job.failedCount}/{job.totalCount}</dd></div></dl><time dateTime={job.updatedAt}>{formatDateTime(job.updatedAt)}</time></Link></li>)}</ul>;

  if (datasetsQuery.isPending || jobsQuery.isPending || samplesQuery.isPending) return <div className="page-stack workspace-page"><PageHeader title={t(`${copyKey}.workspace.title`)} /><p role="status">{t(`${copyKey}.common.state.loading.body`)}</p></div>;
  if (queryError) return <div className="page-stack workspace-page"><PageHeader title={t(`${copyKey}.workspace.title`)} /><section className="generation-feedback" role="alert"><p>{apiErrorMessage(queryError, locale)}</p></section></div>;

  return (
    <div className="page-stack workspace-page">
      <PageHeader title={t(`${copyKey}.workspace.title`)} actions={<Button variant="primary" onClick={() => setCreateOpen(true)}>{t(`${copyKey}.workspace.create.action`)}</Button>} />
      {mutationError ? <section className="generation-feedback" role="alert"><p>{apiErrorMessage(mutationError, locale)}</p></section> : null}
      <section className="workspace-attention" aria-labelledby="workspace-attention-title"><div className="section-header"><h2 id="workspace-attention-title">{t(`${copyKey}.workspace.attention.title`)}</h2></div><div className="metric-grid metric-grid--five workspace-attention__metrics"><Link className="workspace-metric-link" to="/review?decision=Pending"><Metric label={t(`${copyKey}.workspace.attention.pendingReview`)} value={pendingReview} /></Link><Link className="workspace-metric-link" to="/generate/jobs?status=Running"><Metric label={t(`${copyKey}.workspace.attention.runningJobs`)} value={runningJobs.length} /></Link><Link className="workspace-metric-link" to="/generate/jobs?status=Failed"><Metric label={t(`${copyKey}.workspace.attention.failedJobs`)} value={failedJobs.length} /></Link><Link className="workspace-metric-link" to="/archive"><Metric label={t(`${copyKey}.workspace.attention.pendingArchive`)} value={pendingArchive} /></Link></div></section>
      <section className="panel workspace-datasets" aria-labelledby="workspace-datasets-title">
        <div className="section-header"><h2 id="workspace-datasets-title">{t(`${copyKey}.workspace.datasets.title`)}</h2></div>
        <div className="workspace-datasets__filters"><Field label={t(`${copyKey}.workspace.datasets.searchLabel`)} htmlFor="workspace-dataset-search"><input id="workspace-dataset-search" type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field><Field label={t(`${copyKey}.workspace.datasets.statusFilterLabel`)} htmlFor="workspace-dataset-status"><select id="workspace-dataset-status" value={status} onChange={event => setStatus(event.target.value as ResourceStatus | 'All')}><option value="All">{t(`${copyKey}.workspace.datasets.allStatuses`)}</option><option value="Active">{t(`${copyKey}.status.dataset.Active`)}</option><option value="Disabled">{t(`${copyKey}.status.dataset.Disabled`)}</option></select></Field></div>
        {filtered.length === 0 ? <p>{t(`${copyKey}.workspace.datasets.emptyBody`)}</p> : <TableShell caption={t(`${copyKey}.workspace.datasets.caption`)} columns={[{ key: 'name', label: t(`${copyKey}.workspace.datasets.name`) }, { key: 'purpose', label: t(`${copyKey}.workspace.datasets.purposeLabel`) }, { key: 'status', label: t(`${copyKey}.workspace.datasets.status`) }, { key: 'updated', label: t(`${copyKey}.workspace.datasets.updatedAt`) }, { key: 'actions', label: t(`${copyKey}.workspace.datasets.actions`) }]}>{filtered.map(dataset => <tr key={dataset.id}><th scope="row"><strong>{dataset.name}</strong>{dataset.note ? <span className="workspace-dataset-name__note">{dataset.note}</span> : null}</th><td>{t(`${copyKey}.workspace.datasets.purpose.${dataset.purpose}`)}</td><td><StatusBadge label={t(`${copyKey}.status.dataset.${dataset.status}`)} kind={dataset.status === 'Active' ? 'active' : 'neutral'} /></td><td><time dateTime={dataset.updatedAt}>{formatDateTime(dataset.updatedAt)}</time></td><td><div className="workspace-datasets__actions"><Button variant="quiet" onClick={() => openRename({ id: dataset.id, name: dataset.name, note: dataset.note, revision: dataset.revision })}>{t(`${copyKey}.workspace.rename.action`)}</Button>{dataset.status === 'Active' ? <Button variant="quiet" onClick={() => setDisableTarget({ id: dataset.id, name: dataset.name, note: dataset.note, revision: dataset.revision })}>{t(`${copyKey}.workspace.disable.action`)}</Button> : null}</div></td></tr>)}</TableShell>}
      </section>
      <section className="panel workspace-jobs" aria-labelledby="workspace-jobs-title"><div className="section-header"><h2 id="workspace-jobs-title">{t(`${copyKey}.workspace.jobs.title`)}</h2></div><div className="workspace-jobs__grid"><section className="workspace-jobs__group"><h3>{t(`${copyKey}.workspace.jobs.runningTitle`)}</h3>{renderJobs(runningJobs, 'runningEmpty')}</section><section className="workspace-jobs__group"><h3>{t(`${copyKey}.workspace.jobs.failedTitle`)}</h3>{renderJobs(failedJobs, 'failedEmpty')}</section></div></section>
      <Dialog open={createOpen} title={t(`${copyKey}.workspace.create.title`)} closeLabel={t(`${copyKey}.common.close`)} onClose={resetCreate} footer={<><Button onClick={resetCreate}>{t(`${copyKey}.common.cancel`)}</Button><Button type="submit" form="create-dataset-form" variant="primary">{t(`${copyKey}.workspace.create.submit`)}</Button></>}><form id="create-dataset-form" className="workspace-dialog-form" onSubmit={event => void createDataset(event)}><Field label={t(`${copyKey}.workspace.datasetName.label`)} htmlFor="create-dataset-name" required><input id="create-dataset-name" autoFocus value={createName} onChange={event => setCreateName(event.target.value)} /></Field><Field label={t(`${copyKey}.workspace.datasets.purposeLabel`)} htmlFor="create-dataset-purpose" required><select id="create-dataset-purpose" value={createPurpose} onChange={event => setCreatePurpose(event.target.value as DatasetPurpose)}><option value="Production">{t(`${copyKey}.workspace.datasets.purpose.Production`)}</option><option value="Validation">{t(`${copyKey}.workspace.datasets.purpose.Validation`)}</option></select></Field><Field label={t(`${copyKey}.workspace.datasetNote.label`)} htmlFor="create-dataset-note"><textarea id="create-dataset-note" value={createNote} onChange={event => setCreateNote(event.target.value)} /></Field>{createMutation.isError ? <p className="field__error" role="alert">{apiErrorMessage(createMutation.error, locale)}</p> : null}</form></Dialog>
      <Dialog open={renameTarget !== null} title={t(`${copyKey}.workspace.rename.title`)} closeLabel={t(`${copyKey}.common.close`)} onClose={() => setRenameTarget(null)} footer={<><Button onClick={() => setRenameTarget(null)}>{t(`${copyKey}.common.cancel`)}</Button><Button type="submit" form="rename-dataset-form" variant="primary">{t(`${copyKey}.workspace.rename.submit`)}</Button></>}><form id="rename-dataset-form" className="workspace-dialog-form" onSubmit={event => void renameDataset(event)}><Field label={t(`${copyKey}.workspace.datasetName.label`)} htmlFor="rename-dataset-name" required><input id="rename-dataset-name" value={renameName} onChange={event => setRenameName(event.target.value)} /></Field><Field label={t(`${copyKey}.workspace.datasetNote.label`)} htmlFor="rename-dataset-note"><textarea id="rename-dataset-note" value={renameNote} onChange={event => setRenameNote(event.target.value)} /></Field>{updateMutation.isError ? <p className="field__error" role="alert">{apiErrorMessage(updateMutation.error, locale)}</p> : null}</form></Dialog>
      <ConfirmDialog open={disableTarget !== null} title={t(`${copyKey}.workspace.disable.title`)} body={t(`${copyKey}.workspace.disable.body`, { name: disableTarget?.name ?? '' })} confirmLabel={t(`${copyKey}.workspace.disable.confirm`)} cancelLabel={t(`${copyKey}.common.cancel`)} closeLabel={t(`${copyKey}.common.close`)} onConfirm={() => void disableDataset()} onClose={() => setDisableTarget(null)} />
    </div>
  );
}
