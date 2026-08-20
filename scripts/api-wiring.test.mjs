import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('../frontend/node_modules/typescript');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const clientSource = read('../frontend/src/api/client.ts');
const contractSource = read('../frontend/src/api/contracts.ts');
const querySource = read('../frontend/src/api/queries.ts');
const queryClientSource = read('../frontend/src/api/queryClient.ts');
const jobEventsSource = read('../frontend/src/api/jobEvents.ts');
const reviewListSource = read('../frontend/src/pages/ReviewListPage.tsx');
const reviewDetailSource = read('../frontend/src/pages/ReviewDetailPage.tsx');
const archiveSource = read('../frontend/src/pages/ArchivePage.tsx');
const settingsSource = read('../frontend/src/pages/SettingsPage.tsx');
const statisticsSource = read('../frontend/src/pages/StatisticsPage.tsx');
const workspaceSource = read('../frontend/src/pages/WorkspacePage.tsx');
const workspaceCss = read('../frontend/src/pages/WorkspacePage.css');
const testPageSource = read('../frontend/src/pages/generate/TestPage.tsx');
const testResourcesSource = read('../frontend/src/pages/generate/TestResources.tsx');
const testWorkflowSource = read('../frontend/src/pages/generate/testWorkflow.ts');
const productionPageSource = read('../frontend/src/pages/generate/ProductionPage.tsx');
const resultsPageSource = [
  read('../frontend/src/pages/generate/ResultsPage.tsx'),
  read('../frontend/src/pages/generate/ResultsView.tsx'),
  read('../frontend/src/pages/generate/ResultsOutputList.tsx'),
  read('../frontend/src/pages/generate/resultsModel.ts'),
].join('\n');
const assistantSource = read('../frontend/src/pages/generate/AssistantPanel.tsx');
const formalGenerationSource = read('../frontend/src/pages/generate/formalGeneration.ts');
const generatePageSource = read('../frontend/src/pages/GeneratePage.tsx');
const generationCss = read('../frontend/src/pages/generate/GenerationPage.css');
const responsiveCss = read('../frontend/src/styles/responsive.css');
const sharedSource = read('../frontend/src/pages/generate/shared.tsx');
const gpuStatusSource = read('../frontend/src/gpuStatus.ts');
const archiveHelpers = read('../frontend/src/reviewArchive.ts');
const mainSource = read('../frontend/src/main.tsx');
const appSource = read('../frontend/src/app/App.tsx');
const preferencesSource = read('../frontend/src/preferences.ts');
const appShellSource = read('../frontend/src/components/AppShell.tsx');
const firstReviewerSource = read('../frontend/src/app/FirstReviewerDialog.tsx');
const packageSource = read('../package.json');
const drawioSource = read('../docs/generation-flow.drawio');
const generationLocaleSource = read('../frontend/src/locales/features/generation.ts');
const localeSource = `${read('../frontend/src/locales/features/reviewArchive.ts')}\n${read('../frontend/src/locales/features/workspaceSettingsStatistics.ts')}\n${generationLocaleSource}`;

function loadClient(fetchMock) {
  const output = ts.transpileModule(clientSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, fetch: fetchMock, window: { location: { protocol: 'http:', host: 'example.test' } }, URLSearchParams });
  return module.exports;
}

function loadGpuStatus() {
  const output = ts.transpileModule(gpuStatusSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports });
  return module.exports;
}

function loadFormalGeneration() {
  const output = ts.transpileModule(formalGenerationSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports });
  return module.exports;
}

test('API failures are mapped to localized error kinds without exposing server messages', async () => {
  const client = loadClient(async () => ({ ok: false, status: 409, json: async () => ({ error: { code: 'review_revision_conflict', message: 'internal detail', details: {} } }) }));
  await assert.rejects(() => client.apiRequest('/api/reviews', { method: 'POST', body: '{}' }), error => error.status === 409 && !client.apiErrorMessage(error, 'en-US').includes('internal detail'));
  assert.match(queryClientSource, /retry: false/u);
  assert.doesNotMatch(queryClientSource, /shouldRetry|refetchInterval/u);
});

