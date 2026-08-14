import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHIVE_PAGE_SIZE,
  applyConflictDirectionChange,
  archiveFileName,
  archiveJsonl,
  pageCount,
  pageItems,
  reviewLocation,
  safeReviewReturnTarget,
} from '../frontend/src/reviewArchive.ts';
import type { Sample } from '../frontend/src/types.ts';

test('changing the true emotion modality invalidates review without changing media', () => {
  const sample = {
    conflictDirection: 'Audio',
    reviewDecision: 'Accepted',
    reviewRevision: 3,
    archiveStatus: 'Current',
    revision: 7,
    updatedAt: '2026-08-10T00:00:00.000Z',
    primaryAssetId: 'asset-primary',
  } as Sample;

  const result = applyConflictDirectionChange(sample, 'Vision', '2026-08-11T00:00:00.000Z');

  assert.equal(result.conflictDirection, 'Vision');
  assert.equal(result.reviewDecision, 'Pending');
  assert.equal(result.revision, 8);
  assert.equal(result.reviewRevision, 4);
  assert.equal(result.archiveStatus, 'NeedsUpdate');
  assert.equal(result.primaryAssetId, 'asset-primary');
});

test('uses fixed pages of twenty archive rows', () => {
  const rows = Array.from({ length: 45 }, (_, index) => index + 1);
  assert.equal(ARCHIVE_PAGE_SIZE, 20);
  assert.equal(pageCount(rows.length), 3);
  assert.deepEqual(pageItems(rows, 2), rows.slice(20, 40));
  assert.deepEqual(pageItems(rows, 9), rows.slice(40, 45));
});

test('keeps safe application pages and filters in the review return target', () => {
  const returnTo = '/archive?dataset=dataset-main&category=C-VA&page=3';
  const location = reviewLocation('CS-000008', returnTo);
  const params = new URL(location, 'https://conflictstudio.local').searchParams;
  assert.equal(params.get('sample'), 'CS-000008');
  assert.equal(safeReviewReturnTarget(params.get('returnTo')), returnTo);
  assert.equal(safeReviewReturnTarget('/workspace?dataset=1#pending'), '/workspace?dataset=1#pending');
});

test('rejects external, protocol-relative, review, and unknown return targets', () => {
  for (const target of [
    'https://example.com/archive',
    '//example.com/archive',
    '/review?sample=CS-000001',
    '/unknown',
    'https://conflictstudio.local.evil.example/archive',
  ]) {
    assert.equal(safeReviewReturnTarget(target), null);
  }
  const location = new URL(reviewLocation('CS-000001', 'https://example.com/archive'), 'https://conflictstudio.local');
  assert.equal(location.searchParams.get('sample'), 'CS-000001');
  assert.equal(location.searchParams.has('returnTo'), false);
});

test('exports stable delivery fields without internal ids or embedded media', () => {
  const sample = {
    displayId: 'CS-0101', datasetId: 'dataset-main', category: 'C-VT', conflictDirection: 'Text',
    trueEmotion: 'sadness', apparentEmotion: 'neutral', trueEmotionDescription: 'The text carries the intended emotion.',
    dialogue: null, displayText: 'I am not doing well.', videoPrompt: 'Stable camera.', negativePrompt: 'No subtitles.',
    contentPlanName: 'Quiet denial', model: 'LTX-2.3', seed: 42, age: 35, gender: 'Female', ethnicity: 'EastAsian',
    generationRecord: { id: 'attempt-101', model: 'LTX-2.3', precision: null, gpu: 'GPU0', seed: 42 },
    primaryAssetId: 'asset-video-0101', sourceAssetId: 'asset-source-0101', thumbnailAssetId: 'asset-thumb-0101',
    updatedAt: '2026-08-11T08:00:00.000Z',
  } as Sample;
  const line = archiveJsonl('正式生成集', [sample]).trim();
  const record = JSON.parse(line);

  assert.equal(record.sample_id, 'CS-0101');
  assert.equal(record.dataset_name, '正式生成集');
  assert.equal(record.media.primary_asset_id, sample.primaryAssetId);
  assert.equal(record.model, 'LTX-2.3');
  assert.equal('source_asset_id' in record.media, false);
  assert.equal('thumbnail_asset_id' in record.media, false);
  assert.equal(record.sample_id.includes('archive-sample'), false);
  assert.equal(line.includes('data:video'), false);
  assert.equal(line.includes('dataset-main'), false);
  assert.equal(line.includes('Accepted'), false);
  assert.equal(line.includes('Aligned'), false);
  const containsPrecision = (value: unknown): boolean => value !== null && typeof value === 'object'
    && Object.entries(value).some(([key, child]) => key === 'precision' || containsPrecision(child));
  assert.equal(containsPrecision(record), false);
  assert.equal(archiveFileName('正式生成集'), '正式生成集.jsonl');
});

test('rejects an archive manifest row without a model', () => {
  const sample = {
    displayId: 'CS-0102',
    category: 'A-VA',
    model: '',
  } as Sample;

  assert.throws(() => archiveJsonl('Formal', [sample]), /has no model/u);
});
