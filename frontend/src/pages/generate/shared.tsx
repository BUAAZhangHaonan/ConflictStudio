import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import { Button, ConfirmDialog, PageHeader, StatusBadge } from '../../components';
import { apiErrorMessage } from '../../api/client';
import { useGpuSlotsQuery, useReleaseGpuMutation } from '../../api/queries';
import { generationText, type GenerationKey } from '../../locales/features/generation';
import { useRepositorySnapshot } from '../../store';
import { formatDateTime } from '../../time';
import type {
  Category,
  ConflictDirection,
  Locale,
  ModelName,
} from '../../types';
import type { GpuAvailability, GpuSlot, JobStatus } from '../../api/contracts';

export const categories: Category[] = ['A-VA', 'A-VT', 'C-VA', 'C-VT'];
export { models } from '../../generationProfile';
export const ages = [25, 35, 45, 60] as const;
export const genders = ['Male', 'Female'] as const;
export const ethnicities = ['EastAsian', 'White', 'Black', 'SouthAsian', 'Latino'] as const;
export const emotions = ['neutral', 'joy', 'sadness', 'anger', 'fear', 'surprise', 'disgust'] as const;

const draftPrefix = 'conflictstudio.generation.draft.';
export function useGenerationCopy() {
  const locale = useRepositorySnapshot().preferences.locale;
  return useCallback(
    (key: GenerationKey, values?: Record<string, string | number>) => generationText(locale, key, values),
    [locale],
  );
}

export function useGenerationLocale(): Locale {
  return useRepositorySnapshot().preferences.locale;
}

export function localizedName(
  locale: Locale,
  value: { nameZh: string; nameEn: string },
): string {
  return locale === 'zh-CN' ? value.nameZh : value.nameEn;
}

export function readGenerationDraft<T>(key: string): T | null {
  const value = window.sessionStorage.getItem(`${draftPrefix}${key}`);
  return value ? (JSON.parse(value) as T) : null;
}

export function saveGenerationDraft<T>(key: string, value: T): void {
  window.sessionStorage.setItem(`${draftPrefix}${key}`, JSON.stringify(value));
}

export function useGenerationDraft<T>(key: string, value: T, dirty: boolean) {
  useEffect(() => {
    const storageKey = `${draftPrefix}${key}`;
    if (dirty) window.sessionStorage.setItem(storageKey, JSON.stringify(value));
    else window.sessionStorage.removeItem(storageKey);
  }, [dirty, key, value]);
}

export function useUnsavedChanges(dirty: boolean) {
  const g = useGenerationCopy();
  const [leaveOpen, setLeaveOpen] = useState(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && `${currentLocation.pathname}${currentLocation.search}` !== `${nextLocation.pathname}${nextLocation.search}`,
  );

  useEffect(() => {
    setLeaveOpen(blocker.state === 'blocked');
  }, [blocker.state]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = g('generate.leaveConfirm');
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty, g]);

  return (
    <ConfirmDialog
      open={leaveOpen}
      title={g('generate.leaveTitle')}
      body={g('generate.leaveConfirm')}
      confirmLabel={g('generate.leaveAction')}
      cancelLabel={g('common.cancel')}
      closeLabel={g('common.close')}
      onConfirm={() => {
        setLeaveOpen(false);
        if (blocker.state === 'blocked') blocker.proceed();
      }}
      onClose={() => {
        setLeaveOpen(false);
        if (blocker.state === 'blocked') blocker.reset();
      }}
    />
  );
}

export function useCommandEnter(action: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey) || event.isComposing) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [action, enabled]);
}

export function GenerationScaffold({
  title,
  subtitle,
  action,
  children,
}: {
  title: GenerationKey;
  subtitle: GenerationKey;
  action?: ReactNode;
  children: ReactNode;
}) {
  const g = useGenerationCopy();
  return (
    <div className="page-stack generation-page">
      <PageHeader title={g(title)} actions={action} />
      <p className="generation-page__subtitle">{g(subtitle)}</p>
      {children}
    </div>
  );
}

export function OperationFeedback({
  error,
  onDismiss,
}: {
  error: unknown;
  onDismiss: () => void;
}) {
  const g = useGenerationCopy();
  const locale = useRepositorySnapshot().preferences.locale;
  return (
    <section className="generation-feedback" role="alert">
      <div>
        <h2>{g('feedback.errorTitle')}</h2>
        <p>{apiErrorMessage(error, locale)}</p>
      </div>
      <Button variant="quiet" onClick={onDismiss} aria-label={g('feedback.dismiss')} title={g('feedback.dismiss')}>
        {g('common.close')}
      </Button>
    </section>
  );
}

