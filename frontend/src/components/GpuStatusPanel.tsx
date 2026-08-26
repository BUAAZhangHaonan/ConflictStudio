import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { StatusBadge } from '.';
import { generationQueries } from '../api/queries';
import type { GpuSlot } from '../api/contracts';

const copyKey = 'workspaceSettingsStatistics';
const terminalItemStatuses = ['Completed', 'Failed', 'Cancelled'];

type Translate = ReturnType<typeof useTranslation>['t'];

function slotBadge(gpu: GpuSlot): { labelKey: string; kind: 'neutral' | 'active' } {
  if (gpu.serviceStatus !== 'running') return { labelKey: 'serviceStopped', kind: 'neutral' };
  if (gpu.availability === 'Available') return { labelKey: 'onlineIdle', kind: 'active' };
  return { labelKey: 'onlineBusy', kind: 'neutral' };
}

function gigabytes(mib: number): string {
  return (mib / 1024).toFixed(1) + ' GB';
}

function formatDuration(t: Translate, ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes >= 60) {
    return t(`${copyKey}.workspace.gpuStatus.durationHours`, {
      hours: Math.floor(minutes / 60),
      minutes: minutes % 60,
    });
  }
  return t(`${copyKey}.workspace.gpuStatus.durationMinutes`, { minutes, seconds: totalSeconds % 60 });
}

function GpuSlotCard({ gpu }: { gpu: GpuSlot }) {
  const { t } = useTranslation();
  const badge = slotBadge(gpu);
  const jobId = gpu.activeJobId;
  const jobQuery = useQuery({
    ...generationQueries.gpuPanelJob(jobId ?? 0),
    enabled: jobId !== null,
  });
  const job = jobQuery.data ?? null;
  const kind = job !== null && job.source === 'Production' ? 'production' : 'test';
  const itemsQuery = useQuery({
    ...generationQueries.resultItems(kind, jobId ?? 0, 1),
    enabled: jobId !== null && job !== null,
    refetchInterval: 5000,
  });
  const progressQuery = useQuery({
    ...generationQueries.jobLatestProgress(jobId ?? 0),
    enabled: jobId !== null,
  });

  const progressEvents = progressQuery.data ?? [];
  const latest = progressEvents[0];
  const previous = progressEvents[1];
  let percent: number | null = null;
  let etaMs: number | null = null;
  if (
    latest !== undefined
    && latest.payload.progressValue !== null
    && latest.payload.progressMaximum !== null
    && latest.payload.progressMaximum > 0
  ) {
    const value = latest.payload.progressValue;
    const maximum = latest.payload.progressMaximum;
    percent = Math.round((value / maximum) * 100);
    if (previous !== undefined && previous.payload.progressValue !== null) {
      const elapsedMs = Date.parse(latest.createdAt) - Date.parse(previous.createdAt);
      const delta = value - previous.payload.progressValue;
      if (elapsedMs > 0 && delta > 0) etaMs = ((maximum - value) / delta) * elapsedMs;
    }
  }
  let stageLabel: string | null = null;
  if (percent === null) {
    const item = (itemsQuery.data?.items ?? [])
      .find(candidate => !terminalItemStatuses.includes(candidate.status));
    if (item !== undefined) stageLabel = t(`${copyKey}.workspace.gpuStatus.stages.${item.stage}`);
  }
  const elapsedMs = job !== null && job.startedAt !== null
    ? Date.now() - Date.parse(job.startedAt)
    : null;

  const memoryUsed = gpu.memory.usedMiB;
  const memoryTotal = gpu.memory.totalMiB;
  const hasMemory = memoryUsed !== null && memoryTotal !== null && memoryTotal > 0;

  return (
    <article className="gpu-status__card">
      <div className="gpu-status__head">
        <h3 className="gpu-status__name">{gpu.slot}{gpu.gpuName ? ` - ${gpu.gpuName}` : ''}</h3>
        <StatusBadge
          label={t(`${copyKey}.workspace.gpuStatus.${badge.labelKey}`)}
          kind={badge.kind}
        />
      </div>
      {gpu.statusReason ? <p className="gpu-status__reason">{gpu.statusReason}</p> : null}
      <dl className="gpu-status__meta">
        <div>
          <dt>{t(`${copyKey}.workspace.gpuStatus.model`)}</dt>
          <dd>{gpu.loadedModel
            ? `${gpu.loadedModel}${gpu.loadedPrecision ? ' ' + gpu.loadedPrecision : ''}`
            : t(`${copyKey}.workspace.gpuStatus.noModel`)}</dd>
        </div>
        {hasMemory ? (
          <div>
            <dt>{t(`${copyKey}.workspace.gpuStatus.memory`)}</dt>
            <dd>
              <span className="gpu-status__memory">
                <span className="gpu-status__bar">
                  <span
                    className="gpu-status__bar-fill"
                    style={{ width: Math.min(100, Math.round(((memoryUsed as number) / (memoryTotal as number)) * 100)) + '%' }}
                  />
                </span>
                <span>{gigabytes(memoryUsed as number)} / {gigabytes(memoryTotal as number)}</span>
              </span>
            </dd>
          </div>
        ) : null}
      </dl>
      {jobId !== null && job !== null ? (
        <div className="gpu-status__job">
          <p className="gpu-status__job-line">
            <span>{t(`${copyKey}.workspace.gpuStatus.jobLabel`)}</span>
            <Link to={`/generate/results?tab=${kind}&jobId=${job.id}`}>{job.displayName}</Link>
          </p>
          <p className="gpu-status__job-line">
            <span>{t(`${copyKey}.workspace.gpuStatus.dataset`)}</span>
            {job.datasetId !== null && job.datasetNameSnapshot
              ? <Link to={`/review?datasetId=${job.datasetId}`}>{job.datasetNameSnapshot}</Link>
              : t(`${copyKey}.workspace.gpuStatus.noDataset`)}
          </p>
          {percent !== null || stageLabel !== null ? (
            <p className="gpu-status__job-line">
              <span>{t(`${copyKey}.workspace.gpuStatus.progress`)}</span>
              {percent !== null ? <strong>{percent}%</strong> : <strong>{stageLabel}</strong>}
            </p>
          ) : null}
          {percent !== null && etaMs !== null ? (
            <p className="gpu-status__job-note">
              {t(`${copyKey}.workspace.gpuStatus.eta`, { value: formatDuration(t, etaMs) })}
            </p>
          ) : null}
          {elapsedMs !== null ? (
            <p className="gpu-status__job-note">
              {t(`${copyKey}.workspace.gpuStatus.elapsed`, { value: formatDuration(t, elapsedMs) })}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function GpuStatusPanel() {
  const { t } = useTranslation();
  const gpuQuery = useQuery({
    ...generationQueries.gpuSlots(),
    refetchInterval: 5000,
  });

  return (
    <section className="panel gpu-status-panel" aria-labelledby="gpu-status-title">
      <div className="section-header">
        <h2 id="gpu-status-title">{t(`${copyKey}.workspace.gpuStatus.title`)}</h2>
      </div>
      {gpuQuery.isError ? (
        <p className="field__error" role="alert">{t(`${copyKey}.workspace.gpuStatus.error`)}</p>
      ) : gpuQuery.isPending ? (
        <p className="gpu-status__loading" role="status">
          <span className="state-view__progress" aria-hidden="true" />
          {t(`${copyKey}.common.state.loading.body`)}
        </p>
      ) : (
        <div className="gpu-status">
          {(gpuQuery.data ?? []).map(gpu => <GpuSlotCard key={gpu.slot} gpu={gpu} />)}
        </div>
      )}
    </section>
  );
}
