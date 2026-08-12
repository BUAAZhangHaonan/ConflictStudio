import type { Category, ConflictDirection, ContentMode, ContentStatus, ModelName } from '../types';

export type ResourceStatus = 'Active' | 'Disabled';
export type DatasetPurpose = 'Production' | 'Validation';
export type GpuSlotName = 'GPU0' | 'GPU1';
export type GpuAvailability = 'Available' | 'Reserved' | 'Busy' | 'ExternalOccupied' | 'Unknown';
export type Gender = 'Male' | 'Female';
export type Ethnicity = 'EastAsian' | 'White' | 'Black' | 'SouthAsian' | 'Latino';
export type Age = 25 | 35 | 45 | 60;
export type JobStatus = 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';
export type JobItemStage =
  | 'PromptQueued'
  | 'PromptGenerating'
  | 'PromptReady'
  | 'Rendering'
  | 'MediaProcessing'
  | 'Completed';

export interface RevisionedResource {
  id: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Dataset extends RevisionedResource {
  name: string;
  purpose: DatasetPurpose;
  note: string;
  status: ResourceStatus;
}

export interface DatasetCreate {
  name: string;
  purpose: DatasetPurpose;
  note: string;
}

export interface DatasetUpdate {
  expectedRevision: number;
  name?: string;
  purpose?: DatasetPurpose;
  note?: string;
  status?: ResourceStatus;
}

export interface ContentPlanFields {
  name: string;
  category: Category;
  conflictDirection: ConflictDirection | null;
  mode: ContentMode;
  status: ContentStatus;
  trueEmotion: string;
  apparentEmotion: string;
  scene: string;
  triggerEvent: string;
  psychologicalBackground: string;
  dialogue: string | null;
  displayText: string | null;
  trueEmotionDescription: string;
  baseVideoPrompt: string;
  contentRequirements: string;
  sceneSupplement: string;
}

export interface ContentPlan extends RevisionedResource, ContentPlanFields {}
export type ContentPlanCreate = ContentPlanFields;
export type ContentPlanUpdate = Partial<Omit<ContentPlanFields, 'category'>> & { expectedRevision: number };

export interface PromptPresetFields {
  name: string;
  category: Category;
  styleGuidance: string;
  sceneSupplement: string;
  positiveExamples: string[];
  negativeExamples: string[];
  finalRenderNegativeConstraints: string;
  status: ResourceStatus;
}

export interface PromptPreset extends RevisionedResource, PromptPresetFields {}
export type PromptPresetCreate = PromptPresetFields;
export type PromptPresetUpdate = Partial<Omit<PromptPresetFields, 'category'>> & { expectedRevision: number };

export interface BackgroundPresetFields {
  name: string;
  scene: string;
  ambientSound: string;
  participantRelationship: string;
  lighting: string;
  framing: string;
  status: ResourceStatus;
}

export interface BackgroundPreset extends RevisionedResource, BackgroundPresetFields {}
export type BackgroundPresetCreate = BackgroundPresetFields;
export type BackgroundPresetUpdate = Partial<BackgroundPresetFields> & { expectedRevision: number };

export interface SourceSelection {
  id: number;
  expectedRevision: number;
}

export interface Selection {
  id: number;
  name: string;
  revision: number;
}

export interface Demographic {
  age: Age;
  gender: Gender;
  ethnicity: Ethnicity;
}

export interface BatchDraftFields {
  datasetId: number;
  category: Category;
  conflictDirection: ConflictDirection | null;
  model: ModelName;
  quantity: number;
  seed: number | null;
  contentPlans: SourceSelection[];
  promptPresets: SourceSelection[];
  backgroundPresets: SourceSelection[];
  demographics: Demographic[];
  gpuSlots: GpuSlotName[];
}

export type BatchDraftCreate = BatchDraftFields;
export type BatchDraftUpdate = BatchDraftFields & { expectedRevision: number };

export interface BatchDraft extends RevisionedResource {
  datasetId: number;
  datasetRevision: number;
  category: Category;
  conflictDirection: ConflictDirection | null;
  model: ModelName;
  quantity: number;
  seed: number;
  status: 'Draft' | 'Submitted';
  contentPlans: Selection[];
  promptPresets: Selection[];
  backgroundPresets: Selection[];
  demographics: Demographic[];
  gpuSlots: GpuSlotName[];
}

export interface BatchAllocation {
  sequence: number;
  contentPlan: Selection;
  promptPreset: Selection;
  backgroundPreset: Selection;
  demographic: Demographic;
  gpuSlot: GpuSlotName;
  model: ModelName;
  seed: number;
  requiresPromptGeneration: boolean;
  systemInput: string;
  userInput: string;
  finalPositivePrompt: string | null;
  finalNegativePrompt: string;
}

export interface BatchPreview {
  batchDraftId: number;
  expectedRevision: number;
  gpuRevisions: Partial<Record<GpuSlotName, number>>;
  allocations: BatchAllocation[];
}

export interface PromptPreviewRequest {
  contentPlan: SourceSelection;
  promptPreset: SourceSelection;
  backgroundPreset: SourceSelection;
  demographic: Demographic;
}

export interface PromptPreview {
  contentPlan: Selection;
  promptPreset: Selection;
  backgroundPreset: Selection;
  category: Category;
  conflictDirection: ConflictDirection | null;
  demographic: Demographic;
  requiresPromptGeneration: boolean;
  systemInput: string;
  userInput: string;
  finalPositivePrompt: string | null;
  finalNegativePrompt: string;
}

export interface JobEventPayload {
  preparedCount: number | null;
  completedCount: number | null;
  failedCount: number | null;
  totalCount: number | null;
  slotCount: number | null;
  sequence: number | null;
  gpuSlot: GpuSlotName | null;
  failureCode: string | null;
  failureReason: string | null;
  progressValue: number | null;
  progressMaximum: number | null;
}

export type JobEventType =
  | 'JobQueued'
  | 'JobStarted'
  | 'CancelRequested'
  | 'ItemPromptStarted'
  | 'ItemPromptReady'
  | 'ItemRenderStarted'
  | 'ItemRenderProgress'
  | 'ItemMediaProcessing'
  | 'ItemCompleted'
  | 'ItemFailed'
  | 'ItemCancelled'
  | 'JobInterrupted'
  | 'JobCompleted'
  | 'JobFailed'
  | 'JobCancelled';

export interface JobEvent {
  id: number;
  jobId: number;
  itemId: number | null;
  eventType: JobEventType;
  payload: JobEventPayload;
  createdAt: string;
}

export interface Snapshot {
  id: number;
  sequence: number;
  datasetId: number;
  datasetRevision: number;
  contentPlanId: number;
  contentPlanRevision: number;
  promptPresetId: number;
  promptPresetRevision: number;
  backgroundPresetId: number;
  backgroundPresetRevision: number;
  policyVersion: string;
  category: Category;
  conflictDirection: ConflictDirection | null;
  age: Age;
  gender: Gender;
  ethnicity: Ethnicity;
  model: ModelName;
  seed: number;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  rendererProfileVersion: string;
  promptModel: string;
  sourceHasAudio: boolean;
  deriveSilentPrimary: boolean;
  systemInput: string;
  userInput: string;
  finalNegativePrompt: string;
  fixedPositivePrompt: string | null;
  fixedDialogue: string | null;
  fixedVtText: string | null;
  fixedTrueEmotionDescription: string | null;
  trueEmotion: string;
  apparentEmotion: string;
  createdAt: string;
}

export interface JobItemPromptResult {
  id: number;
  jobItemId: number;
  policyVersion: string;
  systemInput: string;
  userInput: string;
  rawStructuredResponse: string;
  finalPositivePrompt: string;
  finalNegativePrompt: string;
  dialogue: string | null;
  vtText: string | null;
  trueEmotionDescription: string;
  createdAt: string;
}

export interface JobItem {
  id: number;
  sequence: number;
  gpuSlot: GpuSlotName;
  stage: JobItemStage;
  status: JobStatus;
  failureCode: string | null;
  failureReason: string | null;
  rendererPromptId: string | null;
  sourceAssetId: number | null;
  primaryAssetId: number | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  input: Snapshot;
  promptResult: JobItemPromptResult | null;
}

export interface JobSummary {
  id: number;
  displayName: string;
  source: 'Production';
  datasetId: number;
  batchDraftId: number;
  category: Category;
  conflictDirection: ConflictDirection | null;
  model: ModelName;
  status: JobStatus;
  totalCount: number;
  preparedCount: number;
  completedCount: number;
  failedCount: number;
  confirmModelSwitch: boolean;
  cancelRequestedAt: string | null;
  failureCode: string | null;
  failureReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface JobDetail extends JobSummary {
  items: JobItem[];
  events: JobEvent[];
}

export interface GpuSlot {
  slot: GpuSlotName;
  availability: GpuAvailability;
  loadedModel: ModelName | null;
  activeJobId: number | null;
  revision: number;
  checkedAt: string;
}
