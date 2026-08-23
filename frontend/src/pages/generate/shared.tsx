import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import { Button, ConfirmDialog, PageHeader } from '../../components';
import { apiErrorMessage } from '../../api/client';
import { generationText, type GenerationKey } from '../../locales/features/generation';
import { usePreferences } from '../../preferences';
import type {
  Age,
  Ethnicity,
  Gender,
  JobEvent,
  JobStatus,
  TestComparisonInput,
  TestExecutionMode,
} from '../../api/contracts';
import type {
  Category,
  ConflictDirection,
  Locale,
  ModelName,
  ModelPrecision,
} from '../../types';

export const categories: Category[] = ['A-VA', 'A-VT', 'C-VA', 'C-VT'];
export const ages: Age[] = [25, 35, 45, 60];
export const genders: Gender[] = ['Male', 'Female'];
export const ethnicities: Ethnicity[] = ['EastAsian', 'White', 'Black', 'SouthAsian', 'Latino'];

const draftPrefix = 'conflictstudio.generation.';
const hiddenTestsKey = 'conflictstudio.generation.hiddenTests';

export const testCopyDraftKey = 'test-copy';

export interface TestCopyDraft {
  kind: 'PromptTest' | 'VideoTest';
  category: Category;
  conflictDirection: ConflictDirection | null;
  contentScriptId: number;
  sceneId: number;
  promptTemplateVersionId: number;
  age: Age;
  gender: Gender;
  ethnicity: Ethnicity;
  seed: number;
  model: ModelName;
  precision: ModelPrecision | null;
  comparisons: TestComparisonInput[];
  executionMode: TestExecutionMode;
}

export function useGenerationCopy() {
  const locale = usePreferences().locale;
  return useCallback(
    (key: GenerationKey, values?: Record<string, string | number>) => generationText(locale, key, values),
    [locale],
  );
}

export function useGenerationLocale(): Locale {
  return usePreferences().locale;
}

export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

export function localizedName(locale: Locale, value: { nameZh: string; nameEn: string }): string {
  return locale === 'zh-CN' ? value.nameZh : value.nameEn;
}

export function categoryLabel(g: ReturnType<typeof useGenerationCopy>, category: Category): string {
  return g(('category.' + category) as GenerationKey);
}

export function directionLabel(
  g: ReturnType<typeof useGenerationCopy>,
  direction: ConflictDirection | null,
): string {
  return direction ? g(('direction.' + direction) as GenerationKey) : g('common.none');
}

export function profileLabel(model: ModelName | null, precision: ModelPrecision | null): string {
  if (model === null) return '';
  return precision === null ? model : model + ' ' + precision;
}

export function jobStatusKind(status: JobStatus) {
  if (status === 'Running') return 'active' as const;
  if (status === 'Completed') return 'complete' as const;
  if (status === 'Failed' || status === 'Cancelled') return 'problem' as const;
  return 'neutral' as const;
}

export function jobFailureMessage(code: string | null, g: ReturnType<typeof useGenerationCopy>): string {
  if (code === 'interrupted_by_restart') return g('results.failure.interrupted');
  if (code?.startsWith('gpu_')) return g('results.failure.gpu');
  if (code?.startsWith('prompt_') || code?.startsWith('llm_')) return g('results.failure.prompt');
  if (code?.startsWith('media_') || code?.startsWith('ffmpeg_')) return g('results.failure.media');
  if (code?.startsWith('model_') || code?.startsWith('renderer_')) return g('results.failure.render');
  return g('results.failure.general');
}

export function parseSeeds(value: string): number[] | null {
  const tokens = value.split(/[\s,]+/u).filter(Boolean);
  if (tokens.length === 0) return null;
  const values = tokens.map(token => Number(token));
  if (values.some(seed => !Number.isInteger(seed) || seed < 0 || seed >= 2 ** 31)) return null;
  return [...new Set(values)];
}

export function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}

