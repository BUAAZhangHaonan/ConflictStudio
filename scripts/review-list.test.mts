import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import {
  buildReviewListLocation,
  currentPageSelection,
  readReviewListLocation,
  restoreReviewListState,
  reviewDetailLocation,
  safeReviewListReturnTarget,
  saveReviewListState,
} from '../frontend/src/reviewArchive.ts';

const require = createRequire(import.meta.url);
const ts = require('../frontend/node_modules/typescript');
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const contractSource = read('../frontend/src/api/contracts.ts');
const querySource = read('../frontend/src/api/queries.ts');
const clientSource = read('../frontend/src/api/client.ts');
const pageSource = read('../frontend/src/pages/ReviewListPage.tsx');
const workspaceSource = read('../frontend/src/pages/WorkspacePage.tsx');
const backendRouteSource = read('../backend/api/routes.py');
const paginationSource = read('../backend/services/pagination.py');
const contractFile = ts.createSourceFile('contracts.ts', contractSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function interfaceDeclaration(name: string) {
  return contractFile.statements.find((node: any) => ts.isInterfaceDeclaration(node) && node.name.text === name);
}

function interfaceBody(name: string): string {
  const declaration = interfaceDeclaration(name);
  return declaration?.members.map((member: any) => member.getText(contractFile)).join('\n') ?? '';
}

function loadClient(fetchMock: () => Promise<unknown>) {
  const output = ts.transpileModule(clientSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    fetch: fetchMock,
    URLSearchParams,
    window: { location: { protocol: 'https:', host: 'example.test' } },
  });
  return module.exports as {
    apiRequest: (path: string, init?: RequestInit) => Promise<unknown>;
    apiErrorMessage: (error: unknown, locale: 'zh-CN' | 'en-US') => string;
  };
}

function loadQueries() {
  const output = ts.transpileModule(querySource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const noop = () => undefined;
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier: string) => {
      if (specifier === './client') return { apiRequest: noop };
      if (specifier === '@tanstack/react-query') {
        return { queryOptions: (value: unknown) => value, useMutation: noop, useQuery: noop, useQueryClient: noop };
      }
      throw new Error(`Unexpected query dependency: ${specifier}`);
    },
    URLSearchParams,
  });
  return module.exports as {
    reviewSampleListPath: (input: ReturnType<typeof readReviewListLocation>) => string;
  };
}

class MemoryStorage {
  value: string | null = null;
  getItem(): string | null { return this.value; }
  setItem(_key: string, value: string): void { this.value = value; }
}

test('new review contracts match the list and detail backend slice without generation internals', () => {
  for (const name of [
    'ReviewQueue',
    'ReviewMediaRead',
    'ReviewResultRead',
    'ReviewSampleListRead',
    'ReviewSampleDetailRead',
    'ReviewNoteDraftRead',
    'ReviewNoteDraftUpdate',
    'ReviewSampleReferenceRead',
    'ReviewSubmissionRead',
    'ReviewSubmissionCreate',
    'ReviewBatchItemCreate',
    'ReviewBatchSubmissionCreate',
    'SampleClassificationConversionUpdate',
  ]) assert.ok(interfaceDeclaration(name), name);

  const listAndDetail = `${interfaceBody('ReviewSampleListRead')}\n${interfaceBody('ReviewSampleDetailRead')}`;
  assert.doesNotMatch(listAndDetail, /seed|prompt|attempt|gpu|vlm/iu);
  assert.match(interfaceBody('ReviewSubmissionCreate'), /queue: ReviewQueue;/u);
  assert.match(interfaceBody('ReviewMutationRequest'), /expectedNoteDraftRevision: number;/u);
  assert.doesNotMatch(interfaceBody('ReviewBatchItemCreate'), /queue:/u);
  assert.match(interfaceBody('SampleClassificationConversionUpdate'), /reviewerId: number;/u);
  assert.match(interfaceBody('ReviewSubmissionRead'), /nextReference: ReviewSampleReferenceRead \| null;/u);
});

