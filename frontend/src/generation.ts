import type {
  ContentItem,
  GpuSlot,
  GpuState,
  Job,
  JobItem,
  JobStatus,
  Preset,
  Sample,
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

export function buildJobItems(
  quantity: number,
  status: JobStatus,
  gpus: readonly GpuSlot[],
  completedCount = status === 'Completed' ? quantity : 0,
  currentItemSequence: number | null = null,
  contentItemIds: readonly string[] = [],
): JobItem[] {
  return Array.from({ length: quantity }, (_, index) => {
    const sequence = index + 1;
    const completed = sequence <= completedCount;
    const current = sequence === currentItemSequence;
    const itemStatus: JobStatus = completed
      ? 'Completed'
      : current
        ? status === 'Failed' ? 'Failed' : 'Running'
        : status === 'Cancelled' ? 'Cancelled' : 'Queued';
    return {
      sequence,
      status: itemStatus,
      gpu: completed || current ? gpus[index % gpus.length] ?? null : null,
      contentItemId: contentItemIds.length > 0 ? contentItemIds[index % contentItemIds.length] : null,
    };
  });
}
