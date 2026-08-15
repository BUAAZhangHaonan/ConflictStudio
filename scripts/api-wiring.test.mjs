import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const reviewSource = read('../frontend/src/pages/ReviewPage.tsx');
const archiveSource = read('../frontend/src/pages/ArchivePage.tsx');
const settingsSource = read('../frontend/src/pages/SettingsPage.tsx');
const statisticsSource = read('../frontend/src/pages/StatisticsPage.tsx');
const workspaceSource = read('../frontend/src/pages/WorkspacePage.tsx');
const workspaceCss = read('../frontend/src/pages/WorkspacePage.css');
const batchesSource = read('../frontend/src/pages/generate/BatchesPage.tsx');
const contentSource = read('../frontend/src/pages/generate/ContentPage.tsx');
const jobsSource = read('../frontend/src/pages/generate/JobsPage.tsx');
const generationCss = read('../frontend/src/pages/generate/GenerationPage.css');
const sharedSource = read('../frontend/src/pages/generate/shared.tsx');
const gpuStatusSource = read('../frontend/src/gpuStatus.ts');
const archiveHelpers = read('../frontend/src/reviewArchive.ts');
const mainSource = read('../frontend/src/main.tsx');
const preferencesSource = read('../frontend/src/preferences.ts');
const appShellSource = read('../frontend/src/components/AppShell.tsx');
const firstReviewerSource = read('../frontend/src/app/FirstReviewerDialog.tsx');
const prefillSource = read('../frontend/src/generationPrefill.ts');
const localeSource = `${read('../frontend/src/locales/features/reviewArchive.ts')}\n${read('../frontend/src/locales/features/workspaceSettingsStatistics.ts')}\n${read('../frontend/src/locales/features/generation.ts')}`;

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

test('frontend contracts include the exact reviewer, review, statistics, archive, health and sample fields', () => {
  for (const name of ['Reviewer', 'ReviewerCreate', 'ReviewerRename', 'ReviewCreate', 'ReviewBatchCreate', 'Review', 'ReviewerStatistics', 'ArchivePreview', 'Archive', 'Health', 'SampleClassificationUpdate']) {
    assert.match(contractSource, new RegExp(`export (?:interface|type) ${name}\\b`));
  }
  for (const field of ['reviewerId', 'note', 'expectedRevision', 'expectedReviewRevision']) assert.match(contractSource, new RegExp(`${field}:`));
  for (const field of ['currentReview', 'inArchive', 'archiveSyncStatus', 'actualContentSummary', 'actualSceneSummary', 'generationCompatibility']) assert.match(contractSource, new RegExp(`${field}:`));
  const sample = contractSource.match(/export interface Sample \{([\s\S]*?)\n\}/u)?.[1] ?? '';
  assert.doesNotMatch(sample, /precision:/u);
  assert.match(sample, /generationRecord: GenerationAttempt;/u);
  const classification = contractSource.match(/export interface SampleClassificationUpdate \{([\s\S]*?)\n\}/u)?.[1] ?? '';
  assert.match(classification, /apparentEmotion\?: string;/u);
  assert.match(classification, /trueEmotionDescription: string;/u);
  assert.doesNotMatch(classification, /trueEmotion:/u);
});

