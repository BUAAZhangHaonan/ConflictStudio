import type {
  Category,
  ConflictDirection,
  ContentMode,
  ContentStatus,
  ModelName,
  ModelPrecision,
} from '../types';

export type ResourceStatus = 'Draft' | 'Active' | 'Inactive' | 'Disabled';
export type DatasetStatus = 'Active' | 'Inactive';
export type DatasetPurpose = 'Formal' | 'Production' | 'Validation';
export type GpuSlotName = 'GPU0' | 'GPU1';
export type GpuAvailability = 'Available' | 'Reserved' | 'Busy' | 'ExternalOccupied' | 'Unknown';
export type Gender = 'Male' | 'Female';
export type Ethnicity = 'EastAsian' | 'White' | 'Black' | 'SouthAsian' | 'Latino';
export type Age = 25 | 45 | 60;
export type SpokenLanguage = 'zh' | 'en' | 'es' | 'de' | 'ja' | 'ko';
export type JobSource = 'Production' | 'PromptTest' | 'VideoTest';
export type JobStatus = 'Queued' | 'Running' | 'Interrupted' | 'Completed' | 'Failed' | 'Cancelled';
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

export interface PromptTemplate extends RevisionedResource {
  name: string;
  category: Category;
}

export interface PromptTemplateVersion {
  id: number;
  templateId: number;
  templateName: string;
  category: Category;
  version: number;
  organizationRules: string;
  styleGuidance: string;
  positiveExamples: string[];
  negativeExamples: string[];
  ltxNegativePrompt: string;
  h3NegativePrompt: string;
  verificationStatus: TemplateVersionStatus;
  revision: number;
  createdAt: string;
  verifiedAt: string | null;
}

export interface PromptTemplateVersionCreate {
  expectedTemplateRevision: number;
  organizationRules: string;
  styleGuidance: string;
  positiveExamples: string[];
  negativeExamples: string[];
  ltxNegativePrompt: string;
  h3NegativePrompt: string;
}

export interface PromptTemplateVersionVerify {
  expectedRevision: number;
}

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
  language: SpokenLanguage;
}

export interface BatchDraftFields {
  targetDatasetId: number;
  displayName: string | null;
  category: Category;
  conflictDirection: ConflictDirection | null;
  model: ModelName;
  precision: ModelPrecision | null;
  contentSelections: BatchContentSelectionInput[];
  promptTemplateVersionId: number;
  demographics: Demographic[];
  gpuSlots: GpuSlotName[];
  seeds: number[];
}

export type BatchDraftCreate = BatchDraftFields;
export type BatchDraftUpdate = BatchDraftFields & { expectedRevision: number };

export interface BatchDraft extends RevisionedResource {
  targetDatasetId: number;
  datasetRevision: number;
  displayName: string | null;
  category: Category;
  conflictDirection: ConflictDirection | null;
  model: ModelName;
  precision: ModelPrecision | null;
  combinationCount: number;
  totalCount: number;
  seeds: number[];
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
  combinationCount: number;
  seedCount: number;
  totalCount: number;
  gpuRevisions: Record<GpuSlotName, number>;
  allocations: BatchAllocation[];
}

export interface TestComparisonInput {
  model: ModelName;
  precision: ModelPrecision | null;
  gpuSlot: GpuSlotName;
}

export interface PromptTestCreate {
  contentScript: SourceSelection;
  promptTemplateVersion: SourceSelection;
  scene: SourceSelection;
  demographic: Demographic;
  model: ModelName;
  precision: ModelPrecision | null;
}

export interface VideoTestCreate {
  contentScript: SourceSelection;
  promptTemplateVersion: SourceSelection;
  scene: SourceSelection;
  demographic: Demographic;
  seed: number | null;
  comparisons: TestComparisonInput[];
  executionMode: TestExecutionMode;
  expectedGpuRevisions: Record<string, number>;
  confirmModelSwitch: boolean;
}

export interface ResourceAssistantPromptTemplateReference {
  id: number;
  expectedRevision: number;
}

export type ResourceAssistantContentDraft = Omit<ContentScriptCreate, 'sceneIds' | 'status'> & {
  status: 'Draft';
};
export type ResourceAssistantSceneDraft = Omit<SceneCreate, 'status'> & {
  status: 'Draft';
};
export type ResourceAssistantPromptVersionDraft = Omit<
  PromptTemplateVersionCreate,
  'expectedTemplateRevision'
>;

export interface ResourceAssistantBundle {
  contentScript: ResourceAssistantContentDraft;
  scenes: ResourceAssistantSceneDraft[];
  promptTemplateVersion: ResourceAssistantPromptVersionDraft;
}

export interface ResourceAssistantProposeRequest {
  userRequirement: string;
  promptTemplate: ResourceAssistantPromptTemplateReference;
}

export interface ResourceAssistantProposal {
  promptTemplate: PromptTemplate;
  bundle: ResourceAssistantBundle;
}

export interface ResourceAssistantApplyRequest {
  promptTemplate: ResourceAssistantPromptTemplateReference;
  bundle: ResourceAssistantBundle;
}

