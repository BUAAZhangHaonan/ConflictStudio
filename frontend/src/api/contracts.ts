import type {
  Category,
  ConflictDirection,
  ContentMode,
  ContentStatus,
  ModelName,
  ModelPrecision,
} from '../types';

export type ResourceStatus = 'Active' | 'Disabled';
export type DatasetStatus = 'Active' | 'Inactive';
export type DatasetPurpose = 'Formal' | 'Production' | 'Validation';
export type GpuSlotName = 'GPU0' | 'GPU1';
export type GpuAvailability = 'Available' | 'Reserved' | 'Busy' | 'ExternalOccupied' | 'Unknown';
export type Gender = 'Male' | 'Female';
export type Ethnicity = 'EastAsian' | 'White' | 'Black' | 'SouthAsian' | 'Latino';
export type Age = 25 | 35 | 45 | 60;
export type JobStatus = 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';
export type GenerationAttemptStatus = 'Running' | 'Completed' | 'Failed';
export type GenerationCompatibility = 'Compatible' | 'NeedsRegeneration';
export type ReviewDecision = 'Pending' | 'Accepted' | 'Rejected';
export type ArchiveSyncStatus = 'Current' | 'NeedsUpdate';
export type Protocol = 'VA' | 'VT';
export type Relation = 'Aligned' | 'Conflict';
export type TestExecutionMode = 'Parallel' | 'Serial';
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

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: 20;
  total: number;
  totalPages: number;
}

export interface Dataset extends RevisionedResource {
  name: string;
  purpose: DatasetPurpose;
  note: string;
  status: DatasetStatus;
}

export interface DatasetCreate {
  name: string;
  note: string;
}

export interface DatasetUpdate {
  expectedRevision: number;
  name?: string;
  note?: string;
  status?: DatasetStatus;
}

export interface ContentScriptFields {
  nameZh: string;
  nameEn: string;
  category: Category;
  conflictDirection: ConflictDirection | null;
  mode: ContentMode;
  status: ContentStatus;
  trueEmotion: string;
  apparentEmotion: string;
  sceneZh: string;
  sceneEn: string;
  triggerEventZh: string;
  triggerEventEn: string;
  psychologicalBackgroundZh: string;
  psychologicalBackgroundEn: string;
  dialogue: string | null;
  displayText: string | null;
  trueEmotionDescription: string;
  baseVideoPrompt: string;
  contentRequirementsZh: string;
  contentRequirementsEn: string;
  sceneSupplementZh: string;
  sceneSupplementEn: string;
}

export interface ContentScript extends RevisionedResource, ContentScriptFields {
  sceneIds: number[];
}
export type ContentScriptCreate = ContentScriptFields & { sceneIds: number[] };
export type ContentScriptUpdate = Partial<Omit<ContentScriptFields, 'category'>> & { sceneIds: number[]; expectedRevision: number };

export type TemplateVersionStatus = 'Draft' | 'Verified';

export interface PromptTemplateVersionFields {
  name: string;
  category: Category;
  version: number;
  styleGuidance: string;
  positiveExamples: string[];
  negativeExamples: string[];
  ltxNegativePrompt: string;
  h3NegativePrompt: string;
  verificationStatus: TemplateVersionStatus;
}

export interface PromptTemplateVersion extends RevisionedResource, PromptTemplateVersionFields {}
export type PromptTemplateVersionCreate = PromptTemplateVersionFields;
export interface PromptTemplateVersionVerify { expectedRevision: number; }

export interface SceneFields {
  nameZh: string;
  nameEn: string;
  sceneZh: string;
  sceneEn: string;
  ambientSoundZh: string;
  ambientSoundEn: string;
  participantRelationshipZh: string;
  participantRelationshipEn: string;
  lightingZh: string;
  lightingEn: string;
  framingZh: string;
  framingEn: string;
  status: ResourceStatus;
}

export interface Scene extends RevisionedResource, SceneFields {}
export type SceneCreate = SceneFields;
export type SceneUpdate = Partial<SceneFields> & { expectedRevision: number };

export interface SourceSelection {
  id: number;
  expectedRevision: number;
}

export interface ContentScriptScenes {
  contentScriptId: number;
  contentScriptRevision: number;
  scenes: BilingualSelection[];
}

export interface BatchContentSelectionInput {
  contentScriptId: number;
  sceneIds: number[];
}

export interface BatchContentSelection {
  contentScript: BilingualSelection;
  mode: 'Fixed' | 'Generative';
  scenes: BilingualSelection[];
  compatibleScenes: BilingualSelection[];
}

export interface Selection {
  id: number;
  name: string;
  revision: number;
}

export interface BilingualSelection {
  id: number;
  nameZh: string;
  nameEn: string;
  revision: number;
}

export interface Demographic {
  age: Age;
  gender: Gender;
  ethnicity: Ethnicity;
}

