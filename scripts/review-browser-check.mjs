import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';

const playwrightModule = process.env.CONFLICTSTUDIO_PLAYWRIGHT_MODULE;
if (!playwrightModule) throw new Error('CONFLICTSTUDIO_PLAYWRIGHT_MODULE is required.');
const { chromium } = await import(pathToFileURL(playwrightModule).href);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = resolve(projectRoot, 'frontend');
const baseUrl = 'http://127.0.0.1:4174';

function sample(id, reviewDecision = 'Pending') {
  const displayId = `CS-${String(id).padStart(6, '0')}`;
  return {
    id,
    displayId,
    jobItemId: id,
    datasetId: 1,
    category: 'C-VA',
    conflictDirection: 'Audio',
    reviewDecision,
    reviewRevision: 2,
    model: 'LTX-2.5',
    generationRecord: {
      id: 9000 + id,
      attemptNumber: 3,
      model: 'LTX-2.5',
      precision: 'BF16',
      gpuSlot: 'GPU0',
      seed: 424242,
      sourceAssetId: null,
      sourceAssetUrl: null,
      primaryAssetId: id,
      primaryAssetUrl: '/media/review-sample.mp4',
      rendererPromptId: `prompt-${id}`,
      status: 'Completed',
      failureReason: null,
      startedAt: '2026-08-14T08:00:00.000Z',
      finishedAt: '2026-08-14T08:01:00.000Z',
    },
    gpuSlot: 'GPU0',
    contentPlanId: 1,
    contentPlanRevision: 4,
    promptPresetId: 1,
    sourceAssetId: null,
    sourceAssetUrl: null,
    primaryAssetId: id,
    primaryAssetUrl: '/media/review-sample.mp4',
    dialogue: 'I understand.',
    displayText: null,
    videoPrompt: 'A fixed camera records a short reply.',
    negativePrompt: 'No subtitles.',
    trueEmotionDescription: 'The voice carries sadness while the expression stays calm.',
    trueEmotion: 'sadness',
    apparentEmotion: 'neutral',
    contentPlanNameZh: '克制回应',
    contentPlanNameEn: 'Restrained reply',
    sceneZh: '安静办公室',
    sceneEn: 'Quiet office',
    triggerEventZh: '收到坏消息',
    triggerEventEn: 'Bad news arrives',
    psychologicalBackgroundZh: '人物压住情绪',
    psychologicalBackgroundEn: 'The person suppresses emotion',
    age: 35,
    gender: 'Female',
    ethnicity: 'EastAsian',
    seed: 424242,
    revision: 7,
    createdAt: '2026-08-14T08:00:00.000Z',
    updatedAt: '2026-08-14T08:01:00.000Z',
  };
}

const pendingSamples = Array.from({ length: 30 }, (_, index) => sample(index + 1));
const acceptedSamples = Array.from({ length: 25 }, (_, index) => sample(index + 31, 'Accepted'));
const allSamples = [...pendingSamples, ...acceptedSamples];

async function open(page, route, locale = 'en-US') {
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
  await page.evaluate(value => localStorage.setItem('conflictstudio.prototype.locale', value), locale);
  await page.reload({ waitUntil: 'networkidle' });
}

