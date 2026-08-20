import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHIVE_PAGE_SIZE,
  buildArchiveLocation,
  buildReviewListLocation,
  clampPage,
  pageItems,
  readReviewListLocation,
  restoreReviewListState,
  reviewDetailLocation,
  safeReviewListReturnTarget,
  safeReviewReturnTarget,
  saveReviewListState,
} from '../frontend/src/reviewArchive.ts';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test('archive links open the detail route and preserve a safe return address', () => {
  const location = buildArchiveLocation({ datasetId: 4, search: 'CS-000021', category: 'C-VT', page: 2 });
  assert.equal(location, '/archive?dataset=4&search=CS-000021&category=C-VT&page=2');
  assert.equal(
    reviewDetailLocation(21, location),
    '/review/21?returnTo=%2Farchive%3Fdataset%3D4%26search%3DCS-000021%26category%3DC-VT%26page%3D2',
  );
  assert.equal(safeReviewReturnTarget(location), location);
});

test('unsafe return targets never enter a detail link', () => {
  assert.equal(safeReviewReturnTarget('https://example.com/archive'), null);
  assert.equal(safeReviewReturnTarget('/not-allowed'), null);
  assert.equal(reviewDetailLocation(21, 'https://example.com/archive'), '/review/21');
});

test('review list location keeps filters and page without a sample query parameter', () => {
  const location = buildReviewListLocation({
    search: 'CS-000021',
    datasetId: 4,
    decision: 'Pending',
    protocol: 'VT',
    relation: 'Conflict',
    direction: 'Text',
    page: 3,
  });
  assert.equal(location, '/review?search=CS-000021&datasetId=4&decision=Pending&protocol=VT&relation=Conflict&direction=Text&page=3');
  assert.equal(readReviewListLocation(location).page, 3);
  assert.equal(new URL(location, 'https://conflictstudio.local').searchParams.has('sampleId'), false);
  assert.equal(safeReviewListReturnTarget(location), location);
});

test('review list state restores the exact URL, page and scroll position', () => {
  const stateStorage = storage();
  const returnTo = '/review?decision=Pending&page=2';
  assert.equal(saveReviewListState({ returnTo, page: 2, scrollY: 480 }, stateStorage), true);
  assert.deepEqual(restoreReviewListState(returnTo, stateStorage), { returnTo, page: 2, scrollY: 480 });
  assert.equal(restoreReviewListState('/review?page=1', stateStorage), null);
});

test('archive pagination always uses twenty rows and clamps invalid pages', () => {
  const values = Array.from({ length: 45 }, (_, index) => index + 1);
  assert.equal(ARCHIVE_PAGE_SIZE, 20);
  assert.deepEqual(pageItems(values, 2), values.slice(20, 40));
  assert.equal(clampPage(0, values.length), 1);
  assert.equal(clampPage(9, values.length), 3);
});
