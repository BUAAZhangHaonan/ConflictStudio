import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useBlocker, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, ConfirmDialog, PageHeader, StatusBadge, useToast } from '../../components';
import { generationText, type GenerationKey } from '../../locales/features/generation';
import { useMockRepository, useRepositorySnapshot } from '../../store';
import { formatDateTime } from '../../time';
import { composeVideoGenerationInput } from '../../generation';
import type {
  Category,
  ContentItem,
  ConflictDirection,
  ExamplePageState,
  GpuAvailability,
  JobStatus,
  JobStepStatus,
  ModelName,
  Preset,
  RepositoryFailureKind,
} from '../../types';

export const categories: Category[] = ['A-VA', 'A-VT', 'C-VA', 'C-VT'];
export const models = ['LTX-2.3', 'MiniMax H3'] as const;
export const ages = [25, 35, 45, 60] as const;
export const genders = ['Male', 'Female'] as const;
export const ethnicities = ['EastAsian', 'White', 'Black', 'SouthAsian', 'Latino'] as const;

const draftPrefix = 'conflictstudio.generation.draft.';
export function useGenerationCopy() {
  const locale = useRepositorySnapshot().preferences.locale;
  return useCallback(
    (key: GenerationKey, values?: Record<string, string | number>) => generationText(locale, key, values),
    [locale],
  );
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
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && `${currentLocation.pathname}${currentLocation.search}` !== `${nextLocation.pathname}${nextLocation.search}`,
  );

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm(g('generate.leaveConfirm'))) blocker.proceed();
    else blocker.reset();
  }, [blocker, g]);

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

export function useGenerationQueryState(): ExamplePageState {
  const [params] = useSearchParams();
  const value = params.get('state');
  if (value === null || value === 'normal' || value === 'ready') return 'ready';
  if (value === 'loading' || value === 'empty' || value === 'filtered' || value === 'error' || value === 'conflict') {
    return value;
  }
  return 'ready';
}

export function GenerationState({ state }: { state: Exclude<ExamplePageState, 'ready'> }) {
  const g = useGenerationCopy();
  const navigate = useNavigate();
  const location = useLocation();
  const canAct = state === 'filtered' || state === 'error' || state === 'conflict';
  return (
    <section
      className="panel generation-state"
      role={state === 'error' || state === 'conflict' ? 'alert' : 'status'}
      aria-label={g('state.region')}
      aria-live={state === 'error' || state === 'conflict' ? 'assertive' : 'polite'}
      aria-busy={state === 'loading' || undefined}
    >
      {state === 'loading' ? <span className="state-view__progress" aria-hidden="true" /> : null}
      <h2>{g(`state.${state}Title` as GenerationKey)}</h2>
      <p>{g(`state.${state}Body` as GenerationKey)}</p>
      {canAct ? (
        <Button variant="secondary" onClick={() => navigate(location.pathname, { replace: true })}>
          {g(state === 'filtered' ? 'common.clearFilters' : 'common.retry')}
        </Button>
      ) : null}
    </section>
  );
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
  const state = useGenerationQueryState();
  return (
    <div className="page-stack generation-page">
      <PageHeader title={g(title)} actions={state === 'ready' ? action : undefined} />
      <p className="generation-page__subtitle">{g(subtitle)}</p>
      {state === 'ready' ? children : <GenerationState state={state} />}
    </div>
  );
}

