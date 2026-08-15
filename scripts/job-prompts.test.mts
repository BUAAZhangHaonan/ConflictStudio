import assert from 'node:assert/strict';
import test from 'node:test';
import { finalJobItemPrompts } from '../frontend/src/jobPrompts.ts';

const input = {
  fixedPositivePrompt: null,
  finalNegativePrompt: 'Final negative prompt.',
  userInput: 'Complete generation instruction with spokenText, positivePrompt, dialogue, and vtText.',
};

test('a failed generated item without a result exposes no raw prompt input', () => {
  assert.equal(finalJobItemPrompts({ input, promptResult: null }), null);
});

test('a generated result exposes only its complete final positive and negative prompts', () => {
  const promptResult = {
    finalPositivePrompt: 'Final positive prompt.\nKeep the full second line.',
    finalNegativePrompt: 'Final negative prompt.\nKeep the full second line.',
  };
  assert.deepEqual(finalJobItemPrompts({ input, promptResult }), {
    positive: promptResult.finalPositivePrompt,
    negative: promptResult.finalNegativePrompt,
  });
});

test('fixed content exposes its fixed final positive and negative prompts', () => {
  assert.deepEqual(finalJobItemPrompts({
    input: { ...input, fixedPositivePrompt: 'Fixed final positive prompt.' },
    promptResult: null,
  }), {
    positive: 'Fixed final positive prompt.',
    negative: input.finalNegativePrompt,
  });
});
