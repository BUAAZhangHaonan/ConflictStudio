import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  readSavedReviewListState,
  saveReviewListState,
} from '../frontend/src/reviewArchive.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const page = read('../frontend/src/pages/ReviewDetailPage.tsx');
const css = read('../frontend/src/pages/ReviewDetailPage.css');
const locales = read('../frontend/src/locales/features/reviewArchive.ts');
const queries = read('../frontend/src/api/queries.ts');

test('detail prefers an explicit safe list return and keeps saved scroll as a fallback', () => {
  assert.match(page, /safeReviewListReturnTarget\(searchParams\.get\('returnTo'\)\)[\s\S]*safeReviewReturnTarget\(searchParams\.get\('returnTo'\)\)/u);
  assert.match(page, /const returnTo = explicitReturnTo \?\? savedListState\?\.returnTo \?\? '\/review'/u);
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  assert.equal(saveReviewListState({ returnTo: '/review?decision=Pending&page=3', page: 3, scrollY: 420 }, storage), true);
  assert.deepEqual(readSavedReviewListState(storage), {
    returnTo: '/review?decision=Pending&page=3', page: 3, scrollY: 420,
  });
});

test('detail labels a safe Results return separately from a review-list return', () => {
  assert.match(page, /const backLabel = t\(returnTo\.startsWith\('\/generate\/results'\)[\s\S]*'review\.detail\.backToResults'[\s\S]*'review\.detail\.backToList'\)/u);
  assert.equal((page.match(/\{backLabel\}/gu) ?? []).length, 3);
  assert.match(locales, /backToResults: 'Back to generation results'/u);
  assert.match(locales, /backToResults: '返回生成结果'/u);
});

test('detail receives the resolved nullable reviewer from ReviewGate', () => {
  assert.match(page, /const reviewer = useReviewGateReviewer\(\)/u);
  assert.match(page, /const reviewerId = reviewer\?\.id \?\? null/u);
  assert.doesNotMatch(page, /useReviewerState|canReview|aria-readonly|is-read-only/u);
});

test('guests browse the detail page read-only without any mutation path', () => {
  assert.match(page, /readOnly=\{reviewerId === null\}/u);
  assert.match(page, /if \(reviewerId === null \|\| note === savedNote \|\| noteState === 'failed' \|\| noteState === 'saving'\) return/u);
  assert.match(page, /reviewerId === null \|\| writeBusy \|\| acceptanceBlocked[\s\S]*chooseReviewDecision\('Accepted'\)/u);
  assert.match(page, /reviewerId === null \|\| writeBusy\}[\s\S]*chooseReviewDecision\('Rejected'\)/u);
  assert.match(page, /reviewerId === null \|\| writeBusy\}[\s\S]*openConversion/u);
  assert.match(page, /review\.detail\.guestHint/u);
  assert.match(locales, /guestHint: 'Sign in as a reviewer in Settings to change decisions or notes\.'/u);
  assert.match(locales, /guestHint: '请先在设置中选择审核人，才能修改决定或备注。'/u);
});

test('note draft re-initializes when the reviewer identity changes mid-session', () => {
  assert.match(page, /initializedDraftRef\.current = null;[\s\S]*\}, \[sampleId, reviewerId\]\)/u);
  assert.match(page, /const key = `\$\{sample\.id\}:\$\{reviewerId\}:\$\{sample\.revision\}`/u);
});

