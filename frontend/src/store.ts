import {
  createContext,
  createElement,
  useContext,
  useRef,
  useSyncExternalStore,
  type PropsWithChildren,
  type ReactElement,
} from 'react';
import {
  DATA_STORAGE_KEY,
  initialData,
  LOCALE_STORAGE_KEY,
  REVIEWER_STORAGE_KEY,
} from './mock';
import { silentVideoDataUrl, voicedVideoDataUrl } from './mockMedia';
import {
  isDirectionValid,
  type Archive,
  type ArchivePreview,
  type BatchDraft,
  type BatchPreview,
  type BatchReviewInput,
  type Category,
  type ConflictDirection,
  type ContentItem,
  type ContentItemInput,
  type ContentStatus,
  type Dataset,
  type DatasetCounts,
  type DatasetStatus,
  type GpuSlot,
  type Job,
  type JobStatus,
  type Locale,
  type PreparedTest,
  type Preset,
  type PresetInput,
  type RepositoryData,
  type RepositoryFailure,
  type RepositoryResult,
  type RepositorySnapshot,
  type Reviewer,
  type SaveReviewInput,
  type Sample,
  type Statistics,
  type StatisticsFilter,
  type TestDraft,
  type TransferCategoryInput,
  type UpdateJobResultInput,
  type UpdateJobResultValue,
  protocolForCategory,
} from './types';
import { allocatePrototypeId } from './id';

type Listener = () => void;

function copy<T>(value: T): T {
  return structuredClone(value);
}

function now(): string {
  return new Date().toISOString();
}

function success<T>(value: T): RepositoryResult<T> {
  return { ok: true, value };
}

function failure(
  kind: RepositoryFailure['kind'],
  options: Pick<RepositoryFailure, 'field' | 'currentRevision'> = {},
): RepositoryFailure {
  return { ok: false, kind, ...options };
}

function loadData(storage: Storage): RepositoryData {
  const raw = storage.getItem(DATA_STORAGE_KEY);
  if (raw === null) return copy(initialData);
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== 3
  ) {
    throw new Error('Prototype data has an unsupported shape.');
  }
  return parsed as RepositoryData;
}

function loadLocale(storage: Storage): Locale {
  const value = storage.getItem(LOCALE_STORAGE_KEY);
  return value === 'en-US' ? 'en-US' : 'zh-CN';
}

function createJob(
  input: Pick<Job, 'source' | 'datasetId' | 'category' | 'conflictDirection' | 'model' | 'gpu' | 'status' | 'seed' | 'quantity'>,
  timestamp: string,
  startedAt: string | null,
): Job {
  return {
    id: allocatePrototypeId('job'),
    parentJobId: null,
    ...input,
    progress: 0,
    steps: [],
    logs: [],
    resultSampleIds: [],
    revision: 1,
    createdAt: timestamp,
    startedAt,
    completedAt: null,
    updatedAt: timestamp,
  };
}

function createSteps(jobId: string): Job['steps'] {
  const stepNames = [
    'PrepareContent',
    'GeneratePrompt',
    'GenerateVideo',
    'ProcessMedia',
    'SaveResult',
  ] as const;
  return stepNames.map((name, index): Job['steps'][number] => ({
    id: `${jobId}-step-${index + 1}`,
    order: index + 1,
    name,
    status: 'Waiting' as const,
    startedAt: null,
    completedAt: null,
  }));
}

function reserveRunningJobs(
  gpuStates: RepositoryData['gpuStates'],
  jobs: readonly Job[],
  timestamp: string,
): RepositoryData['gpuStates'] {
  const runningByGpu = new Map<GpuSlot, Job>();
  jobs.filter(job => job.status === 'Running').forEach(job => runningByGpu.set(job.gpu, job));
  return gpuStates.map(item => {
    const job = runningByGpu.get(item.slot);
    return job
      ? { ...item, availability: 'Reserved', loadedModel: job.model, activeJobId: job.id, checkedAt: timestamp }
      : item;
  });
}

export function canKeepTestResult(
  job: Job,
): job is Job & { testInput: PreparedTest; testAssignmentOrder: number } {
  return job.status === 'Completed'
    && job.testInput !== undefined
    && job.testAssignmentOrder !== undefined
    && job.testInput.assignments.some(assignment => assignment.order === job.testAssignmentOrder)
    && job.resultSampleIds.length === 0;
}

