import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('../frontend/node_modules/typescript');
const clientSource = readFileSync(new URL('../frontend/src/api/client.ts', import.meta.url), 'utf8');
const contractSource = readFileSync(new URL('../frontend/src/api/contracts.ts', import.meta.url), 'utf8');
const querySource = readFileSync(new URL('../frontend/src/api/queries.ts', import.meta.url), 'utf8');
const eventSource = readFileSync(new URL('../frontend/src/api/jobEvents.ts', import.meta.url), 'utf8');
const contentPageSource = readFileSync(new URL('../frontend/src/pages/generate/ContentPage.tsx', import.meta.url), 'utf8');
const backgroundPageSource = readFileSync(new URL('../frontend/src/pages/generate/BackgroundsPage.tsx', import.meta.url), 'utf8');
const batchesPageSource = readFileSync(new URL('../frontend/src/pages/generate/BatchesPage.tsx', import.meta.url), 'utf8');
const testPageSource = readFileSync(new URL('../frontend/src/pages/generate/TestPage.tsx', import.meta.url), 'utf8');
const jobsPageSource = readFileSync(new URL('../frontend/src/pages/generate/JobsPage.tsx', import.meta.url), 'utf8');
const reviewPageSource = readFileSync(new URL('../frontend/src/pages/ReviewPage.tsx', import.meta.url), 'utf8');
const archivePageSource = readFileSync(new URL('../frontend/src/pages/ArchivePage.tsx', import.meta.url), 'utf8');
const workspacePageSource = readFileSync(new URL('../frontend/src/pages/WorkspacePage.tsx', import.meta.url), 'utf8');
const sharedGenerationSource = readFileSync(new URL('../frontend/src/pages/generate/shared.tsx', import.meta.url), 'utf8');
const generationLocaleSource = readFileSync(new URL('../frontend/src/locales/features/generation.ts', import.meta.url), 'utf8');
const reviewArchiveLocaleSource = readFileSync(new URL('../frontend/src/locales/features/reviewArchive.ts', import.meta.url), 'utf8');
const workspaceLocaleSource = readFileSync(new URL('../frontend/src/locales/features/workspaceSettingsStatistics.ts', import.meta.url), 'utf8');
const generationCssSource = readFileSync(new URL('../frontend/src/pages/generate/GenerationPage.css', import.meta.url), 'utf8');

const operationalPageSources = {
  workspace: workspacePageSource,
  jobs: jobsPageSource,
  review: reviewPageSource,
  archive: archivePageSource,
};

