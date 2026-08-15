import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHIVE_PAGE_SIZE,
  buildArchiveLocation,
  clampPage,
  pageItems,
  reviewLocation,
  safeReviewReturnTarget,
} from '../frontend/src/reviewArchive.ts';

test('archive locations are canonical and retain active filters and page', () => {
  const location = buildArchiveLocation({ datasetId: 4, search: 'CS-000021', category: 'C-VT', page: 2 });
  assert.equal(location, '/archive?dataset=4&search=CS-000021&category=C-VT&page=2');
  assert.equal(reviewLocation(21, location), '/review?sampleId=21&returnTo=%2Farchive%3Fdataset%3D4%26search%3DCS-000021%26category%3DC-VT%26page%3D2');
  assert.equal(safeReviewReturnTarget(location), location);
});

test('unsafe return targets are rejected', () => {
  assert.equal(safeReviewReturnTarget('https://example.com/archive'), null);
  assert.equal(safeReviewReturnTarget('/not-allowed'), null);
  assert.equal(safeReviewReturnTarget('/archive?dataset=1&page=2'), '/archive?dataset=1&page=2');
});

test('archive pagination always uses twenty rows and clamps invalid pages', () => {
  const values = Array.from({ length: 45 }, (_, index) => index + 1);
  assert.equal(ARCHIVE_PAGE_SIZE, 20);
  assert.deepEqual(pageItems(values, 2), values.slice(20, 40));
  assert.equal(clampPage(0, values.length), 1);
  assert.equal(clampPage(9, values.length), 3);
});
