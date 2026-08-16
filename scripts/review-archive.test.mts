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
import {
  buildCorrectedSampleBatchPrefill,
  readCorrectedSampleBatchPrefill,
} from '../frontend/src/generationPrefill.ts';

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

test('CS-000002 regeneration keeps content 22 and scene 22 in the unsaved prefill', () => {
  const prefill = buildCorrectedSampleBatchPrefill({
    displayId: 'CS-000002',
    category: 'A-VA',
    conflictDirection: null,
    promptTemplateVersionId: 7,
    generationRecord: { model: 'LTX-2.5', precision: 'BF16' },
    age: 25,
    gender: 'Female',
    ethnicity: 'EastAsian',
  }, {
    id: 22,
    nameZh: '随意邀请',
    nameEn: 'Casual invitation',
    revision: 4,
    mode: 'Fixed',
  }, {
    id: 22,
    nameZh: '明亮客厅',
    nameEn: 'Bright living room',
    revision: 3,
  });

  assert.equal(prefill.sourceDisplayId, 'CS-000002');
  assert.deepEqual(prefill.contentScript, {
    id: 22,
    nameZh: '随意邀请',
    nameEn: 'Casual invitation',
    revision: 4,
    mode: 'Fixed',
  });
  assert.deepEqual(prefill.scene, {
    id: 22,
    nameZh: '明亮客厅',
    nameEn: 'Bright living room',
    revision: 3,
  });
  assert.deepEqual(readCorrectedSampleBatchPrefill({ correctedSampleBatch: prefill }), prefill);
});