export interface ResourceAssistantApplyResult {
  contentScript: ContentScript;
  scenes: Scene[];
  promptTemplateVersion: PromptTemplateVersion;
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
  | 'JobResumed'
  | 'JobRetryQueued'
  | 'CancelRequested'
  | 'ItemPromptStarted'
  | 'ItemPromptReady'
  | 'ItemRenderStarted'
  | 'ItemRenderMissing'
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
  datasetName: string | null;
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
  language: SpokenLanguage;
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
  trueEmotion: string;
  apparentEmotion: string;
  contentScriptNameZh: string;
  contentScriptNameEn: string;
  contentSceneZh: string;
  contentSceneEn: string;
  triggerEventZh: string;
  triggerEventEn: string;
  psychologicalBackgroundZh: string;
  psychologicalBackgroundEn: string;
  shootingSceneNameZh: string;
  shootingSceneNameEn: string;
  shootingSceneZh: string;
  shootingSceneEn: string;
  ambientSoundZh: string;
  ambientSoundEn: string;
  participantRelationshipZh: string;
  participantRelationshipEn: string;
  lightingZh: string;
  lightingEn: string;
  framingZh: string;
  framingEn: string;
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
  gpuSlot: GpuSlotName | null;
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

export interface ReviewQueue {
  decision: 'All' | ReviewDecision;
  datasetId: number | null;
  protocol: Protocol | null;
  relation: Relation | null;
  direction: ConflictDirection | null;
  search: string | null;
  inArchive?: boolean | null;
}

export type ReviewQueueFilter = ReviewQueue;

export interface ReviewMediaRead {
  url: string;
  hasAudio: boolean;
}

export interface ReviewResultRead {
  id: number;
  sampleId: number;
  reviewerId: number;
  reviewerName: string;
  protocol: Protocol;
  relation: Relation;
  decision: ReviewDecision;
  note: string;
  sampleRevision: number;
  revision: number;
  createdAt: string;
}

export interface ReviewSampleListRead {
  id: number;
  displayId: string;
  datasetId: number;
  datasetName: string;
  category: Category;
  protocol: Protocol;
  relation: Relation;
  conflictDirection: ConflictDirection | null;
  reviewDecision: ReviewDecision;
  reviewRevision: number;
  currentReview: ReviewResultRead | null;
  inArchive: boolean;
  archiveSyncStatus: ArchiveSyncStatus;
  generationCompatibility: GenerationCompatibility;
  primaryMedia: ReviewMediaRead;
  trueEmotion: string;
  apparentEmotion: string;
  contentScriptNameZh: string;
  contentScriptNameEn: string;
  gender: Gender;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewSampleDetailRead extends ReviewSampleListRead {
  sourceMedia: ReviewMediaRead | null;
  dialogue: string | null;
  displayText: string | null;
  trueEmotionDescription: string;
  sceneZh: string;
  sceneEn: string;
  triggerEventZh: string;
  triggerEventEn: string;
  psychologicalBackgroundZh: string;
  psychologicalBackgroundEn: string;
  age: number;
  ethnicity: Ethnicity;
  language: SpokenLanguage;
  model: ModelName;
  precision: ModelPrecision | null;
  compatibleSceneCount: number;
}

export interface ReviewNoteDraftRead {
  sampleId: number;
  reviewerId: number;
  sampleRevision: number;
  note: string;
  revision: number;
  updatedAt: string | null;
}

export interface ReviewNoteDraftUpdate {
  reviewerId: number;
  note: string;
  expectedRevision: number;
  expectedSampleRevision: number;
}

export interface ReviewSampleReferenceRead {
  id: number;
  displayId: string;
  page: number;
}

export interface ReviewSubmissionRead extends ReviewSampleDetailRead {
  nextReference: ReviewSampleReferenceRead | null;
}

export interface ReviewMutationRequest {
  sampleId: number;
  reviewerId: number;
  decision: ReviewDecision;
  expectedRevision: number;
  expectedReviewRevision: number;
  expectedNoteDraftRevision: number;
}

export interface ReviewSubmissionCreate extends ReviewMutationRequest {
  queue: ReviewQueue;
}

export interface ReviewBatchItemCreate extends Omit<ReviewMutationRequest, 'decision'> {
  decision: Exclude<ReviewDecision, 'Pending'>;
}

export interface ReviewBatchSubmissionCreate {
  items: ReviewBatchItemCreate[];
}

export interface SampleClassificationConversionUpdate {
  reviewerId: number;
  expectedRevision: number;
  targetCategory: Category;
  conflictDirection: ConflictDirection | null;
  apparentEmotion?: string | null;
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

export interface JobProfile {
  model: ModelName;
  precision: ModelPrecision | null;
}

export interface JobSummary {
  id: number;
  displayName: string;
  source: JobSource;
  datasetId: number | null;
  datasetNameSnapshot: string | null;
  batchDraftId: number | null;
  category: Category;
  conflictDirection: ConflictDirection | null;
  model: ModelName | null;
  precision: ModelPrecision | null;
  profiles: JobProfile[];
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
