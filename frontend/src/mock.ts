import type {
  Archive,
  BatchDraft,
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
import { buildJobItems, composeVideoGenerationInput, createBatchAllocationSnapshot } from './generation';

export const DATA_STORAGE_KEY = 'conflictstudio.prototype.data.v10';
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
  const conflictDirection = directionBySample[`${category}-${index}`] ?? null;
  const trueEmotion = category.startsWith('C-') ? '悲伤' : index === 1 ? '悲伤' : '平静';
  const apparentEmotion = category.startsWith('C-') ? '平静' : trueEmotion;
  const model = sampleIndex % 3 === 0 ? 'LTX-2.5' : sampleIndex % 3 === 1 ? 'LTX-2.3' : 'MiniMax H3';
  const gpu = sampleIndex % 2 === 0 ? 'GPU0' : 'GPU1';
  const trueEmotionDescription = category === 'C-VA'
    ? conflictDirection === 'Vision'
      ? '人物的表情和动作表现出悲伤，声音保持平静。真实情绪主要由视觉信息表达。'
      : '人物的表情保持平静，声音中的停顿和轻微颤抖表现出悲伤。真实情绪主要由声音表达。'
    : category === 'C-VT'
      ? conflictDirection === 'Vision'
        ? '人物的表情和动作表现出悲伤，显示文本保持轻松。真实情绪主要由视觉信息表达。'
        : '人物的表情保持平静，显示文本表达出悲伤。真实情绪主要由文本表达。'
      : protocol === 'VA'
        ? '人物的视觉表现和声音都表达相同情绪，两种信息相互支持。'
        : '人物的视觉表现和显示文本都表达相同情绪，两种信息相互支持。';
  return {
    id,
    displayId: `CS-${String(sampleIndex + 1).padStart(4, '0')}`,
    datasetId: sampleIndex < 8 ? 'dataset-main' : 'dataset-validation',
    category,
    conflictDirection,
    reviewDecision: decision,
    reviewRevision: decision === 'Pending' ? 0 : 1,
    model,
    generationRecord: {
      id: `attempt-${id}`,
      model,
      precision: model === 'LTX-2.5' ? 'INT8' : null,
      gpu,
      seed: 3200 + sampleIndex,
    },
    gpu,
    contentItemId: `content-${category.toLowerCase()}`,
    presetId: `preset-${category.toLowerCase()}`,
    primaryAssetId: `asset-video-${String(sampleIndex + 1).padStart(4, '0')}`,
    primaryAssetUrl: protocol === 'VA' ? voicedVideoDataUrl : silentVideoDataUrl,
    sourceAssetId: protocol === 'VT' ? `asset-source-${String(sampleIndex + 1).padStart(4, '0')}` : null,
    sourceAssetUrl: protocol === 'VT' ? voicedVideoDataUrl : null,
    thumbnailAssetId: `asset-thumb-${sampleIndex + 1}`,
    dialogue: protocol === 'VA' ? '我没事，你先忙吧。' : null,
    displayText: protocol === 'VT' ? '今天一切都很好。' : null,
    videoPrompt: 'A natural indoor conversation, restrained body language, stable camera, realistic lighting.',
    negativePrompt: 'Subtitles, camera cuts, exaggerated gestures, distorted hands.',
    explanation: '示例内容用于核对审核、归档和生成页面的字段。',
    generationNote: index === 1 ? '需要复核人物动作。' : '',
    trueEmotionDescription,
    trueEmotion,
    apparentEmotion,
    contentPlanName: category.startsWith('C-') ? '克制情绪冲突' : '自然情绪表达',
    scenario: '安静的室内，两人进行简短交谈。',
    triggerEvent: '对方询问人物最近的状态。',
    psychologicalBackground: '人物不希望让对方担心，因此控制了外在表现。',
    age: [25, 35, 45, 60][sampleIndex % 4] as 25 | 35 | 45 | 60,
    gender: sampleIndex % 2 === 0 ? 'Female' : 'Male',
    ethnicity: ['EastAsian', 'White', 'Black', 'SouthAsian', 'Latino'][sampleIndex % 5] as Sample['ethnicity'],
    contentVersion: 2,
    seed: 3200 + sampleIndex,
    archiveStatus: decision === 'Accepted' && sampleIndex % 4 === 1 ? 'NeedsUpdate' : 'Current',
    revision: decision === 'Pending' ? 1 : 2,
    updatedAt: baseDate,
  };
}

const reviewSamples = categories.flatMap((category, categoryIndex) =>
  decisions.map((_, decisionIndex) => makeSample(category, decisionIndex, categoryIndex * 3 + decisionIndex)),
);

