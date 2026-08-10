export type Locale = 'zh-CN' | 'en-US';

export type Category = 'A-VA' | 'A-VT' | 'C-VA' | 'C-VT';
export type Protocol = 'VA' | 'VT';
export type ConflictDirection = 'Vision' | 'Audio' | 'Text';
export type ReviewDecision = 'Pending' | 'Accepted' | 'Rejected';
export type JobStatus = 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';
export type ContentStatus = 'Draft' | 'Active' | 'Disabled';
export type DatasetStatus = 'Active' | 'Disabled';
export type ContentMode = 'Fixed' | 'Generative';
export type ModelName = 'LTX-2.3' | 'MiniMax H3';
export type GpuSlot = 'GPU0' | 'GPU1';
export type GpuAvailability = 'Available' | 'Reserved' | 'ExternalOccupied' | 'Unknown';
export type ArchiveStatus = 'Current' | 'NeedsUpdate';
export type PresetRuleKey =
  | 'presets.rule.subject'
  | 'presets.rule.signal'
  | 'presets.rule.camera';
export type JobSource = 'Production' | 'Test' | 'Rerender';
export type JobStepStatus = 'Waiting' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';
export type TestExecutionMode = 'Parallel' | 'Serial';
export type ExamplePageState = 'ready' | 'loading' | 'empty' | 'filtered' | 'error' | 'conflict';

export interface Revisioned {
  revision: number;
  updatedAt: string;
}

export interface Dataset extends Revisioned {
  id: string;
  name: string;
  status: DatasetStatus;
  createdAt: string;
}

export interface Reviewer extends Revisioned {
  id: string;
  name: string;
  createdAt: string;
}

export interface GpuState {
  slot: GpuSlot;
  availability: GpuAvailability;
  loadedModel: ModelName | null;
  activeJobId: string | null;
  checkedAt: string;
}

export interface Sample extends Revisioned {
  id: string;
  displayId: string;
  datasetId: string;
  category: Category;
  conflictDirection: ConflictDirection | null;
  reviewDecision: ReviewDecision;
  reviewRevision: number;
  model: ModelName;
  gpu: GpuSlot;
  contentItemId: string | null;
  presetId: string | null;
  primaryAssetId: string;
  sourceAssetId: string | null;
  thumbnailAssetId: string | null;
  dialogue: string | null;
  displayText: string | null;
  videoPrompt: string;
  explanation: string;
  generationNote: string;
  emotion: string;
  seed: number;
  archiveStatus: ArchiveStatus;
}

export interface Review {
  id: string;
  sampleId: string;
  reviewerId: string;
  decision: ReviewDecision;
  note: string;
  sampleRevision: number;
  revision: number;
  createdAt: string;
}

