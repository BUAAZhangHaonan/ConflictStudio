import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildJobItems,
  composeVideoGenerationInput,
  contentIsReferenced,
  validateBatchGpuSelection,
} from '../frontend/src/generation.ts';
import type { Job, Sample } from '../frontend/src/types.ts';

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

test('tracks dynamic work by completed count and current video', () => {
  const items = buildJobItems(5, 'Running', ['GPU0', 'GPU1'], 2, 3, ['content-a', 'content-b']);

  assert.deepEqual(items.map(item => item.status), ['Completed', 'Completed', 'Running', 'Queued', 'Queued']);
  assert.deepEqual(items.map(item => item.gpu), ['GPU0', 'GPU1', 'GPU0', null, null]);
  assert.deepEqual(items.map(item => item.contentItemId), ['content-a', 'content-b', 'content-a', 'content-b', 'content-a']);
});

test('prevents deleting content used by tasks or samples', () => {
  const job = { batchInput: { draft: { contentItemIds: ['content-used'] } } } as unknown as Job;
  const sample = { contentItemId: 'content-sample' } as unknown as Sample;

  assert.equal(contentIsReferenced('content-used', [job], []), true);
  assert.equal(contentIsReferenced('content-sample', [], [sample]), true);
  assert.equal(contentIsReferenced('content-free', [job], [sample]), false);
});
