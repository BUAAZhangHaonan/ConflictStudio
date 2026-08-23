import { ApiError } from '../../api/client';
import type {
  JobDetail,
  JobItem,
  JobProfile,
  JobSource,
  JobStatus,
  TestComparisonInput,
} from '../../api/contracts';
import { formatDateTime } from '../../time';
import { protocolForCategory } from '../../types';
import type { TestCopyDraft } from './shared';

export type ResultKind = 'test' | 'production';
export type ResultListState = 'loading' | 'networkError' | 'serviceError' | 'filteredEmpty' | 'empty' | 'ready';
export type ResultMediaRole = 'vaAudiovisual' | 'vtSourceAudio' | 'vtSilentPrimary';

export interface ResultMedia {
  role: ResultMediaRole;
  src: string;
  muted: boolean;
}

export function resultKind(value: string | null): ResultKind {
  return value === 'production' ? 'production' : 'test';
}

export function resultTaskName(source: JobSource, createdAt: string, labels: Record<JobSource, string>): string {
  return labels[source] + ' ' + formatDateTime(createdAt);
}

export function completedProgress(value: Pick<JobDetail, 'completedCount' | 'failedCount' | 'totalCount'>) {
  return {
    current: value.completedCount + value.failedCount,
    total: value.totalCount,
  };
}

export function profileText(profile: JobProfile): string {
  return profile.precision === null ? profile.model : profile.model + ' ' + profile.precision;
}

export function profilesText(
  profiles: readonly JobProfile[],
  fallbackModel: JobProfile['model'] | null = null,
  fallbackPrecision: JobProfile['precision'] = null,
): string {
  if (profiles.length > 0) return profiles.map(profileText).join(', ');
  return fallbackModel === null
    ? ''
    : profileText({ model: fallbackModel, precision: fallbackPrecision });
}

export function controlVisibility(status: JobStatus, selectedFailedCount: number) {
  return {
    cancel: status === 'Queued' || status === 'Running',
    resume: status === 'Interrupted',
    retry: status === 'Failed' && selectedFailedCount > 0,
  };
}

export function failedItemRevisions(items: readonly JobItem[], selectedIds: readonly number[]): Record<string, number> {
  const selected = new Set(selectedIds);
  return Object.fromEntries(
    items
      .filter(item => item.status === 'Failed' && selected.has(item.id))
      .map(item => [String(item.id), item.revision]),
  );
}

export function resultListState(options: {
  pending: boolean;
  error: unknown;
  total: number;
  statusFiltered: boolean;
}): ResultListState {
  if (options.pending) return 'loading';
  if (options.error instanceof ApiError && options.error.transport === 'network') return 'networkError';
  if (options.error !== null && options.error !== undefined) return 'serviceError';
  if (options.total === 0) return options.statusFiltered ? 'filteredEmpty' : 'empty';
  return 'ready';
}

export function mediaForItem(item: JobItem): ResultMedia[] {
  if (protocolForCategory(item.input.category) === 'VA') {
    return item.primaryAssetUrl
      ? [{ role: 'vaAudiovisual', src: item.primaryAssetUrl, muted: false }]
      : [];
  }
  const media: ResultMedia[] = [];
  if (item.sourceAssetUrl) media.push({ role: 'vtSourceAudio', src: item.sourceAssetUrl, muted: false });
  if (item.primaryAssetUrl) media.push({ role: 'vtSilentPrimary', src: item.primaryAssetUrl, muted: true });
  return media;
}

export function buildTestDraft(detail: JobDetail, items: readonly JobItem[]): TestCopyDraft | null {
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
        && value.gpuSlot === comparison.gpuSlot
      )) comparisons.push(comparison);
    }
    if (comparisons.length === 0 || comparisons.length > 2) return null;
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
    executionMode: comparisons.length > 1
      && new Set(comparisons.map(item => item.gpuSlot)).size === 1
      ? 'Serial'
      : 'Parallel',
  };
}