test('queries and mutations use only the current backend endpoints', () => {
  for (const endpoint of ['/api/reviewers', '/api/reviews', '/api/reviews/batch', '/statistics', '/classification', '/api/archives', '/api/archives/preview', '/api/archives/sync', '/api/health', '/api/gpu-slots']) {
    assert.equal(querySource.includes(endpoint), true, endpoint);
  }
  assert.doesNotMatch(querySource, /\/api\/samples\/\$\{id\}\/review/u);
  assert.match(querySource, /invalidateQueries\(\{ queryKey: \['reviewerStatistics'\]/u);
  assert.match(querySource, /client\.invalidateQueries\(\{ queryKey: roots\.archives \}\)/u);
});

test('review uses persistent reviews and a revisioned classification form with coherent emotions', () => {
  for (const token of ['useCreateReviewMutation', 'useCreateReviewsBatchMutation', 'useUpdateSampleClassificationMutation', 'currentReviewerId', 'expectedReviewRevision', 'expectedRevision', 'batchConfirmOpen', 'classificationOpen', 'targetApparentEmotion', 'targetDescription', 'matchingEmotion']) assert.match(reviewSource, new RegExp(token));
  assert.match(reviewSource, /conflictTarget \? \{ apparentEmotion:/u);
  assert.match(reviewSource, /trueEmotionDescription: targetDescription\.trim\(\)/u);
  assert.match(reviewSource, /preservedTrueEmotion/u);
  assert.match(reviewSource, /window\.scrollY/u);
  assert.match(reviewSource, /queueListRef\.current\?\.scrollTop/u);
  assert.match(reviewSource, /useLayoutEffect/u);
  assert.match(reviewSource, /focus\(\{ preventScroll: true \}\)/u);
  assert.match(reviewSource, /navigate\(returnTarget, \{ replace: true \}\)/u);
  assert.doesNotMatch(reviewSource, /navigate\(-1\)|useMockRepository|useRepositorySnapshot/u);
  assert.match(reviewSource, /selected\.generationCompatibility === 'NeedsRegeneration'/u);
  assert.match(reviewSource, /selected\.actualContentSummary\.nameZh/u);
  assert.match(reviewSource, /selected\.actualSceneSummary\.nameZh/u);
  assert.match(reviewSource, /disabled=\{preferences\.currentReviewerId === null \|\| selectedNeedsRegeneration\}/u);
  assert.match(reviewSource, /disabled=\{preferences\.currentReviewerId === null \|\| batchAcceptBlocked\}/u);
  assert.match(reviewSource, /reviewer\.readOnlyHint/u);
  assert.match(localeSource, /actualVideoScene: 'Actual video scene'/u);
  assert.match(localeSource, /actualVideoScene: '实际视频场景'/u);
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
  assert.match(archiveSource, /<Pagination page=\{samplesQuery\.data\?\.page/u);
  assert.match(archiveSource, /buildArchiveLocation/u);
  assert.match(archiveSource, /reviewLocation\(sample\.id, returnTo\)/u);
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

test('batch scene selection and result prompts use explicit independent controls', () => {
  assert.match(batchesSource, /contentSelections: form\.contentSelections\.map/u);
  assert.match(batchesSource, /selection\.contentPlan\.mode === 'Generative'/u);
  assert.match(batchesSource, /batches\.selectCompatibleScenes/u);
  assert.match(batchesSource, /batches\.clearCompatibleScenes/u);
  assert.match(batchesSource, /selected && next\.contentSelections\.length > 0 \? next : null/u);
  assert.match(batchesSource, /role="status" aria-live="polite">\{dirty \? g\('batches\.unsavedStatus'\) : ''\}/u);
  assert.match(localeSource, /'batches\.selectCompatibleScenes': 'Select all available scenes'/u);
  assert.match(localeSource, /'batches\.unsavedStatus': 'Unsaved changes'/u);
  assert.match(localeSource, /'batches\.unsavedStatus': '有未保存的更改'/u);
  assert.match(localeSource, /'batches\.selectCompatibleScenes': '全选可用场景'/u);
  assert.match(reviewSource, /navigate\('\/generate\/batches', \{ state \}\)/u);
  assert.match(reviewSource, /buildCorrectedSampleBatchPrefill\(selected/u);
  assert.match(prefillSource, /sourceDisplayId: sample\.displayId/u);
  assert.match(batchesSource, /readCorrectedSampleBatchPrefill\(location\.state\)/u);
  assert.match(batchesSource, /targetDatasetId: null/u);
  assert.match(batchesSource, /quantity: 1/u);
  assert.match(batchesSource, /dirty && prefill === null/u);
  assert.match(localeSource, /regenerateAction: 'Regenerate with the registered scene'/u);
  assert.match(localeSource, /regenerateAction: '使用已登记场景重新生成'/u);
  assert.match(localeSource, /'batches\.correctedPrefill': '\{\{sample\}\} has been copied into a new unsaved batch/u);
  assert.match(localeSource, /'batches\.correctedPrefill': '已将 \{\{sample\}\} 和登记场景预填/u);
  assert.equal((jobsSource.match(/className="generation-current-input__prompt"/gu) ?? []).length, 2);
  assert.match(generationCss, /\.generation-current-input__prompt \{[\s\S]*grid-column: 1 \/ -1/u);
  assert.match(generationCss, /\.generation-current-input__prompt pre \{[\s\S]*white-space: pre-wrap/u);
});

test('content plans save fields and compatible scenes in one request', () => {
  assert.doesNotMatch(contentSource, /useReplaceContentBackgroundsMutation|\/backgrounds.*method: 'PUT'/u);
  assert.match(contentSource, /backgroundPresetIds: \[\]/u);
  assert.match(contentSource, /await updateMutation\.mutateAsync/u);
  assert.match(contentSource, /draft\.mode === 'Fixed' && !creating \? \(/u);
  assert.match(contentSource, /className="generation-fixed-scene"/u);
  assert.match(contentSource, /useContentBackgroundsQuery\(!creating && draft\.mode === 'Fixed'/u);
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
  assert.match(jobsSource, /jobFailureMessage\(selected\.failureCode/u);
  assert.match(jobsSource, /jobFailureMessage\(item\.failureCode/u);
  assert.doesNotMatch(jobsSource, />\{selected\.failureReason\}</u);
  assert.match(workspaceSource, /failureKey\(job\.failureCode\)/u);
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
  const production = [mainSource, reviewSource, archiveSource, settingsSource, statisticsSource, sharedSource].join('\n');
  assert.doesNotMatch(production, /MockRepository|RepositoryProvider|useExamplePageState|PageStateBoundary|\?state=/u);
  assert.doesNotMatch(localeSource, /example status|示例状态|example video|示例视频/iu);
});