test('prompt response failures have concise bilingual messages without internal codes', async () => {
  const cases = [
    ['invalid_prompt_envelope', 'The generation service returned an invalid response. Try again.', '生成服务返回了无效响应。请重试。'],
    ['empty_prompt_content', 'The generation service returned no content. Try again.', '生成服务没有返回内容。请重试。'],
    ['invalid_prompt_json', 'The generation service returned content that could not be read. Try again.', '生成服务返回的内容无法读取。请重试。'],
    ['duplicate_prompt_key', 'The generation service returned repeated fields. Try again.', '生成服务返回了重复字段。请重试。'],
    ['invalid_prompt_schema', 'The generation service returned missing or invalid fields. Try again.', '生成服务返回的字段缺失或有误。请重试。'],
  ];

  for (const [code, english, chinese] of cases) {
    const client = loadClient(async () => ({ ok: false, status: 502, json: async () => ({ error: { code, message: 'sensitive upstream detail', details: { requestId: 'internal-request' } } }) }));
    await assert.rejects(
      () => client.apiRequest('/api/test-runs', { method: 'POST', body: '{}' }),
      error => {
        assert.equal(client.apiErrorMessage(error, 'en-US'), english);
        assert.equal(client.apiErrorMessage(error, 'zh-CN'), chinese);
        assert.doesNotMatch(client.apiErrorMessage(error, 'en-US'), new RegExp(code, 'u'));
        assert.doesNotMatch(client.apiErrorMessage(error, 'zh-CN'), /internal-request|sensitive/u);
        return true;
      },
    );
  }
});

test('display name failures have plain bilingual messages without backend details', async () => {
  const client = loadClient(async () => ({
    ok: false,
    status: 422,
    json: async () => ({
      error: {
        code: 'invalid_display_name',
        message: 'internal regex and field detail',
        details: { fields: [{ field: 'name_en', message: 'sensitive pattern' }] },
      },
    }),
  }));

  await assert.rejects(
    () => client.apiRequest('/api/content-scripts', { method: 'POST', body: '{}' }),
    error => {
      assert.equal(client.apiErrorMessage(error, 'en-US'), 'Use a clear English name of 1 to 60 characters. Do not use import labels, slugs, statuses, or version tags.');
      assert.equal(client.apiErrorMessage(error, 'zh-CN'), '请输入 1 至 60 个字符的清晰英文名称。不要使用导入标记、短标识、状态值或版本号。');
      assert.doesNotMatch(client.apiErrorMessage(error, 'en-US'), /name_en|regex|sensitive pattern/u);
      assert.doesNotMatch(client.apiErrorMessage(error, 'zh-CN'), /name_en|regex|sensitive pattern/u);
      return true;
    },
  );
});

test('frontend contracts include current generation, review, statistics, archive, health and sample fields', () => {
  for (const name of ['BatchDraft', 'BatchPreview', 'PromptTestCreate', 'VideoTestCreate', 'ConfigurationAssistant', 'JobItem', 'Reviewer', 'ReviewSampleListRead', 'ReviewSampleDetailRead', 'ReviewNoteDraftRead', 'ReviewSubmissionCreate', 'ReviewBatchSubmissionCreate', 'SampleClassificationConversionUpdate', 'ReviewerStatistics', 'ArchivePreview', 'Archive', 'Health']) {
    assert.match(contractSource, new RegExp(`export (?:interface|type) ${name}\\b`));
  }
  for (const field of ['reviewerId', 'expectedRevision', 'expectedReviewRevision', 'expectedNoteDraftRevision']) assert.match(contractSource, new RegExp(`${field}:`));
  const detail = contractSource.match(/export interface ReviewSampleDetailRead extends ReviewSampleListRead \{([\s\S]*?)\n\}/u)?.[1] ?? '';
  for (const field of ['sourceMedia', 'dialogue', 'displayText', 'trueEmotionDescription', 'model', 'precision', 'compatibleSceneCount']) assert.match(detail, new RegExp(`${field}:`));
  assert.doesNotMatch(detail, /seed|prompt|attempt|gpu|vlm/iu);
  assert.doesNotMatch(contractSource, /export interface (?:ReviewCreate|ReviewBatchCreate|SampleClassificationUpdate)\b/u);
});

