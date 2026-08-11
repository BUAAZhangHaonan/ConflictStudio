import type {
  Archive,
  Category,
  ConflictDirection,
  ContentItem,
  Job,
  JobStatus,
  Preset,
  RepositoryData,
  Review,
  ReviewDecision,
  Sample,
} from './types';
import { silentVideoDataUrl, voicedVideoDataUrl } from './mockMedia';

export const DATA_STORAGE_KEY = 'conflictstudio.prototype.data.v5';
export const LOCALE_STORAGE_KEY = 'conflictstudio.prototype.locale';
export const REVIEWER_STORAGE_KEY = 'conflictstudio.prototype.reviewer.v2';

const baseDate = '2026-08-09T10:00:00.000Z';

const categories: Category[] = ['A-VA', 'A-VT', 'C-VA', 'C-VT'];
const decisions: ReviewDecision[] = ['Pending', 'Accepted', 'Rejected'];
const directionBySample: Record<string, ConflictDirection | null> = {
  'C-VA-0': 'Vision',
  'C-VA-1': 'Audio',
  'C-VA-2': 'Vision',
  'C-VT-0': 'Vision',
  'C-VT-1': 'Text',
  'C-VT-2': 'Vision',
};

function makeSample(category: Category, index: number, sampleIndex: number): Sample {
  const protocol = category.endsWith('VA') ? 'VA' : 'VT';
  const decision = decisions[index];
  const id = `sample-${category.toLowerCase()}-${index + 1}`;
  return {
    id,
    displayId: `CS-${String(sampleIndex + 1).padStart(4, '0')}`,
    datasetId: sampleIndex < 8 ? 'dataset-main' : 'dataset-validation',
    category,
    conflictDirection: directionBySample[`${category}-${index}`] ?? null,
    reviewDecision: decision,
    reviewRevision: decision === 'Pending' ? 0 : 1,
    model: sampleIndex % 2 === 0 ? 'LTX-2.3' : 'MiniMax H3',
    gpu: sampleIndex % 2 === 0 ? 'GPU0' : 'GPU1',
    contentItemId: `content-${category.toLowerCase()}`,
    presetId: `preset-${category.toLowerCase()}`,
    primaryAssetId: protocol === 'VA' ? voicedVideoDataUrl : silentVideoDataUrl,
    sourceAssetId: protocol === 'VT' ? voicedVideoDataUrl : null,
    thumbnailAssetId: `asset-thumb-${sampleIndex + 1}`,
    dialogue: protocol === 'VA' ? '我没事，你先忙吧。' : null,
    displayText: protocol === 'VT' ? '今天一切都很好。' : null,
    videoPrompt: 'A natural indoor conversation, restrained body language, stable camera, realistic lighting.',
    explanation: '示例内容用于核对审核、归档和生成页面的字段。',
    generationNote: index === 1 ? '需要复核人物动作。' : '',
    emotion: index === 1 ? '悲伤' : '平静',
    seed: 3200 + sampleIndex,
    archiveStatus: decision === 'Accepted' && sampleIndex % 4 === 1 ? 'NeedsUpdate' : 'Current',
    revision: decision === 'Pending' ? 1 : 2,
    updatedAt: baseDate,
  };
}

const samples = categories.flatMap((category, categoryIndex) =>
  decisions.map((_, decisionIndex) => makeSample(category, decisionIndex, categoryIndex * 3 + decisionIndex)),
);