export class MockRepository {
  private snapshot: RepositorySnapshot;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly storage: Storage) {
    this.snapshot = {
      data: loadData(storage),
      preferences: {
        locale: loadLocale(storage),
        currentReviewerId: storage.getItem(REVIEWER_STORAGE_KEY),
      },
    };
  }

  getSnapshot = (): RepositorySnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    this.listeners.forEach(listener => listener());
  }

  private commitData(data: RepositoryData): void {
    this.storage.setItem(DATA_STORAGE_KEY, JSON.stringify(data));
    this.snapshot = { ...this.snapshot, data };
    this.emit();
  }

  private commitPreferences(preferences: RepositorySnapshot['preferences']): void {
    this.storage.setItem(LOCALE_STORAGE_KEY, preferences.locale);
    if (preferences.currentReviewerId === null) {
      this.storage.removeItem(REVIEWER_STORAGE_KEY);
    } else {
      this.storage.setItem(REVIEWER_STORAGE_KEY, preferences.currentReviewerId);
    }
    this.snapshot = { ...this.snapshot, preferences };
    this.emit();
  }

  setLocale(locale: Locale): void {
    this.commitPreferences({ ...this.snapshot.preferences, locale });
  }

  setCurrentReviewer(reviewerId: string): RepositoryResult<Reviewer> {
    const reviewer = this.snapshot.data.reviewers.find(item => item.id === reviewerId);
    if (!reviewer) return failure('NotFound', { field: 'reviewerId' });
    this.commitPreferences({ ...this.snapshot.preferences, currentReviewerId: reviewerId });
    return success(reviewer);
  }

  getDatasetCounts(datasetId: string): DatasetCounts {
    const samples = this.snapshot.data.samples.filter(sample => sample.datasetId === datasetId);
    return {
      sampleCount: samples.length,
      pendingCount: samples.filter(sample => sample.reviewDecision === 'Pending').length,
      acceptedCount: samples.filter(sample => sample.reviewDecision === 'Accepted').length,
      rejectedCount: samples.filter(sample => sample.reviewDecision === 'Rejected').length,
    };
  }

  createDataset(name: string): RepositoryResult<Dataset> {
    const cleanName = name.trim();
    if (!cleanName) return failure('InvalidInput', { field: 'name' });
    if (this.snapshot.data.datasets.some(item => item.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
      return failure('InvalidInput', { field: 'name' });
    }
    const timestamp = now();
    const dataset: Dataset = {
      id: allocatePrototypeId('dataset'),
      name: cleanName,
      status: 'Active',
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const data = copy(this.snapshot.data);
    data.datasets.unshift(dataset);
    data.archives.push({
      datasetId: dataset.id,
      currentSampleIds: [],
      lastSyncedAt: null,
      revision: 1,
      updatedAt: timestamp,
    });
    data.activities.unshift({
      id: allocatePrototypeId('activity'),
      action: 'DatasetCreated',
      objectLabel: dataset.name,
      reviewerId: this.snapshot.preferences.currentReviewerId,
      occurredAt: timestamp,
    });
    this.commitData(data);
    return success(dataset);
  }

  renameDataset(datasetId: string, name: string, expectedRevision: number): RepositoryResult<Dataset> {
    const dataset = this.snapshot.data.datasets.find(item => item.id === datasetId);
    if (!dataset) return failure('NotFound', { field: 'datasetId' });
    if (dataset.revision !== expectedRevision) {
      return failure('Conflict', { currentRevision: dataset.revision });
    }
    const cleanName = name.trim();
    if (!cleanName) return failure('InvalidInput', { field: 'name' });
    if (
      this.snapshot.data.datasets.some(
        item => item.id !== datasetId && item.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase(),
      )
    ) {
      return failure('InvalidInput', { field: 'name' });
    }
    const timestamp = now();
    const updated: Dataset = { ...dataset, name: cleanName, revision: dataset.revision + 1, updatedAt: timestamp };
    const data = copy(this.snapshot.data);
    data.datasets = data.datasets.map(item => (item.id === datasetId ? updated : item));
    data.activities.unshift({
      id: allocatePrototypeId('activity'),
      action: 'DatasetRenamed',
      objectLabel: updated.name,
      reviewerId: this.snapshot.preferences.currentReviewerId,
      occurredAt: timestamp,
    });
    this.commitData(data);
    return success(updated);
  }

  setDatasetStatus(
    datasetId: string,
    status: DatasetStatus,
    expectedRevision: number,
  ): RepositoryResult<Dataset> {
    const dataset = this.snapshot.data.datasets.find(item => item.id === datasetId);
    if (!dataset) return failure('NotFound', { field: 'datasetId' });
    if (dataset.revision !== expectedRevision) {
      return failure('Conflict', { currentRevision: dataset.revision });
    }
    const timestamp = now();
    const updated: Dataset = { ...dataset, status, revision: dataset.revision + 1, updatedAt: timestamp };
    const data = copy(this.snapshot.data);
    data.datasets = data.datasets.map(item => (item.id === datasetId ? updated : item));
    data.activities.unshift({
      id: allocatePrototypeId('activity'),
      action: 'DatasetDisabled',
      objectLabel: updated.name,
      reviewerId: this.snapshot.preferences.currentReviewerId,
      occurredAt: timestamp,
    });
    this.commitData(data);
    return success(updated);
  }

  previewBatch(draft: BatchDraft): RepositoryResult<BatchPreview> {
    const dataset = this.snapshot.data.datasets.find(item => item.id === draft.datasetId);
    if (!dataset) return failure('NotFound', { field: 'datasetId' });
    if (dataset.status !== 'Active') return failure('Unavailable', { field: 'datasetId' });
    if (!isDirectionValid(draft.category, draft.conflictDirection)) {
      return failure('InvalidInput', { field: 'conflictDirection' });
    }
    if (
      draft.quantity < 1 ||
      draft.contentItemIds.length === 0 ||
      draft.ages.length === 0 ||
      draft.genders.length === 0 ||
      draft.ethnicities.length === 0
    ) {
      return failure('InvalidInput', { field: 'quantity' });
    }
    const contents = draft.contentItemIds.map(id => this.snapshot.data.contentItems.find(item => item.id === id));
    if (
      contents.some(
        item =>
          !item ||
          item.status !== 'Active' ||
          item.category !== draft.category ||
          item.conflictDirection !== draft.conflictDirection,
      )
    ) {
      return failure('InvalidInput', { field: 'contentItemIds' });
    }
    const preset = this.snapshot.data.presets.find(item => item.id === draft.presetId);
    if (!preset || preset.category !== draft.category) return failure('InvalidInput', { field: 'presetId' });
    const gpu = this.snapshot.data.gpuStates.find(item => item.slot === draft.gpu);
    if (!gpu || gpu.availability !== 'Available') return failure('Unavailable', { field: 'gpu' });

    const combinations = draft.ages.flatMap(age =>
      draft.genders.flatMap(gender => draft.ethnicities.map(ethnicity => ({ age, gender, ethnicity }))),
    );
    const allocations = Array.from({ length: draft.quantity }, (_, index) => {
      const content = contents[index % contents.length]!;
      const demographics = combinations[index % combinations.length];
      return {
        sequence: index + 1,
        contentItemId: content.id,
        contentItemName: content.name,
        category: draft.category,
        conflictDirection: draft.conflictDirection,
        ...demographics,
        model: draft.model,
        gpu: draft.gpu,
      };
    });
    return success({
      draft: copy(draft),
      allocations,
      datasetRevision: dataset.revision,
      contentItemRevisions: Object.fromEntries(contents.map(item => [item!.id, item!.revision])),
      presetRevision: preset.revision,
    });
  }

  submitBatch(preview: BatchPreview): RepositoryResult<Job> {
    const dataset = this.snapshot.data.datasets.find(item => item.id === preview.draft.datasetId);
    if (!dataset) return failure('NotFound', { field: 'datasetId' });
    if (dataset.revision !== preview.datasetRevision) {
      return failure('Conflict', { currentRevision: dataset.revision });
    }
    for (const [id, expectedRevision] of Object.entries(preview.contentItemRevisions)) {
      const content = this.snapshot.data.contentItems.find(item => item.id === id);
      if (!content) return failure('NotFound', { field: 'contentItemId' });
      if (content.revision !== expectedRevision) {
        return failure('Conflict', { currentRevision: content.revision });
      }
    }
    const preset = this.snapshot.data.presets.find(item => item.id === preview.draft.presetId);
    if (!preset) return failure('NotFound', { field: 'presetId' });
    if (preset.revision !== preview.presetRevision) {
      return failure('Conflict', { currentRevision: preset.revision });
    }
    const gpu = this.snapshot.data.gpuStates.find(item => item.slot === preview.draft.gpu);
    if (!gpu || gpu.availability !== 'Available') return failure('Unavailable', { field: 'gpu' });

    const timestamp = now();
    const job = createJob(
      {
        source: 'Production',
        datasetId: preview.draft.datasetId,
        category: preview.draft.category,
        conflictDirection: preview.draft.conflictDirection,
        model: preview.draft.model,
        gpu: preview.draft.gpu,
        status: 'Queued',
        seed: preview.draft.seed,
        quantity: preview.draft.quantity,
      },
      timestamp,
      null,
    );
    job.batchInput = copy(preview);
    const data = copy(this.snapshot.data);
    data.jobs.unshift(job);
    data.gpuStates = data.gpuStates.map(item =>
      item.slot === job.gpu
        ? { ...item, availability: 'Reserved', loadedModel: job.model, activeJobId: job.id, checkedAt: timestamp }
        : item,
    );
    data.activities.unshift({
      id: allocatePrototypeId('activity'),
      action: 'JobCreated',
      objectLabel: job.id,
      reviewerId: this.snapshot.preferences.currentReviewerId,
      occurredAt: timestamp,
    });
    this.commitData(data);
    return success(job);
  }

  prepareTest(draft: TestDraft): RepositoryResult<PreparedTest> {
    if (!isDirectionValid(draft.category, draft.conflictDirection)) {
      return failure('InvalidInput', { field: 'conflictDirection' });
    }
    if (draft.assignments.length < 1 || draft.assignments.length > 2) {
      return failure('InvalidInput', { field: 'assignments' });
    }
    const models = new Set(draft.assignments.map(item => item.model));
    if (models.size !== draft.assignments.length) return failure('InvalidInput', { field: 'assignments' });
    if (draft.executionMode === 'Parallel' && new Set(draft.assignments.map(item => item.gpu)).size !== draft.assignments.length) {
      return failure('InvalidInput', { field: 'assignments' });
    }
    const content = this.snapshot.data.contentItems.find(item => item.id === draft.contentItemId);
    if (!content || content.category !== draft.category || content.conflictDirection !== draft.conflictDirection) {
      return failure('InvalidInput', { field: 'contentItemId' });
    }
    const preset = this.snapshot.data.presets.find(item => item.id === draft.presetId);
    if (!preset || preset.category !== draft.category) return failure('InvalidInput', { field: 'presetId' });
    return success({
      id: allocatePrototypeId('prepared-test'),
      ...copy(draft),
      models: draft.assignments.map(item => item.model),
      dialogue: content.dialogue,
      displayText: content.displayText,
      explanation: content.explanation,
      videoPrompt: content.videoPrompt,
      emotion: content.emotion,
      contentRevision: content.revision,
      presetRevision: preset.revision,
    });
  }

  submitTest(prepared: PreparedTest): RepositoryResult<Job[]> {
    const content = this.snapshot.data.contentItems.find(item => item.id === prepared.contentItemId);
    const preset = this.snapshot.data.presets.find(item => item.id === prepared.presetId);
    if (!content || !preset) return failure('NotFound');
    if (content.revision !== prepared.contentRevision) {
      return failure('Conflict', { currentRevision: content.revision });
    }
    if (preset.revision !== prepared.presetRevision) {
      return failure('Conflict', { currentRevision: preset.revision });
    }
    const usedSlots = [...new Set(prepared.assignments.map(item => item.gpu))];
    for (const slot of usedSlots) {
      const gpu = this.snapshot.data.gpuStates.find(item => item.slot === slot);
      if (!gpu || gpu.availability !== 'Available') return failure('Unavailable', { field: slot });
    }
    const timestamp = now();
    const jobs = prepared.assignments
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((assignment, index): Job => {
        const immediatelyRunning = prepared.executionMode === 'Parallel' || index === 0;
        const job = createJob(
          {
            source: 'Test',
            datasetId: null,
            category: prepared.category,
            conflictDirection: prepared.conflictDirection,
            model: assignment.model,
            gpu: assignment.gpu,
            status: immediatelyRunning ? 'Running' : 'Queued',
            seed: prepared.seed,
            quantity: 1,
          },
          timestamp,
          immediatelyRunning ? timestamp : null,
        );
        job.testInput = copy(prepared);
        job.testAssignmentOrder = assignment.order;
        return job;
      });
    const data = copy(this.snapshot.data);
    data.jobs = [...jobs, ...data.jobs];
    data.gpuStates = reserveRunningJobs(data.gpuStates, jobs, timestamp);
    data.activities.unshift(
      ...jobs.map(job => ({
        id: allocatePrototypeId('activity'),
        action: 'JobCreated' as const,
        objectLabel: job.id,
        reviewerId: this.snapshot.preferences.currentReviewerId,
        occurredAt: timestamp,
      })),
    );
    this.commitData(data);
    return success(jobs);
  }

  cancelJob(jobId: string, expectedRevision: number): RepositoryResult<Job> {
    const job = this.snapshot.data.jobs.find(item => item.id === jobId);
    if (!job) return failure('NotFound', { field: 'jobId' });
    if (job.revision !== expectedRevision) return failure('Conflict', { currentRevision: job.revision });
    if (job.status !== 'Queued' && job.status !== 'Running') return failure('InvalidInput', { field: 'status' });
    const timestamp = now();
    const updated: Job = {
      ...job,
      status: 'Cancelled',
      completedAt: timestamp,
      updatedAt: timestamp,
      revision: job.revision + 1,
      steps: job.steps.map(step =>
        step.status === 'Running' || step.status === 'Waiting'
          ? { ...step, status: 'Cancelled', completedAt: timestamp }
          : step,
      ),
    };
    const data = copy(this.snapshot.data);
    data.jobs = data.jobs.map(item => (item.id === jobId ? updated : item));
    data.gpuStates = data.gpuStates.map(item =>
      item.activeJobId === jobId
        ? { ...item, availability: 'Available', activeJobId: null, checkedAt: timestamp }
        : item,
    );
    this.commitData(data);
    return success(updated);
  }

  retryJob(
    jobId: string,
    gpu: GpuSlot,
    seed: number | null,
    expectedRevision: number,
  ): RepositoryResult<Job> {
    const source = this.snapshot.data.jobs.find(item => item.id === jobId);
    if (!source) return failure('NotFound', { field: 'jobId' });
    if (source.revision !== expectedRevision) return failure('Conflict', { currentRevision: source.revision });
    if (source.status !== 'Failed' && source.status !== 'Cancelled') return failure('InvalidInput', { field: 'status' });
    const gpuState = this.snapshot.data.gpuStates.find(item => item.slot === gpu);
    if (!gpuState || gpuState.availability !== 'Available') return failure('Unavailable', { field: 'gpu' });
    const timestamp = now();
    const id = allocatePrototypeId('job');
    const job: Job = {
      ...source,
      id,
      parentJobId: source.id,
      source: 'Rerender',
      gpu,
      seed,
      status: 'Queued',
      progress: 0,
      steps: createSteps(id),
      logs: [{ sequence: 1, stepId: `${id}-step-1`, messageKey: 'jobs.log.created', occurredAt: timestamp }],
      resultSampleIds: [],
      revision: 1,
      createdAt: timestamp,
      startedAt: null,
      completedAt: null,
      updatedAt: timestamp,
    };
    if (job.testInput) {
      job.testInput = {
        ...copy(job.testInput),
        seed,
        assignments: job.testInput.assignments.map(assignment =>
          assignment.order === job.testAssignmentOrder ? { ...assignment, gpu } : assignment,
        ),
      };
    }
    const data = copy(this.snapshot.data);
    data.jobs.unshift(job);
    data.gpuStates = data.gpuStates.map(item =>
      item.slot === gpu
        ? { ...item, availability: 'Reserved', loadedModel: job.model, activeJobId: job.id, checkedAt: timestamp }
        : item,
    );
    this.commitData(data);
    return success(job);
  }

  keepTestResult(jobId: string, datasetId: string, expectedRevision: number): RepositoryResult<Sample> {
    const job = this.snapshot.data.jobs.find(item => item.id === jobId);
    const dataset = this.snapshot.data.datasets.find(item => item.id === datasetId);
    if (!job || !dataset) return failure('NotFound');
    if (job.revision !== expectedRevision) return failure('Conflict', { currentRevision: job.revision });
    if (!canKeepTestResult(job)) return failure('InvalidInput', { field: 'result' });
    const input = job.testInput;
    const assignment = input.assignments.find(item => item.order === job.testAssignmentOrder)!;
    const timestamp = now();
    const sampleId = allocatePrototypeId('sample');
    const protocol = protocolForCategory(input.category);
    const sample: Sample = {
      id: sampleId,
      displayId: `CS-${String(this.snapshot.data.samples.length + 1).padStart(4, '0')}`,
      datasetId,
      category: input.category,
      conflictDirection: input.conflictDirection,
      reviewDecision: 'Pending',
      reviewRevision: 0,
      model: assignment.model,
      gpu: assignment.gpu,
      contentItemId: input.contentItemId,
      presetId: input.presetId,
      primaryAssetId: protocol === 'VA' ? voicedVideoDataUrl : silentVideoDataUrl,
      sourceAssetId: protocol === 'VT' ? voicedVideoDataUrl : null,
      thumbnailAssetId: null,
      dialogue: input.dialogue,
      displayText: input.displayText,
      videoPrompt: input.videoPrompt,
      explanation: input.explanation,
      generationNote: '',
      emotion: input.emotion,
      seed: input.seed ?? 0,
      archiveStatus: 'Current',
      revision: 1,
      updatedAt: timestamp,
    };
    const data = copy(this.snapshot.data);
    data.samples.unshift(sample);
    data.jobs = data.jobs.map(item =>
      item.id === jobId
        ? { ...item, resultSampleIds: [...item.resultSampleIds, sampleId], revision: item.revision + 1, updatedAt: timestamp }
        : item,
    );
    this.commitData(data);
    return success(sample);
  }

  releaseGpu(slot: GpuSlot): RepositoryResult<GpuSlot> {
    const gpu = this.snapshot.data.gpuStates.find(item => item.slot === slot);
    if (!gpu) return failure('NotFound', { field: 'gpu' });
    if (gpu.availability !== 'Available' || gpu.activeJobId !== null || gpu.loadedModel === null) {
      return failure('Unavailable', { field: 'gpu' });
    }
    const timestamp = now();
    const data = copy(this.snapshot.data);
    data.gpuStates = data.gpuStates.map(item =>
      item.slot === slot ? { ...item, loadedModel: null, checkedAt: timestamp } : item,
    );
    this.commitData(data);
    return success(slot);
  }

  updateJobResult(input: UpdateJobResultInput): RepositoryResult<UpdateJobResultValue> {
    const job = this.snapshot.data.jobs.find(item => item.id === input.jobId);
    const sample = this.snapshot.data.samples.find(item => item.id === input.sampleId);
    if (!job || !sample) return failure('NotFound');
    if (job.revision !== input.expectedJobRevision) {
      return failure('Conflict', { currentRevision: job.revision });
    }
    if (sample.revision !== input.expectedSampleRevision) {
      return failure('Conflict', { currentRevision: sample.revision });
    }
    if (
      job.status !== 'Completed' ||
      job.resultSampleIds[job.resultSampleIds.length - 1] !== sample.id
    ) {
      return failure('InvalidInput', { field: 'result' });
    }

    const protocol = protocolForCategory(sample.category);
    const dialogue = protocol === 'VA' ? input.dialogue : null;
    const displayText = protocol === 'VT' ? input.displayText : null;
    const needsRerender = input.videoPrompt !== sample.videoPrompt || dialogue !== sample.dialogue;
    const invalidatesReview = needsRerender || displayText !== sample.displayText;
    if (needsRerender && input.rerenderGpu === null) {
      return failure('InvalidInput', { field: 'gpu' });
    }
    const gpu = input.rerenderGpu === null
      ? null
      : this.snapshot.data.gpuStates.find(item => item.slot === input.rerenderGpu);
    if (needsRerender && (!gpu || gpu.availability !== 'Available')) {
      return failure('Unavailable', { field: 'gpu' });
    }

    const timestamp = now();
    const updatedSample: Sample = needsRerender
      ? sample
      : {
          ...sample,
          dialogue,
          displayText,
          videoPrompt: input.videoPrompt,
          explanation: input.explanation,
          generationNote: input.generationNote,
          reviewDecision: invalidatesReview ? 'Pending' : sample.reviewDecision,
          reviewRevision: invalidatesReview ? sample.reviewRevision + 1 : sample.reviewRevision,
          archiveStatus: 'NeedsUpdate',
          revision: sample.revision + 1,
          updatedAt: timestamp,
        };

    const rerenderBase = needsRerender
      ? createJob(
          {
            source: 'Rerender',
            datasetId: sample.datasetId,
            category: sample.category,
            conflictDirection: sample.conflictDirection,
            model: sample.model,
            gpu: input.rerenderGpu!,
            status: 'Queued',
            seed: sample.seed,
            quantity: 1,
          },
          timestamp,
          null,
        )
      : null;
    const rerenderJob: Job | null = rerenderBase
      ? {
          ...rerenderBase,
          parentJobId: job.id,
          batchInput: job.batchInput,
          testInput: job.testInput,
          testAssignmentOrder: job.testAssignmentOrder,
          rerenderInput: {
            dialogue,
            displayText,
            videoPrompt: input.videoPrompt,
            explanation: input.explanation,
            generationNote: input.generationNote,
          },
          steps: createSteps(rerenderBase.id),
          logs: [{
            sequence: 1,
            stepId: `${rerenderBase.id}-step-1`,
            messageKey: 'jobs.log.rerenderCreated',
            occurredAt: timestamp,
          }],
        }
      : null;
    const updatedJob: Job = {
      ...job,
      revision: job.revision + 1,
      updatedAt: timestamp,
      logs: [
        ...job.logs,
        {
          sequence: job.logs.length + 1,
          stepId: job.steps[job.steps.length - 1]?.id ?? `${job.id}-step-5`,
          messageKey: needsRerender ? 'jobs.log.rerenderCreated' : 'jobs.log.resultEdited',
          occurredAt: timestamp,
        },
      ],
    };

    const data = copy(this.snapshot.data);
    data.samples = data.samples.map(item => item.id === sample.id ? updatedSample : item);
    data.jobs = [
      ...(rerenderJob ? [rerenderJob] : []),
      ...data.jobs.map(item => item.id === job.id ? updatedJob : item),
    ];
    if (rerenderJob) {
      data.gpuStates = data.gpuStates.map(item =>
        item.slot === rerenderJob.gpu
          ? {
              ...item,
              availability: 'Reserved',
              loadedModel: rerenderJob.model,
              activeJobId: rerenderJob.id,
              checkedAt: timestamp,
            }
          : item,
      );
      data.activities.unshift({
        id: allocatePrototypeId('activity'),
        action: 'JobCreated',
        objectLabel: rerenderJob.id,
        reviewerId: this.snapshot.preferences.currentReviewerId,
        occurredAt: timestamp,
      });
    }
    this.commitData(data);
    return success({ sample: updatedSample, rerenderJob });
  }

  createContentItem(input: ContentItemInput): RepositoryResult<ContentItem> {
    if (!input.name.trim() || !isDirectionValid(input.category, input.conflictDirection)) {
      return failure('InvalidInput', { field: 'contentItem' });
    }
    const timestamp = now();
    const item: ContentItem = {
      ...copy(input),
      id: allocatePrototypeId('content'),
      name: input.name.trim(),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const data = copy(this.snapshot.data);
    data.contentItems.unshift(item);
    this.commitData(data);
    return success(item);
  }

  updateContentItem(
    contentId: string,
    patch: Partial<ContentItemInput>,
    expectedRevision: number,
  ): RepositoryResult<ContentItem> {
    const item = this.snapshot.data.contentItems.find(entry => entry.id === contentId);
    if (!item) return failure('NotFound', { field: 'contentId' });
    if (item.revision !== expectedRevision) return failure('Conflict', { currentRevision: item.revision });
    const candidate = { ...item, ...copy(patch) };
    if (!candidate.name.trim() || !isDirectionValid(candidate.category, candidate.conflictDirection)) {
      return failure('InvalidInput', { field: 'contentItem' });
    }
    const updated: ContentItem = {
      ...candidate,
      name: candidate.name.trim(),
      revision: item.revision + 1,
      updatedAt: now(),
    };
    const data = copy(this.snapshot.data);
    data.contentItems = data.contentItems.map(entry => (entry.id === contentId ? updated : entry));
    this.commitData(data);
    return success(updated);
  }

  setContentStatus(
    contentId: string,
    status: ContentStatus,
    expectedRevision: number,
  ): RepositoryResult<ContentItem> {
    return this.updateContentItem(contentId, { status }, expectedRevision);
  }

  createPreset(input: PresetInput): RepositoryResult<Preset> {
    if (!input.name.trim()) return failure('InvalidInput', { field: 'name' });
    const timestamp = now();
    const preset: Preset = {
      ...copy(input),
      id: allocatePrototypeId('preset'),
      name: input.name.trim(),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const data = copy(this.snapshot.data);
    data.presets.unshift(preset);
    this.commitData(data);
    return success(preset);
  }

  updatePreset(
    presetId: string,
    patch: Partial<Omit<PresetInput, 'fixedStructureRules' | 'category'>>,
    expectedRevision: number,
  ): RepositoryResult<Preset> {
    const preset = this.snapshot.data.presets.find(item => item.id === presetId);
    if (!preset) return failure('NotFound', { field: 'presetId' });
    if (preset.revision !== expectedRevision) return failure('Conflict', { currentRevision: preset.revision });
    const updated: Preset = {
      ...preset,
      ...copy(patch),
      name: patch.name?.trim() || preset.name,
      revision: preset.revision + 1,
      updatedAt: now(),
    };
    const data = copy(this.snapshot.data);
    data.presets = data.presets.map(item => (item.id === presetId ? updated : item));
    this.commitData(data);
    return success(updated);
  }

  createReviewer(name: string): RepositoryResult<Reviewer> {
    const cleanName = name.trim();
    if (!cleanName) return failure('InvalidInput', { field: 'name' });
    if (this.snapshot.data.reviewers.some(item => item.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
      return failure('InvalidInput', { field: 'name' });
    }
    const timestamp = now();
    const reviewer: Reviewer = {
      id: allocatePrototypeId('reviewer'),
      name: cleanName,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const data = copy(this.snapshot.data);
    data.reviewers.push(reviewer);
    this.commitData(data);
    this.commitPreferences({ ...this.snapshot.preferences, currentReviewerId: reviewer.id });
    return success(reviewer);
  }

  renameReviewer(reviewerId: string, name: string, expectedRevision: number): RepositoryResult<Reviewer> {
    const reviewer = this.snapshot.data.reviewers.find(item => item.id === reviewerId);
    if (!reviewer) return failure('NotFound', { field: 'reviewerId' });
    if (reviewer.revision !== expectedRevision) {
      return failure('Conflict', { currentRevision: reviewer.revision });
    }
    const cleanName = name.trim();
    if (!cleanName) return failure('InvalidInput', { field: 'name' });
    if (
      this.snapshot.data.reviewers.some(
        item => item.id !== reviewerId && item.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase(),
      )
    ) {
      return failure('InvalidInput', { field: 'name' });
    }
    const updated: Reviewer = { ...reviewer, name: cleanName, revision: reviewer.revision + 1, updatedAt: now() };
    const data = copy(this.snapshot.data);
    data.reviewers = data.reviewers.map(item => (item.id === reviewerId ? updated : item));
    this.commitData(data);
    return success(updated);
  }

  saveReview(input: SaveReviewInput): RepositoryResult<Sample> {
    const sample = this.snapshot.data.samples.find(item => item.id === input.sampleId);
    if (!sample) return failure('NotFound', { field: 'sampleId' });
    if (!this.snapshot.data.reviewers.some(item => item.id === input.reviewerId)) {
      return failure('NotFound', { field: 'reviewerId' });
    }
    if (sample.revision !== input.expectedSampleRevision) {
      return failure('Conflict', { currentRevision: sample.revision });
    }
    if (sample.reviewRevision !== input.expectedReviewRevision) {
      return failure('Conflict', { currentRevision: sample.reviewRevision });
    }
    const timestamp = now();
    const nextReviewRevision = sample.reviewRevision + 1;
    const archived = this.snapshot.data.archives.some(archive => archive.currentSampleIds.includes(sample.id));
    const updated: Sample = {
      ...sample,
      reviewDecision: input.decision,
      reviewRevision: nextReviewRevision,
      archiveStatus: archived || input.decision === 'Accepted' ? 'NeedsUpdate' : sample.archiveStatus,
      revision: sample.revision + 1,
      updatedAt: timestamp,
    };
    const data = copy(this.snapshot.data);
    data.samples = data.samples.map(item => (item.id === sample.id ? updated : item));
    data.reviews.push({
      id: allocatePrototypeId('review'),
      sampleId: sample.id,
      reviewerId: input.reviewerId,
      decision: input.decision,
      note: input.note.trim(),
      sampleRevision: sample.revision,
      revision: nextReviewRevision,
      createdAt: timestamp,
    });
    data.activities.unshift({
      id: allocatePrototypeId('activity'),
      action: 'ReviewSaved',
      objectLabel: sample.displayId,
      reviewerId: input.reviewerId,
      occurredAt: timestamp,
    });
    this.commitData(data);
    return success(updated);
  }

  batchReview(input: BatchReviewInput): RepositoryResult<Sample[]> {
    if (!this.snapshot.data.reviewers.some(item => item.id === input.reviewerId)) {
      return failure('NotFound', { field: 'reviewerId' });
    }
    const selected = input.items.map(item => ({
      request: item,
      sample: this.snapshot.data.samples.find(sample => sample.id === item.sampleId),
    }));
    const missing = selected.find(item => !item.sample);
    if (missing) return failure('NotFound', { field: 'sampleId' });
    const stale = selected.find(
      item =>
        item.sample!.revision !== item.request.expectedSampleRevision ||
        item.sample!.reviewRevision !== item.request.expectedReviewRevision,
    );
    if (stale) return failure('Conflict', { currentRevision: stale.sample!.revision });
    const timestamp = now();
    const ids = new Set(input.items.map(item => item.sampleId));
    const archives = this.snapshot.data.archives;
    const updatedSamples = selected.map(({ sample }) => ({
      ...sample!,
      reviewDecision: input.decision,
      reviewRevision: sample!.reviewRevision + 1,
      archiveStatus:
        archives.some(archive => archive.currentSampleIds.includes(sample!.id)) || input.decision === 'Accepted'
          ? ('NeedsUpdate' as const)
          : sample!.archiveStatus,
      revision: sample!.revision + 1,
      updatedAt: timestamp,
    }));
    const byId = new Map(updatedSamples.map(sample => [sample.id, sample]));
    const data = copy(this.snapshot.data);
    data.samples = data.samples.map(sample => byId.get(sample.id) ?? sample);
    data.reviews.push(
      ...updatedSamples.map(sample => ({
        id: allocatePrototypeId('review'),
        sampleId: sample.id,
        reviewerId: input.reviewerId,
        decision: input.decision,
        note: input.note.trim(),
        sampleRevision: sample.revision - 1,
        revision: sample.reviewRevision,
        createdAt: timestamp,
      })),
    );
    data.activities.unshift(
      ...updatedSamples.map(sample => ({
        id: allocatePrototypeId('activity'),
        action: 'ReviewSaved' as const,
        objectLabel: sample.displayId,
        reviewerId: input.reviewerId,
        occurredAt: timestamp,
      })),
    );
    this.commitData(data);
    return success(updatedSamples.filter(sample => ids.has(sample.id)));
  }

  transferCategory(input: TransferCategoryInput): RepositoryResult<Sample> {
    const sample = this.snapshot.data.samples.find(item => item.id === input.sampleId);
    if (!sample) return failure('NotFound', { field: 'sampleId' });
    if (sample.revision !== input.expectedRevision) {
      return failure('Conflict', { currentRevision: sample.revision });
    }
    if (protocolForCategory(sample.category) !== protocolForCategory(input.targetCategory)) {
      return failure('InvalidInput', { field: 'targetCategory' });
    }
    if (!isDirectionValid(input.targetCategory, input.conflictDirection)) {
      return failure('InvalidInput', { field: 'conflictDirection' });
    }
    const timestamp = now();
    const updated: Sample = {
      ...sample,
      category: input.targetCategory,
      conflictDirection: input.conflictDirection,
      reviewDecision: 'Pending',
      reviewRevision: sample.reviewRevision + 1,
      archiveStatus: 'NeedsUpdate',
      revision: sample.revision + 1,
      updatedAt: timestamp,
    };
    const data = copy(this.snapshot.data);
    data.samples = data.samples.map(item => (item.id === sample.id ? updated : item));
    this.commitData(data);
    return success(updated);
  }

  previewArchive(datasetId: string): RepositoryResult<ArchivePreview> {
    if (!this.snapshot.data.datasets.some(item => item.id === datasetId)) {
      return failure('NotFound', { field: 'datasetId' });
    }
    const archive = this.snapshot.data.archives.find(item => item.datasetId === datasetId);
    const current = new Set(archive?.currentSampleIds ?? []);
    const accepted = this.snapshot.data.samples.filter(
      sample => sample.datasetId === datasetId && sample.reviewDecision === 'Accepted',
    );
    const acceptedIds = new Set(accepted.map(sample => sample.id));
    const addedSampleIds = accepted.filter(sample => !current.has(sample.id)).map(sample => sample.id);
    const updatedSampleIds = accepted
      .filter(sample => current.has(sample.id) && sample.archiveStatus === 'NeedsUpdate')
      .map(sample => sample.id);
    const removedSampleIds = [...current].filter(id => !acceptedIds.has(id));
    return success({
      datasetId,
      addedSampleIds,
      updatedSampleIds,
      removedSampleIds,
      unchangedCount: accepted.length - addedSampleIds.length - updatedSampleIds.length,
      expectedArchiveRevision: archive?.revision ?? 0,
    });
  }

  syncArchive(preview: ArchivePreview): RepositoryResult<Archive> {
    const currentArchive = this.snapshot.data.archives.find(item => item.datasetId === preview.datasetId);
    const currentRevision = currentArchive?.revision ?? 0;
    if (currentRevision !== preview.expectedArchiveRevision) {
      return failure('Conflict', { currentRevision });
    }
    const freshPreview = this.previewArchive(preview.datasetId);
    if (!freshPreview.ok) return freshPreview;
    const same =
      JSON.stringify(freshPreview.value.addedSampleIds) === JSON.stringify(preview.addedSampleIds) &&
      JSON.stringify(freshPreview.value.updatedSampleIds) === JSON.stringify(preview.updatedSampleIds) &&
      JSON.stringify(freshPreview.value.removedSampleIds) === JSON.stringify(preview.removedSampleIds);
    if (!same) return failure('Conflict', { currentRevision });
    const timestamp = now();
    const currentSampleIds = this.snapshot.data.samples
      .filter(sample => sample.datasetId === preview.datasetId && sample.reviewDecision === 'Accepted')
      .map(sample => sample.id);
    const archive: Archive = {
      datasetId: preview.datasetId,
      currentSampleIds,
      lastSyncedAt: timestamp,
      revision: currentRevision + 1,
      updatedAt: timestamp,
    };
    const currentSet = new Set(currentSampleIds);
    const removedSet = new Set(preview.removedSampleIds);
    const data = copy(this.snapshot.data);
    data.archives = currentArchive
      ? data.archives.map(item => (item.datasetId === preview.datasetId ? archive : item))
      : [...data.archives, archive];
    data.samples = data.samples.map(sample =>
      sample.datasetId === preview.datasetId && (currentSet.has(sample.id) || removedSet.has(sample.id))
        ? { ...sample, archiveStatus: 'Current', updatedAt: timestamp }
        : sample,
    );
    data.activities.unshift({
      id: allocatePrototypeId('activity'),
      action: 'ArchiveSynced',
      objectLabel: this.snapshot.data.datasets.find(item => item.id === preview.datasetId)?.name ?? preview.datasetId,
      reviewerId: this.snapshot.preferences.currentReviewerId,
      occurredAt: timestamp,
    });
    this.commitData(data);
    return success(archive);
  }

  getStatistics(filter: StatisticsFilter): RepositoryResult<Statistics> {
    if (!this.snapshot.data.reviewers.some(item => item.id === filter.reviewerId)) {
      return failure('NotFound', { field: 'reviewerId' });
    }
    if (filter.startDate > filter.endDate) return failure('InvalidInput', { field: 'startDate' });
    const sampleById = new Map(this.snapshot.data.samples.map(sample => [sample.id, sample]));
    const inRange = this.snapshot.data.reviews.filter(review => {
      const sample = sampleById.get(review.sampleId);
      const day = review.createdAt.slice(0, 10);
      return (
        review.reviewerId === filter.reviewerId &&
        day >= filter.startDate &&
        day <= filter.endDate &&
        (filter.datasetId === null || sample?.datasetId === filter.datasetId)
      );
    });
    const latest = new Map<string, (typeof inRange)[number]>();
    inRange.forEach(review => {
      const current = latest.get(review.sampleId);
      if (!current || review.revision > current.revision) latest.set(review.sampleId, review);
    });
    const latestReviews = [...latest.values()];
    const latestSamples = latestReviews.flatMap(review => {
      const sample = sampleById.get(review.sampleId);
      return sample ? [sample] : [];
    });
    const changedSampleIds = new Set<string>();
    const reviewHistory = new Map<string, typeof this.snapshot.data.reviews>();
    this.snapshot.data.reviews.forEach(review => {
      if (review.reviewerId !== filter.reviewerId) return;
      const sample = sampleById.get(review.sampleId);
      if (filter.datasetId !== null && sample?.datasetId !== filter.datasetId) return;
      const history = reviewHistory.get(review.sampleId) ?? [];
      history.push(review);
      reviewHistory.set(review.sampleId, history);
    });
    reviewHistory.forEach(history => {
      history.sort((left, right) => left.revision - right.revision);
      history.forEach((review, index) => {
        const previous = history[index - 1];
        const day = review.createdAt.slice(0, 10);
        if (
          previous
          && previous.decision !== review.decision
          && day >= filter.startDate
          && day <= filter.endDate
        ) {
          changedSampleIds.add(review.sampleId);
        }
      });
    });

    const start = new Date(`${filter.startDate}T00:00:00.000Z`);
    const end = new Date(`${filter.endDate}T00:00:00.000Z`);
    const activity: Statistics['activity'] = [];
    for (let date = start; date <= end; date = new Date(date.getTime() + 86_400_000)) {
      const day = date.toISOString().slice(0, 10);
      activity.push({ date: day, reviewedCount: inRange.filter(review => review.createdAt.startsWith(day)).length });
    }
    return success({
      reviewerId: filter.reviewerId,
      datasetId: filter.datasetId,
      startDate: filter.startDate,
      endDate: filter.endDate,
      uniqueReviewedCount: latestReviews.length,
      revisedSampleCount: changedSampleIds.size,
      archivedCurrentCount: latestSamples.filter(
        sample => sample.reviewDecision === 'Accepted' && sample.archiveStatus === 'Current',
      ).length,
      needsUpdateCount: latestSamples.filter(sample => sample.archiveStatus === 'NeedsUpdate').length,
      acceptedCount: latestReviews.filter(review => review.decision === 'Accepted').length,
      rejectedCount: latestReviews.filter(review => review.decision === 'Rejected').length,
      vaCount: latestSamples.filter(sample => protocolForCategory(sample.category) === 'VA').length,
      vtCount: latestSamples.filter(sample => protocolForCategory(sample.category) === 'VT').length,
      activity,
    });
  }
}

const RepositoryContext = createContext<MockRepository | null>(null);

export function RepositoryProvider({ children }: PropsWithChildren): ReactElement {
  const repositoryRef = useRef<MockRepository | null>(null);
  if (!repositoryRef.current) repositoryRef.current = new MockRepository(window.localStorage);
  return createElement(RepositoryContext.Provider, { value: repositoryRef.current }, children);
}

export function useMockRepository(): MockRepository {
  const repository = useContext(RepositoryContext);
  if (!repository) throw new Error('RepositoryProvider is required.');
  return repository;
}

export function useRepositorySnapshot(): RepositorySnapshot {
  const repository = useMockRepository();
  return useSyncExternalStore(repository.subscribe, repository.getSnapshot, repository.getSnapshot);
}

export function categoriesForProtocol(protocol: 'VA' | 'VT'): Category[] {
  return protocol === 'VA' ? ['A-VA', 'C-VA'] : ['A-VT', 'C-VT'];
}

export function nextCategory(category: Category): Category {
  const transfers: Record<Category, Category> = {
    'A-VA': 'C-VA',
    'C-VA': 'A-VA',
    'A-VT': 'C-VT',
    'C-VT': 'A-VT',
  };
  return transfers[category];
}

export function directionForTransfer(
  targetCategory: Category,
  preferred: ConflictDirection | null,
): ConflictDirection | null {
  if (targetCategory === 'A-VA' || targetCategory === 'A-VT') return null;
  if (preferred && isDirectionValid(targetCategory, preferred)) return preferred;
  return targetCategory === 'C-VA' ? 'Vision' : 'Text';
}

export function canRetry(status: JobStatus): boolean {
  return status === 'Failed' || status === 'Cancelled';
}