async function installApi(page) {
  await page.route('**/api/datasets', route => route.fulfill({ json: [{ id: 1, name: 'Formal samples', revision: 1 }] }));
  await page.route('**/api/samples*', route => {
    const decision = new URL(route.request().url()).searchParams.get('decision');
    route.fulfill({ json: decision === 'Accepted' ? acceptedSamples : decision === 'Pending' ? pendingSamples : allSamples });
  });
  await page.route('**/media/review-sample.mp4', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
}

const server = await createServer({
  root: frontendRoot,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 4174, strictPort: true },
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    localStorage.setItem('conflictstudio.prototype.reviewer.v2', 'reviewer-lin');
    if (!localStorage.getItem('conflictstudio.prototype.locale')) localStorage.setItem('conflictstudio.prototype.locale', 'en-US');
  });
  const page = await context.newPage();
  await installApi(page);

  const returnTo = '/archive?dataset=1&category=C-VA&page=2';
  await open(page, `/review?page=3&category=C-VA&sample=CS-000001&returnTo=${encodeURIComponent(returnTo)}`);
  await page.locator('.review-detail').waitFor();
  assert.equal(await page.locator('.review-queue').isVisible(), false, '390px selected view must hide the queue.');
  for (const selector of ['.review-media video', '.review-context', '.review-generation-record', '.review-decision']) {
    assert.equal(await page.locator(selector).isVisible(), true, `390px selected view must show ${selector}.`);
  }
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(mobileOverflow, 0, '390px selected review must not overflow horizontally.');
  const sampleContext = await page.locator('.review-context').textContent();
  assert.equal(sampleContext.includes('LTX-2.5'), true, 'Sample context must keep the model.');
  for (const generationValue of ['BF16', 'GPU0', '424242', '9001']) {
    assert.equal(sampleContext.includes(generationValue), false, `Sample context must not contain ${generationValue}.`);
  }
  const generationRecord = await page.locator('.review-generation-record').textContent();
  for (const value of ['LTX-2.5', 'BF16', 'GPU0', '424242', '3', '9001']) {
    assert.equal(generationRecord.includes(value), true, `Generation record must contain ${value}.`);
  }
  assert.equal((await page.locator('.review-grid').textContent()).includes('CS-000001'), true, 'The official six-digit sample ID must remain visible.');

  await page.getByRole('button', { name: 'Back to queue', exact: true }).click();
  await page.waitForFunction(() => !new URL(window.location.href).searchParams.has('sample'));
  await page.locator('.review-queue').waitFor({ state: 'visible' });
  const queueUrl = new URL(page.url());
  assert.equal(queueUrl.searchParams.has('sample'), false, 'Back to queue must remove only sample.');
  assert.equal(queueUrl.searchParams.get('page'), '3');
  assert.equal(queueUrl.searchParams.get('category'), 'C-VA');
  assert.equal(queueUrl.searchParams.get('returnTo'), returnTo);
  assert.equal(await page.locator('.review-queue').isVisible(), true, '390px no-selection view must show the queue.');
  assert.equal(await page.locator('.review-detail').count(), 0, '390px no-selection view must not show stale detail.');

  const queueList = page.locator('.review-queue__list');
  await queueList.evaluate(element => { element.scrollTop = 180; });
  const preservedScroll = await queueList.evaluate(element => element.scrollTop);
  await page.locator('.review-queue__item').nth(7).evaluate(element => element.click());
  await page.locator('.review-detail').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Back to queue', exact: true }).click();
  await queueList.waitFor({ state: 'visible' });
  assert.equal(await queueList.evaluate(element => element.scrollTop), preservedScroll, 'Returning to the queue must preserve its scroll position.');

  for (const [locale, labels] of [
    ['en-US', ['Generation record', 'Attempt revision', 'Attempt ID']],
    ['zh-CN', ['生成记录', '尝试序号', '尝试记录编号']],
  ]) {
    await open(page, '/review?sample=CS-000002', locale);
    const text = await page.locator('.review-generation-record').textContent();
    for (const label of labels) assert.equal(text.includes(label), true, `${locale} must show ${label}.`);
  }

  await open(page, `/review?sample=CS-000001&returnTo=${encodeURIComponent('https://example.com/archive')}`);
  assert.equal(await page.getByRole('button', { name: /previous page|上一页/u }).count(), 0, 'Unsafe returnTo must not render a source return action.');
  await page.getByRole('button', { name: /Back to queue|返回队列/u }).click();
  assert.equal(new URL(page.url()).origin, baseUrl, 'Unsafe returnTo must never leave the application.');

  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/review?sample=CS-000001', 'en-US');
  const desktop = await page.evaluate(() => {
    const queue = document.querySelector('.review-queue')?.getBoundingClientRect();
    const media = document.querySelector('.review-media')?.getBoundingClientRect();
    const decision = document.querySelector('.review-decision')?.getBoundingClientRect();
    const video = document.querySelector('.review-media video');
    if (!queue || !media || !decision || !(video instanceof HTMLVideoElement)) return null;
    const videoBounds = video.getBoundingClientRect();
    return {
      threeColumns: queue.right < media.left && media.right < decision.left,
      videoContained: videoBounds.left >= media.left && videoBounds.right <= media.right && videoBounds.bottom <= media.bottom,
      objectFit: getComputedStyle(video).objectFit,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert.ok(desktop, '1440px review layout must render.');
  assert.equal(desktop.threeColumns, true, '1440px review must keep queue, media, and decision in three columns.');
  assert.equal(desktop.videoContained, true, '1440px video must remain fully inside its panel.');
  assert.equal(desktop.objectFit, 'contain', '1440px video must preserve the complete frame.');
  assert.equal(desktop.overflow, 0, '1440px review must not overflow horizontally.');

  await open(page, '/archive?dataset=1&category=C-VA&page=2', 'en-US');
  await page.getByRole('link', { name: 'CS-000051', exact: true }).click();
  assert.equal(new URL(page.url()).pathname, '/review');
  assert.equal(new URL(page.url()).searchParams.get('returnTo'), '/archive?dataset=1&category=C-VA&page=2');
  await page.getByRole('button', { name: 'Back to previous page', exact: true }).click();
  await page.waitForURL(/\/archive\?dataset=1&category=C-VA&page=2$/u);
  assert.equal(new URL(page.url()).pathname, '/archive', 'Safe returnTo must return to the source page.');

  console.log('Review browser checks passed: mobile split view, safe returns, contracts, bilingual copy, and desktop layout.');
} finally {
  if (browser) await browser.close();
  await server.close();
}