test('queries and mutations use only current backend generation and review endpoints', () => {
  for (const endpoint of [
    '/api/datasets',
    '/api/content-scripts',
    '/api/prompt-templates',
    '/api/prompt-template-versions',
    '/api/test-runs/prompt',
    '/api/test-runs/video',
    '/api/batch-drafts',
    '/api/test-results',
    '/api/generation-results',
    '/api/configuration-assistants',
    '/api/jobs/',
    '/api/gpu-slots',
    '/api/reviewers',
    '/api/reviews',
    '/api/reviews/batch',
    '/statistics',
    '/classification',
    '/api/archives',
    '/api/archives/preview',
    '/api/archives/sync',
    '/api/health',
  ]) assert.equal(querySource.includes(endpoint), true, endpoint);
  assert.doesNotMatch(querySource, /\/api\/samples\/\$\{id\}\/review/u);
  assert.doesNotMatch(querySource, /content-plans|prompt-presets|video-background-presets|\/keep|\/promote/u);
  assert.match(querySource, /invalidateQueries\(\{ queryKey: \['reviewerStatistics'\]/u);
  assert.match(querySource, /client\.invalidateQueries\(\{ queryKey: roots\.archives \}\)/u);
});

test('review uses separate list and detail routes with current mutations and safe return state', () => {
  for (const token of ['useReviewSampleListQuery', 'useSubmitReviewBatchMutation', 'saveReviewListState', 'reviewDetailLocation', 'window.scrollY']) assert.match(reviewListSource, new RegExp(token));
  for (const token of ['useReviewSampleDetailQuery', 'useReviewNoteDraftQuery', 'usePutReviewNoteDraftMutation', 'useSubmitReviewMutation', 'useConvertSampleClassificationMutation', 'expectedNoteDraftRevision', 'nextReference', 'safeReviewReturnTarget']) assert.match(reviewDetailSource, new RegExp(token));
  assert.match(appSource, /path="\/review" element=\{<ReviewListPage \/>\}/u);
  assert.match(appSource, /path="\/review\/:sampleId" element=\{<ReviewDetailPage \/>\}/u);
  assert.doesNotMatch(`${reviewListSource}\n${reviewDetailSource}`, /seed|positivePrompt|negativePrompt|generationRecord|gpuSlot|shortcut/iu);
  assert.doesNotMatch(querySource, /useCreateReviewMutation|useCreateReviewsBatchMutation|useUpdateSampleClassificationMutation/u);
});

test('statistics reads one real reviewer statistics response and renders only eight metrics plus activity', () => {
  assert.match(statisticsSource, /useReviewerStatisticsQuery/u);
  for (const field of ['uniqueReviewedCount', 'acceptedCount', 'rejectedCount', 'vaCount', 'vtCount', 'revisedSampleCount', 'archivedCurrentCount', 'needsUpdateCount']) assert.match(statisticsSource, new RegExp(`statistics\\.${field}`));
  assert.equal((statisticsSource.match(/<Metric /gu) ?? []).length, 8);
  assert.match(statisticsSource, /statistics\.activity\.map/u);
  assert.doesNotMatch(statisticsSource, /getStatistics|13|mock|PageStateBoundary/u);
});

test('settings uses real health, dataset, GPU and reviewer queries with explicit refetch', () => {
  for (const hook of ['useHealthQuery', 'useDatasetsQuery', 'useGpuSlotsQuery', 'useReviewersQuery', 'useCreateReviewerMutation', 'useRenameReviewerMutation']) assert.match(settingsSource, new RegExp(hook));
  assert.match(settingsSource, /healthQuery\.refetch\(\)/u);
  assert.match(settingsSource, /gpuQuery\.refetch\(\)/u);
  assert.match(settingsSource, /const reviewerPending = reviewersQuery\.isPending \|\| \(preferences\.currentReviewerId !== null && currentReviewerQuery\.isPending\)/u);
  assert.match(settingsSource, /const servicesPending = healthQuery\.isPending \|\| datasetsQuery\.isPending \|\| gpuQuery\.isPending/u);
  assert.match(settingsSource, /preferences\.currentReviewerId === null \? \[\] : \[currentReviewerQuery\.refetch\(\)\]/u);
  assert.doesNotMatch(settingsSource, /if \(reviewersQuery\.isPending|const queryError =/u);
  assert.doesNotMatch(settingsSource, /setTimeout|700|statusReason|useMockRepository|Repository/u);
  assert.doesNotMatch(mainSource, /RepositoryProvider/u);
});

test('archive uses preview, sync, manifest download and canonical return locations', () => {
  for (const hook of ['useArchivesQuery', 'usePreviewArchiveMutation', 'useSyncArchiveMutation']) assert.match(archiveSource, new RegExp(hook));
  assert.match(archiveSource, /\/api\/archives\/\$\{archive\.datasetId\}\/manifest/u);
  assert.match(archiveSource, /const archiveTotal = archive\?\.currentCount \?\? 0/u);
  assert.match(archiveSource, /archiveTotal === 0/u);
  assert.doesNotMatch(archiveSource, /rows\.length === 0[\s\S]{0,300}<Pagination/u);
  assert.match(archiveSource, /buildArchiveLocation/u);
  assert.match(archiveSource, /reviewDetailLocation\(sample\.id, returnTo\)/u);
  assert.match(archiveSource, /sample\.primaryMedia\.url/u);
  assert.match(archiveHelpers, /if \(state\.page > 1\) params\.set\('page'/u);
  assert.doesNotMatch(archiveSource, /archiveJsonl|Blob|URL\.createObjectURL|navigate\(-1\)/u);
  assert.doesNotMatch(archiveSource, /previewSamples\(|byId\.get\(item\.sampleId\)/u);
  assert.match(archiveSource, /preview\.added\.map\(sample/u);
});

test('workspace is a card list through 1024px and keeps every action visible', () => {
  assert.match(workspaceCss, /@media \(max-width: 1200px\) \{[\s\S]*\.workspace-datasets \.table-shell tbody tr[\s\S]*display: grid/u);
  assert.match(workspaceSource, /data-label=\{t\(`\$\{copyKey\}\.workspace\.datasets\.actions`\)\}/u);
  assert.match(workspaceSource, /workspace-dataset-name__title/u);
  assert.match(workspaceSource, /dataset\.note \? <span className="workspace-dataset-name__note"/u);
  assert.match(workspaceCss, /\.workspace-dataset-name \{[\s\S]*display: grid/u);
  assert.match(localeSource, /purposeLabel: 'Purpose'/u);
  assert.match(localeSource, /purposeLabel: '用途'/u);
});

test('generation navigation has only Test, Generate and Results routes', () => {
  for (const route of ['/generate/test', '/generate/production', '/generate/results']) {
  assert.match(appShellSource, /function currentPrimaryPath\(pathname: string\)/u);
  assert.match(appShellSource, /pathname\.startsWith\('\/review'\)/u);
    assert.match(appSource, new RegExp(route.replaceAll('/', '\\/')));
    assert.match(appShellSource, new RegExp(route.replaceAll('/', '\\/')));
  }
  assert.match(generatePageSource, /section === 'test' \? <TestPage/u);
  assert.match(generatePageSource, /section === 'production' \? <ProductionPage/u);
  assert.match(generatePageSource, /section === 'results' \? <ResultsPage/u);
  assert.doesNotMatch(`${appSource}\n${appShellSource}\n${generatePageSource}`, /\/generate\/(batches|content|scenes|template-versions|jobs)/u);
  for (const file of ['BatchesPage.tsx', 'ContentPage.tsx', 'ScenesPage.tsx', 'PromptTemplateVersionsPage.tsx', 'JobsPage.tsx']) {
    assert.equal(existsSync(new URL('../frontend/src/pages/generate/' + file, import.meta.url)), false, file);
  }
  assert.doesNotMatch(generationLocaleSource, /'(?:batches|content|scenes|templates|jobs)\./u);
  assert.doesNotMatch(packageSource, /job-prompts/u);
});

test('test page manages isolated resources and displays the exact prompt test output', () => {
  for (const token of ['PromptTest', 'VideoTest', 'useSubmitPromptTestMutation', 'useSubmitVideoTestMutation', 'useContentScenesQuery', 'verificationStatus', 'useResultItemsQuery', 'promptOutput', 'testCopyDraftKey', 'TestResources']) {
    assert.match(testPageSource, new RegExp(token));
  }
  assert.match(testPageSource, /promptTestMutation\.mutateAsync/u);
  assert.match(testPageSource, /videoTestMutation\.mutateAsync/u);
  assert.match(testPageSource, /promptOutput\.finalPositivePrompt/u);
  assert.match(testPageSource, /promptOutput\.negativePrompt/u);
  assert.match(testPageSource, /results\?tab=test&job=/u);
  assert.doesNotMatch(testPageSource, /temporaryInputs|usePromptPreviewMutation|keep|promote|Sample|datasetId|systemInput|userInput/u);
  for (const token of ['useCreateContentScriptMutation', 'useUpdateContentScriptMutation', 'useCreateSceneMutation', 'useUpdateSceneMutation', 'useCreatePromptTemplateVersionMutation', 'useVerifyPromptTemplateVersionMutation']) {
    assert.match(testResourcesSource, new RegExp(token));
  }
  assert.match(testWorkflowSource, /sceneIds/u);
  assert.match(generationLocaleSource, /Test results never enter a formal dataset, review, or archive/u);
});
test('formal generation uses explicit valid combinations and current preview and submit contracts', () => {
  for (const token of ['useDatasetsQuery', "status: 'Active'", 'contentSelections', 'selectedSceneIds', 'demographics', 'parseSeeds', 'gpuSlots', 'usePreviewBatchMutation', 'useSubmitBatchMutation']) {
    assert.match(productionPageSource, new RegExp(token));
  }
  assert.match(productionPageSource, /item\.mode === 'Fixed' \? \[scenes\[0\]\.id\] : \[\]/u);
  assert.match(productionPageSource, /item\.mode === 'Generative'/u);
  assert.match(productionPageSource, /Select all on this page|production\.selectPage/u);
  assert.equal(productionPageSource.includes('preview?.allocations.slice((previewPage - 1) * 20, previewPage * 20)'), true);
  assert.match(productionPageSource, /expectedGpuRevisions: preview\.gpuRevisions/u);
  assert.match(productionPageSource, /const unsavedDialog = useUnsavedChanges\(dirty\)/u);
  assert.match(productionPageSource, /userEdited && JSON\.stringify\(form\) !== savedFormSignature/u);
  assert.match(productionPageSource, /setUserEdited\(false\)/u);
  assert.match(productionPageSource, /production-dataset-search/);
  assert.match(productionPageSource, /\{unsavedDialog\}/u);
  assert.match(productionPageSource, /queryClient\.fetchQuery\([\s\S]*generationQueries\.batchDraft/u);
  assert.match(productionPageSource, /productionFormFromDraft\(refreshed, templateVersion\.templateId\)/u);
  assert.match(productionPageSource, /results\?tab=production&job=/u);
  assert.doesNotMatch(productionPageSource, /generationPrefill|readCorrectedSampleBatchPrefill|correctedSampleBatch/u);
  assert.doesNotMatch(productionPageSource, /quantity/u);
});

test('results separate test and formal tasks and wire explicit task controls', () => {
  for (const token of ['useTestResultsQuery', 'useProductionResultsQuery', 'useResultItemsQuery', 'useJobEventsQuery', 'useCancelJobMutation', 'useResumeJobMutation', 'useRetryFailedItemsMutation', 'expectedRevision', 'itemRevisions']) {
    assert.match(resultsPageSource, new RegExp(token));
  }
  assert.match(resultsPageSource, /listQuery\.data\?\.page/u);
  assert.match(resultsPageSource, /itemsQuery\.data\?\.page/u);
  assert.match(resultsPageSource, /eventsQuery\.data\?\.page/u);
  assert.match(resultsPageSource, /collapseProgressEvents/u);
  assert.match(resultsPageSource, /writeSessionDraft\(testCopyDraftKey/u);
  assert.match(resultsPageSource, /disabled=\{testDraft === null\}/u);
  assert.match(resultsPageSource, /jobFailureMessage\(detail\.failureCode/u);
  assert.match(resultsPageSource, /jobFailureMessage\(item\.failureCode/u);
  assert.doesNotMatch(resultsPageSource, />\{detail\.failureReason\}</u);
  assert.doesNotMatch(resultsPageSource, /failureDetails|requestId|httpStatus|finishReason|\/keep|\/promote/u);
});

test('assistant candidate mapper keeps every choice explicit and builds only compatible visible values', () => {
  const {
    assistantValuesWithCandidates,
    candidateChoicesReady,
    chooseCandidate,
    initialCandidateChoices,
  } = loadFormalGeneration();
  const groups = [
    { kind: 'Dataset', items: [{ id: 1, revision: 2, label: 'Formal one' }, { id: 2, revision: 1, label: 'Formal two' }] },
    { kind: 'ContentScript', items: [{ id: 11, revision: 4, label: '内容一 / Content one' }, { id: 12, revision: 3, label: '内容二 / Content two' }] },
    { kind: 'ShootingScene', items: [{ id: 21, revision: 5, label: '场景一 / Scene one' }, { id: 22, revision: 2, label: '场景二 / Scene two' }] },
    { kind: 'PromptTemplateVersion', items: [{ id: 31, revision: 7, label: 'Template v3' }, { id: 32, revision: 1, label: 'Template v4' }] },
  ];
  let choices = initialCandidateChoices(groups);
  assert.equal(choices.Dataset, null);
  assert.equal(choices.PromptTemplateVersion, null);
  assert.equal(choices.ContentScript.length, 0);
  assert.equal(choices.ShootingScene.length, 0);
  choices = chooseCandidate(choices, 'Dataset', 2);
  choices = chooseCandidate(choices, 'PromptTemplateVersion', 31);
  choices = chooseCandidate(choices, 'ContentScript', 11);
  choices = chooseCandidate(choices, 'ContentScript', 12);
  choices = chooseCandidate(choices, 'ShootingScene', 21);
  choices = chooseCandidate(choices, 'ShootingScene', 22);
  const values = assistantValuesWithCandidates(
    { displayName: 'A-VA-formal' },
    groups,
    choices,
    {
      11: [{ id: 21, revision: 5, nameZh: '场景一', nameEn: 'Scene one' }],
      12: [{ id: 22, revision: 2, nameZh: '场景二', nameEn: 'Scene two' }],
    },
  );
  assert.equal(values.targetDataset.id, 2);
  assert.equal(values.promptTemplateVersion.id, 31);
  assert.equal(JSON.stringify(values.contentSelections.map(value => ({
    content: value.contentScript.id,
    scenes: value.scenes.map(scene => scene.id),
  }))), JSON.stringify([
    { content: 11, scenes: [21] },
    { content: 12, scenes: [22] },
  ]));
  assert.equal(candidateChoicesReady(groups, choices, values), true);
  const incomplete = chooseCandidate(choices, 'ShootingScene', 22);
  const incompleteValues = assistantValuesWithCandidates(
    {},
    groups,
    incomplete,
    { 11: [{ id: 21, revision: 5 }], 12: [{ id: 22, revision: 2 }] },
  );
  assert.equal(candidateChoicesReady(groups, incomplete, incompleteValues), false);
});

test('formal generation mapper preserves controlled values and rejects invalid batch inputs', () => {
  const { buildBatchDraftRequest, productionFormFromDraft } = loadFormalGeneration();
  const form = {
    targetDatasetId: 4,
    displayName: 'A-VA-20260817',
    category: 'A-VA',
    conflictDirection: null,
    promptTemplateId: 8,
    promptTemplateVersionId: 9,
    selectedContent: [{
      id: 10,
      revision: 2,
      nameZh: '内容',
      nameEn: 'Content',
      mode: 'Fixed',
      scenes: [{ id: 12, revision: 1, nameZh: '场景', nameEn: 'Scene' }],
      selectedSceneIds: [12],
    }],
    selectedAges: [25],
    selectedGenders: ['Female'],
    selectedEthnicities: ['EastAsian'],
    seeds: '7',
    model: 'LTX-2.5',
    precision: 'INT8',
    gpuSlots: ['GPU0'],
  };
  const request = buildBatchDraftRequest(form, [7], new Set(['GPU0']));
  assert.equal(request.targetDatasetId, 4);
  assert.equal(JSON.stringify(request.contentSelections), JSON.stringify([{ contentScriptId: 10, sceneIds: [] }]));
  assert.equal(buildBatchDraftRequest({ ...form, targetDatasetId: null }, [7], new Set(['GPU0'])), null);
  assert.equal(buildBatchDraftRequest({ ...form, gpuSlots: ['GPU1'] }, [7], new Set(['GPU0'])), null);
  const restored = productionFormFromDraft({
    targetDatasetId: 4,
    displayName: 'A-VA-restored',
    category: 'A-VA',
    conflictDirection: null,
    promptTemplateVersion: { id: 9, revision: 3, name: 'Template v2' },
    contentSelections: [{
      contentScript: { id: 10, revision: 2, nameZh: '内容', nameEn: 'Content' },
      mode: 'Fixed',
      scenes: [{ id: 12, revision: 1, nameZh: '场景', nameEn: 'Scene' }],
      compatibleScenes: [{ id: 12, revision: 1, nameZh: '场景', nameEn: 'Scene' }],
    }],
    demographics: [{ age: 25, gender: 'Female', ethnicity: 'EastAsian' }],
    seeds: [7, 8],
    model: 'LTX-2.5',
    precision: 'INT8',
    gpuSlots: ['GPU0', 'GPU1'],
  }, 8);
  assert.equal(restored.promptTemplateId, 8);
  assert.equal(restored.seeds, '7, 8');
  assert.equal(JSON.stringify(restored.gpuSlots), JSON.stringify(['GPU0', 'GPU1']));
});

test('assistant renders all candidates and uses one server confirmation before visible application', () => {
  for (const token of ['missingFields', 'candidates', 'changedFields', 'selectedValues', 'confirmedFields', 'createContentScript', 'createShootingScene', 'ConfirmDialog']) {
    assert.match(assistantSource, new RegExp(token));
  }
  assert.match(assistantSource, /type=\{single \? 'radio' : 'checkbox'\}/u);
  assert.match(assistantSource, /checked=\{checked\}/u);
  assert.match(assistantSource, /chooseCandidate\(value, group\.kind, item\.id\)/u);
  assert.match(assistantSource, /if \(!clean \|\| \(production && batchDraft === null\)\) return/u);
  assert.match(assistantSource, /saved = await apply\.mutateAsync/u);
  assert.match(assistantSource, /confirmedFields: selected/u);
  assert.match(assistantSource, /createContentScript: production && createContent/u);
  assert.match(assistantSource, /createShootingScene: production && createScene/u);
  assert.match(assistantSource, /linkNewSceneToContent: production && linkDrafts/u);
  assert.match(assistantSource, /await onApply\(saved\.appliedValues \?\? values, saved\)/u);
  assert.match(productionPageSource, /setForm\(nextForm\)/u);
  assert.match(productionPageSource, /setSavedFormSignature\(JSON\.stringify\(nextForm\)\)/u);
  assert.match(productionPageSource, /targetDatasetId: event\.target\.value \? Number\(event\.target\.value\) : null/u);
  assert.match(productionPageSource, /promptTemplateVersionId: event\.target\.value \? Number\(event\.target\.value\) : null/u);
  assert.match(assistantSource, /assistant\.selectionChanged/u);
  assert.match(assistantSource, /assistant\.proposedContent/u);
  assert.match(assistantSource, /assistant\.proposedScene/u);
  assert.doesNotMatch(assistantSource, /submitBatch|createDataset|updateDataset|renameDataset|deleteDataset|mergeDataset|review/u);
  assert.doesNotMatch(productionPageSource, /promote|testArtifact|createDataset/u);
});

test('relationship guide is accessible and the DrawIO source has two pages', () => {
  assert.match(sharedSource, /<details className="generation-guide">/u);
  assert.match(sharedSource, /<ol className="generation-guide__flow">/u);
  assert.equal((drawioSource.match(/<diagram /gu) ?? []).length, 2);
  assert.match(drawioSource, /name="Generation settings"/u);
  assert.match(drawioSource, /name="Test and formal boundaries"/u);
  assert.match(generationCss, /@media \(max-width: 1279px\)[\s\S]*\.generation-test-layout[\s\S]*grid-template-columns: 1fr/u);
  assert.match(responsiveCss, /@media \(max-width: 390px\)[\s\S]*\.generate-nav[\s\S]*grid-template-columns: repeat\(3/u);
});

test('production reviewer identity comes only from the Reviewer API and user selection', () => {
  const sources = `${settingsSource}\n${preferencesSource}\n${appShellSource}\n${firstReviewerSource}`;
  assert.doesNotMatch(sources, /林然|陈宁|Lin Ran|Chen Ning/u);
  assert.doesNotMatch(sources, /DEFAULT_REVIEWER|presetReviewer|mockReviewer/u);
  assert.match(appShellSource, /preferences\.currentReviewerName/u);
  assert.match(firstReviewerSource, /useReviewersQuery\(reviewerPage\)/u);
  assert.match(firstReviewerSource, /reviewers\.length === 0/u);
  assert.match(firstReviewerSource, /const \[dismissed, setDismissed\] = useState\(false\)/u);
  assert.match(firstReviewerSource, /reviewer\.continueReadOnly/u);
  assert.doesNotMatch(firstReviewerSource, /dismissible=\{false\}|onClose=\{\(\) => undefined\}/u);
});

test('GPU and task failures are localized from stable fields instead of raw backend text', () => {
  assert.match(settingsSource, /gpuStatusReason\(gpu\)/u);
  assert.match(sharedSource, /gpuStatusReason\(gpu\)/u);
  assert.doesNotMatch(sharedSource, /gpu\.statusReason \?/u);
  assert.match(resultsPageSource, /jobFailureMessage\(detail\.failureCode/u);
  assert.match(resultsPageSource, /jobFailureMessage\(item\.failureCode/u);
  assert.doesNotMatch(resultsPageSource, />\{detail\.failureReason\}</u);
  assert.doesNotMatch(resultsPageSource, /failureDetails|requestId|httpStatus|finishReason/u);
  assert.match(workspaceSource, /failureKey\(job\.failureCode\)/u);
  assert.match(contractSource, /export interface PromptFailureDetails/u);
  assert.match(contractSource, /fields: PromptSchemaFieldDetail\[\] \| null/u);
  assert.match(jobEventsSource, /failureDetails: event\.payload\.failureDetails \?\? item\.failureDetails/u);
});

test('job events update interrupted and resumed task state in both result caches', () => {
  assert.match(jobEventsSource, /event\.eventType === 'JobResumed'/u);
  assert.match(jobEventsSource, /event\.eventType === 'JobRetryQueued'/u);
  assert.match(jobEventsSource, /event\.eventType === 'JobInterrupted'\) return 'Interrupted'/u);
  assert.match(jobEventsSource, /queryKeys\.testResults\[0\]/u);
  assert.match(jobEventsSource, /queryKeys\.productionResults\[0\]/u);
});

test('GPU status reasons cover every availability without contradictory ready text', () => {
  const { gpuStatusReason } = loadGpuStatus();
  const gpu = { activeJobId: null, availability: 'Available', loadedModel: null, serviceStatus: 'stopped' };
  assert.equal(gpuStatusReason(gpu), 'ready');
  assert.equal(gpuStatusReason({ ...gpu, loadedModel: 'LTX-2.5' }), 'loaded');
  assert.equal(gpuStatusReason({ ...gpu, serviceStatus: 'notInstalled' }), 'notInstalled');
  assert.equal(gpuStatusReason({ ...gpu, availability: 'Reserved' }), 'reserved');
  assert.equal(gpuStatusReason({ ...gpu, availability: 'Busy' }), 'busy');
  assert.equal(gpuStatusReason({ ...gpu, availability: 'ExternalOccupied' }), 'external');
  assert.equal(gpuStatusReason({ ...gpu, availability: 'Unknown', loadedModel: 'LTX-2.5' }), 'unknown');
  assert.equal(gpuStatusReason({ ...gpu, availability: 'Unknown', activeJobId: 7 }), 'activeJob');
});

test('production source is disconnected from the removed business mock system', () => {
  const production = [mainSource, reviewListSource, reviewDetailSource, archiveSource, settingsSource, statisticsSource, sharedSource, testPageSource, productionPageSource, resultsPageSource].join('\n');
  assert.doesNotMatch(production, /MockRepository|RepositoryProvider|useExamplePageState|PageStateBoundary|\?state=/u);
  assert.doesNotMatch(localeSource, /example status|示例状态|example video|示例视频/iu);
});