test('every sample list consumer uses the current review list contract', () => {
  assert.equal(interfaceDeclaration('Sample'), undefined);
  assert.doesNotMatch(contractSource, /export interface Review \{/u);
  assert.doesNotMatch(
    querySource,
    /Page<Sample>|filter\.category|category\?: Category/u,
  );
  assert.match(
    querySource,
    /apiRequest<Page<ReviewSampleListRead>>\(reviewSampleListPath\(params\)\)/u,
  );
  assert.match(
    querySource,
    /samples: \(filter: SampleQueryFilter, page: number\)[\s\S]*?apiRequest<Page<ReviewSampleListRead>>\(pagePath\('\/api\/samples', page, params\)\)/u,
  );
  assert.equal((workspaceSource.match(/useSamplesQuery\(\{/gu) ?? []).length, 2);
  assert.match(workspaceSource, /decision: 'Pending'/u);
  assert.match(workspaceSource, /decision: 'Accepted'/u);
  assert.match(workspaceSource, /const pendingReview = pendingReviewQuery\.data\?\.total \?\? 0;/u);
  assert.match(workspaceSource, /const pendingArchive = pendingArchiveQuery\.data\?\.total \?\? 0;/u);
  assert.doesNotMatch(workspaceSource, /pending(?:Review|Archive)Query\.data\?\.items/u);
});

test('new review API helpers are separate and use the current endpoints and revision fields', () => {
  const sampleListRoute = backendRouteSource.match(/@router\.get\("\/samples"[\s\S]*?(?=\n\n@router\.get\("\/samples\/\{sample_id\}"[^\n]*)/u)?.[0] ?? '';
  for (const helper of [
    'reviewSampleQueries',
    'useReviewSampleListQuery',
    'useReviewSampleDetailQuery',
    'useReviewNoteDraftQuery',
    'usePutReviewNoteDraftMutation',
    'useSubmitReviewMutation',
    'useSubmitReviewBatchMutation',
    'useConvertSampleClassificationMutation',
  ]) assert.match(querySource, new RegExp(`\\b${helper}\\b`, 'u'));

  for (const field of ['search', 'datasetId', 'decision', 'protocol', 'relation', 'direction', 'page']) {
    assert.match(querySource, new RegExp(`params\\.set\\('${field}'`, 'u'), field);
  }
  assert.doesNotMatch(querySource, /params\.set\('pageSize'|pageSize: typeof/u);
  assert.notEqual(sampleListRoute, '');
  assert.match(sampleListRoute, /dataset_id:[\s\S]*alias="datasetId"/u);
  assert.match(sampleListRoute, /page: int = Query\(default=1, ge=1\)/u);
  assert.doesNotMatch(sampleListRoute, /page_?size|pageSize/iu);
  assert.match(paginationSource, /^PAGE_SIZE = 20$/mu);
  assert.match(paginationSource, /\.limit\(PAGE_SIZE\)[\s\S]*page_size=PAGE_SIZE/u);
  assert.match(querySource, /method: 'GET'|queryFn:/u);
  assert.match(querySource, /review-note-draft[\s\S]*method: 'PUT'/u);
  assert.match(querySource, /api\/reviews'[\s\S]*method: 'POST'/u);
  assert.match(querySource, /api\/reviews\/batch'[\s\S]*method: 'POST'/u);
  assert.match(querySource, /classification`[\s\S]*method: 'PATCH'/u);
  assert.match(querySource, /reviewSamplesPage[\s\S]*reviewSampleDetail[\s\S]*reviewNoteDraft/u);
});

test('review conflict messages are short, localized and hide backend details', async () => {
  for (const [code, english, chinese] of [
    ['review_revision_conflict', 'This review changed. Reload it and try again.', '审核结果已更新。请重新加载后再试。'],
    ['note_draft_revision_conflict', 'This note changed. Reload it and try again.', '备注已更新。请重新加载后再试。'],
  ]) {
    const client = loadClient(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code, message: 'raw internal exception', details: { endpoint: '/api/private' } } }),
    }));
    await assert.rejects(
      () => client.apiRequest('/api/reviews', { method: 'POST', body: '{}' }),
      error => {
        assert.equal(client.apiErrorMessage(error, 'en-US'), english);
        assert.equal(client.apiErrorMessage(error, 'zh-CN'), chinese);
        assert.doesNotMatch((error as Error).message, /raw internal|\/api|exception/iu);
        assert.doesNotMatch(`${english}${chinese}`, /conflict|endpoint|exception|\/api|review_revision|note_draft/iu);
        return true;
      },
    );
  }
});

test('review list URLs retain every filter and fixed twenty row pagination', () => {
  const state = {
    search: '  CS 21  ',
    datasetId: 7,
    decision: 'Rejected' as const,
    protocol: 'VT' as const,
    relation: 'Conflict' as const,
    direction: 'Text' as const,
    page: 3,
  };
  const location = buildReviewListLocation(state);
  assert.equal(location, '/review?search=CS+21&datasetId=7&decision=Rejected&protocol=VT&relation=Conflict&direction=Text&page=3');
  const locationState = readReviewListLocation(location);
  assert.deepEqual(locationState, { ...state, search: 'CS 21' });
  assert.equal(
    loadQueries().reviewSampleListPath(locationState),
    '/api/samples?search=CS+21&datasetId=7&decision=Rejected&protocol=VT&relation=Conflict&direction=Text&page=3',
  );
  const invalidLocation = `/review?${new URLSearchParams({ page: '0', datasetId: 'nope', decision: 'Unknown', search: 'x'.repeat(161) })}`;
  assert.deepEqual(readReviewListLocation(invalidLocation), {
    search: null,
    datasetId: null,
    decision: 'All',
    protocol: null,
    relation: null,
    direction: null,
    page: 1,
  });
  assert.match(contractSource, /export interface Page<T> \{[\s\S]*?pageSize: 20;/u);
  assert.match(pageSource, /useReviewSampleListQuery\(\{[\s\S]*?page: locationState\.page,[\s\S]*?\}\)/u);
  assert.doesNotMatch(pageSource, /pageSize/u);
});

test('review return state accepts only the list path and restores exact page and scroll', () => {
  assert.equal(safeReviewListReturnTarget('/review?decision=Pending&page=2'), '/review?decision=Pending&page=2');
  assert.equal(safeReviewListReturnTarget('/review/21?returnTo=/review'), null);
  assert.equal(safeReviewListReturnTarget('/review-evil?page=2'), null);
  assert.equal(safeReviewListReturnTarget('//conflictstudio.local/review?page=2'), null);
  assert.equal(safeReviewListReturnTarget('https://example.com/review?page=2'), null);
  assert.equal(reviewDetailLocation(21), '/review/21');

  const storage = new MemoryStorage();
  const saved = { returnTo: '/review?decision=Pending&page=2', page: 2, scrollY: 684 };
  assert.equal(saveReviewListState(saved, storage), true);
  assert.deepEqual(restoreReviewListState(saved.returnTo, storage), saved);
  assert.equal(restoreReviewListState('/review?decision=Pending&page=3', storage), null);
  assert.equal(saveReviewListState({ ...saved, page: 3 }, storage), false);
  assert.match(pageSource, /if \(!listQuery\.isSuccess \|\| restoredLocationRef\.current === returnTo\) return;/u);
  assert.match(pageSource, /window\.scrollTo\(\{ top: saved\.scrollY, left: 0, behavior: 'auto' \}\)/u);
  assert.match(read('../frontend/src/pages/ReviewDetailPage.tsx'), /useLayoutEffect\(\(\) => \{[\s\S]*window\.scrollTo\(\{ top: 0, left: 0, behavior: 'auto' \}\)[\s\S]*\}, \[sampleId\]\)/u);
});

test('selection stays on the current page and read only mode keeps detail browsing available', () => {
  assert.deepEqual([...currentPageSelection(new Set([1, 2, 21]), [21, 22])], [21]);
  assert.match(pageSource, /locationState\.page,[\s\S]*\]\);/u);
  assert.match(pageSource, /const canReview = preferences\.currentReviewerId !== null;/u);
  assert.equal((pageSource.match(/if \(!canReview\) return;/gu) ?? []).length, 2);
  assert.match(pageSource, /if \(preferences\.currentReviewerId === null \|\| selectedSamples\.length === 0\) return;/u);
  assert.equal((pageSource.match(/disabled=\{!canReview\}/gu) ?? []).length >= 3, true);
  assert.match(pageSource, /disabled=\{!canReview \|\| selectedSamples\.length === 0\}/u);
  assert.match(pageSource, /saveReviewListState\([\s\S]*navigate\(reviewDetailLocation\(sample\.id\)\)/u);
  assert.doesNotMatch(pageSource, /if \(!canReview\) return;[\s\S]{0,120}reviewDetailLocation/u);
});

test('list rows use only the ten approved visible data fields and batch confirmation has no notes', () => {
  const allowlist = pageSource.match(/REVIEW_LIST_VISIBLE_FIELDS = \[([\s\S]*?)\] as const;/u)?.[1] ?? '';
  const allowlistFields = [...allowlist.matchAll(/'([^']+)'/gu)].map(match => match[1]);
  assert.deepEqual(allowlistFields, [
    'displayId',
    'primaryMedia',
    'datasetName',
    'relation',
    'protocol',
    'trueEmotion',
    'apparentEmotion',
    'conflictDirection',
    'gender',
    'reviewDecision',
  ]);
  assert.equal((pageSource.match(/REVIEW_LIST_VISIBLE_FIELDS\[/gu) ?? []).length, 10);
  const row = pageSource.match(/<tr key=\{sample\.id\}[\s\S]*?<\/tr>/u)?.[0] ?? '';
  assert.notEqual(row, '');
  const rowFields = [...new Set([...row.matchAll(/sample\.([A-Za-z][A-Za-z0-9]*)/gu)].map(match => match[1]).filter(field => field !== 'id'))];
  assert.deepEqual(rowFields, allowlistFields);
  assert.doesNotMatch(allowlist, /seed|prompt|attempt|gpu|vlm|revision|archive|model/iu);
  const confirmation = pageSource.match(/<ConfirmDialog([\s\S]*?)\/>/u)?.[1] ?? '';
  assert.notEqual(confirmation, '');
  assert.doesNotMatch(confirmation, /note/iu);
  assert.match(confirmation, /selectedSamples\.length/u);
  assert.match(confirmation, /batchConfirmConsequence/u);
});

test('list localizes emotion values and fits the desktop content width', () => {
  const css = readFileSync(new URL('../frontend/src/pages/ReviewListPage.css', import.meta.url), 'utf8');
  const locales = readFileSync(new URL('../frontend/src/locales/features/reviewArchive.ts', import.meta.url), 'utf8');
  assert.match(pageSource, /emotionLabel\(sample\.trueEmotion\)/u);
  assert.match(pageSource, /emotionLabel\(sample\.apparentEmotion\)/u);
  assert.match(locales, /contentment: '满足'/u);
  assert.match(locales, /sadness: '悲伤'/u);
  assert.match(css, /table-layout: fixed/u);
  assert.match(css, /\.review-list__results \.table-shell \{ overflow: visible; \}/u);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*overflow-x: auto/u);
  assert.doesNotMatch(css, /min-width: 1240px/u);
});

test('review emotions use the locale namespace and never expose raw values or keys', () => {
  const localeSource = read('../frontend/src/locales/features/reviewArchive.ts');
  const enSource = read('../frontend/src/locales/en-US.ts');
  const zhSource = read('../frontend/src/locales/zh-CN.ts');
  assert.match(enSource, /emotion: reviewArchiveEnUS\.emotion/u);
  assert.match(zhSource, /emotion: reviewArchiveZhCN\.emotion/u);
  for (const value of ['contentment', 'sadness', 'joy', 'anger', 'fear', 'surprise']) {
    assert.match(localeSource, new RegExp(value + ':'));
  }
  assert.match(pageSource, /i18n\.exists\(key\) \? t\(key\) : t\('review\.list\.emotionNotProvided'\)/u);
  assert.equal(pageSource.includes('<td className="review-list__emotion">{t(`emotion.'), false);
});

test('review list uses a named dataset select and complete cards at 600 pixels', () => {
  const css = read('../frontend/src/pages/ReviewListPage.css');
  assert.match(pageSource, /useDatasetsQuery\(1\)/u);
  assert.match(pageSource, /<select[\s\S]*id="review-list-dataset"[\s\S]*disabled=\{datasets\.length === 0\}[\s\S]*datasets\.map\(dataset/u);
  assert.doesNotMatch(pageSource, /type="number"[\s\S]{0,180}review-list-dataset/u);
  for (const field of ['displayId', 'primaryMedia', 'datasetName', 'relation', 'protocol', 'trueEmotion', 'apparentEmotion', 'conflictDirection', 'gender', 'reviewDecision']) {
    assert.match(pageSource, new RegExp(`sample\\.${field}`));
  }
  assert.match(pageSource, /className="review-list__cards"/u);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.review-list__results \.table-shell \{ display: none; \}[\s\S]*\.review-list__cards \{[\s\S]*display: grid/u);
});
