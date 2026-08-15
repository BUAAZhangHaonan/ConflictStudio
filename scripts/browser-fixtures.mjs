const timestamp = '2026-08-14T08:00:00.000Z';

export const preferenceKeys = {
  locale: 'conflictstudio.locale',
  reviewerId: 'conflictstudio.reviewer.id',
  reviewerName: 'conflictstudio.reviewer.name',
};

const testVideoBase64 = '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';
const testVideo = Buffer.from(testVideoBase64, 'base64');

export const gpuSlotsFixture = [
  { slot: 'GPU0', availability: 'Available', loadedModel: 'LTX-2.5', loadedPrecision: 'INT8', serviceStatus: 'running', gpuName: 'NVIDIA RTX PRO 6000 Blackwell', memory: { usedMiB: 8192, totalMiB: 97887 }, activeJobId: null, revision: 2, checkedAt: timestamp, statusReason: null },
  { slot: 'GPU1', availability: 'Available', loadedModel: null, loadedPrecision: null, serviceStatus: 'stopped', gpuName: 'NVIDIA RTX PRO 6000 Blackwell', memory: { usedMiB: 16, totalMiB: 97887 }, activeJobId: null, revision: 3, checkedAt: timestamp, statusReason: null },
];

export const datasetsFixture = [
  { id: 1, name: 'Formal samples', purpose: 'Formal', note: 'Formal review data', status: 'Active', revision: 1, createdAt: timestamp, updatedAt: timestamp },
  { id: 2, name: 'Validation samples', purpose: 'Validation', note: 'Model comparison data', status: 'Active', revision: 1, createdAt: timestamp, updatedAt: timestamp },
  ...Array.from({ length: 20 }, (_, index) => ({
    id: index + 3,
    name: `Dataset ${index + 3}`,
    purpose: 'Formal',
    note: `Dataset note ${index + 3}`,
    status: index === 0 ? 'Inactive' : 'Active',
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  })),
];

export const contentPlansFixture = [{
  id: 1, nameZh: '克制回应', nameEn: 'Restrained reply', category: 'A-VA', conflictDirection: null,
  mode: 'Fixed', status: 'Active', trueEmotion: 'sadness', apparentEmotion: 'sadness',
  sceneZh: '安静办公室', sceneEn: 'Quiet office', triggerEventZh: '收到坏消息', triggerEventEn: 'Bad news arrives',
  psychologicalBackgroundZh: '人物压住情绪', psychologicalBackgroundEn: 'The person suppresses emotion',
  dialogue: 'I understand.', displayText: null, trueEmotionDescription: 'The voice and expression carry sadness.',
  baseVideoPrompt: 'A fixed camera records a short reply.', contentRequirementsZh: '自然回应', contentRequirementsEn: 'Natural reply',
  sceneSupplementZh: '稳定镜头', sceneSupplementEn: 'Stable camera', backgroundPresetIds: [1], revision: 1, createdAt: timestamp, updatedAt: timestamp,
}, {
  id: 2, nameZh: '临时来电', nameEn: 'Unexpected call', category: 'A-VA', conflictDirection: null,
  mode: 'Generative', status: 'Active', trueEmotion: 'sadness', apparentEmotion: 'sadness',
  sceneZh: '接听电话', sceneEn: 'Answering a call', triggerEventZh: '收到消息', triggerEventEn: 'A message arrives',
  psychologicalBackgroundZh: '人物保持克制', psychologicalBackgroundEn: 'The person remains restrained',
  dialogue: '', displayText: null, trueEmotionDescription: '', baseVideoPrompt: '', contentRequirementsZh: '生成自然对白', contentRequirementsEn: 'Write natural dialogue',
  sceneSupplementZh: '', sceneSupplementEn: '', backgroundPresetIds: [1, 2], revision: 1, createdAt: timestamp, updatedAt: timestamp,
}];

export const promptPresetsFixture = [{
  id: 1, name: 'Natural conversation', category: 'A-VA', styleGuidance: 'Natural restrained acting.',
  positiveExamples: ['A natural reply.'], negativeExamples: ['Exaggerated acting.'], finalRenderNegativeConstraints: 'No subtitles.',
  status: 'Active', revision: 1, createdAt: timestamp, updatedAt: timestamp,
}];

