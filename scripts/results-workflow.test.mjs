import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('../frontend/node_modules/typescript');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const modelSource = read('../frontend/src/pages/generate/resultsModel.ts');
const viewSource = read('../frontend/src/pages/generate/ResultsView.tsx');
const outputSource = read('../frontend/src/pages/generate/ResultsOutputList.tsx');
const querySource = read('../frontend/src/api/queries.ts');
const paginationSource = read('../backend/services/pagination.py');
const cssSource = read('../frontend/src/pages/generate/GenerationPage.css');
const timeSource = read('../frontend/src/time.ts');

function loadCommonJs(source, dependencies = {}, globals = {}) {
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: identifier => {
      if (!(identifier in dependencies)) throw new Error('Unexpected import: ' + identifier);
      return dependencies[identifier];
    },
    ...globals,
  });
  return module.exports;
}

class ApiError extends Error {
  constructor(transport) {
    super('request failed');
    this.transport = transport;
  }
}

const time = loadCommonJs(timeSource, {}, { Intl, Date, Object });
const model = loadCommonJs(modelSource, {
  '../../api/client': { ApiError },
  '../../time': time,
  '../../types': {
    protocolForCategory: category => category.endsWith('-VA') ? 'VA' : 'VT',
  },
});

function jobItem(overrides = {}) {
  return {
    id: 4,
    sequence: 1,
    revision: 2,
    status: 'Completed',
    primaryAssetUrl: '/api/media/primary',
    sourceAssetUrl: null,
    gpuSlot: 'GPU0',
    input: {
      category: 'A-VA',
      conflictDirection: null,
      contentScriptId: 10,
      sceneId: 20,
      promptTemplateVersionId: 30,
      age: 25,
      gender: 'Female',
      ethnicity: 'EastAsian',
      seed: 123,
      model: 'LTX-2.5',
      precision: 'INT8',
    },
    ...overrides,
  };
}

test('Results model formats Beijing task names and n/m progress', () => {
  const name = model.resultTaskName('VideoTest', '2026-08-17T06:29:34Z', {
    Production: '正式生成',
    PromptTest: '提示词测试',
    VideoTest: '视频测试',
  });
  assert.equal(name, '视频测试 2026-08-17 14:29:34');
  assert.deepEqual(
    { ...model.completedProgress({ completedCount: 13, failedCount: 2, totalCount: 20 }) },
    { current: 15, total: 20 },
  );
  assert.equal(model.profilesText([
    { model: 'LTX-2.5', precision: 'INT8' },
    { model: 'MiniMax H3', precision: null },
  ]), 'LTX-2.5 INT8, MiniMax H3');
});

test('Results task and output lists use service pages of 20', () => {
  assert.match(paginationSource, /PAGE_SIZE = 20/u);
  assert.match(viewSource, /useTestResultsQuery\(page, filter\)/u);
  assert.match(viewSource, /useProductionResultsQuery\(page, filter\)/u);
  assert.match(viewSource, /useResultItemsQuery\(kind, selectedId, itemPage\)/u);
  assert.match(viewSource, /onPageChange=\{setItemPage\}/u);
  assert.match(querySource, /testResults: \(page: number/u);
  assert.match(querySource, /resultItems: \(kind: 'test' \| 'production', id: number, page: number\)/u);
});

test('Results distinguishes empty, filtered, network, and service failures', () => {
  assert.equal(model.resultListState({ pending: true, error: null, total: 0, statusFiltered: false }), 'loading');
  assert.equal(model.resultListState({ pending: false, error: null, total: 0, statusFiltered: false }), 'empty');
  assert.equal(model.resultListState({ pending: false, error: null, total: 0, statusFiltered: true }), 'filteredEmpty');
  assert.equal(model.resultListState({
    pending: false,
    error: new ApiError('network'),
    total: 0,
    statusFiltered: false,
  }), 'networkError');
  assert.equal(model.resultListState({
    pending: false,
    error: new ApiError('service'),
    total: 0,
    statusFiltered: false,
  }), 'serviceError');
});

test('Results exposes cancel, resume, retry and bounded persistent events', () => {
  assert.deepEqual({ ...model.controlVisibility('Running', 0) }, { cancel: true, resume: false, retry: false });
  assert.deepEqual({ ...model.controlVisibility('Interrupted', 0) }, { cancel: false, resume: true, retry: false });
  assert.deepEqual({ ...model.controlVisibility('Failed', 2) }, { cancel: false, resume: false, retry: true });
  for (const token of [
    'useCancelJobMutation',
    'useResumeJobMutation',
    'useRetryFailedItemsMutation',
    'useJobEventReplay',
    'expectedRevision',
    'itemRevisions',
  ]) assert.match(viewSource, new RegExp(token));
  assert.match(cssSource, /\.generation-event-list \{[\s\S]*max-height: 280px;[\s\S]*overflow: auto;/u);
  assert.match(viewSource, /job\.failureCode \|\| job\.status === 'Failed'/u);
  assert.match(outputSource, /item\.failureCode \|\| item\.status === 'Failed'/u);
});

test('Results assigns VA and VT media roles explicitly', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(model.mediaForItem(jobItem()))), [
    { role: 'vaAudiovisual', src: '/api/media/primary', muted: false },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(model.mediaForItem(jobItem({
    primaryAssetUrl: '/api/media/silent',
    sourceAssetUrl: '/api/media/source',
    input: { ...jobItem().input, category: 'C-VT', conflictDirection: 'Text' },
  })))), [
    { role: 'vtSourceAudio', src: '/api/media/source', muted: false },
    { role: 'vtSilentPrimary', src: '/api/media/silent', muted: true },
  ]);
  assert.match(outputSource, /results\.media\.va/u);
  assert.match(outputSource, /results\.media\.vtSource/u);
  assert.match(outputSource, /results\.media\.vtPrimary/u);
});