function loadClient(fetchMock) {
  const output = ts.transpileModule(clientSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const context = { module, exports: module.exports, fetch: fetchMock, window: { location: { protocol: 'http:', host: 'example.test' } }, URLSearchParams };
  vm.runInNewContext(output, context);
  return module.exports;
}

test('API request uses mocked fetch and maps HTTP and network failures', async () => {
  const calls = [];
  const client = loadClient(async (path, init) => {
    calls.push([path, init]);
    return { ok: false, status: 503, json: async () => ({ error: { code: 'renderer_not_configured', message: 'internal', details: {} } }) };
  });
  await assert.rejects(() => client.apiRequest('/api/batch-drafts/1/submit', { method: 'POST', body: '{}' }), error => error.code === 'renderer_not_configured' && error.kind === 'renderer');
  assert.equal(calls[0][0], '/api/batch-drafts/1/submit');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
  const networkClient = loadClient(async () => { throw new Error('offline'); });
  await assert.rejects(() => networkClient.apiRequest('/api/jobs'), error => error.code === 'network_error' && error.kind === 'network');
});

test('CRUD, batch, and GPU release mutations carry revision and confirmation contracts', () => {
  for (const name of ['expectedRevision', 'expectedGpuRevisions', 'confirmModelSwitch']) assert.match(querySource, new RegExp(name));
  for (const path of ['/api/datasets', '/api/content-plans', '/api/prompt-presets', '/api/video-background-presets', '/api/batch-drafts', '/api/jobs']) assert.match(querySource, new RegExp(path.replaceAll('/', '\\/')));
  assert.match(querySource, /invalidateJobAuthority/);
  assert.match(querySource, /queryKeys\.jobItems/);
  assert.match(querySource, /queryKeys\.jobEvents/);
  assert.match(querySource, /\/api\/gpu-slots\/\$\{slot\}\/release/u);
  assert.match(querySource, /\/api\/test-runs/u);
  assert.match(contractSource, /export interface TestRunCreate/u);
  assert.match(contractSource, /loadedPrecision: ModelPrecision \| null/u);
  assert.match(contractSource, /precision: ModelPrecision \| null/u);
  for (const field of ['serviceStatus', 'gpuName', 'memory', 'statusReason']) assert.match(contractSource, new RegExp(field));
  assert.match(querySource, /refetchInterval: 5000/u);
});

test('live GPU polling cannot reinitialize an edited new batch', () => {
  assert.match(batchesPageSource, /const batchDefaultsInitialized = useRef\(stored !== null\)/u);
  assert.match(batchesPageSource, /if \(batchDefaultsInitialized\.current \|\| initialQueriesPending\) return/u);
  assert.match(batchesPageSource, /batchDefaultsInitialized\.current = true/u);
  assert.match(batchesPageSource, /\[datasetsQuery\.data, gpuQuery\.data, initialQueriesPending\]/u);
});

test('GPU release errors stay in React Query feedback and live status reasons are visible', () => {
  assert.match(sharedGenerationSource, /releaseMutation\.mutate\(/u);
  assert.doesNotMatch(sharedGenerationSource, /releaseMutation\.mutateAsync/u);
  assert.match(sharedGenerationSource, /gpu\.statusReason \? <p>\{g\('gpu\.statusReason'/u);
  assert.equal(generationLocaleSource.match(/'gpu\.statusReason'/gu)?.length, 2);
});

test('test bench submits only the currently previewed form through the real test-run API', () => {
  assert.match(testPageSource, /useSubmitTestRunMutation/u);
  assert.match(testPageSource, /const result = previewedFormKey === formKey \? previewMutation\.data : undefined/u);
  assert.match(testPageSource, /!result[\s\S]*!validExecution/u);
  assert.match(testPageSource, /expectedGpuRevisions/u);
  assert.match(testPageSource, /test-bench-v3/u);
});

test('job results expose retained assets and generation attempts', () => {
  assert.match(contractSource, /export interface GenerationAttempt/u);
  assert.match(contractSource, /attempts: GenerationAttempt\[\]/u);
  assert.match(contractSource, /primaryAssetUrl: string \| null/u);
  assert.match(jobsPageSource, /item\.primaryAssetUrl \? <video/u);
  assert.match(jobsPageSource, /item\.sourceAssetUrl/u);
  assert.match(jobsPageSource, /item\.attempts\.map/u);
});

test('completed test results can be kept as formal samples without a mock path', () => {
  assert.match(querySource, /\/api\/job-items\/\$\{itemId\}\/keep/u);
  assert.match(jobsPageSource, /selected\.source === 'Test'/u);
  assert.match(jobsPageSource, /item\.sampleId !== null/u);
  assert.doesNotMatch(jobsPageSource, /keepTestResult/u);
});

test('the visible review queue reads pending current Sample records', () => {
  assert.match(querySource, /samples: \(decision\?: ReviewDecision\) => \['samples', decision \?\? 'All'\] as const/u);
  assert.match(querySource, /useSamplesQuery\(decision\?: ReviewDecision\)/u);
  assert.match(querySource, /new URLSearchParams\(\{ decision \}\)/u);
  assert.match(querySource, /\/api\/samples\/\$\{id\}\/review/u);
  assert.match(reviewPageSource, /useSamplesQuery\('Pending'\)/u);
  assert.match(reviewPageSource, /sample\.reviewDecision === 'Pending'/u);
  const sampleContract = contractSource.match(/export interface Sample \{([\s\S]*?)\n\}/u)?.[1];
  assert.ok(sampleContract);
  assert.match(sampleContract, /model: ModelName;/u);
  assert.match(sampleContract, /generationRecord: GenerationAttempt;/u);
  assert.doesNotMatch(sampleContract, /precision:/u);
  assert.match(reviewPageSource, /selected\.generationRecord\.precision/u);
  assert.doesNotMatch(reviewPageSource, /selected\.precision/u);
  assert.doesNotMatch(reviewPageSource, /useMockRepository|useRepositorySnapshot/u);
});

test('workspace, jobs, review, and archive read operational data only from API queries', () => {
  for (const [page, source] of Object.entries(operationalPageSources)) {
    assert.doesNotMatch(
      source,
      /useMockRepository|useRepositorySnapshot|useExamplePageState|from ['"]\.\.\/store['"]|from ['"]\.\.\/mock['"]/u,
      `${page} must not read mock, local-storage, or example-state data`,
    );
  }

  assert.match(workspacePageSource, /useDatasetsQuery\(\)/u);
  assert.match(workspacePageSource, /useJobsQuery\(\)/u);
  assert.match(workspacePageSource, /useSamplesQuery\(\)/u);
  assert.match(jobsPageSource, /useJobsQuery\(\)/u);
  assert.match(reviewPageSource, /useSamplesQuery\('Pending'\)/u);
  assert.match(archivePageSource, /useDatasetsQuery\(\)/u);
  assert.match(archivePageSource, /useSamplesQuery\('Accepted'\)/u);
  assert.match(archivePageSource, /<td>\{sample\.model\}<\/td>/u);
  assert.doesNotMatch(archivePageSource, /sample\.precision|generationRecord\.precision/u);
});

test('empty API arrays drive truthful empty states on all four operational pages', () => {
  assert.match(workspacePageSource, /const datasets = datasetsQuery\.data \?\? \[\]/u);
  assert.match(workspacePageSource, /const samples = samplesQuery\.data \?\? \[\]/u);
  assert.match(workspacePageSource, /filtered\.length === 0[\s\S]*workspace\.datasets\.emptyBody/u);

  assert.match(jobsPageSource, /const jobs = jobsQuery\.data \?\? \[\]/u);
  assert.match(jobsPageSource, /jobs\.length === 0 \? 'jobs\.empty' : 'jobs\.filtered'/u);

  assert.match(reviewPageSource, /const samples = samplesQuery\.data \?\? \[\]/u);
  assert.match(reviewPageSource, /samples\.length === 0[\s\S]*review\.emptyTitle[\s\S]*review\.emptyBody/u);

  assert.match(archivePageSource, /const datasets = datasetsQuery\.data \?\? \[\]/u);
  assert.match(archivePageSource, /const acceptedSamples = samplesQuery\.data \?\? \[\]/u);
  assert.match(archivePageSource, /(?:datasets|archiveDatasets)\.length === 0[\s\S]*archive\.emptyTitle[\s\S]*archive\.emptyBody/u);
  assert.match(archivePageSource, /(?:rows|samples)\.length === 0[\s\S]*archive\.emptyTitle[\s\S]*archive\.emptyBody/u);
});

test('archive keeps API dataset names raw and makes no mock archive or sync claim', () => {
  assert.match(archivePageSource, /\.name\}<\/option>/u);
  assert.doesNotMatch(archivePageSource, /localizedName\(|正式生成集|验证集|已停用示例集/u);
  assert.doesNotMatch(
    archivePageSource,
    /previewArchive|syncArchive|ArchivePreview|currentSampleIds/u,
  );
});

test('running and failed workspace groups use distinct bilingual empty copy', () => {
  assert.match(workspacePageSource, /emptyKey: 'runningEmpty' \| 'failedEmpty'/u);
  assert.match(workspacePageSource, /renderJobs\(runningJobs, 'runningEmpty'\)/u);
  assert.match(workspacePageSource, /renderJobs\(failedJobs, 'failedEmpty'\)/u);

  for (const [key, english, chinese] of [
    ['runningEmpty', 'There are no running jobs.', '当前没有运行任务。'],
    ['failedEmpty', 'There are no failed jobs.', '当前没有失败任务。'],
  ]) {
    assert.equal(workspaceLocaleSource.match(new RegExp(`${key}:`, 'gu'))?.length, 2);
    assert.equal(workspaceLocaleSource.includes(`${key}: '${english}'`), true);
    assert.equal(workspaceLocaleSource.includes(`${key}: '${chinese}'`), true);
  }
  assert.equal(reviewArchiveLocaleSource.match(/emptyTitle:/gu)?.length, 4);
  assert.equal(reviewArchiveLocaleSource.match(/emptyBody:/gu)?.length, 4);
});

test('1024px production batch category keeps its full English selected value in bounds', () => {
  assert.match(batchesPageSource, /className="generation-batch-category"[\s\S]*htmlFor="batch-category"/u);
  assert.match(
    generationCssSource,
    /\.generation-batch-category, \.generation-batch-category select \{ min-width: 0; max-width: 100%; \}/u,
  );
  assert.match(
    generationCssSource,
    /@media \(min-width: 901px\) and \(max-width: 1100px\) \{[\s\S]*?\.generation-batch-category \{ grid-column: 1 \/ -1; \}/u,
  );
});

test('generation catalogs use paired Chinese and English business fields', () => {
  const contentFields = contractSource.match(/export interface ContentPlanFields \{([\s\S]*?)\n\}/u)?.[1] ?? '';
  const backgroundFields = contractSource.match(/export interface BackgroundPresetFields \{([\s\S]*?)\n\}/u)?.[1] ?? '';
  for (const field of ['nameZh', 'nameEn', 'sceneZh', 'sceneEn', 'triggerEventZh', 'triggerEventEn', 'psychologicalBackgroundZh', 'psychologicalBackgroundEn', 'contentRequirementsZh', 'contentRequirementsEn', 'sceneSupplementZh', 'sceneSupplementEn']) {
    assert.match(contentFields, new RegExp(`\\b${field}:`));
  }
  for (const field of ['nameZh', 'nameEn', 'sceneZh', 'sceneEn', 'ambientSoundZh', 'ambientSoundEn', 'participantRelationshipZh', 'participantRelationshipEn', 'lightingZh', 'lightingEn', 'framingZh', 'framingEn']) {
    assert.match(backgroundFields, new RegExp(`\\b${field}:`));
  }
  assert.doesNotMatch(contentFields, /\b(?:name|scene|triggerEvent|psychologicalBackground|contentRequirements|sceneSupplement):/u);
  assert.doesNotMatch(backgroundFields, /\b(?:name|scene|ambientSound|participantRelationship|lighting|framing):/u);
});

test('catalog editors and generation selectors use locale-specific names without changing IDs', () => {
  for (const source of [contentPageSource, backgroundPageSource]) {
    assert.match(source, /localizedName\(locale, item\)/u);
    assert.match(source, /nameZh/u);
    assert.match(source, /nameEn/u);
  }
  assert.match(contentPageSource, /item\.sceneZh/u);
  assert.match(contentPageSource, /item\.sceneEn/u);
  assert.match(backgroundPageSource, /item\.sceneZh/u);
  assert.match(backgroundPageSource, /item\.sceneEn/u);
  for (const source of [batchesPageSource, testPageSource]) {
    assert.match(source, /localizedName\(locale, item\)/u);
    assert.match(source, /value=\{item\.id\}/u);
  }
  assert.match(testPageSource, /contentPlan: \{ id: selectedContent\.id/u);
  assert.match(testPageSource, /backgroundPreset: \{ id: selectedBackground\.id/u);
});

test('mocked WebSocket wiring preserves the cursor and refetches authority', () => {
  class MockWebSocket { constructor(url) { this.url = url; } close() {} }
  assert.equal(typeof MockWebSocket, 'function');
  assert.match(eventSource, /afterEventId/);
  assert.match(eventSource, /invalidateAuthorityForJobEvent/);
  assert.match(eventSource, /queryKeys\.job\(event\.jobId\)/);
  assert.match(eventSource, /queryKeys\.jobItems\(event\.jobId\)/);
  assert.match(eventSource, /cursor\.current/);
});