export const backgroundsFixture = [
  {
    id: 1, nameZh: '安静办公室', nameEn: 'Quiet office', sceneZh: '安静办公室', sceneEn: 'Quiet office',
    ambientSoundZh: '轻微空调声', ambientSoundEn: 'Low air conditioner hum', participantRelationshipZh: '同事', participantRelationshipEn: 'Colleagues',
    lightingZh: '柔和室内光', lightingEn: 'Soft indoor light', framingZh: '中景', framingEn: 'Medium shot', status: 'Active',
    revision: 1, createdAt: timestamp, updatedAt: timestamp,
  },
  {
    id: 2, nameZh: '安静客厅', nameEn: 'Quiet living room', sceneZh: '安静客厅', sceneEn: 'Quiet living room',
    ambientSoundZh: '轻微室内底噪', ambientSoundEn: 'Low room tone', participantRelationshipZh: '独处', participantRelationshipEn: 'Alone',
    lightingZh: '柔和窗光', lightingEn: 'Soft window light', framingZh: '中近景', framingEn: 'Medium close-up', status: 'Active',
    revision: 1, createdAt: timestamp, updatedAt: timestamp,
  },
  {
    id: 3, nameZh: '停用场景', nameEn: 'Disabled scene', sceneZh: '停用场景', sceneEn: 'Disabled scene',
    ambientSoundZh: '无', ambientSoundEn: 'None', participantRelationshipZh: '独处', participantRelationshipEn: 'Alone',
    lightingZh: '自然光', lightingEn: 'Natural light', framingZh: '中景', framingEn: 'Medium shot', status: 'Disabled',
    revision: 1, createdAt: timestamp, updatedAt: timestamp,
  },
];

export const jobFixture = {
  id: 1, displayName: 'A-VA-20260814160000', source: 'Production', datasetId: 1, batchDraftId: 1,
  category: 'A-VA', conflictDirection: null, model: 'LTX-2.5', precision: 'INT8', status: 'Completed',
  totalCount: 128, preparedCount: 128, completedCount: 128, failedCount: 0, confirmModelSwitch: false,
  cancelRequestedAt: null, failureCode: null, failureReason: null, startedAt: timestamp, finishedAt: timestamp,
  revision: 2, createdAt: timestamp, updatedAt: timestamp,
};

function jobItem(id, sequence, gpuSlot) {
  return {
    id, sequence, gpuSlot, stage: 'Completed', status: 'Completed', failureCode: null, failureReason: null,
    rendererPromptId: `prompt-${id}`, sourceAssetId: null, sourceAssetUrl: null, primaryAssetId: id,
    primaryAssetUrl: '/media/browser-check.webm', revision: 2, createdAt: timestamp, updatedAt: timestamp,
    input: {
      id, sequence, datasetId: 1, datasetRevision: 1, contentPlanId: 1, contentPlanRevision: 1,
      promptPresetId: 1, promptPresetRevision: 1, backgroundPresetId: 1, backgroundPresetRevision: 1,
      policyVersion: 'prompt-policy-v1', category: 'A-VA', conflictDirection: null, age: 25, gender: 'Female', ethnicity: 'EastAsian',
      model: 'LTX-2.5', precision: 'INT8', seed: 3200 + sequence, width: 1344, height: 768, fps: 24, frameCount: 121,
      rendererProfileVersion: 'ltx25-v1', promptModel: 'deepseek-v4-flash', sourceHasAudio: true, deriveSilentPrimary: false,
      systemInput: 'Return valid JSON.', userInput: 'Generate a natural reply.', finalNegativePrompt: 'No subtitles, no captions, no logos, no extra people, no distorted hands, no abrupt camera movement, and no unreadable background text.',
      fixedPositivePrompt: 'A fixed camera records one person in a quiet office. The person faces forward, speaks a short restrained reply, keeps natural eye movement, and shows a clear but controlled emotional expression. Soft light keeps the full face visible while the background remains simple and still.', fixedDialogue: 'I understand.', fixedVtText: null,
      fixedTrueEmotionDescription: 'The voice and expression carry sadness.', trueEmotion: 'sadness', apparentEmotion: 'sadness', createdAt: timestamp,
    },
    promptResult: null,
    latestAttempt: { id, attemptNumber: 1, model: 'LTX-2.5', precision: 'INT8', gpuSlot, seed: 3200 + sequence, sourceAssetId: null, sourceAssetUrl: null, primaryAssetId: id, primaryAssetUrl: '/media/browser-check.webm', rendererPromptId: `prompt-${id}`, status: 'Completed', failureReason: null, startedAt: timestamp, finishedAt: timestamp },
    attemptCount: 25,
    sampleId: id,
  };
}

