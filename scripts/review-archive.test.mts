import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHIVE_PAGE_SIZE,
  applyConflictDirectionChange,
  archiveFileName,
  archiveJsonl,
  archiveReturnTarget,
  pageCount,
  pageItems,
  reviewLocation,
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

test('keeps the archive page and filters in the review return target', () => {
  const returnTo = '/archive?dataset=dataset-main&category=C-VA&page=3';
  const location = reviewLocation('CS-0008', returnTo);
  const params = new URL(location, 'https://conflictstudio.local').searchParams;
  assert.equal(params.get('sample'), 'CS-0008');
  assert.equal(archiveReturnTarget(params.get('returnTo')), returnTo);
  assert.equal(archiveReturnTarget('/workspace'), null);
});

test('exports stable delivery fields without internal ids or embedded media', () => {
  const sample = {
    displayId: 'CS-0101', datasetId: 'dataset-main', category: 'C-VT', conflictDirection: 'Text',
    trueEmotion: 'sadness', apparentEmotion: 'neutral', trueEmotionDescription: 'The text carries the intended emotion.',
    dialogue: null, displayText: 'I am not doing well.', videoPrompt: 'Stable camera.', negativePrompt: 'No subtitles.',
    contentPlanName: 'Quiet denial', model: 'LTX-2.3', seed: 42, age: 35, gender: 'Female', ethnicity: 'EastAsian',
    primaryAssetId: 'asset-video-0101', sourceAssetId: 'asset-source-0101', thumbnailAssetId: 'asset-thumb-0101',
    updatedAt: '2026-08-11T08:00:00.000Z',
  } as Sample;
  const line = archiveJsonl('正式生成集', [sample]).trim();
  const record = JSON.parse(line);

  assert.equal(record.sample_id, 'CS-0101');
  assert.equal(record.dataset_name, '正式生成集');
  assert.equal(record.media.primary_asset_id, sample.primaryAssetId);
  assert.equal(record.sample_id.includes('archive-sample'), false);
  assert.equal(line.includes('data:video'), false);
  assert.equal(line.includes('dataset-main'), false);
  assert.equal(line.includes('Accepted'), false);
  assert.equal(line.includes('Aligned'), false);
  assert.equal(archiveFileName('正式生成集'), '正式生成集.jsonl');
});
