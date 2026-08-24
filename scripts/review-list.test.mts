import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildReviewListLocation,
  currentPageSelection,
  readReviewListLocation,
  restoreReviewListState,
  reviewDetailLocation,
  safeReviewListReturnTarget,
  saveReviewListState,
} from '../frontend/src/reviewArchive.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const contracts = read('../frontend/src/api/contracts.ts');
const queries = read('../frontend/src/api/queries.ts');
const page = read('../frontend/src/pages/ReviewListPage.tsx');
const css = read('../frontend/src/pages/ReviewListPage.css');
const app = read('../frontend/src/app/App.tsx');
const gate = read('../frontend/src/app/ReviewGate.tsx');

class MemoryStorage {
  value: string | null = null;
  getItem(): string | null { return this.value; }
  setItem(_key: string, value: string): void { this.value = value; }
}

test('review routes resolve the stored reviewer identity and allow guest browsing', () => {
  assert.match(app, /<Route element=\{<ReviewGate \/>\}>[\s\S]*path="\/review"[\s\S]*path="\/review\/:sampleId"/u);
  assert.match(gate, /const \{ currentReviewer, isPending, error, retry \} = useReviewerState\(\)/u);
  assert.match(gate, /reviewer: Reviewer \| null/u);
  assert.match(gate, /<Outlet context=\{\{ reviewer: currentReviewer \}/u);
  assert.match(gate, /review\.gate\.guestBody/u);
  assert.match(gate, /<Link to="\/settings">/u);
  assert.match(page, /const reviewer = useReviewGateReviewer\(\)/u);
  assert.match(page, /const reviewerId = reviewer\?\.id \?\? null/u);
  assert.doesNotMatch(`${app}\n${gate}\n${page}`, /FirstReviewerDialog|continueReadOnly|readOnlyHint|canReview/u);
  assert.doesNotMatch(gate, /FIXED_REVIEWER_NAME|useReviewerByNameQuery|zhanghaonan/u);
  assert.doesNotMatch(gate, /reviewers\.map|type="radio"|maxLength/u);
});

test('dataset filter loads every server page into one selectable collection', () => {
  assert.match(page, /const datasetsQuery = useAllDatasetsQuery\(\)/u);
  assert.match(page, /const datasets = datasetsQuery\.data \?\? \[\]/u);
  assert.match(queries, /async function allPageItems<T>[\s\S]*first\.totalPages - 1[\s\S]*pagePath\(path, index \+ 2\)/u);
  assert.match(queries, /allDatasets: \(\) => queryOptions\([\s\S]*allPageItems<Dataset>\('\/api\/datasets'\)/u);
  assert.match(queries, /export function useAllDatasetsQuery\(\)/u);
});

test('review URLs preserve all filters and pass an explicit safe return address', () => {
  const state = {
    search: '  CS 21  ', datasetId: 7, decision: 'Rejected' as const,
    protocol: 'VT' as const, relation: 'Conflict' as const, direction: 'Text' as const, page: 3,
  };
  const location = buildReviewListLocation(state);
  assert.equal(location, '/review?search=CS+21&datasetId=7&decision=Rejected&protocol=VT&relation=Conflict&direction=Text&page=3');
  assert.deepEqual(readReviewListLocation(location), { ...state, search: 'CS 21' });
  assert.equal(safeReviewListReturnTarget(location), location);
  assert.equal(reviewDetailLocation(21, location), `/review/21?${new URLSearchParams({ returnTo: location }).toString()}`);
  assert.match(page, /navigate\(reviewDetailLocation\(sample\.id, returnTo\)\)/u);
});

test('list scroll restoration is tied to the exact filter and page URL', () => {
  const storage = new MemoryStorage();
  const returnTo = '/review?decision=Pending&page=2';
  assert.equal(saveReviewListState({ returnTo, page: 2, scrollY: 684 }, storage), true);
  assert.deepEqual(restoreReviewListState(returnTo, storage), { returnTo, page: 2, scrollY: 684 });
  assert.equal(restoreReviewListState('/review?decision=Pending&page=3', storage), null);
  assert.match(page, /window\.scrollTo\(\{ top: saved\.scrollY, left: 0, behavior: 'auto' \}\)/u);
  assert.match(page, /page: locationState\.page, scrollY: window\.scrollY/u);
});

test('batch review fetches every selected note draft before opening confirmation', () => {
  assert.match(page, /Promise\.all\(selectedSamples\.map\(sample => \([\s\S]*queryClient\.fetchQuery\(reviewSampleQueries\.note\(sample\.id, reviewerId, sample\.revision\)\)/u);
  assert.match(page, /if \(reviewerId === null \|\| selectedSamples\.length === 0 \|\| acceptedBlockedCount > 0\) return/u);
  const batchPayload = page.slice(page.indexOf('setBatchItems('), page.indexOf('setBatchConfirmOpen(true)'));
  assert.match(batchPayload, /expectedRevision: sample\.revision/u);
  assert.doesNotMatch(batchPayload, /expectedSampleRevision/u);
  assert.match(page, /expectedReviewRevision: sample\.reviewRevision/u);
  assert.match(page, /expectedNoteDraftRevision: drafts\[index\]\.revision/u);
  assert.match(page, /setBatchItems\([\s\S]*setBatchConfirmOpen\(true\)/u);
  assert.doesNotMatch(page, /expectedNoteDraftRevision: 0/u);
  assert.match(contracts, /decision: ReviewDecision;/u);
  const reviewMutation = /export interface ReviewMutationRequest \{([\s\S]*?)\n\}/u.exec(contracts)?.[1] ?? '';
  assert.match(reviewMutation, /expectedRevision: number;/u);
  assert.doesNotMatch(reviewMutation, /expectedSampleRevision/u);
  assert.match(contracts, /ReviewBatchItemCreate extends Omit<ReviewMutationRequest, 'decision'>[\s\S]*decision: Exclude<ReviewDecision, 'Pending'>;/u);
});

test('batch decisions stay accept or reject and block incompatible acceptance', () => {
  assert.match(page, /useState<Exclude<ReviewDecision, 'Pending'>>\('Accepted'\)/u);
  assert.equal((page.match(/<option value="Accepted">/gu) ?? []).length >= 1, true);
  assert.equal((page.match(/<option value="Rejected">/gu) ?? []).length >= 1, true);
  const batchSelect = page.slice(page.indexOf('id="review-list-batch-decision"'), page.indexOf('</select>', page.indexOf('id="review-list-batch-decision"')));
  assert.doesNotMatch(batchSelect, /<option value="Pending">/u);
  assert.match(page, /sample\.generationCompatibility === 'NeedsRegeneration'/u);
  assert.match(page, /disabled=\{selectedSamples\.length === 0 \|\| acceptedBlockedCount > 0\}/u);
});

test('list selection never leaks across pages', () => {
  assert.deepEqual([...currentPageSelection(new Set([1, 2, 21]), [21, 22])], [21]);
  assert.match(page, /setSelectedIds\(new Set\(\)\);[\s\S]*locationState\.page/u);
});

test('desktop filters collapse and media stays inside naturally sized table rows', () => {
  assert.match(page, /<details className="panel review-list__filters">/u);
  assert.doesNotMatch(page, /<details className="panel review-list__filters" open/u);
  assert.match(page, /activeFilterCount/u);
  assert.match(page, /t\('review\.list\.typeValue', \{ relation: relationCode\(sample\.relation\), protocol: protocolCode\(sample\.protocol\) \}\)/u);
  assert.match(page, /emotionLabel\(sample\.trueEmotion\)[\s\S]*emotionLabel\(sample\.apparentEmotion\)/u);
  assert.equal((page.match(/\{ key:/gu) ?? []).length, 7);
  assert.match(css, /table-layout: fixed/u);
  const sampleCellRule = /\.review-list__sample-cell \{([^}]*)\}/u.exec(css)?.[1] ?? '';
  assert.doesNotMatch(sampleCellRule, /display:\s*grid/u);
  assert.match(css, /\.review-list__sample-cell \.table-link \{ display: block; \}/u);
  assert.match(css, /\.review-list__sample-cell video \{[\s\S]*width: 112px;[\s\S]*height: 63px;[\s\S]*object-fit: contain/u);
});

test('390 pixel cards keep media contained without horizontal overflow', () => {
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.review-list__results \.table-shell \{ display: none; \}[\s\S]*\.review-list__cards \{[\s\S]*display: grid/u);
  assert.match(css, /\.review-list__cards video \{[\s\S]*width: 100%;[\s\S]*object-fit: contain/u);
  assert.match(queries, /reviewSampleQueries/u);
});
