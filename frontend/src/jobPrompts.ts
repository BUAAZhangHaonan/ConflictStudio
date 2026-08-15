import type { JobItem, JobItemPromptResult } from './api/contracts';

export interface FinalJobItemPrompts {
  positive: string;
  negative: string;
}

interface JobItemPromptSource {
  input: Pick<JobItem['input'], 'fixedPositivePrompt' | 'finalNegativePrompt'>;
  promptResult: Pick<JobItemPromptResult, 'finalPositivePrompt' | 'finalNegativePrompt'> | null;
}

export function finalJobItemPrompts(item: JobItemPromptSource): FinalJobItemPrompts | null {
  if (item.promptResult) {
    return {
      positive: item.promptResult.finalPositivePrompt,
      negative: item.promptResult.finalNegativePrompt,
    };
  }
  if (item.input.fixedPositivePrompt !== null) {
    return {
      positive: item.input.fixedPositivePrompt,
      negative: item.input.finalNegativePrompt,
    };
  }
  return null;
}
