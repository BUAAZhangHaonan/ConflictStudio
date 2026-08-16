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
  contentScript: BilingualSelection & { mode: 'Fixed' | 'Generative' };
  scene: BilingualSelection;
  promptTemplateVersionId: number;
  model: ModelName;
  precision: ModelPrecision | null;
  demographic: Demographic;
}

export interface CorrectedSampleBatchNavigationState {
  correctedSampleBatch: CorrectedSampleBatchPrefill;
}

interface RegenerationSample {
  displayId: string;
  category: Category;
  conflictDirection: ConflictDirection | null;
  promptTemplateVersionId: number;
  generationRecord: {
    model: ModelName;
    precision: ModelPrecision | null;
  };
  age: Demographic['age'];
  gender: Demographic['gender'];
  ethnicity: Demographic['ethnicity'];
}

export function buildCorrectedSampleBatchPrefill(
  sample: RegenerationSample,
  contentScript: CorrectedSampleBatchPrefill['contentScript'],
  scene: BilingualSelection,
): CorrectedSampleBatchPrefill {
  return {
    sourceDisplayId: sample.displayId,
    category: sample.category,
    conflictDirection: sample.conflictDirection,
    contentScript,
    scene,
    promptTemplateVersionId: sample.promptTemplateVersionId,
    model: sample.generationRecord.model,
    precision: sample.generationRecord.precision,
    demographic: {
      age: sample.age,
      gender: sample.gender,
      ethnicity: sample.ethnicity,
    },
  };
}

export function readCorrectedSampleBatchPrefill(
  state: unknown,
): CorrectedSampleBatchPrefill | null {
  if (typeof state !== 'object' || state === null || !('correctedSampleBatch' in state)) return null;
  return (state as CorrectedSampleBatchNavigationState).correctedSampleBatch;
}