export interface BatchDraftFields {
  targetDatasetId: number;
  category: Category;
  conflictDirection: ConflictDirection | null;
  model: ModelName;
  precision: ModelPrecision | null;
  quantity: number;
  seed: number | null;
  contentSelections: BatchContentSelectionInput[];
  promptTemplateVersionId: number;
  demographics: Demographic[];
  gpuSlots: GpuSlotName[];
}

export type BatchDraftCreate = BatchDraftFields;
export type BatchDraftUpdate = BatchDraftFields & { expectedRevision: number };

export interface BatchDraft extends RevisionedResource {
  targetDatasetId: number;
  datasetRevision: number;
  category: Category;
  conflictDirection: ConflictDirection | null;
  model: ModelName;
  precision: ModelPrecision | null;
  quantity: number;
  seed: number;
  status: 'Draft' | 'Submitted';
  contentSelections: BatchContentSelection[];
  promptTemplateVersion: Selection;
  demographics: Demographic[];
  gpuSlots: GpuSlotName[];
}

export interface BatchAllocation {
  sequence: number;
  contentScript: BilingualSelection;
  promptTemplateVersion: Selection;
  scene: BilingualSelection;
  demographic: Demographic;
  gpuSlot: GpuSlotName;
  model: ModelName;
  precision: ModelPrecision | null;
  seed: number;
  requiresPromptGeneration: boolean;
  systemInput: string;
  userInput: string;
  finalPositivePrompt: string | null;
  negativePrompt: string;
}

export interface BatchPreview {
  batchDraftId: number;
  expectedRevision: number;
  gpuRevisions: Partial<Record<GpuSlotName, number>>;
  allocations: BatchAllocation[];
}

export interface PromptPreviewRequest {
  contentScript: SourceSelection;
  promptTemplateVersion: SourceSelection;
  scene: SourceSelection;
  demographic: Demographic;
  model: ModelName;
}

export interface PromptPreview {
  contentScript: BilingualSelection;
  promptTemplateVersion: Selection;
  scene: BilingualSelection;
  category: Category;
  conflictDirection: ConflictDirection | null;
  demographic: Demographic;
  requiresPromptGeneration: boolean;
  systemInput: string;
  userInput: string;
  finalPositivePrompt: string | null;
  negativePrompt: string;
}

export interface TestComparisonInput {
  model: ModelName;
  precision: ModelPrecision | null;
  gpuSlot: GpuSlotName;
}

export interface TestRunCreate {
  contentScript: SourceSelection;
  promptTemplateVersion: SourceSelection;
  scene: SourceSelection;
  demographic: Demographic;
  seed: number | null;
  comparisons: TestComparisonInput[];
  executionMode: TestExecutionMode;
  expectedGpuRevisions: Partial<Record<GpuSlotName, number>>;
  confirmModelSwitch: boolean;
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
  failureDetails: PromptFailureDetails | null;
  progressValue: number | null;
  progressMaximum: number | null;
}

export interface PromptSchemaFieldDetail {
  path: string;
  type: string;
  reason: string;
}

export interface PromptFailureDetails {
  httpStatus: number | null;
  finishReason: string | null;
  requestId: string | null;
  fields: PromptSchemaFieldDetail[] | null;
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
  datasetId: number | null;
  datasetRevision: number | null;
  contentScriptId: number;
  contentScriptRevision: number;
  promptTemplateVersionId: number;
  promptTemplateVersionRevision: number;
  sceneId: number;
  sceneRevision: number;
  policyVersion: string;
  category: Category;
  conflictDirection: ConflictDirection | null;
  age: Age;
  gender: Gender;
  ethnicity: Ethnicity;
  model: ModelName;
  precision: ModelPrecision | null;
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
  negativePrompt: string;
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
  negativePrompt: string;
  dialogue: string | null;
  vtText: string | null;
  trueEmotionDescription: string;
  createdAt: string;
}