export function readSessionDraft<T>(key: string): T | null {
  const value = window.sessionStorage.getItem(draftPrefix + key);
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    window.sessionStorage.removeItem(draftPrefix + key);
    return null;
  }
}

export function writeSessionDraft<T>(key: string, value: T): void {
  window.sessionStorage.setItem(draftPrefix + key, JSON.stringify(value));
}

export function takeSessionDraft<T>(key: string): T | null {
  const value = readSessionDraft<T>(key);
  window.sessionStorage.removeItem(draftPrefix + key);
  return value;
}

export function hiddenTestIds(): number[] {
  const value = window.localStorage.getItem(hiddenTestsKey);
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(item => Number.isInteger(item)) as number[] : [];
  } catch {
    window.localStorage.removeItem(hiddenTestsKey);
    return [];
  }
}

export function hideTestResult(id: number): number[] {
  const values = [...new Set([...hiddenTestIds(), id])];
  window.localStorage.setItem(hiddenTestsKey, JSON.stringify(values));
  return values;
}

export function GenerationScaffold({
  title,
  subtitle,
  children,
}: {
  title: GenerationKey;
  subtitle: GenerationKey;
  children: ReactNode;
}) {
  const g = useGenerationCopy();
  return (
    <div className="page-stack generation-page">
      <PageHeader title={g(title)} />
      <p className="generation-page__subtitle">{g(subtitle)}</p>
      {children}
    </div>
  );
}

export function OperationFeedback({ error, onDismiss }: { error: unknown; onDismiss: () => void }) {
  const g = useGenerationCopy();
  const locale = usePreferences().locale;
  return (
    <section className="generation-feedback" role="alert">
      <div>
        <h2>{g('feedback.title')}</h2>
        <p>{apiErrorMessage(error, locale)}</p>
      </div>
      <Button variant="quiet" onClick={onDismiss}>{g('common.close')}</Button>
    </section>
  );
}

export function RelationshipGuide({ production }: { production: boolean }) {
  const g = useGenerationCopy();
  return (
    <details className="generation-guide">
      <summary>{g('guide.title')}</summary>
      <p>{g('guide.summary')}</p>
      <ol className="generation-guide__flow">
        <li><strong>{g('guide.content')}</strong><span>{g('guide.contentBody')}</span></li>
        <li><strong>{g('guide.scene')}</strong><span>{g('guide.sceneBody')}</span></li>
        <li><strong>{g('guide.version')}</strong><span>{g('guide.versionBody')}</span></li>
        <li><strong>{g('guide.final')}</strong><span>{g('guide.finalBody')}</span></li>
      </ol>
      <p>{g(production ? 'guide.productionBoundary' : 'guide.testBoundary')}</p>
    </details>
  );
}

export function useUnsavedChanges(dirty: boolean) {
  const [open, setOpen] = useState(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && currentLocation.pathname + currentLocation.search !== nextLocation.pathname + nextLocation.search,
  );

  useEffect(() => {
    setOpen(blocker.state === 'blocked');
  }, [blocker.state]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const g = useGenerationCopy();
  return (
    <ConfirmDialog
      open={open}
      title={g('production.unsaved')}
      body={g('production.unsaved')}
      confirmLabel={g('common.confirm')}
      cancelLabel={g('common.cancel')}
      closeLabel={g('common.close')}
      onConfirm={() => {
        setOpen(false);
        if (blocker.state === 'blocked') blocker.proceed();
      }}
      onClose={() => {
        setOpen(false);
        if (blocker.state === 'blocked') blocker.reset();
      }}
    />
  );
}

export function collapseProgressEvents(events: readonly JobEvent[]): JobEvent[] {
  const collapsed: JobEvent[] = [];
  for (const event of events) {
    const previous = collapsed[collapsed.length - 1];
    if (
      event.eventType === 'ItemRenderProgress'
      && previous?.eventType === 'ItemRenderProgress'
      && previous.itemId === event.itemId
    ) {
      collapsed[collapsed.length - 1] = event;
    } else {
      collapsed.push(event);
    }
  }
  return collapsed;
}