const archiveSamples = Array.from({ length: 28 }, (_, index): Sample => {
  const category = categories[index % categories.length];
  const sampleIndex = index + 100;
  return {
    ...makeSample(category, 1, sampleIndex),
    id: `archive-sample-${String(index + 1).padStart(3, '0')}`,
    displayId: `CS-${String(index + 101).padStart(4, '0')}`,
    datasetId: 'dataset-main',
    reviewDecision: 'Accepted',
    reviewRevision: 1,
    archiveStatus: index % 7 === 0 ? 'NeedsUpdate' : 'Current',
    revision: 2,
  };
});

const samples = [...reviewSamples, ...archiveSamples];

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
    createdAt: new Date(Date.parse(baseDate) - index * 86_400_000).toISOString(),
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
  historicalDual = false,
): Job {
  const id = historicalDual ? 'job-dual-history' : `job-${status.toLowerCase()}`;
  const model = index % 3 === 0 ? 'LTX-2.5' : index % 3 === 1 ? 'LTX-2.3' : 'MiniMax H3';
  const precision = model === 'LTX-2.5' ? 'INT8' : null;
  const gpus = (historicalDual
    ? ['GPU0', 'GPU1']
    : status === 'Running'
    ? ['GPU0', 'GPU1']
    : [status === 'Queued' ? 'GPU1' : index % 2 === 0 ? 'GPU0' : 'GPU1']) as Job['gpus'];
  const category = source === 'Test'
    ? 'A-VA'
    : historicalDual || status === 'Running'
      ? 'C-VA'
      : categories[index % categories.length];
  const conflictDirection: ConflictDirection | null = category === 'C-VA'
    ? 'Audio'
    : category === 'C-VT'
      ? 'Text'
      : null;
  const seed = 9000 + index;
  const timestamp = historicalDual || status === 'Running'
    ? '2026-08-11T07:23:31.000Z'
    : new Date(Date.parse(baseDate) - index * 75_000).toISOString();
  const job: Job = {
    id,
    parentJobId: null,
    source,
    datasetId: source === 'Test' ? null : 'dataset-main',
    category,
    conflictDirection,
    model,
    precision,
    gpus,
    status,
    failureReason: status === 'Failed' ? 'ModelServiceUnavailable' : null,
    completedCount: historicalDual ? 128 : status === 'Completed' ? 1 : status === 'Running' ? 33 : 0,
    seed,
    quantity: historicalDual || status === 'Running' ? 128 : index === 0 ? 8 : 1,
    steps: stepsFor(status, id, timestamp),
    logs: [
      { sequence: 1, stepId: `${id}-step-1`, messageKey: 'jobs.log.created', occurredAt: timestamp },
      { sequence: 2, stepId: `${id}-step-2`, messageKey: 'jobs.log.contentReady', occurredAt: timestamp },
    ],
    items: [],
    resultSampleIds: [],
    revision: 1,
    createdAt: timestamp,
    startedAt: status === 'Queued' ? null : timestamp,
    completedAt: status === 'Completed' || status === 'Failed' || status === 'Cancelled' ? timestamp : null,
    updatedAt: timestamp,
  };
  job.items = buildJobItems(
    job.quantity,
    job.status,
    job.gpus,
    job.completedCount,
    status === 'Running' ? [34, 35] : status === 'Failed' ? [1] : [],
  );
  if (source === 'Test') {
    const content = contentItems.find(item =>
      item.category === category && item.conflictDirection === job.conflictDirection,
    );
    const preset = presets.find(item => item.category === category);
    if (!content || !preset) throw new Error(`Missing mock test input for ${id}.`);
    const prompts = composeVideoGenerationInput(content, preset);
    job.testInput = {
      id: `prepared-${id}`,
      category,
      conflictDirection: job.conflictDirection,
      contentItemId: content.id,
      contentItemName: content.name,
      presetId: preset.id,
      presetName: preset.name,
      age: 25,
      gender: 'Female',
      ethnicity: 'EastAsian',
      seed,
      assignments: [{ model, precision, gpu: gpus[0], order: 1 }],
      executionMode: 'Serial',
      dialogue: content.dialogue,
      displayText: content.displayText,
      explanation: content.explanation,
      videoPrompt: content.videoPrompt,
      finalPositivePrompt: prompts.positivePrompt,
      finalNegativePrompt: prompts.negativePrompt,
      emotion: content.emotion,
      scene: content.scene,
      contentRevision: content.revision,
      presetRevision: preset.revision,
    };
    job.testAssignmentOrder = 1;
  }
  if (source === 'Production') {
    const matching = contentItems.filter(item =>
      item.status === 'Active'
      && item.category === category
      && item.conflictDirection === job.conflictDirection,
    );
    const preset = presets.find(item => item.category === category);
    if (!preset || matching.length === 0) throw new Error(`Missing mock batch input for ${id}.`);
    const contentIds = matching.map(item => item.id);
    const batchDraft: BatchDraft = {
      datasetId: 'dataset-main',
      category,
      conflictDirection: job.conflictDirection,
      contentItemIds: contentIds,
      presetId: preset.id,
      model,
      precision,
      gpus,
      quantity: job.quantity,
      seed,
      ages: [25, 35, 45, 60] as Array<25 | 35 | 45 | 60>,
      genders: ['Male', 'Female'] as Array<'Male' | 'Female'>,
      ethnicities: ['EastAsian', 'White', 'Black', 'SouthAsian', 'Latino'] as Sample['ethnicity'][],
    };
    job.batchInput = {
      draft: batchDraft,
      allocations: Array.from({ length: job.quantity }, (_, itemIndex) => {
        const content = matching[itemIndex % matching.length];
        const age = [25, 35, 45, 60] as const;
        const gender = ['Male', 'Female'] as const;
        const ethnicity = ['EastAsian', 'White', 'Black', 'SouthAsian', 'Latino'] as const;
        return createBatchAllocationSnapshot(itemIndex + 1, batchDraft, content, preset, {
          age: age[itemIndex % age.length],
          gender: gender[itemIndex % gender.length],
          ethnicity: ethnicity[itemIndex % ethnicity.length],
        });
      }),
      datasetRevision: 3,
      contentItemRevisions: Object.fromEntries(matching.map(item => [item.id, item.revision])),
      presetRevision: preset.revision,
    };
    job.items = buildJobItems(
      job.quantity,
      job.status,
      job.gpus,
      job.completedCount,
      status === 'Running' ? [34, 35] : status === 'Failed' ? [1] : [],
      contentIds,
    );
  }
  return job;
}

