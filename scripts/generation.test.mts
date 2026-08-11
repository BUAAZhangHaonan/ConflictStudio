import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildJobItems,
  composeVideoGenerationInput,
  contentIsReferenced,
  createBatchAllocationSnapshot,
  jobProgress,
  selectInitialBatchDraft,
  validateBatchGpuSelection,
} from '../frontend/src/generation.ts';
import type { BatchDraft, ContentItem, Job, Preset, Sample } from '../frontend/src/types.ts';

test('composes only the prompts sent to ComfyUI', () => {
  const input = composeVideoGenerationInput(
    {
      videoPrompt: 'Base video prompt.',
      sceneSupplement: 'Quiet room.',
    },
    {
      styleInstruction: 'Natural movement.',
      sceneSupplement: 'Fixed camera.',
      renderNegativeConstraints: 'No subtitles.',
    },
  );

  assert.equal(
    input.positivePrompt,
    'Base video prompt.\n\nQuiet room.\n\nNatural movement.\n\nFixed camera.',
  );
  assert.equal(input.negativePrompt, 'No subtitles.');
});

test('accepts one or two distinct available GPUs', () => {
  const states = [
    { slot: 'GPU0', availability: 'Available', loadedModel: null, activeJobId: null, checkedAt: '' },
    { slot: 'GPU1', availability: 'Reserved', loadedModel: 'LTX-2.3', activeJobId: 'job-1', checkedAt: '' },
  ] as const;

  assert.equal(validateBatchGpuSelection([], states), 'NoSelection');
  assert.equal(validateBatchGpuSelection(['GPU0'], states), null);
  assert.equal(validateBatchGpuSelection(['GPU1'], states), 'Unavailable');
  assert.equal(validateBatchGpuSelection(['GPU0', 'GPU0'], states), 'Duplicate');
});

test('tracks two running videos from item status and GPU assignments', () => {
  const items = buildJobItems(5, 'Running', ['GPU0', 'GPU1'], 2, [3, 4], ['content-a', 'content-b']);

  assert.deepEqual(items.map(item => item.status), ['Completed', 'Completed', 'Running', 'Running', 'Queued']);
  assert.deepEqual(items.map(item => item.gpuId), ['GPU0', 'GPU1', 'GPU0', 'GPU1', null]);
  assert.deepEqual(items.map(item => item.contentItemId), ['content-a', 'content-b', 'content-a', 'content-b', 'content-a']);
});

test('stores immutable prompt and reference snapshots for every video', () => {
  const draft = {
    datasetId: 'dataset', category: 'C-VA', conflictDirection: 'Audio', contentItemIds: ['content'],
    presetId: 'preset', model: 'LTX-2.3', gpus: ['GPU0'], quantity: 1, seed: 42,
    ages: [25], genders: ['Female'], ethnicities: ['EastAsian'],
  } satisfies BatchDraft;
  const content = {
    id: 'content', name: '声音线索', revision: 4, videoPrompt: 'Original prompt.', sceneSupplement: 'Original scene.',
  } as ContentItem;
  const preset = {
    id: 'preset', name: '标准预设', revision: 7, styleInstruction: 'Original style.',
    sceneSupplement: 'Fixed camera.', renderNegativeConstraints: 'No subtitles.',
  } as Preset;
  const snapshot = createBatchAllocationSnapshot(1, draft, content, preset, {
    age: 25, gender: 'Female', ethnicity: 'EastAsian',
  });

  content.name = 'Changed content';
  content.videoPrompt = 'Changed prompt.';
  preset.name = 'Changed preset';
  preset.renderNegativeConstraints = 'Changed negative prompt.';

  assert.equal(snapshot.contentItemName, '声音线索');
  assert.equal(snapshot.contentItemRevision, 4);
  assert.equal(snapshot.presetName, '标准预设');
  assert.equal(snapshot.presetRevision, 7);
  assert.equal(snapshot.finalPositivePrompt, 'Original prompt.\n\nOriginal scene.\n\nOriginal style.\n\nFixed camera.');
  assert.equal(snapshot.finalNegativePrompt, 'No subtitles.');
  assert.equal(snapshot.seed, 42);
});

test('loads a saved batch without replacing its GPU or references', () => {
  const saved = {
    datasetId: 'saved-dataset', category: 'A-VT', conflictDirection: null, contentItemIds: ['disabled-content'],
    presetId: 'disabled-preset', model: 'MiniMax H3', gpus: ['GPU1'], quantity: 12, seed: 77,
    ages: [45], genders: ['Male'], ethnicities: ['SouthAsian'],
  } satisfies BatchDraft;
  const defaults = {
    ...saved,
    datasetId: 'new-dataset', contentItemIds: ['active-content'], presetId: 'active-preset', gpus: ['GPU0'],
  } satisfies BatchDraft;

  assert.deepEqual(selectInitialBatchDraft(saved, defaults), saved);
});

test('derives progress only from completed count and quantity', () => {
  assert.equal(jobProgress(33, 128), 25.78125);
  assert.equal(jobProgress(5, 0), 0);
  const jobState = { completedCount: 33, quantity: 128 };
  assert.equal('progress' in jobState, false);
  assert.equal('currentItemSequence' in jobState, false);
});

test('prevents deleting content used by tasks or samples', () => {
  const job = { batchInput: { draft: { contentItemIds: ['content-used'] } } } as unknown as Job;
  const sample = { contentItemId: 'content-sample' } as unknown as Sample;

  assert.equal(contentIsReferenced('content-used', [job], []), true);
  assert.equal(contentIsReferenced('content-sample', [], [sample]), true);
  assert.equal(contentIsReferenced('content-free', [job], [sample]), false);
});