export const jobItemsFixture = Array.from({ length: 25 }, (_, index) => jobItem(index + 1, index + 1, index % 2 ? 'GPU1' : 'GPU0'));

function reviewRecord(id, sampleId, decision = 'Accepted') {
  return { id, sampleId, reviewerId: 1, reviewerName: 'Lin', datasetId: 1, protocol: 'VA', relation: 'Conflict', decision, note: '', sampleRevision: 1, revision: 1, createdAt: timestamp };
}

export function sampleFixture(id, reviewDecision = 'Pending', category = 'C-VA') {
  const protocol = category.endsWith('-VA') ? 'VA' : 'VT';
  const accepted = reviewDecision === 'Accepted';
  const currentReview = accepted ? reviewRecord(5000 + id, id) : null;
  return {
    id, displayId: `CS-${String(id).padStart(6, '0')}`, jobItemId: id, datasetId: 1, datasetName: 'Formal samples', category,
    conflictDirection: category === 'C-VA' ? 'Audio' : category === 'C-VT' ? 'Text' : null,
    reviewDecision, reviewRevision: accepted ? 1 : 0, currentReview, inArchive: accepted,
    archiveSyncStatus: accepted ? 'Current' : 'NeedsUpdate', model: 'LTX-2.5',
    generationRecord: { id: 9000 + id, attemptNumber: 3, model: 'LTX-2.5', precision: 'BF16', gpuSlot: id % 2 ? 'GPU0' : 'GPU1', seed: 424242 + id, sourceAssetId: null, sourceAssetUrl: null, primaryAssetId: id, primaryAssetUrl: '/media/browser-check.webm', rendererPromptId: `prompt-${id}`, status: 'Completed', failureReason: null, startedAt: timestamp, finishedAt: timestamp },
    gpuSlot: id % 2 ? 'GPU0' : 'GPU1', contentPlanId: 1, contentPlanRevision: 4, promptPresetId: 1,
    sourceAssetId: null, sourceAssetUrl: null, primaryAssetId: id, primaryAssetUrl: '/media/browser-check.webm',
    dialogue: protocol === 'VA' ? 'I understand.' : null, displayText: protocol === 'VT' ? 'I understand.' : null,
    videoPrompt: 'A fixed camera records a short reply.', negativePrompt: 'No subtitles.',
    trueEmotionDescription: category.startsWith('A-') ? 'The visible and spoken emotion is sadness.' : 'The voice carries sadness while the expression stays calm.', trueEmotion: 'sadness', apparentEmotion: category.startsWith('A-') ? 'sadness' : 'neutral',
    contentPlanNameZh: '克制回应', contentPlanNameEn: 'Restrained reply', sceneZh: '安静办公室', sceneEn: 'Quiet office',
    triggerEventZh: '收到坏消息', triggerEventEn: 'Bad news arrives', psychologicalBackgroundZh: '人物压住情绪', psychologicalBackgroundEn: 'The person suppresses emotion',
    age: 35, gender: 'Female', ethnicity: 'EastAsian', seed: 424242 + id, revision: 1, createdAt: timestamp, updatedAt: timestamp,
  };
}

function datesBetween(startDate, endDate) {
  const values = [];
  for (let cursor = new Date(`${startDate}T00:00:00Z`), end = new Date(`${endDate}T00:00:00Z`); cursor <= end; cursor = new Date(cursor.getTime() + 86_400_000)) {
    values.push(cursor.toISOString().slice(0, 10));
  }
  return values;
}