const resultHistoryJobs: Job[] = [
  {
    ...makeJob('Completed', 6, 'Rerender'),
    id: 'job-result-previous',
    source: 'Production',
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
  ['content-a-va-calm', '平静安慰', 'A-VA', null, 'Generative', 'Active'],
  ['content-a-vt', '平静说明', 'A-VT', null, 'Generative', 'Active'],
  ['content-a-vt-notice', '简短告知', 'A-VT', null, 'Fixed', 'Active'],
  ['content-c-va', '声音掩饰', 'C-VA', 'Audio', 'Fixed', 'Active'],
  ['content-c-va-audio-2', '语气泄露', 'C-VA', 'Audio', 'Generative', 'Active'],
  ['content-c-va-vision', '表情暴露', 'C-VA', 'Vision', 'Generative', 'Active'],
  ['content-c-va-vision-2', '动作泄露', 'C-VA', 'Vision', 'Fixed', 'Active'],
  ['content-c-vt', '文字掩饰', 'C-VT', 'Text', 'Fixed', 'Active'],
  ['content-c-vt-text-2', '文字坦白', 'C-VT', 'Text', 'Generative', 'Active'],
  ['content-c-vt-vision', '动作否认', 'C-VT', 'Vision', 'Generative', 'Active'],
  ['content-c-vt-vision-2', '表情泄露', 'C-VT', 'Vision', 'Fixed', 'Active'],
  ['content-draft', '候选场景草稿', 'A-VA', null, 'Generative', 'Draft'],
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
  sceneSupplement: 'Avoid exaggerated acting and complex camera movement.',
  revision: 1,
  createdAt: baseDate,
  updatedAt: baseDate,
}));

const presets: Preset[] = categories.map((category, index) => ({
  id: `preset-${category.toLowerCase()}`,
  name: `${category} 标准预设`,
  category,
  status: 'Active',
  fixedStructureRules: [
    'presets.rule.subject',
    'presets.rule.signal',
    'presets.rule.camera',
  ],
  styleInstruction: 'Keep the acting natural, restrained, and clearly observable.',
  sceneSupplement: 'Use a simple indoor setting with stable framing.',
  positiveExamples: ['动作与目标关系清楚。'],
  negativeExamples: ['避免旁白解释关系。'],
  renderNegativeConstraints: 'No subtitles, no camera cuts, no exaggerated gestures, no distorted hands.',
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
  version: 8,
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
    { slot: 'GPU0', availability: 'Available', loadedModel: 'LTX-2.3', loadedPrecision: null, activeJobId: null, checkedAt: baseDate },
    { slot: 'GPU1', availability: 'Available', loadedModel: 'MiniMax H3', loadedPrecision: null, activeJobId: null, checkedAt: baseDate },
  ],
  samples,
  reviews,
  jobs: [
    makeJob('Completed', 1, 'Production', true),
    ...(['Queued', 'Completed', 'Failed', 'Cancelled'] as JobStatus[])
      .map((status, index) => makeJob(
        status,
        index,
        status === 'Running' || status === 'Failed' ? 'Production' : 'Test',
      )),
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