test('note autosave and every exit flush the live draft revision before continuing', () => {
  assert.match(page, /type NoteState = 'loading' \| 'dirty' \| 'saving' \| 'saved' \| 'failed'/u);
  assert.match(page, /const flushNote = useCallback\(async \(\): Promise<boolean>/u);
  assert.match(page, /noteMutation\.mutateAsync\([\s\S]*expectedRevision: noteRevisionRef\.current[\s\S]*expectedSampleRevision: sample\.revision/u);
  assert.match(page, /window\.setTimeout\(\(\) => \{ void flushNote\(\); \}, 400\)/u);
  assert.match(page, /if \(!await flushNote\(\)\) return;[\s\S]*navigate\(reviewDetailLocation/u);
  assert.match(page, /if \(await flushNote\(\)\) navigate\(returnTo\)/u);
  assert.match(page, /if \(await flushNote\(\)\) setReviewDecision\(decision\)/u);
  assert.match(page, /disabled=\{navigationPending \|\| noteSaving\}/u);
  assert.match(page, /useReviewNoteDraftQuery\(sampleId, reviewerId, sampleRevision\)/u);
  assert.match(page, /expectedNoteDraftRevision: noteRevision/u);
  assert.match(page, /const noteReady = noteQuery\.isSuccess && noteState === 'saved' && note === savedNote/u);
  assert.match(locales, /dirty: 'Not saved yet'/u);
});

test('accepted and rejected samples can be returned to Pending with history retained', () => {
  assert.match(page, /useState<ReviewDecision \| null>\(null\)/u);
  assert.match(page, /sample\.reviewDecision !== 'Pending'[\s\S]*chooseReviewDecision\('Pending'\)/u);
  assert.match(page, /decision: reviewDecision/u);
  const reviewPayload = page.slice(page.indexOf('reviewMutation.mutate({'), page.indexOf('}, {', page.indexOf('reviewMutation.mutate({')));
  assert.match(reviewPayload, /expectedRevision: sample\.revision/u);
  assert.doesNotMatch(reviewPayload, /expectedSampleRevision/u);
  assert.match(page, /withdrawConfirmBody/u);
  assert.match(locales, /The latest decision will be withdrawn\. Review history will remain\./u);
  assert.match(locales, /将撤回当前决定，审核历史会保留。/u);
});

test('generation compatibility is the only acceptance block', () => {
  assert.match(page, /const acceptanceBlocked = sample\.generationCompatibility === 'NeedsRegeneration'/u);
  assert.match(page, /disabled=\{reviewerId === null \|\| writeBusy \|\| acceptanceBlocked\}[\s\S]*chooseReviewDecision\('Accepted'\)/u);
  assert.match(page, /reviewDecision === 'Accepted' && sample\.generationCompatibility === 'NeedsRegeneration'/u);
  assert.doesNotMatch(page, /compatibleSceneCount === 0/u);
  assert.match(locales, /needs regeneration before it can be accepted/u);
});

test('review history stays collapsed and loads only when opened', () => {
  assert.match(page, /useReviewHistoryQuery\(sampleId, historyPage, historyOpen\)/u);
  assert.match(page, /<details[\s\S]*className="panel review-detail__history"[\s\S]*onToggle=\{event => setHistoryOpen\(event\.currentTarget\.open\)\}/u);
  assert.doesNotMatch(page, /className="panel review-detail__history" open/u);
  assert.match(page, /historyQuery\.data\.items\.map/u);
  assert.match(queries, /apiRequest<Page<ReviewResultRead>>\(`\/api\/reviews\?/u);
});

test('previous and next navigation cross page boundaries and retain explicit returnTo', () => {
  assert.match(page, /queryClient\.fetchQuery\(reviewSampleQueries\.list/u);
  assert.match(page, /direction === 'previous'[\s\S]*adjacent\.items\[adjacent\.items\.length - 1\][\s\S]*adjacent\.items\[0\]/u);
  assert.match(page, /const nextReturnTo = buildReviewListLocation\(\{ \.\.\.listLocation, page: targetPage \}\)/u);
  assert.match(page, /reviewDetailLocation\(target\.id, nextReturnTo\)/u);
  assert.match(page, /reviewDetailLocation\(nextReference\.id, nextListLocation\)/u);
  assert.doesNotMatch(page, /saveReviewListState/u);
});

test('review submission preserves a non-list Results return while list queues keep their page', () => {
  assert.match(page, /if \(listReturnTo === null\) \{[\s\S]*reviewDetailLocation\(nextReference\.id, returnTo\)/u);
  assert.match(page, /readReviewListLocation\(listReturnTo\)[\s\S]*page: nextReference\.page/u);
  assert.match(page, /reviewDetailLocation\(nextReference\.id, nextListLocation\)/u);
});

test('class conversion is secondary and still enforces the full target class input', () => {
  assert.match(page, /<details className="review-detail__secondary">[\s\S]*openConversion/u);
  const primaryActions = page.slice(page.indexOf('review-detail__actions'), page.indexOf('review-detail__secondary'));
  assert.doesNotMatch(primaryActions, /openConversion|conversion\.action/u);
  assert.match(page, /conversionApparentEmotion !== emotionKey\(sample\.trueEmotion\)/u);
  assert.match(page, /conflictDirection: needsDirection \? conversionDirection : null/u);
  assert.match(page, /trueEmotionDescription: conversionDescription\.trim\(\)/u);
});

test('media stays contained at wide and 390 pixel layouts', () => {
  assert.match(css, /\.review-detail__media video \{[\s\S]*object-fit: contain/u);
  assert.match(css, /@media \(max-width: 639px\)[\s\S]*max-height: 70svh;[\s\S]*object-fit: contain/u);
  assert.match(css, /overflow-x: hidden/u);
  assert.doesNotMatch(css, /overflow-y|overflow:\s*auto/u);
});
