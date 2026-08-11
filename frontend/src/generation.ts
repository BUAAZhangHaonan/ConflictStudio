import type {
  BatchAllocation,
  BatchDraft,
  ContentItem,
  GpuSlot,
  GpuState,
  Job,
  JobItem,
  JobStatus,
  PreparedTest,
  Preset,
  Sample,
  TestDraft,
} from './types';

export interface VideoGenerationInput {
  positivePrompt: string;
  negativePrompt: string;
}

export function composeVideoGenerationInput(
  content: Pick<ContentItem, 'videoPrompt' | 'sceneSupplement'>,
  preset: Pick<Preset, 'styleInstruction' | 'sceneSupplement' | 'renderNegativeConstraints'>,
): VideoGenerationInput {
  return {
    positivePrompt: [
      content.videoPrompt,
      content.sceneSupplement,
      preset.styleInstruction,
      preset.sceneSupplement,
    ].map(value => value.trim()).filter(Boolean).join('\n\n'),
    negativePrompt: preset.renderNegativeConstraints.trim(),
  };
}

export function contentIsReferenced(
  contentId: string,
  jobs: readonly Job[],
  samples: readonly Sample[],
): boolean {
  return jobs.some(job =>
    job.batchInput?.draft.contentItemIds.includes(contentId)
    || job.testInput?.contentItemId === contentId,
  ) || samples.some(sample => sample.contentItemId === contentId);
}

export function validateBatchGpuSelection(
  slots: readonly GpuSlot[],
  states: readonly GpuState[],
): 'NoSelection' | 'TooMany' | 'Duplicate' | 'Unavailable' | null {
  if (slots.length === 0) return 'NoSelection';
  if (slots.length > 2) return 'TooMany';
  if (new Set(slots).size !== slots.length) return 'Duplicate';
  return slots.every(slot => states.some(state => state.slot === slot && state.availability === 'Available'))
    ? null
    : 'Unavailable';
}

export function selectInitialBatchDraft(stored: BatchDraft | null, defaults: BatchDraft): BatchDraft {
  return structuredClone(stored ?? defaults);
}

export function jobProgress(completedCount: number, quantity: number): number {
  if (quantity <= 0) return 0;
  return Math.min(100, Math.max(0, (completedCount / quantity) * 100));
}

export function createBatchAllocationSnapshot(
  sequence: number,
  draft: BatchDraft,
  content: ContentItem,
  preset: Preset,
  demographics: Pick<BatchAllocation, 'age' | 'gender' | 'ethnicity'>,
): BatchAllocation {
  const prompts = composeVideoGenerationInput(content, preset);
  return {
    sequence,
    contentItemId: content.id,
    contentItemName: content.name,
    contentItemRevision: content.revision,
    presetId: preset.id,
    presetName: preset.name,
    presetRevision: preset.revision,
    category: draft.category,
    conflictDirection: draft.conflictDirection,
    ...demographics,
    model: draft.model,
    seed: draft.seed === null ? 100_000 + sequence : draft.seed + sequence - 1,
    finalPositivePrompt: prompts.positivePrompt,
    finalNegativePrompt: prompts.negativePrompt,
  };
}

export function createPreparedTestSnapshot(
  id: string,
  draft: TestDraft,
  content: ContentItem,
  preset: Preset,
): PreparedTest {
  const prompts = composeVideoGenerationInput(content, preset);
  return {
    id,
    ...structuredClone(draft),
    contentItemName: content.name,
    presetName: preset.name,
    dialogue: content.dialogue,
    displayText: content.displayText,
    explanation: content.explanation,
    videoPrompt: content.videoPrompt,
    finalPositivePrompt: prompts.positivePrompt,
    finalNegativePrompt: prompts.negativePrompt,
    emotion: content.emotion,
    scene: content.scene,
    contentRevision: content.revision,
    presetRevision: preset.revision,
  };
}

export function buildJobItems(
  quantity: number,
  status: JobStatus,
  gpus: readonly GpuSlot[],
  completedCount = status === 'Completed' ? quantity : 0,
  activeSequences: readonly number[] = [],
  contentItemIds: readonly string[] = [],
): JobItem[] {
  return Array.from({ length: quantity }, (_, index) => {
    const sequence = index + 1;
    const completed = sequence <= completedCount;
    const activeIndex = activeSequences.indexOf(sequence);
    const active = activeIndex >= 0;
    const itemStatus: JobStatus = completed
      ? 'Completed'
      : active
        ? status === 'Failed' ? 'Failed' : 'Running'
        : status === 'Cancelled' ? 'Cancelled' : 'Queued';
    return {
      sequence,
      status: itemStatus,
      gpuId: completed
        ? gpus[index % gpus.length] ?? null
        : active
          ? gpus[activeIndex % gpus.length] ?? null
          : null,
      contentItemId: contentItemIds.length > 0 ? contentItemIds[index % contentItemIds.length] : null,
    };
  });
}