export interface JobStep {
  id: string;
  order: number;
  name: 'PrepareContent' | 'GeneratePrompt' | 'GenerateVideo' | 'ProcessMedia' | 'SaveResult';
  status: JobStepStatus;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JobLog {
  sequence: number;
  stepId: string;
  messageKey: string;
  occurredAt: string;
}

export interface Job extends Revisioned {
  id: string;
  parentJobId: string | null;
  source: JobSource;
  datasetId: string | null;
  category: Category;
  conflictDirection: ConflictDirection | null;
  model: ModelName;
  gpu: GpuSlot;
  status: JobStatus;
  progress: number;
  seed: number | null;
  quantity: number;
  batchInput?: BatchPreview;
  testInput?: PreparedTest;
  testAssignmentOrder?: number;
  rerenderInput?: RerenderInput;
  steps: JobStep[];
  logs: JobLog[];
  resultSampleIds: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RerenderInput {
  dialogue: string | null;
  displayText: string | null;
  videoPrompt: string;
  explanation: string;
  generationNote: string;
}

export interface UpdateJobResultInput {
  jobId: string;
  sampleId: string;
  dialogue: string | null;
  displayText: string | null;
  videoPrompt: string;
  explanation: string;
  generationNote: string;
  rerenderGpu: GpuSlot | null;
  expectedJobRevision: number;
  expectedSampleRevision: number;
}

export interface UpdateJobResultValue {
  sample: Sample;
  rerenderJob: Job | null;
}

export interface ContentItem extends Revisioned {
  id: string;
  name: string;
  category: Category;
  conflictDirection: ConflictDirection | null;
  mode: ContentMode;
  status: ContentStatus;
  emotion: string;
  scene: string;
  dialogue: string | null;
  displayText: string | null;
  explanation: string;
  videoPrompt: string;
  contentInstruction: string;
  sceneSupplement: string;
  createdAt: string;
}

export interface Preset extends Revisioned {
  id: string;
  name: string;
  category: Category;
  fixedStructureRules: readonly PresetRuleKey[];
  styleInstruction: string;
  sceneSupplement: string;
  positiveExamples: string[];
  negativeExamples: string[];
  renderNegativeConstraints: string;
  createdAt: string;
}

export interface Archive extends Revisioned {
  datasetId: string;
  currentSampleIds: string[];
  lastSyncedAt: string | null;
}

export interface Activity {
  id: string;
  action: 'DatasetCreated' | 'DatasetRenamed' | 'DatasetDisabled' | 'JobCreated' | 'ReviewSaved' | 'ArchiveSynced';
  objectLabel: string;
  reviewerId: string | null;
  occurredAt: string;
}

export interface Statistics {
  reviewerId: string;
  datasetId: string | null;
  startDate: string;
  endDate: string;
  uniqueReviewedCount: number;
  revisedSampleCount: number;
  archivedCurrentCount: number;
  needsUpdateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  vaCount: number;
  vtCount: number;
  activity: Array<{ date: string; reviewedCount: number }>;
}

export interface BrowserPreferences {
  locale: Locale;
  currentReviewerId: string | null;
}

export interface RepositoryData {
  version: 2;
  datasets: Dataset[];
  reviewers: Reviewer[];
  gpuStates: GpuState[];
  samples: Sample[];
  reviews: Review[];
  jobs: Job[];
  contentItems: ContentItem[];
  presets: Preset[];
  archives: Archive[];
  activities: Activity[];
}

export interface RepositorySnapshot {
  data: RepositoryData;
  preferences: BrowserPreferences;
}

export type RepositoryFailureKind = 'Conflict' | 'NotFound' | 'InvalidInput' | 'Unavailable';

export interface RepositoryFailure {
  ok: false;
  kind: RepositoryFailureKind;
  field?: string;
  currentRevision?: number;
}

export interface RepositorySuccess<T> {
  ok: true;
  value: T;
}

export type RepositoryResult<T> = RepositorySuccess<T> | RepositoryFailure;

export interface DatasetCounts {
  sampleCount: number;
  pendingCount: number;
  acceptedCount: number;
  rejectedCount: number;
}

export interface BatchDraft {
  datasetId: string;
  category: Category;
  conflictDirection: ConflictDirection | null;
  contentItemIds: string[];
  presetId: string;
  model: ModelName;
  gpu: GpuSlot;
  quantity: number;
  seed: number | null;
  ages: Array<25 | 35 | 45 | 60>;
  genders: Array<'Male' | 'Female'>;
  ethnicities: Array<'EastAsian' | 'White' | 'Black' | 'SouthAsian' | 'Latino'>;
}

export interface BatchAllocation {
  sequence: number;
  contentItemId: string;
  contentItemName: string;
  category: Category;
  conflictDirection: ConflictDirection | null;
  age: 25 | 35 | 45 | 60;
  gender: 'Male' | 'Female';
  ethnicity: 'EastAsian' | 'White' | 'Black' | 'SouthAsian' | 'Latino';
  model: ModelName;
  gpu: GpuSlot;
}

export interface BatchPreview {
  draft: BatchDraft;
  allocations: BatchAllocation[];
  datasetRevision: number;
  contentItemRevisions: Record<string, number>;
  presetRevision: number;
}

export interface PreparedTest {
  id: string;
  category: Category;
  conflictDirection: ConflictDirection | null;
  contentItemId: string;
  presetId: string;
  age: 25 | 35 | 45 | 60;
  gender: 'Male' | 'Female';
  ethnicity: 'EastAsian' | 'White' | 'Black' | 'SouthAsian' | 'Latino';
  seed: number | null;
  models: ModelName[];
  assignments: Array<{ model: ModelName; gpu: GpuSlot; order: number }>;
  executionMode: TestExecutionMode;
  dialogue: string | null;
  displayText: string | null;
  explanation: string;
  videoPrompt: string;
  contentRevision: number;
  presetRevision: number;
}

export interface TestDraft {
  category: Category;
  conflictDirection: ConflictDirection | null;
  contentItemId: string;
  presetId: string;
  age: 25 | 35 | 45 | 60;
  gender: 'Male' | 'Female';
  ethnicity: 'EastAsian' | 'White' | 'Black' | 'SouthAsian' | 'Latino';
  seed: number | null;
  assignments: Array<{ model: ModelName; gpu: GpuSlot; order: number }>;
  executionMode: TestExecutionMode;
}

export type ContentItemInput = Omit<ContentItem, 'id' | 'revision' | 'createdAt' | 'updatedAt'>;
export type PresetInput = Omit<Preset, 'id' | 'revision' | 'createdAt' | 'updatedAt'>;

export interface SaveReviewInput {
  sampleId: string;
  reviewerId: string;
  decision: ReviewDecision;
  note: string;
  expectedSampleRevision: number;
  expectedReviewRevision: number;
}

export interface BatchReviewInput {
  reviewerId: string;
  decision: Exclude<ReviewDecision, 'Pending'>;
  note: string;
  items: Array<{
    sampleId: string;
    expectedSampleRevision: number;
    expectedReviewRevision: number;
  }>;
}

export interface TransferCategoryInput {
  sampleId: string;
  targetCategory: Category;
  conflictDirection: ConflictDirection | null;
  expectedRevision: number;
}

export interface ArchivePreview {
  datasetId: string;
  addedSampleIds: string[];
  updatedSampleIds: string[];
  removedSampleIds: string[];
  unchangedCount: number;
  expectedArchiveRevision: number;
}

export interface StatisticsFilter {
  reviewerId: string;
  datasetId: string | null;
  startDate: string;
  endDate: string;
}

export function protocolForCategory(category: Category): Protocol {
  return category.endsWith('-VA') ? 'VA' : 'VT';
}

export function allowedDirections(category: Category): readonly ConflictDirection[] {
  if (category === 'C-VA') return ['Vision', 'Audio'];
  if (category === 'C-VT') return ['Vision', 'Text'];
  return [];
}

export function isDirectionValid(
  category: Category,
  direction: ConflictDirection | null,
): boolean {
  const allowed = allowedDirections(category);
  return allowed.length === 0 ? direction === null : direction !== null && allowed.includes(direction);
}
