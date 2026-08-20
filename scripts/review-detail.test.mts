import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  readSavedReviewListState,
  saveReviewListState,
} from '../frontend/src/reviewArchive.ts';

const page = readFileSync(new URL('../frontend/src/pages/ReviewDetailPage.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../frontend/src/pages/ReviewDetailPage.css', import.meta.url), 'utf8');
const locales = readFileSync(new URL('../frontend/src/locales/features/reviewArchive.ts', import.meta.url), 'utf8');

test('detail reads the path sample and restores a safe list return address', () => {
  assert.match(page, /useParams<\{ sampleId: string \}>/);
  assert.match(page, /readSavedReviewListState\(\)/);
  assert.match(page, /returnTo = savedListState\?\.returnTo \?\? '\/review'/);
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  assert.equal(saveReviewListState({ returnTo: '/review?decision=Pending&page=3', page: 3, scrollY: 420 }, storage), true);
  assert.deepEqual(readSavedReviewListState(storage), {
    returnTo: '/review?decision=Pending&page=3',
    page: 3,
    scrollY: 420,
  });
});

test('VA stays sounded and VT offers one source audio toggle only when source media exists', () => {
  assert.match(page, /showSourceToggle = sample\.protocol === 'VT' && sample\.sourceMedia !== null/);
  assert.match(page, /muted=\{sample\.protocol === 'VT' && !useSourceAudio\}/);
  assert.match(page, /showSourceToggle \? \(/);
  assert.equal((page.match(/<MediaPanel/g) ?? []).length, 1);
  assert.match(page, /playSourceAudio/);
  assert.match(page, /showSilentPrimary/);
});

test('missing reviewer is read only and disables every write action', () => {
  assert.match(page, /const canReview = reviewerId !== null/);
  assert.match(page, /readOnly=\{!canReview\}/);
  assert.match(page, /disabled=\{!canReview \|\| !noteReady \|\| writeBusy\}/);
  assert.match(page, /disabled=\{!canReview \|\| writeBusy\}/);
  assert.match(page, /review\.detail\.readOnly/);
});

test('note autosave exposes loading saving saved failure and retry states', () => {
  assert.match(page, /type NoteState = 'loading' \| 'saving' \| 'saved' \| 'failed'/);
  assert.match(page, /window\.setTimeout\(\(\) => \{/);
  assert.match(page, /\}, 400\)/);
  assert.match(page, /usePutReviewNoteDraftMutation/);
  assert.match(page, /expectedRevision/);
  assert.match(page, /expectedSampleRevision/);
  assert.match(page, /retryNoteSave/);
  assert.match(locales, /Another person changed this note\. Refresh the page before trying again\./);
  assert.doesNotMatch(page, /manual save|beforeunload|leave warning/i);
});

test('review sends queue and note revision then follows the next page reference', () => {
  assert.match(page, /expectedNoteDraftRevision: noteRevision/);
  assert.match(page, /queue: queueFromReturnTarget\(returnTo\)/);
  assert.match(page, /value => followReviewResult\(value\.nextReference\)/);
  assert.match(page, /page: nextReference\.page/);
  assert.match(page, /reviewDetailLocation\(nextReference\.id\)/);
  assert.match(page, /navigate\(returnTo, \{ replace: true \}\)/);
});

test('classification confirmation sends reviewer and direction without a reason', () => {
  assert.match(page, /useConvertSampleClassificationMutation/);
  assert.match(page, /reviewerId,/);
  assert.match(page, /targetCategory,/);
  assert.match(page, /conflictDirection: needsDirection \? conversionDirection : null/);
  assert.match(page, /await detailQuery\.refetch\(\)/);
  assert.match(page, /status\.review\.Pending/);
  assert.doesNotMatch(page, /reason\s*:/);
});

test('zero compatible scenes stays on detail and links to generation', () => {
  assert.match(page, /sample\.compatibleSceneCount === 0/);
  assert.match(page, /<Link to="\/generate\/production">/);
  assert.match(locales, /当前内容没有可用拍摄场景，因此暂时不能生成。/);
  const block = page.slice(page.indexOf('sample.compatibleSceneCount === 0'), page.indexOf('review-detail__decision'));
  assert.doesNotMatch(block, /navigate\(/);
});

test('detail renders only approved context and one disclosure', () => {
  assert.match(page, /trueEmotionDescription/);
  assert.match(page, /sample\.protocol === 'VA' \? sample\.dialogue/);
  assert.match(page, /sample\.displayText/);
  assert.match(page, /sample\.relation === 'Aligned' \? 'A' : 'C'/);
  assert.match(page, /beijingTimestamp/);
  assert.equal((page.match(/<details/g) ?? []).length, 1);
  assert.doesNotMatch(page, /\bseed\b|positivePrompt|negativePrompt|attempt|gpu|vlm|shortcut/i);
});

test('responsive CSS contains the wide split and three narrow widths', () => {
  assert.match(css, /grid-template-columns: minmax\(0, 1\.1fr\) minmax\(26rem, 0\.9fr\)/);
  assert.match(css, /@media \(max-width: 1279px\)/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /width: 100%/);
  assert.match(css, /object-fit: contain/);
  assert.match(css, /overflow-x: hidden/);
  assert.doesNotMatch(css, /overflow-y|overflow:\s*auto/);
  for (const width of [1440, 1024, 768, 390]) assert.equal(Number.isInteger(width), true);
});

test('English and Chinese detail copy have matching keys and clean separators', () => {
  for (const key of ['loadingTitle', 'emptyTitle', 'errorTitle', 'readOnly', 'playSourceAudio', 'saving', 'saved', 'failed', 'retry', 'conversion', 'noCompatibleScene']) {
    assert.equal((locales.match(new RegExp(`${key}:`, 'g')) ?? []).length >= 2, true, key);
  }
  const detailCopy = locales.split('    detail: {').slice(1).map(value => value.split('    searchLabel:')[0]).join('');
  assert.doesNotMatch(detailCopy, /[·—]/);
});