const reviews: Review[] = samples
  .filter(sample => sample.reviewDecision !== 'Pending')
  .map((sample, index) => ({
    id: `review-${index + 1}`,
    sampleId: sample.id,
    reviewerId: index % 2 === 0 ? 'reviewer-lin' : 'reviewer-chen',
    decision: sample.reviewDecision,
    note: index % 3 === 0 ? '已核对媒体与文本。' : '',
    sampleRevision: 1,
    revision: 1,
    createdAt: `2026-08-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
  }));

reviews.push(
  {
    id: 'review-revised-1',
    sampleId: 'sample-a-va-2',
    reviewerId: 'reviewer-lin',
    decision: 'Rejected',
    note: '首次决定。',
    sampleRevision: 1,
    revision: 1,
    createdAt: '2026-08-02T09:00:00.000Z',
  },
  {
    id: 'review-revised-2',
    sampleId: 'sample-a-va-2',
    reviewerId: 'reviewer-lin',
    decision: 'Accepted',
    note: '复核后修改决定。',
    sampleRevision: 1,
    revision: 2,
    createdAt: '2026-08-06T09:00:00.000Z',
  },
);

function stepsFor(status: JobStatus, jobId: string, timestamp = baseDate): Job['steps'] {
  const names: Job['steps'][number]['name'][] = [
    'PrepareContent',
    'GeneratePrompt',
    'GenerateVideo',
    'ProcessMedia',
    'SaveResult',
  ];
  return names.map((name, index) => {
    let stepStatus: Job['steps'][number]['status'] = 'Waiting';
    if (status === 'Completed') stepStatus = 'Completed';
    if (status === 'Running') stepStatus = index < 2 ? 'Completed' : index === 2 ? 'Running' : 'Waiting';
    if (status === 'Failed') stepStatus = index < 2 ? 'Completed' : index === 2 ? 'Failed' : 'Waiting';
    if (status === 'Cancelled') stepStatus = index === 0 ? 'Completed' : index === 1 ? 'Cancelled' : 'Waiting';
    return {
      id: `${jobId}-step-${index + 1}`,
      order: index + 1,
      name,
      status: stepStatus,
      startedAt: stepStatus === 'Waiting' ? null : timestamp,
      completedAt: stepStatus === 'Completed' ? timestamp : null,
    };
  });
}

function makeJob(
  status: JobStatus,
  index: number,
  source: Job['source'] = status === 'Queued' || status === 'Running' || status === 'Completed' || status === 'Failed'
    ? 'Test'
    : 'Rerender',
): Job {
  const id = `job-${status.toLowerCase()}`;
  const model = index % 2 === 0 ? 'LTX-2.3' : 'MiniMax H3';
  const gpu = status === 'Queued' ? 'GPU1' : index % 2 === 0 ? 'GPU0' : 'GPU1';
  const category = source === 'Test' ? 'A-VA' : categories[index % categories.length];
  const seed = 9000 + index;
  const timestamp = new Date(Date.parse(baseDate) - index * 75_000).toISOString();
  const job: Job = {
    id,
    parentJobId: null,
    source,
    datasetId: source === 'Test' ? null : 'dataset-main',
    category,
    conflictDirection: null,
    model,
    gpu,
    status,
    failureReason: status === 'Failed' ? 'ModelServiceUnavailable' : null,
    progress: status === 'Completed' ? 100 : status === 'Running' ? 54 : status === 'Queued' ? 0 : 38,
    seed,
    quantity: index === 0 ? 8 : 1,
    steps: stepsFor(status, id, timestamp),
    logs: [
      { sequence: 1, stepId: `${id}-step-1`, messageKey: 'jobs.log.created', occurredAt: timestamp },
      { sequence: 2, stepId: `${id}-step-2`, messageKey: 'jobs.log.contentReady', occurredAt: timestamp },
    ],
    resultSampleIds: [],
    revision: 1,
    createdAt: timestamp,
    startedAt: status === 'Queued' ? null : timestamp,
    completedAt: status === 'Completed' || status === 'Failed' || status === 'Cancelled' ? timestamp : null,
    updatedAt: timestamp,
  };
  if (source === 'Test') {
    const content = contentItems.find(item =>
      item.category === category && item.conflictDirection === job.conflictDirection,
    );
    const preset = presets.find(item => item.category === category);
    if (!content || !preset) throw new Error(`Missing mock test input for ${id}.`);
    job.testInput = {
      id: `prepared-${id}`,
      category,
      conflictDirection: job.conflictDirection,
      contentItemId: content.id,
      presetId: preset.id,
      age: 25,
      gender: 'Female',
      ethnicity: 'EastAsian',
      seed,
      models: [model],
      assignments: [{ model, gpu, order: 1 }],
      executionMode: 'Serial',
      dialogue: content.dialogue,
      displayText: content.displayText,
      explanation: content.explanation,
      videoPrompt: content.videoPrompt,
      emotion: content.emotion,
      contentRevision: content.revision,
      presetRevision: preset.revision,
    };
    job.testAssignmentOrder = 1;
  }
  return job;
}

const resultHistoryJobs: Job[] = [
  {
    ...makeJob('Completed', 6, 'Production'),
    id: 'job-result-previous',
    datasetId: 'dataset-main',
    steps: stepsFor('Completed', 'job-result-previous'),
    logs: [
      { sequence: 1, stepId: 'job-result-previous-step-1', messageKey: 'jobs.log.created', occurredAt: '2026-08-07T08:00:00.000Z' },
      { sequence: 2, stepId: 'job-result-previous-step-2', messageKey: 'jobs.log.contentReady', occurredAt: '2026-08-07T08:01:00.000Z' },
    ],
    resultSampleIds: [],
    createdAt: '2026-08-07T08:00:00.000Z',
    startedAt: '2026-08-07T08:01:00.000Z',
    completedAt: '2026-08-07T08:08:00.000Z',
    updatedAt: '2026-08-07T08:08:00.000Z',
  },
  {
    ...makeJob('Completed', 7, 'Rerender'),
    id: 'job-result-current',
    parentJobId: 'job-result-previous',
    source: 'Rerender',
    datasetId: 'dataset-main',
    steps: stepsFor('Completed', 'job-result-current'),
    logs: [
      { sequence: 1, stepId: 'job-result-current-step-1', messageKey: 'jobs.log.created', occurredAt: '2026-08-08T08:00:00.000Z' },
      { sequence: 2, stepId: 'job-result-current-step-2', messageKey: 'jobs.log.contentReady', occurredAt: '2026-08-08T08:01:00.000Z' },
    ],
    resultSampleIds: ['sample-a-va-2'],
    createdAt: '2026-08-08T08:00:00.000Z',
    startedAt: '2026-08-08T08:01:00.000Z',
    completedAt: '2026-08-08T08:08:00.000Z',
    updatedAt: '2026-08-08T08:08:00.000Z',
  },
];

const contentItems: ContentItem[] = [
  ['content-a-va', '克制回应', 'A-VA', null, 'Fixed', 'Active'],
  ['content-a-vt', '平静说明', 'A-VT', null, 'Generative', 'Draft'],
  ['content-c-va', '声音掩饰', 'C-VA', 'Audio', 'Fixed', 'Active'],
  ['content-c-va-vision', '表情暴露', 'C-VA', 'Vision', 'Generative', 'Disabled'],
  ['content-c-vt', '文字掩饰', 'C-VT', 'Text', 'Fixed', 'Active'],
  ['content-c-vt-vision', '动作否认', 'C-VT', 'Vision', 'Generative', 'Draft'],
].map((entry, index) => ({
  id: entry[0] as string,
  name: entry[1] as string,
  category: entry[2] as Category,
  conflictDirection: entry[3] as ConflictDirection | null,
  mode: entry[4] as ContentItem['mode'],
  status: entry[5] as ContentItem['status'],
  emotion: index % 2 === 0 ? 'sadness' : 'neutral',
  scene: '室内固定机位，两人短暂交谈。',
  dialogue: (entry[2] as Category).endsWith('VA') ? '我真的没事。' : null,
  displayText: (entry[2] as Category).endsWith('VT') ? '今天过得很好。' : null,
  explanation: '视觉、声音或文本的关系由类别和方向决定。',
  videoPrompt: 'A restrained two-person conversation in a quiet room, realistic movement, fixed camera.',
  contentInstruction: '生成简短、自然、可直接拍摄的日常场景。',
  sceneSupplement: '避免夸张表演和复杂镜头。',
  revision: 1,
  createdAt: baseDate,
  updatedAt: baseDate,
}));

const presets: Preset[] = categories.map((category, index) => ({
  id: `preset-${category.toLowerCase()}`,
  name: `${category} 标准预设`,
  category,
  fixedStructureRules: [
    'presets.rule.subject',
    'presets.rule.signal',
    'presets.rule.camera',
  ],
  styleInstruction: '保持自然、克制和可观察。',
  sceneSupplement: '使用简单室内场景。',
  positiveExamples: ['动作与目标关系清楚。'],
  negativeExamples: ['避免旁白解释关系。'],
  renderNegativeConstraints: 'No subtitles, no camera cuts, no exaggerated gestures.',
  revision: 1,
  createdAt: baseDate,
  updatedAt: `2026-08-0${index + 1}T09:00:00.000Z`,
}));

const archives: Archive[] = [
  {
    datasetId: 'dataset-main',
    currentSampleIds: samples
      .filter(sample => sample.datasetId === 'dataset-main' && sample.reviewDecision === 'Accepted')
      .map(sample => sample.id),
    lastSyncedAt: '2026-08-08T09:00:00.000Z',
    revision: 2,
    updatedAt: '2026-08-08T09:00:00.000Z',
  },
  {
    datasetId: 'dataset-validation',
    currentSampleIds: [],
    lastSyncedAt: null,
    revision: 1,
    updatedAt: baseDate,
  },
];

export const initialData: RepositoryData = {
  version: 4,
  datasets: [
    {
      id: 'dataset-main',
      name: '正式生成集',
      purpose: 'Production',
      note: '用于本轮正式样本审核。',
      status: 'Active',
      revision: 3,
      createdAt: baseDate,
      updatedAt: baseDate,
    },
    {
      id: 'dataset-validation',
      name: '验证集',
      purpose: 'Validation',
      note: '用于比较提示词和模型结果。',
      status: 'Active',
      revision: 2,
      createdAt: baseDate,
      updatedAt: baseDate,
    },
    {
      id: 'dataset-paused',
      name: '已停用示例集',
      purpose: 'General',
      note: '',
      status: 'Disabled',
      revision: 2,
      createdAt: baseDate,
      updatedAt: baseDate,
    },
  ],
  reviewers: [
    { id: 'reviewer-lin', name: '林然', revision: 1, createdAt: baseDate, updatedAt: baseDate },
    { id: 'reviewer-chen', name: '陈宁', revision: 2, createdAt: baseDate, updatedAt: baseDate },
  ],
  gpuStates: [
    { slot: 'GPU0', availability: 'Available', loadedModel: 'LTX-2.3', activeJobId: null, checkedAt: baseDate },
    { slot: 'GPU1', availability: 'Reserved', loadedModel: 'MiniMax H3', activeJobId: 'job-running', checkedAt: baseDate },
  ],
  samples,
  reviews,
  jobs: [
    ...(['Queued', 'Running', 'Completed', 'Failed', 'Cancelled'] as JobStatus[])
      .map((status, index) => makeJob(status, index)),
    ...resultHistoryJobs,
  ],
  contentItems,
  presets,
  archives,
  activities: [
    { id: 'activity-1', action: 'ReviewSaved', objectLabel: 'CS-0002', reviewerId: 'reviewer-lin', occurredAt: baseDate },
    { id: 'activity-2', action: 'JobCreated', objectLabel: 'A-VA-20260809-175845', reviewerId: null, occurredAt: baseDate },
    { id: 'activity-3', action: 'ArchiveSynced', objectLabel: '正式生成集', reviewerId: 'reviewer-chen', occurredAt: '2026-08-08T09:00:00.000Z' },
  ],
};