export function OperationFeedback({
  kind,
  onDismiss,
}: {
  kind: RepositoryFailureKind;
  onDismiss: () => void;
}) {
  const g = useGenerationCopy();
  const conflict = kind === 'Conflict';
  return (
    <section className="generation-feedback" role="alert">
      <div>
        <h2>{g(conflict ? 'feedback.conflictTitle' : 'feedback.errorTitle')}</h2>
        <p>{g(conflict ? 'feedback.conflictBody' : 'feedback.errorBody')}</p>
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

export function GpuPanel() {
  const g = useGenerationCopy();
  const repository = useMockRepository();
  const snapshot = useRepositorySnapshot();
  const { showToast } = useToast();
  const [releaseSlot, setReleaseSlot] = useState<null | 'GPU0' | 'GPU1'>(null);
  const [releaseFailed, setReleaseFailed] = useState(false);
  const releaseGpu = snapshot.data.gpuStates.find(gpu => gpu.slot === releaseSlot) ?? null;

  const confirmRelease = () => {
    if (!releaseSlot) return;
    const result = repository.releaseGpu(releaseSlot);
    setReleaseSlot(null);
    if (!result.ok) {
      setReleaseFailed(true);
      return;
    }
    setReleaseFailed(false);
    showToast(g('gpu.released', { gpu: g(`gpu.${result.value}` as GenerationKey) }));
  };

  return (
    <>
      <section className="panel generation-gpus" aria-labelledby="generation-gpus-title">
        <div className="section-header"><h2 id="generation-gpus-title">{g('gpu.title')}</h2></div>
        {releaseFailed ? <p className="field__error" role="alert">{g('gpu.releaseUnavailable')}</p> : null}
        <div className="generation-gpus__grid">
          {snapshot.data.gpuStates.map(gpu => (
            <article key={gpu.slot} className="generation-gpu-card">
              <div>
                <strong>{g(`gpu.${gpu.slot}` as GenerationKey)}</strong>
                <StatusBadge label={g(`gpu.${gpu.availability}` as GenerationKey)} kind={availabilityKind(gpu.availability)} />
              </div>
              <p>{gpu.loadedModel ? g('gpu.loadedModel', { model: g(`model.${gpu.loadedModel}` as GenerationKey) }) : g('gpu.noModel')}</p>
              <p>{g('gpu.checked', { time: formatDateTime(gpu.checkedAt) })}</p>
              {gpu.availability === 'Available' && gpu.loadedModel ? (
                <Button variant="quiet" onClick={() => {
                  setReleaseFailed(false);
                  setReleaseSlot(gpu.slot);
                }}>
                  {g('gpu.release')}
                </Button>
              ) : null}
            </article>
          ))}
        </div>
      </section>
      <ConfirmDialog
        open={releaseGpu !== null}
        title={g('gpu.releaseTitle')}
        body={releaseGpu?.loadedModel
          ? g('gpu.releaseBody', {
              gpu: g(`gpu.${releaseGpu.slot}` as GenerationKey),
              model: g(`model.${releaseGpu.loadedModel}` as GenerationKey),
            })
          : g('gpu.releaseUnavailable')}
        confirmLabel={g('gpu.release')}
        cancelLabel={g('common.cancel')}
        closeLabel={g('common.close')}
        onConfirm={confirmRelease}
        onClose={() => setReleaseSlot(null)}
      />
    </>
  );
}

export function VideoPromptPreview({
  content,
  preset,
}: {
  content: Pick<ContentItem, 'videoPrompt' | 'sceneSupplement'>;
  preset: Pick<Preset, 'styleInstruction' | 'sceneSupplement' | 'renderNegativeConstraints'>;
}) {
  const g = useGenerationCopy();
  const input = composeVideoGenerationInput(content, preset);
  return (
    <section className="generation-prompt-preview" aria-labelledby="video-prompt-preview-title">
      <div className="section-header"><h3 id="video-prompt-preview-title">{g('promptPreview.title')}</h3></div>
      <div className="generation-prompt-preview__field">
        <strong>{g('promptPreview.positive')}</strong>
        <pre>{input.positivePrompt || g('promptPreview.empty')}</pre>
      </div>
      <div className="generation-prompt-preview__field">
        <strong>{g('promptPreview.negative')}</strong>
        <pre>{input.negativePrompt || g('promptPreview.empty')}</pre>
      </div>
      <p>{g('promptPreview.note')}</p>
    </section>
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

export function jobStatusKind(status: JobStatus | JobStepStatus) {
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