export function installPreferences(context, locale = 'en-US') {
  return context.addInitScript(({ keys, selectedLocale }) => {
    if (!localStorage.getItem(keys.locale)) localStorage.setItem(keys.locale, selectedLocale);
    if (!localStorage.getItem(keys.reviewerId)) localStorage.setItem(keys.reviewerId, '1');
    if (!localStorage.getItem(keys.reviewerName)) localStorage.setItem(keys.reviewerName, 'Lin');
  }, { keys: preferenceKeys, selectedLocale: locale });
}

export function createBrowserApiFixture({ reviewers = Array.from({ length: 25 }, (_, index) => ({ id: index + 1, name: index === 0 ? 'Lin' : `Reviewer ${index + 1}`, revision: 1, createdAt: timestamp, updatedAt: timestamp })) } = {}) {
  const state = {
    datasets: datasetsFixture.map(dataset => ({ ...dataset })),
    contentPlans: contentPlansFixture.map(item => ({ ...item })),
    promptPresets: promptPresetsFixture.map(item => ({ ...item })),
    backgrounds: backgroundsFixture.map(item => ({ ...item })),
    contentRelations: new Map([[1, [1]], [2, [1, 2]]]),
    reviewers: reviewers.map(reviewer => ({ ...reviewer })),
    samples: [
      ...Array.from({ length: 30 }, (_, index) => sampleFixture(index + 1, 'Pending', index === 3 ? 'A-VT' : 'C-VA')),
      ...Array.from({ length: 25 }, (_, index) => sampleFixture(index + 31, 'Accepted', 'C-VA')),
    ],
    reviews: [],
    batchDrafts: [],
    jobs: [
      jobFixture,
      ...Array.from({ length: 24 }, (_, index) => ({ ...jobFixture, id: index + 2, displayName: `${index % 2 ? 'C-VA' : 'A-VA'}-20260814${String(160001 + index).padStart(6, '0')}`, source: index % 3 === 0 ? 'Test' : 'Production', status: index % 2 === 0 ? 'Running' : 'Failed', failureCode: index % 2 === 0 ? null : 'renderer_execution_failed' })),
    ],
    jobEvents: Array.from({ length: 45 }, (_, index) => ({
      id: index + 1,
      jobId: 1,
      itemId: index === 0 ? null : (index % 25) + 1,
      eventType: index === 0 ? 'JobQueued' : index === 44 ? 'JobCompleted' : 'ItemRenderProgress',
      payload: { preparedCount: 25, completedCount: Math.min(index, 25), failedCount: 0, totalCount: 25, slotCount: 2, sequence: index === 0 ? null : (index % 25) + 1, gpuSlot: index % 2 ? 'GPU1' : 'GPU0', failureCode: null, failureReason: null, progressValue: index, progressMaximum: 44 },
      createdAt: timestamp,
    })),
    archives: [{ datasetId: 1, revision: 2, lastSyncedAt: timestamp, manifestAvailable: true, currentCount: 25, needsUpdateCount: 3 }],
    requests: [],
    mediaRequests: 0,
    mediaRangeRequests: 0,
  };

  const updateSampleWithReview = input => {
    const index = state.samples.findIndex(sample => sample.id === input.sampleId);
    if (index < 0) return null;
    const original = state.samples[index];
    const reviewer = state.reviewers.find(item => item.id === input.reviewerId);
    const nextReviewRevision = original.reviewRevision + 1;
    const review = {
      id: 7000 + state.reviews.length + 1, sampleId: original.id, reviewerId: input.reviewerId,
      reviewerName: reviewer?.name ?? '', datasetId: original.datasetId,
      protocol: original.category.endsWith('-VA') ? 'VA' : 'VT', relation: original.category.startsWith('A-') ? 'Aligned' : 'Conflict',
      decision: input.decision, note: input.note, sampleRevision: original.revision,
      revision: nextReviewRevision, createdAt: timestamp,
    };
    const next = { ...original, reviewDecision: input.decision, reviewRevision: nextReviewRevision, currentReview: review, revision: original.revision + 1, archiveSyncStatus: 'NeedsUpdate', updatedAt: timestamp };
    state.reviews.push(review);
    state.samples[index] = next;
    return next;
  };

  const statistics = url => {
    const reviewerId = Number(/^\/api\/reviewers\/(\d+)\/statistics$/u.exec(url.pathname)?.[1]);
    const startDate = url.searchParams.get('startDate') ?? '2026-07-16';
    const endDate = url.searchParams.get('endDate') ?? '2026-08-14';
    const empty = endDate <= '2020-12-31';
    return {
      reviewerId,
      datasetId: url.searchParams.has('datasetId') ? Number(url.searchParams.get('datasetId')) : null,
      startDate,
      endDate,
      uniqueReviewedCount: empty ? 0 : 4,
      acceptedCount: empty ? 0 : 3,
      rejectedCount: empty ? 0 : 1,
      vaCount: empty ? 0 : 3,
      vtCount: empty ? 0 : 1,
      revisedSampleCount: empty ? 0 : 1,
      archivedCurrentCount: empty ? 0 : 2,
      needsUpdateCount: empty ? 0 : 1,
      activity: datesBetween(startDate, endDate).map((date, index) => ({ date, reviewedCount: empty ? 0 : index % 9 === 0 ? 1 : 0 })),
    };
  };

  const fulfillJson = (route, value, status = 200) => route.fulfill({ status, json: value, headers: { 'Cache-Control': 'no-store' } });
  const pageValue = (url, values) => {
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
    const start = (page - 1) * 20;
    return { items: values.slice(start, start + 20), page, pageSize: 20, total: values.length, totalPages: Math.ceil(values.length / 20) };
  };

  return {
    state,
    async install(page) {
      await page.route('**/media/browser-check.webm', route => {
        state.mediaRequests += 1;
        const range = route.request().headers().range;
        if (!range) return route.fulfill({ status: 200, contentType: 'video/webm', body: testVideo, headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(testVideo.length) } });
        const match = /^bytes=(\d+)-(\d*)$/u.exec(range);
        const start = match ? Number(match[1]) : 0;
        const end = match?.[2] ? Math.min(Number(match[2]), testVideo.length - 1) : testVideo.length - 1;
        const body = testVideo.subarray(start, end + 1);
        state.mediaRangeRequests += 1;
        return route.fulfill({ status: 206, contentType: 'video/webm', body, headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(body.length), 'Content-Range': `bytes ${start}-${end}/${testVideo.length}` } });
      });
      await page.route(url => url.pathname.startsWith('/api/'), async route => {
        const request = route.request();
        const method = request.method();
        const url = new URL(request.url());
        const path = url.pathname;
        const body = method === 'GET' || method === 'DELETE' ? null : request.postDataJSON();
        state.requests.push({ method, path, query: Object.fromEntries(url.searchParams), body });

        if (method === 'GET' && path === '/api/health') return fulfillJson(route, { ok: true, database: 'available', promptServiceConfigured: true, rendererInstallation: 'installed' });
        if (method === 'GET' && path === '/api/datasets') {
          const search = (url.searchParams.get('search') ?? '').trim().toLocaleLowerCase('en-US');
          const status = url.searchParams.get('status');
          const values = state.datasets.filter(dataset => (!search || `${dataset.name} ${dataset.note}`.toLocaleLowerCase('en-US').includes(search)) && (!status || dataset.status === status));
          return fulfillJson(route, pageValue(url, values));
        }
        if (method === 'POST' && path === '/api/datasets') {
          const dataset = { id: Math.max(0, ...state.datasets.map(item => item.id)) + 1, name: body.name, purpose: 'Formal', note: body.note ?? '', status: 'Active', revision: 1, createdAt: timestamp, updatedAt: timestamp };
          state.datasets.push(dataset);
          return fulfillJson(route, dataset, 201);
        }
        const datasetMatch = /^\/api\/datasets\/(\d+)$/u.exec(path);
        if (method === 'GET' && datasetMatch) return fulfillJson(route, state.datasets.find(item => item.id === Number(datasetMatch[1])));
        if (method === 'PATCH' && datasetMatch) {
          const id = Number(datasetMatch[1]);
          const index = state.datasets.findIndex(item => item.id === id);
          const dataset = { ...state.datasets[index], ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'expectedRevision')), revision: state.datasets[index].revision + 1, updatedAt: timestamp };
          state.datasets[index] = dataset;
          return fulfillJson(route, dataset);
        }
        if (method === 'DELETE' && datasetMatch) {
          const id = Number(datasetMatch[1]);
          if (state.samples.some(sample => sample.datasetId === id)) return fulfillJson(route, { error: { code: 'dataset_not_empty', message: 'Dataset contains records.', details: null } }, 409);
          state.datasets = state.datasets.filter(item => item.id !== id);
          return route.fulfill({ status: 204, body: '' });
        }
        if (method === 'GET' && path === '/api/gpu-slots') return fulfillJson(route, gpuSlotsFixture);
        if (method === 'GET' && path === '/api/content-plans') return fulfillJson(route, pageValue(url, state.contentPlans));
        if (method === 'POST' && path === '/api/content-plans') {
          const content = { id: Math.max(0, ...state.contentPlans.map(item => item.id)) + 1, ...body, revision: 1, createdAt: timestamp, updatedAt: timestamp };
          state.contentPlans.push(content);
          state.contentRelations.set(content.id, [...body.backgroundPresetIds]);
          return fulfillJson(route, content, 201);
        }
        const contentMatch = /^\/api\/content-plans\/(\d+)$/u.exec(path);
        if (method === 'PATCH' && contentMatch) {
          const id = Number(contentMatch[1]);
          const index = state.contentPlans.findIndex(item => item.id === id);
          const content = { ...state.contentPlans[index], ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'expectedRevision')), revision: state.contentPlans[index].revision + 1, updatedAt: timestamp };
          state.contentPlans[index] = content;
          state.contentRelations.set(id, [...body.backgroundPresetIds]);
          return fulfillJson(route, content);
        }
        const relationMatch = /^\/api\/content-plans\/(\d+)\/backgrounds$/u.exec(path);
        if (method === 'GET' && relationMatch) {
          const id = Number(relationMatch[1]);
          const content = state.contentPlans.find(item => item.id === id);
          const backgroundIds = state.contentRelations.get(id) ?? [];
          return fulfillJson(route, { contentPlanId: id, contentPlanRevision: content?.revision ?? 1, backgrounds: state.backgrounds.filter(item => backgroundIds.includes(item.id)).map(item => ({ id: item.id, nameZh: item.nameZh, nameEn: item.nameEn, revision: item.revision })) });
        }
        if (method === 'GET' && path === '/api/prompt-presets') return fulfillJson(route, pageValue(url, state.promptPresets));
        if (method === 'GET' && path === '/api/video-background-presets') return fulfillJson(route, pageValue(url, state.backgrounds));
        if (method === 'GET' && path === '/api/batch-drafts') return fulfillJson(route, pageValue(url, state.batchDrafts));
        if ((method === 'POST' && path === '/api/batch-drafts') || (method === 'PUT' && /^\/api\/batch-drafts\/\d+$/u.test(path))) {
          const contentSelections = body.contentSelections.map(selection => {
            const content = state.contentPlans.find(item => item.id === selection.contentPlanId);
            const compatibleIds = state.contentRelations.get(content.id) ?? [];
            const selectedIds = content.mode === 'Fixed' ? compatibleIds : selection.backgroundPresetIds;
            return {
              contentPlan: { id: content.id, nameZh: content.nameZh, nameEn: content.nameEn, revision: content.revision },
              mode: content.mode,
              backgroundPresets: state.backgrounds.filter(item => selectedIds.includes(item.id)).map(item => ({ id: item.id, nameZh: item.nameZh, nameEn: item.nameEn, revision: item.revision })),
              compatibleBackgrounds: state.backgrounds.filter(item => compatibleIds.includes(item.id)).map(item => ({ id: item.id, nameZh: item.nameZh, nameEn: item.nameEn, revision: item.revision })),
            };
          });
          const promptPreset = state.promptPresets.find(item => item.id === body.promptPresetId);
          const draft = { id: state.batchDrafts[0]?.id ?? 1, ...body, datasetRevision: 1, seed: body.seed ?? 3200, status: 'Draft', contentSelections, promptPreset: { id: promptPreset.id, name: promptPreset.name, revision: promptPreset.revision }, revision: (state.batchDrafts[0]?.revision ?? 0) + 1, createdAt: timestamp, updatedAt: timestamp };
          delete draft.expectedRevision;
          state.batchDrafts = [draft];
          return fulfillJson(route, draft, method === 'POST' ? 201 : 200);
        }
        if (method === 'GET' && path === '/api/jobs') {
          const statuses = url.searchParams.getAll('status');
          return fulfillJson(route, pageValue(url, statuses.length ? state.jobs.filter(job => statuses.includes(job.status)) : state.jobs));
        }
        const jobMatch = /^\/api\/jobs\/(\d+)$/u.exec(path);
        if (method === 'GET' && jobMatch) return fulfillJson(route, state.jobs.find(item => item.id === Number(jobMatch[1])));
        const jobItemsMatch = /^\/api\/jobs\/(\d+)\/items$/u.exec(path);
        if (method === 'GET' && jobItemsMatch) return fulfillJson(route, pageValue(url, Number(jobItemsMatch[1]) === 1 ? jobItemsFixture : []));
        const jobEventsMatch = /^\/api\/jobs\/(\d+)\/events$/u.exec(path);
        if (method === 'GET' && jobEventsMatch) return fulfillJson(route, pageValue(url, state.jobEvents.filter(item => item.jobId === Number(jobEventsMatch[1]))));
        const attemptsMatch = /^\/api\/job-items\/(\d+)\/attempts$/u.exec(path);
        if (method === 'GET' && attemptsMatch) {
          const itemId = Number(attemptsMatch[1]);
          const item = jobItemsFixture.find(value => value.id === itemId);
          const attempts = Array.from({ length: 25 }, (_, index) => ({ ...item.latestAttempt, id: itemId * 100 + index + 1, attemptNumber: index + 1 }));
          return fulfillJson(route, pageValue(url, attempts));
        }
        if (method === 'GET' && path === '/api/reviewers') return fulfillJson(route, pageValue(url, state.reviewers));
        if (method === 'POST' && path === '/api/reviewers') {
          const reviewer = { id: Math.max(0, ...state.reviewers.map(item => item.id)) + 1, name: body.name, revision: 1, createdAt: timestamp, updatedAt: timestamp };
          state.reviewers.push(reviewer);
          return fulfillJson(route, reviewer, 201);
        }
        const reviewerMatch = /^\/api\/reviewers\/(\d+)$/u.exec(path);
        if (method === 'GET' && reviewerMatch) return fulfillJson(route, state.reviewers.find(item => item.id === Number(reviewerMatch[1])));
        if (method === 'PATCH' && reviewerMatch) {
          const id = Number(reviewerMatch[1]);
          const index = state.reviewers.findIndex(item => item.id === id);
          const reviewer = { ...state.reviewers[index], name: body.name, revision: state.reviewers[index].revision + 1, updatedAt: timestamp };
          state.reviewers[index] = reviewer;
          return fulfillJson(route, reviewer);
        }
        if (method === 'GET' && /^\/api\/reviewers\/\d+\/statistics$/u.test(path)) return fulfillJson(route, statistics(url));
        if (method === 'GET' && path === '/api/reviews') return fulfillJson(route, pageValue(url, state.reviews.filter(review => review.sampleId === Number(url.searchParams.get('sampleId')))));
        if (method === 'POST' && path === '/api/reviews') return fulfillJson(route, updateSampleWithReview(body), 201);
        if (method === 'POST' && path === '/api/reviews/batch') return fulfillJson(route, body.items.map(updateSampleWithReview), 201);
        if (method === 'GET' && path === '/api/samples') {
          const decision = url.searchParams.get('decision');
          const datasetId = Number(url.searchParams.get('datasetId'));
          const protocol = url.searchParams.get('protocol');
          const category = url.searchParams.get('category');
          const search = (url.searchParams.get('search') ?? '').trim().toLocaleLowerCase('en-US');
          const values = state.samples.filter(sample => (!decision || sample.reviewDecision === decision)
            && (!datasetId || sample.datasetId === datasetId)
            && (!protocol || sample.category.endsWith(`-${protocol}`))
            && (!category || sample.category === category)
            && (!search || `${sample.displayId} ${sample.datasetName}`.toLocaleLowerCase('en-US').includes(search)));
          return fulfillJson(route, pageValue(url, values));
        }
        const sampleMatch = /^\/api\/samples\/(\d+)$/u.exec(path);
        if (method === 'GET' && sampleMatch) return fulfillJson(route, state.samples.find(sample => sample.id === Number(sampleMatch[1])));
        const classificationMatch = /^\/api\/samples\/(\d+)\/classification$/u.exec(path);
        if (method === 'PATCH' && classificationMatch) {
          const id = Number(classificationMatch[1]);
          const index = state.samples.findIndex(sample => sample.id === id);
          const original = state.samples[index];
          if (body.expectedRevision !== original.revision) return fulfillJson(route, { error: { code: 'revision_conflict', message: 'The sample changed.', details: null } }, 409);
          const conflictTarget = body.targetCategory.startsWith('C-');
          if (!body.trueEmotionDescription?.trim() || (conflictTarget && (!body.apparentEmotion?.trim() || body.apparentEmotion.trim().toLocaleLowerCase('en-US') === original.trueEmotion.trim().toLocaleLowerCase('en-US')))) {
            return fulfillJson(route, { error: { code: 'validation_error', message: 'The classification fields are invalid.', details: null } }, 422);
          }
          const next = {
            ...original,
            category: body.targetCategory,
            conflictDirection: conflictTarget ? body.conflictDirection : null,
            apparentEmotion: conflictTarget ? body.apparentEmotion.trim().toLocaleLowerCase('en-US') : original.trueEmotion,
            trueEmotionDescription: body.trueEmotionDescription.trim(),
            reviewDecision: 'Pending',
            currentReview: null,
            revision: original.revision + 1,
            archiveSyncStatus: 'NeedsUpdate',
            updatedAt: timestamp,
          };
          state.samples[index] = next;
          return fulfillJson(route, next);
        }
        if (method === 'GET' && path === '/api/archives') return fulfillJson(route, pageValue(url, state.archives));
        if (method === 'POST' && path === '/api/archives/preview') {
          const changes = state.samples.filter(sample => sample.datasetId === body.datasetId && sample.id >= 31).slice(0, 25).map(sample => ({
            sampleId: sample.id,
            displayId: sample.displayId,
            expectedRevision: sample.revision,
            datasetId: sample.datasetId,
            datasetName: state.datasets.find(dataset => dataset.id === sample.datasetId)?.name ?? '',
            category: sample.category,
            protocol: sample.category.endsWith('-VA') ? 'VA' : 'VT',
            relation: sample.category.startsWith('A-') ? 'Aligned' : 'Conflict',
            primaryAssetId: sample.primaryAssetId,
            primaryAssetUrl: sample.primaryAssetUrl,
          }));
          return fulfillJson(route, { datasetId: body.datasetId, added: changes.slice(0, 21), updated: changes.slice(21, 23), removed: changes.slice(23), unchangedCount: 30, expectedArchiveRevision: 2 });
        }
        if (method === 'POST' && path === '/api/archives/sync') {
          state.archives = [{ datasetId: body.datasetId, revision: body.expectedArchiveRevision + 1, lastSyncedAt: timestamp, manifestAvailable: true, currentCount: 25, needsUpdateCount: 0 }];
          return fulfillJson(route, state.archives[0]);
        }
        if (method === 'GET' && path === '/api/archives/1/manifest') return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: '{"sampleId":"CS-000031","model":"LTX-2.5"}\n', headers: { 'Content-Disposition': 'attachment; filename="manifest.jsonl"' } });
        return fulfillJson(route, { error: { code: 'fixture_route_missing', message: `${method} ${path} is not covered.`, details: null } }, 501);
      });
    },
  };
}