export interface GenerationAttempt {
  id: number;
  attemptNumber: number;
  model: ModelName;
  precision: ModelPrecision | null;
  gpuSlot: GpuSlotName;
  seed: number;
  sourceAssetId: number | null;
  sourceAssetUrl: string | null;
  primaryAssetId: number | null;
  primaryAssetUrl: string | null;
  rendererPromptId: string;
  status: GenerationAttemptStatus;
  failureReason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface JobItem {
  id: number;
  sequence: number;
  gpuSlot: GpuSlotName;
  stage: JobItemStage;
  status: JobStatus;
  failureCode: string | null;
  failureReason: string | null;
  failureDetails: PromptFailureDetails | null;
  rendererPromptId: string | null;
  sourceAssetId: number | null;
  sourceAssetUrl: string | null;
  primaryAssetId: number | null;
  primaryAssetUrl: string | null;
  renderProgress?: {
    value: number;
    maximum: number;
  } | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  input: Snapshot;
  promptResult: JobItemPromptResult | null;
  latestAttempt: GenerationAttempt | null;
  attemptCount: number;
  sampleId: number | null;
}

export interface KeepTestResultRequest {
  datasetId: number;
  expectedRevision: number;
}

export interface Reviewer extends RevisionedResource {
  name: string;
}

export interface ReviewerCreate {
  name: string;
}

export interface ReviewerRename {
  name: string;
  expectedRevision: number;
}

export interface ReviewCreate {
  sampleId: number;
  reviewerId: number;
  decision: Exclude<ReviewDecision, 'Pending'>;
  note: string;
  expectedRevision: number;
  expectedReviewRevision: number;
}

export interface ReviewBatchCreate {
  items: ReviewCreate[];
}

export interface Review {
  id: number;
  sampleId: number;
  reviewerId: number;
  reviewerName: string;
  datasetId: number;
  protocol: Protocol;
  relation: Relation;
  decision: Exclude<ReviewDecision, 'Pending'>;
  note: string;
  sampleRevision: number;
  revision: number;
  createdAt: string;
}

export interface SampleClassificationUpdate {
  expectedRevision: number;
  targetCategory: Category;
  conflictDirection: ConflictDirection | null;
  apparentEmotion?: string;
  trueEmotionDescription: string;
}

export interface ReviewerActivity {
  date: string;
  reviewedCount: number;
}

export interface ReviewerStatistics {
  reviewerId: number;
  datasetId: number | null;
  startDate: string;
  endDate: string;
  uniqueReviewedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  vaCount: number;
  vtCount: number;
  revisedSampleCount: number;
  archivedCurrentCount: number;
  needsUpdateCount: number;
  activity: ReviewerActivity[];
}

export interface ReviewerStatisticsFilter {
  datasetId?: number;
  startDate?: string;
  endDate?: string;
}

export interface ArchiveChange {
  sampleId: number;
  displayId: string;
  expectedRevision: number;
  datasetId: number;
  datasetName: string;
  category: Category;
  protocol: Protocol;
  relation: Relation;
  primaryAssetId: number;
  primaryAssetUrl: string;
}

export interface ArchivePreviewRequest {
  datasetId: number;
}

export interface ArchivePreview {
  datasetId: number;
  added: ArchiveChange[];
  updated: ArchiveChange[];
  removed: ArchiveChange[];
  unchangedCount: number;
  expectedArchiveRevision: number;
}

export type ArchiveSyncRequest = ArchivePreview;

export interface Archive {
  datasetId: number;
  revision: number;
  lastSyncedAt: string | null;
  manifestAvailable: boolean;
  currentCount: number;
  needsUpdateCount: number;
}

export interface Sample {
  id: number;
  displayId: string;
  jobItemId: number;
  datasetId: number;
  datasetName: string;
  category: Category;
  conflictDirection: ConflictDirection | null;
  reviewDecision: ReviewDecision;
  reviewRevision: number;
  currentReview: Review | null;
  inArchive: boolean;
  archiveSyncStatus: ArchiveSyncStatus;
  model: ModelName;
  generationRecord: GenerationAttempt;
  actualContentSummary: BilingualSelection;
  actualSceneSummary: BilingualSelection;
  generationCompatibility: GenerationCompatibility;
  gpuSlot: GpuSlotName;
  contentScriptId: number;
  contentScriptRevision: number;
  promptTemplateVersionId: number;
  sourceAssetId: number | null;
  sourceAssetUrl: string | null;
  primaryAssetId: number;
  primaryAssetUrl: string;
  dialogue: string | null;
  displayText: string | null;
  videoPrompt: string;
  negativePrompt: string;
  trueEmotionDescription: string;
  trueEmotion: string;
  apparentEmotion: string;
  contentScriptNameZh: string;
  contentScriptNameEn: string;
  sceneZh: string;
  sceneEn: string;
  triggerEventZh: string;
  triggerEventEn: string;
  psychologicalBackgroundZh: string;
  psychologicalBackgroundEn: string;
  age: Age;
  gender: Gender;
  ethnicity: Ethnicity;
  seed: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface JobSummary {
  id: number;
  displayName: string;
  source: 'Production' | 'Test';
  datasetId: number | null;
  batchDraftId: number | null;
  category: Category;
  conflictDirection: ConflictDirection | null;
  model: ModelName | null;
  precision: ModelPrecision | null;
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

export type JobDetail = JobSummary;

export interface GpuSlot {
  slot: GpuSlotName;
  availability: GpuAvailability;
  loadedModel: ModelName | null;
  loadedPrecision: ModelPrecision | null;
  serviceStatus: 'running' | 'stopped' | 'unknown' | 'notInstalled' | 'notConfigured';
  gpuName: string | null;
  memory: {
    usedMiB: number | null;
    totalMiB: number | null;
  };
  activeJobId: number | null;
  revision: number;
  checkedAt: string;
  statusReason: string | null;
}

export interface Health {
  ok: boolean;
  database: string;
  promptServiceConfigured: boolean;
  rendererInstallation: 'installed' | 'notInstalled' | 'unknown' | 'notConfigured';
}