function availabilityKind(status: GpuAvailability) {
  if (status === 'Available') return 'complete' as const;
  if (status === 'Reserved') return 'active' as const;
  if (status === 'ExternalOccupied') return 'problem' as const;
  return 'neutral' as const;
}

export function GpuPanel({ description }: { description?: GenerationKey } = {}) {
  const g = useGenerationCopy();
  const gpuQuery = useGpuSlotsQuery();
  const releaseMutation = useReleaseGpuMutation();
  const [releaseTarget, setReleaseTarget] = useState<GpuSlot | null>(null);

  const release = () => {
    if (!releaseTarget) return;
    releaseMutation.mutate(
      {
        slot: releaseTarget.slot,
        expectedRevision: releaseTarget.revision,
      },
      { onSettled: () => setReleaseTarget(null) },
    );
  };

  return (
    <>
    <section className="panel generation-gpus" aria-labelledby="generation-gpus-title">
      <div className="section-header"><h2 id="generation-gpus-title">{g('gpu.title')}</h2></div>
      {description ? <p className="generation-section-note">{g(description)}</p> : null}
      {gpuQuery.isPending ? <p role="status">{g('state.loadingBody')}</p> : null}
      {gpuQuery.isError ? <OperationFeedback error={gpuQuery.error} onDismiss={() => void gpuQuery.refetch()} /> : null}
      {releaseMutation.isError ? <OperationFeedback error={releaseMutation.error} onDismiss={() => releaseMutation.reset()} /> : null}
      <div className="generation-gpus__grid">
        {(gpuQuery.data ?? []).map(gpu => (
            <article key={gpu.slot} className="generation-gpu-card">
              <div>
                <strong>{g(`gpu.${gpu.slot}` as GenerationKey)}</strong>
                <StatusBadge label={g(`gpu.${gpu.availability}` as GenerationKey)} kind={availabilityKind(gpu.availability)} />
              </div>
              <p>{gpu.loadedModel ? g('gpu.loadedModel', { model: gpu.loadedPrecision ? `${gpu.loadedModel} ${gpu.loadedPrecision}` : gpu.loadedModel }) : g('gpu.noModel')}</p>
              <p>{g(`gpu.service.${gpu.serviceStatus}` as GenerationKey)}</p>
              {gpu.statusReason ? <p>{g('gpu.statusReason', { reason: gpu.statusReason })}</p> : null}
              {gpu.gpuName ? <p>{g('gpu.hardware', { name: gpu.gpuName })}</p> : null}
              <p>{gpu.memory.usedMiB !== null && gpu.memory.totalMiB !== null
                ? g('gpu.memory', { used: gpu.memory.usedMiB, total: gpu.memory.totalMiB })
                : g('gpu.memoryUnknown')}</p>
              <p>{g('gpu.checked', { time: formatDateTime(gpu.checkedAt) })}</p>
              {gpu.loadedModel ? <Button variant="quiet" disabled={gpu.availability !== 'Available' || gpu.activeJobId !== null || releaseMutation.isPending} onClick={() => setReleaseTarget(gpu)}>{g('gpu.release')}</Button> : null}
            </article>
        ))}
      </div>
    </section>
    <ConfirmDialog open={releaseTarget !== null} title={g('gpu.releaseTitle')} body={releaseTarget ? g('gpu.releaseBody', { model: releaseTarget.loadedPrecision ? `${releaseTarget.loadedModel ?? ''} ${releaseTarget.loadedPrecision}` : releaseTarget.loadedModel ?? '', gpu: releaseTarget.slot }) : ''} confirmLabel={g('common.yes')} cancelLabel={g('common.no')} closeLabel={g('common.close')} onConfirm={release} onClose={() => setReleaseTarget(null)} />
    </>
  );
}

export function modelSpecLabel(g: ReturnType<typeof useGenerationCopy>, model: ModelName): string {
  return g(`output.${model}` as GenerationKey);
}

export function categoryLabel(g: ReturnType<typeof useGenerationCopy>, category: Category): string {
  return g(`category.${category}` as GenerationKey);
}

export function directionLabel(g: ReturnType<typeof useGenerationCopy>, direction: ConflictDirection | null): string {
  return direction ? g(`direction.${direction}` as GenerationKey) : g('common.none');
}

export function jobStatusKind(status: JobStatus) {
  if (status === 'Running') return 'active' as const;
  if (status === 'Completed') return 'complete' as const;
  if (status === 'Failed' || status === 'Cancelled') return 'problem' as const;
  return 'neutral' as const;
}

export function parseSeed(value: string): number | null {
  const clean = value.trim();
  return clean === '' ? null : Number.parseInt(clean, 10);
}

export function lines(value: string): string[] {
  return value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
}

export function toggleArrayValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}
