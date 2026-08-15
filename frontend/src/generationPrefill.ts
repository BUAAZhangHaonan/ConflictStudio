import type {
  BilingualSelection,
  Demographic,
} from './api/contracts';
import type {
  Category,
  ConflictDirection,
  ModelName,
  ModelPrecision,
} from './types';

export interface CorrectedSampleBatchPrefill {
  sourceDisplayId: string;
  category: Category;
  conflictDirection: ConflictDirection | null;
  contentPlan: BilingualSelection & { mode: 'Fixed' | 'Generative' };
  backgroundPreset: BilingualSelection;
  promptPresetId: number;
  model: ModelName;
  precision: ModelPrecision | null;
  demographic: Demographic;
}

export interface CorrectedSampleBatchNavigationState {
  correctedSampleBatch: CorrectedSampleBatchPrefill;
}

export function readCorrectedSampleBatchPrefill(
  state: unknown,
): CorrectedSampleBatchPrefill | null {
  if (typeof state !== 'object' || state === null || !('correctedSampleBatch' in state)) return null;
  return (state as CorrectedSampleBatchNavigationState).correctedSampleBatch;
}