test('Results keeps positive and negative prompts separate and readable', () => {
  assert.match(outputSource, /results\.positivePrompt/u);
  assert.match(outputSource, /finalPositivePrompt/u);
  assert.match(outputSource, /results\.negativePrompt/u);
  assert.match(outputSource, /negativePrompt/u);
  assert.match(cssSource, /\.generation-prompt-blocks pre \{[\s\S]*white-space: pre-wrap;[\s\S]*overflow-wrap: anywhere;/u);
});

test('Results puts user output first and keeps task mechanics collapsed', () => {
  const outputIndex = viewSource.indexOf('<section className="generation-result-output"');
  const detailIndex = viewSource.indexOf('<details className="generation-result-technical"');
  assert.equal(outputIndex >= 0 && detailIndex > outputIndex, true);
  const mediaIndex = outputSource.indexOf('<section className="generation-output-media"');
  const technicalIndex = outputSource.indexOf('<details className="generation-output-technical"');
  assert.equal(mediaIndex >= 0 && technicalIndex > mediaIndex, true);
  assert.match(viewSource, /<summary>\{g\('results\.technicalDetails'\)\}<\/summary>/u);
  assert.match(outputSource, /<summary>\{g\('results\.technicalDetails'\)\}<\/summary>/u);
  assert.doesNotMatch(viewSource, /GpuPanel/u);
});

test('completed formal samples enter Review with the exact Results return location', () => {
  assert.match(outputSource, /kind === 'production' && item\.sampleId !== null/u);
  assert.match(outputSource, /\/review\/['"]? \+ item\.sampleId/u);
  assert.match(outputSource, /returnTo=' \+ encodeURIComponent\(returnTo\)/u);
  assert.match(viewSource, /const resultsReturnTo = '\/generate\/results'/u);
  assert.match(viewSource, /returnTo=\{resultsReturnTo\}/u);
});

test('Test handoff copies visible configuration and never promotes assets', () => {
  const detail = {
    source: 'VideoTest',
  };
  const draft = model.buildTestDraft(detail, [jobItem()]);
  assert.equal(draft.kind, 'VideoTest');
  assert.equal(draft.model, 'LTX-2.5');
  assert.equal(draft.precision, 'INT8');
  assert.equal('datasetId' in draft, false);
  assert.equal('assetId' in draft, false);
  assert.equal('media' in draft, false);
  assert.equal(JSON.stringify(draft.comparisons), JSON.stringify([{ model: 'LTX-2.5', precision: 'INT8', gpuSlot: 'GPU0' }]));
  const promptDraft = model.buildTestDraft({ source: 'PromptTest' }, [jobItem()]);
  assert.equal(JSON.stringify(promptDraft.comparisons), '[]');
  assert.match(viewSource, /writeSessionDraft\(testCopyDraftKey, testDraft\)/u);
  const combined = viewSource + outputSource + modelSource;
  assert.doesNotMatch(combined, /promote|promotion|keepAsSample|reuseAsset|datasetId/u);
});

test('Results uses complete task cards without horizontal scrolling through 1100 pixels', () => {
  assert.match(viewSource, /className="generation-results-cards"/u);
  for (const key of ['results.taskType', 'results.status', 'results.progress', 'results.model', 'results.failure', 'results.updated', 'results.kind', 'common.view']) {
    assert.match(viewSource, new RegExp(key.replace('.', '\\.')));
  }
  assert.match(cssSource, /@media \(max-width: 1100px\) \{[\s\S]*?\.generation-results-list \.table-shell \{ display: none; \}[\s\S]*?\.generation-results-cards \{[\s\S]*?display: grid;/u);
  assert.match(cssSource, /\.generation-results-cards \.button \{ width: 100%; \}/u);
});
