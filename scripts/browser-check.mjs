import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';

const playwrightModule = process.env.CONFLICTSTUDIO_PLAYWRIGHT_MODULE;
if (!playwrightModule) throw new Error('CONFLICTSTUDIO_PLAYWRIGHT_MODULE is required.');
const { chromium } = await import(pathToFileURL(playwrightModule).href);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = resolve(projectRoot, 'frontend');
const baseUrl = 'http://127.0.0.1:4173';
const dataKey = 'conflictstudio.prototype.data.v10';
const mockMediaSource = readFileSync(resolve(frontendRoot, 'src/mockMedia.ts'), 'utf8');
const voicedVideoDataUrl = mockMediaSource.match(/voicedVideoDataUrl = '([^']+)'/u)?.[1];
const silentVideoDataUrl = mockMediaSource.match(/silentVideoDataUrl = '([^']+)'/u)?.[1];
if (!voicedVideoDataUrl || !silentVideoDataUrl) throw new Error('Mock review media fixtures are required.');
const gpuSlotsFixture = [
  {
    slot: 'GPU0',
    availability: 'Available',
    loadedModel: 'LTX-2.5',
    loadedPrecision: 'INT8',
    serviceStatus: 'running',
    gpuName: 'NVIDIA RTX PRO 6000 Blackwell',
    memory: { usedMiB: 8192, totalMiB: 97887 },
    activeJobId: null,
    revision: 2,
    checkedAt: '2026-08-14T08:00:00.000Z',
    statusReason: null,
  },
  {
    slot: 'GPU1',
    availability: 'Available',
    loadedModel: null,
    loadedPrecision: null,
    serviceStatus: 'stopped',
    gpuName: 'NVIDIA RTX PRO 6000 Blackwell',
    memory: { usedMiB: 16, totalMiB: 97887 },
    activeJobId: null,
    revision: 3,
    checkedAt: '2026-08-14T08:00:00.000Z',
    statusReason: null,
  },
];
const gpuSlotContractKeys = [
  'activeJobId', 'availability', 'checkedAt', 'gpuName', 'loadedModel',
  'loadedPrecision', 'memory', 'revision', 'serviceStatus', 'slot', 'statusReason',
];
for (const slot of gpuSlotsFixture) {
  assert.deepEqual(Object.keys(slot).sort(), gpuSlotContractKeys, `${slot.slot} fixture must match the current GPU slot response contract.`);
  assert.deepEqual(Object.keys(slot.memory).sort(), ['totalMiB', 'usedMiB'], `${slot.slot} memory fixture must match the current GPU memory response contract.`);
}
const resourceTimestamp = '2026-08-14T08:00:00.000Z';
const datasetsFixture = [{ id: 1, name: 'Formal samples', purpose: 'Production', note: '', status: 'Active', revision: 1, createdAt: resourceTimestamp, updatedAt: resourceTimestamp }];
const contentPlansFixture = [{
  id: 1, nameZh: '克制回应', nameEn: 'Restrained reply', category: 'A-VA', conflictDirection: null,
  mode: 'Fixed', status: 'Active', trueEmotion: 'sadness', apparentEmotion: 'sadness',
  sceneZh: '安静办公室', sceneEn: 'Quiet office', triggerEventZh: '收到坏消息', triggerEventEn: 'Bad news arrives',
  psychologicalBackgroundZh: '人物压住情绪', psychologicalBackgroundEn: 'The person suppresses emotion',
  dialogue: 'I understand.', displayText: null, trueEmotionDescription: 'The voice and expression carry sadness.',
  baseVideoPrompt: 'A fixed camera records a short reply.', contentRequirementsZh: '自然回应', contentRequirementsEn: 'Natural reply',
  sceneSupplementZh: '稳定镜头', sceneSupplementEn: 'Stable camera', revision: 1, createdAt: resourceTimestamp, updatedAt: resourceTimestamp,
}];
const promptPresetsFixture = [{
  id: 1, name: 'Natural conversation', category: 'A-VA', styleGuidance: 'Natural restrained acting.', sceneSupplement: 'Stable camera.',
  positiveExamples: ['A natural reply.'], negativeExamples: ['Exaggerated acting.'], finalRenderNegativeConstraints: 'No subtitles.',
  status: 'Active', revision: 1, createdAt: resourceTimestamp, updatedAt: resourceTimestamp,
}];
const backgroundsFixture = [{
  id: 1, nameZh: '安静办公室', nameEn: 'Quiet office', sceneZh: '安静办公室', sceneEn: 'Quiet office',
  ambientSoundZh: '轻微空调声', ambientSoundEn: 'Low air conditioner hum', participantRelationshipZh: '同事', participantRelationshipEn: 'Colleagues',
  lightingZh: '柔和室内光', lightingEn: 'Soft indoor light', framingZh: '中景', framingEn: 'Medium shot', status: 'Active',
  revision: 1, createdAt: resourceTimestamp, updatedAt: resourceTimestamp,
}];
const jobFixture = {
  id: 1, displayName: 'Dual GPU history', source: 'Production', datasetId: 1, batchDraftId: 1,
  category: 'A-VA', conflictDirection: null, model: 'LTX-2.5', precision: 'INT8', status: 'Completed',
  totalCount: 128, preparedCount: 128, completedCount: 128, failedCount: 0, confirmModelSwitch: false,
  cancelRequestedAt: null, failureCode: null, failureReason: null, startedAt: resourceTimestamp, finishedAt: resourceTimestamp,
  revision: 2, createdAt: resourceTimestamp, updatedAt: resourceTimestamp,
};
function jobItemFixture(id, sequence, gpuSlot) {
  return {
    id, sequence, gpuSlot, stage: 'Completed', status: 'Completed', failureCode: null, failureReason: null,
    rendererPromptId: `prompt-${id}`, sourceAssetId: null, sourceAssetUrl: null, primaryAssetId: id,
    primaryAssetUrl: '/media/review-sample.mp4', revision: 2, createdAt: resourceTimestamp, updatedAt: resourceTimestamp,
    input: {
      id, sequence, datasetId: 1, datasetRevision: 1, contentPlanId: 1, contentPlanRevision: 1,
      promptPresetId: 1, promptPresetRevision: 1, backgroundPresetId: 1, backgroundPresetRevision: 1,
      policyVersion: 'prompt-policy-v1', category: 'A-VA', conflictDirection: null, age: 25, gender: 'Female', ethnicity: 'EastAsian',
      model: 'LTX-2.5', precision: 'INT8', seed: 3200 + sequence, width: 1344, height: 768, fps: 25, frameCount: 121,
      rendererProfileVersion: 'ltx25-v1', promptModel: 'DeepSeek-V4-Flash', sourceHasAudio: true, deriveSilentPrimary: false,
      systemInput: 'Return valid JSON.', userInput: 'Generate a natural reply.', finalNegativePrompt: 'No subtitles.',
      fixedPositivePrompt: 'A fixed camera records a short reply.', fixedDialogue: 'I understand.', fixedVtText: null,
      fixedTrueEmotionDescription: 'The voice and expression carry sadness.', trueEmotion: 'sadness', apparentEmotion: 'sadness', createdAt: resourceTimestamp,
    },
    promptResult: null,
    attempts: [{
      id, attemptNumber: 1, model: 'LTX-2.5', precision: 'INT8', gpuSlot, seed: 3200 + sequence,
      sourceAssetId: null, sourceAssetUrl: null, primaryAssetId: id, primaryAssetUrl: '/media/review-sample.mp4',
      rendererPromptId: `prompt-${id}`, status: 'Completed', failureReason: null, startedAt: resourceTimestamp, finishedAt: resourceTimestamp,
    }],
    sampleId: id,
  };
}
const jobItemsFixture = [jobItemFixture(1, 1, 'GPU0'), jobItemFixture(2, 2, 'GPU1')];
function sampleFixture(id, reviewDecision, category = 'A-VA') {
  const videoAudio = category.endsWith('-VA');
  return {
    id, displayId: `CS-${String(id).padStart(6, '0')}`, jobItemId: id, datasetId: 1, category, conflictDirection: null,
    reviewDecision, reviewRevision: reviewDecision === 'Pending' ? 0 : 1, model: 'LTX-2.5',
    generationRecord: jobItemsFixture[(id - 1) % jobItemsFixture.length].attempts[0], gpuSlot: id % 2 ? 'GPU0' : 'GPU1',
    contentPlanId: 1, contentPlanRevision: 1, promptPresetId: 1, sourceAssetId: null, sourceAssetUrl: null,
    primaryAssetId: id, primaryAssetUrl: videoAudio ? voicedVideoDataUrl : silentVideoDataUrl, dialogue: videoAudio ? 'I understand.' : null, displayText: videoAudio ? null : 'I understand.',
    videoPrompt: 'A fixed camera records a short reply.', negativePrompt: 'No subtitles.',
    trueEmotionDescription: 'The voice and expression carry sadness.', trueEmotion: 'sadness', apparentEmotion: 'sadness',
    contentPlanNameZh: '克制回应', contentPlanNameEn: 'Restrained reply', sceneZh: '安静办公室', sceneEn: 'Quiet office',
    triggerEventZh: '收到坏消息', triggerEventEn: 'Bad news arrives', psychologicalBackgroundZh: '人物压住情绪', psychologicalBackgroundEn: 'The person suppresses emotion',
    age: 25, gender: 'Female', ethnicity: 'EastAsian', seed: 3200 + id, revision: 1, createdAt: resourceTimestamp, updatedAt: resourceTimestamp,
  };
}
const pendingSamplesFixture = Array.from({ length: 30 }, (_, index) => sampleFixture(index + 1, 'Pending', index === 3 ? 'A-VT' : 'A-VA'));
const acceptedSamplesFixture = Array.from({ length: 25 }, (_, index) => sampleFixture(index + 31, 'Accepted'));
const samplesFixture = [...pendingSamplesFixture, ...acceptedSamplesFixture];

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
}

async function setLocale(page, locale) {
  await page.evaluate(value => localStorage.setItem('conflictstudio.prototype.locale', value), locale);
}

async function open(page, route, locale = 'en-US') {
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
  await setLocale(page, locale);
  await page.reload({ waitUntil: 'networkidle' });
}

async function expectNoOverflow(page, route, locale, width, height) {
  await page.setViewportSize({ width, height });
  await open(page, route, locale);
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  equal(overflow.document, 0, `${locale} ${route} ${width} document overflow`);
  equal(overflow.body, 0, `${locale} ${route} ${width} body overflow`);
}

async function expectContained(locator, message) {
  const dimensions = await locator.evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  equal(dimensions.scrollWidth <= dimensions.clientWidth, true, `${message} ${JSON.stringify(dimensions)}`);
}

async function expectReviewMediaFit(page, sampleId, locale, width, height, expectedMuted) {
  await page.setViewportSize({ width, height });
  await open(page, `/review?sample=${sampleId}`, locale);
  const dimensions = await page.locator('.review-media').evaluate(panel => {
    const video = panel.querySelector('video');
    if (!(video instanceof HTMLVideoElement)) return null;
    const panelBounds = panel.getBoundingClientRect();
    const videoBounds = video.getBoundingClientRect();
    return {
      panelBottom: panelBounds.bottom,
      panelTop: panelBounds.top,
      videoBottom: videoBounds.bottom,
      videoTop: videoBounds.top,
      controls: video.controls,
      muted: video.muted,
      objectFit: getComputedStyle(video).objectFit,
      overflowY: getComputedStyle(panel).overflowY,
    };
  });
  equal(dimensions !== null, true, `${locale} ${sampleId} ${width} must render a video.`);
  equal(dimensions.controls, true, `${locale} ${sampleId} ${width} must show native video controls.`);
  equal(dimensions.muted, expectedMuted, `${locale} ${sampleId} ${width} must keep the protocol audio setting.`);
  equal(dimensions.objectFit, 'contain', `${locale} ${sampleId} ${width} must contain the full video frame.`);
  equal(dimensions.videoTop >= dimensions.panelTop - 1, true, `${locale} ${sampleId} ${width} video must start inside the media panel.`);
  equal(dimensions.videoBottom <= dimensions.panelBottom + 1, true, `${locale} ${sampleId} ${width} video and controls must end inside the media panel.`);
  equal(['auto', 'scroll'].includes(dimensions.overflowY), false, `${locale} ${sampleId} ${width} media panel must not require its own scrollbar.`);
}

async function expectTestGuidance(page, locale, width, height) {
  await page.setViewportSize({ width, height });
  await open(page, '/generate/test', locale);
  const notes = page.locator('.generation-section-note');
  equal(await notes.count(), 1, `${locale} test bench at ${width} must explain the test setup.`);
  equal(await notes.evaluateAll(elements => elements.every(element => element.textContent?.trim())), true, `${locale} test bench at ${width} must not show an empty explanation.`);
  equal(await page.locator('.generation-layout > .generation-form').count(), 2, `${locale} test bench at ${width} must separate setup from prompt preview.`);
  equal(await page.locator('[aria-labelledby="test-preview-title"]').locator('input, textarea').count(), 0, `${locale} test bench at ${width} must keep prompt preview read-only.`);
}

async function expectDialogBasics(page, message, dismissible = true) {
  const dialog = page.locator('dialog[open]').last();
  await dialog.waitFor();
  await page.waitForFunction(() => {
    const openDialogs = [...document.querySelectorAll('dialog[open]')];
    const current = openDialogs.at(-1);
    return current instanceof HTMLDialogElement && current.contains(document.activeElement);
  });
  const state = await dialog.evaluate(element => {
    const labelId = element.getAttribute('aria-labelledby');
    const label = labelId ? document.getElementById(labelId)?.textContent?.trim() ?? '' : '';
    const bounds = element.getBoundingClientRect();
    return {
      label,
      activeInside: element.contains(document.activeElement),
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  equal(state.label.length > 0, true, `${message} must have an accessible name.`);
  equal(state.activeInside, true, `${message} must move focus inside.`);
  equal(state.left >= -1 && state.top >= -1, true, `${message} must start inside the viewport.`);
  equal(state.right <= state.viewportWidth + 1 && state.bottom <= state.viewportHeight + 1, true, `${message} must fit inside the viewport.`);
  const trackedDialog = page.getByRole('dialog', { name: state.label, exact: true });
  await page.keyboard.press('Escape');
  if (dismissible) {
    await trackedDialog.waitFor({ state: 'hidden' });
  } else {
    equal(await trackedDialog.isVisible(), true, `${message} must remain open when dismissal is disabled.`);
  }
}

async function expectFocus(page, locator, message) {
  await page.waitForFunction(element => element === document.activeElement, await locator.elementHandle());
  equal(await locator.evaluate(element => element === document.activeElement), true, message);
}

async function resetPrototypeState(page) {
  await page.evaluate(key => {
    localStorage.removeItem(key);
    sessionStorage.clear();
  }, dataKey);
  await page.reload({ waitUntil: 'networkidle' });
}

async function expectNamedControls(page, scope, message) {
  const unnamed = await page.locator(scope).locator('button, a[href], input, select, textarea, summary').evaluateAll(elements =>
    elements.filter(element => {
      if (element instanceof HTMLInputElement && element.type === 'hidden') return false;
      const labelledBy = element.getAttribute('aria-labelledby')
        ?.split(/\s+/u)
        .map(id => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
      const labels = 'labels' in element
        ? [...(element.labels ?? [])].map(label => label.textContent ?? '').join(' ').trim()
        : '';
      const ownText = element.textContent?.trim() ?? '';
      return !(element.getAttribute('aria-label')?.trim() || labelledBy || labels || ownText || element.getAttribute('title')?.trim());
    }).map(element => `${element.tagName.toLowerCase()}#${element.id}`),
  );
  equal(unnamed.length, 0, `${message}: ${unnamed.join(', ')}`);
}

const server = await createServer({
  root: frontendRoot,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.addInitScript(() => {
    if (!localStorage.getItem('conflictstudio.prototype.reviewer.v2')) {
      localStorage.setItem('conflictstudio.prototype.reviewer.v2', 'reviewer-lin');
    }
    if (!localStorage.getItem('conflictstudio.prototype.locale')) {
      localStorage.setItem('conflictstudio.prototype.locale', 'en-US');
    }
  });
  const page = await context.newPage();
  let batchDraftsFixture = [];
  await page.route('**/api/gpu-slots', route => route.fulfill({ json: gpuSlotsFixture }));
  await page.route('**/api/datasets', route => route.fulfill({ json: datasetsFixture }));
  await page.route('**/api/content-plans', route => route.fulfill({ json: contentPlansFixture }));
  await page.route('**/api/prompt-presets', route => route.fulfill({ json: promptPresetsFixture }));
  await page.route('**/api/video-background-presets', route => route.fulfill({ json: backgroundsFixture }));
  await page.route('**/api/batch-drafts', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: batchDraftsFixture });
    const input = route.request().postDataJSON();
    const draft = {
      id: 1,
      datasetId: input.datasetId,
      datasetRevision: 1,
      category: input.category,
      conflictDirection: input.conflictDirection,
      model: input.model,
      precision: input.precision,
      quantity: input.quantity,
      seed: input.seed ?? 3200,
      status: 'Draft',
      contentPlans: input.contentPlans.map(item => ({ ...item, nameZh: contentPlansFixture.find(value => value.id === item.id)?.nameZh ?? '', nameEn: contentPlansFixture.find(value => value.id === item.id)?.nameEn ?? '' })),
      promptPresets: input.promptPresets.map(item => ({ ...item, name: promptPresetsFixture.find(value => value.id === item.id)?.name ?? '' })),
      backgroundPresets: input.backgroundPresets.map(item => ({ ...item, nameZh: backgroundsFixture.find(value => value.id === item.id)?.nameZh ?? '', nameEn: backgroundsFixture.find(value => value.id === item.id)?.nameEn ?? '' })),
      demographics: input.demographics,
      gpuSlots: input.gpuSlots,
      revision: 1,
      createdAt: resourceTimestamp,
      updatedAt: resourceTimestamp,
    };
    batchDraftsFixture = [draft];
    return route.fulfill({ status: 201, json: draft });
  });
  await page.route('**/api/jobs', route => route.fulfill({ json: [jobFixture] }));
  await page.route('**/api/jobs/1', route => route.fulfill({ json: { ...jobFixture, items: jobItemsFixture, events: [] } }));
  await page.route('**/api/jobs/1/items*', route => route.fulfill({ json: jobItemsFixture }));
  await page.route('**/api/jobs/1/events*', route => route.fulfill({ json: [] }));
  await page.route('**/api/samples*', route => {
    const decision = new URL(route.request().url()).searchParams.get('decision');
    route.fulfill({ json: decision ? samplesFixture.filter(sample => sample.reviewDecision === decision) : samplesFixture });
  });
  await page.route('**/media/review-sample.mp4', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  const pageErrors = [];
  const consoleErrors = [];
  const routerWarnings = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') {
      const source = message.location().url;
      consoleErrors.push(source ? `${message.text()} at ${source}` : message.text());
    }
    if (message.type() === 'warning' && message.text().includes('React Router Future Flag Warning')) {
      routerWarnings.push(message.text());
    }
  });

  await open(page, '/workspace');
  equal(await page.evaluate(key => Boolean(localStorage.getItem(key)), dataKey), true, 'Prototype data must initialize.');

  await open(page, '/generate/batches');
  const gpuFieldset = page.getByRole('group', { name: 'GPU', exact: true });
  const gpuChecks = gpuFieldset.locator('input[type="checkbox"]');
  equal(await gpuChecks.count(), 2, 'The production batch must show two GPUs.');
  equal(await gpuChecks.evaluateAll(nodes => nodes.every(node => !node.disabled)), true, 'Both example GPUs must be selectable.');
  const gpuCards = page.locator('.generation-gpu-card');
  equal(await gpuCards.count(), 2, 'The live GPU panel must show both API slots.');
  equal((await gpuCards.nth(0).innerText()).includes('Loaded model: LTX-2.5 INT8'), true, 'GPU0 must show the API model and precision.');
  equal((await gpuCards.nth(0).innerText()).includes('Model service running'), true, 'GPU0 must show the running service state.');
  equal((await gpuCards.nth(0).innerText()).includes('Memory: 8192 / 97887 MiB'), true, 'GPU0 must show the API memory values.');
  equal((await gpuCards.nth(1).innerText()).includes('No model loaded'), true, 'GPU1 must show the empty loaded-model state.');
  equal((await gpuCards.nth(1).innerText()).includes('Model service stopped'), true, 'GPU1 must show the stopped service state.');
  if (!(await gpuChecks.nth(0).isChecked())) await gpuChecks.nth(0).check();
  if (!(await gpuChecks.nth(1).isChecked())) await gpuChecks.nth(1).check();
  equal(await gpuChecks.evaluateAll(nodes => nodes.filter(node => node.checked).length), 2, 'A production batch must allow both GPUs.');

  const contentFieldset = page.getByRole('group', { name: 'Content items', exact: true });
  const contentChecks = contentFieldset.locator('input[type="checkbox"]');
  await contentChecks.first().check();
  equal(await contentChecks.count(), await contentChecks.evaluateAll(nodes => nodes.filter(node => node.checked).length), 'Select all must cover the enabled content shown for the batch.');
  await page.getByRole('group', { name: 'Prompt presets', exact: true }).locator('input[type="checkbox"]').first().check();
  await page.getByRole('group', { name: 'Background presets', exact: true }).locator('input[type="checkbox"]').first().check();

  await page.locator('#batch-quantity').fill('9');
  const leaveTrigger = page.locator('.app-shell__sidebar .primary-nav__link[href="/workspace"]');
  await leaveTrigger.click();
  const leaveDialog = page.getByRole('dialog');
  await leaveDialog.waitFor();
  equal(await leaveDialog.locator('.dialog__header h2').textContent(), 'Unsaved changes', 'Unsaved navigation must use the application dialog.');
  await page.keyboard.press('Escape');
  await leaveDialog.waitFor({ state: 'hidden' });
  equal(new URL(page.url()).pathname, '/generate/batches', 'Cancelling the dialog must keep the batch page open.');
  await expectFocus(page, leaveTrigger, 'Escape from the unsaved dialog must restore the navigation trigger focus.');
  await page.getByRole('button', { name: 'Save batch draft' }).click();

  await page.locator('.app-shell__sidebar .primary-nav__link[href="/workspace"]').click();
  await page.locator('.app-shell__sidebar .primary-nav__link[href="/generate/batches"]').click();
  await page.locator('#batch-quantity').fill('10');
  const backAttempt = page.goBack({ timeout: 1_000 }).catch(() => null);
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').locator('.dialog__footer button').first().click();
  await backAttempt;
  equal(new URL(page.url()).pathname, '/generate/batches', 'Cancelling browser back must keep the batch page open.');

  await page.setViewportSize({ width: 1024, height: 768 });
  const outputProfile = page.locator('#batch-output-profile');
  equal(await outputProfile.evaluate(element => element.scrollHeight <= element.clientHeight + 2), true, 'The output profile must be fully visible at 1024 pixels.');

  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/generate/content', 'zh-CN');
  const basePrompt = await page.locator('#content-base-prompt').inputValue();
  equal(basePrompt.length > 0, true, 'The content editor must show the fixed English base video prompt.');
  equal(/[\u3400-\u9fff]/u.test(basePrompt), false, 'The base video prompt must contain only explicit English fragments.');
  equal(await page.locator('#content-true-emotion').inputValue(), 'sadness', 'The content editor must preserve the stored emotion value across locales.');

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/generate/content');
  const mobileContentSearch = page.getByRole('searchbox', { name: 'Search', exact: true });
  equal(await mobileContentSearch.isVisible(), true, 'The mobile content search must keep its complete accessible label.');
  equal(await mobileContentSearch.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'The mobile content search field must fit its container.');

  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 768 });
    await open(page, '/generate/jobs?job=1');
    await expectContained(page.locator('.generation-layout--jobs .generation-list'), `The job list must not overflow at ${width} pixels.`);
    await expectContained(page.locator('.generation-layout--jobs .generation-filters'), `The job filters must not overflow at ${width} pixels.`);
    await page.getByText('128/128', { exact: true }).first().waitFor();
    const assignedGpus = await page.locator('.generation-result-card__header p').allTextContents();
    equal(assignedGpus.some(value => value.includes('GPU0')) && assignedGpus.some(value => value.includes('GPU1')), true, 'Historical dual GPU items must preserve both GPU assignments.');
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/generate/jobs');
  equal(await page.locator('.generation-job-detail').isVisible(), false, 'Mobile jobs must open on the list.');
  equal(await page.locator('.generation-job-row').count(), 1, 'Mobile jobs must expose every current API job in the list.');
  await expectNamedControls(page, '.generation-list', 'Mobile job list controls must remain named');

  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/generate/test');
  const testLayout = await page.evaluate(() => {
    const panels = [...document.querySelectorAll('.generation-layout > .generation-form')].map(element => element.getBoundingClientRect());
    return { setupLeft: panels[0]?.left, previewLeft: panels[1]?.left, height: document.documentElement.scrollHeight };
  });
  equal(testLayout.setupLeft < testLayout.previewLeft, true, 'Test setup must appear before prompt preview.');
  equal(testLayout.height < 2600, true, 'The desktop test bench must avoid an excessively tall page.');
  equal(await page.locator('.generation-comparisons').count(), 1, 'The test workflow must keep model comparisons in a distinct fieldset.');

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/generate/test');
  const mobileTestHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  equal(mobileTestHeight < 3600, true, `The mobile test bench must avoid a 4000 pixel page. Height: ${mobileTestHeight}`);

  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, '/generate/presets');
  const presetTimes = await page.locator('.generation-selection-card--preset time').evaluateAll(elements =>
    elements.map(element => ({ width: element.getBoundingClientRect().width, scrollWidth: element.scrollWidth, whiteSpace: getComputedStyle(element).whiteSpace })),
  );
  equal(presetTimes.every(item => item.width >= item.scrollWidth && item.whiteSpace === 'nowrap'), true, 'Preset times must not wrap or compress.');

  await open(page, '/generate/test');
  const categoryFit = await page.locator('#test-category').evaluate(element => element.scrollWidth <= element.clientWidth);
  equal(categoryFit, true, 'The test category must be fully visible at 1024 pixels.');

  await page.setViewportSize({ width: 768, height: 900 });
  await open(page, '/workspace');
  equal(await page.locator('.workspace-datasets .table-shell table').evaluate(element => getComputedStyle(element).display), 'block', 'The 768 pixel workspace must use the compact dataset layout.');
  await expectContained(page.locator('.workspace-datasets .table-shell'), 'The compact dataset layout must not require horizontal scrolling.');

  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/review?sample=CS-000001');
  const desktopReview = await page.evaluate(() => {
    const queue = document.querySelector('.review-queue')?.getBoundingClientRect();
    const media = document.querySelector('.review-media')?.getBoundingClientRect();
    const decision = document.querySelector('.review-decision')?.getBoundingClientRect();
    const video = document.querySelector('.review-media video');
    if (!queue || !media || !decision || !(video instanceof HTMLVideoElement)) return null;
    const videoBounds = video.getBoundingClientRect();
    return {
      threeColumns: queue.right < media.left && media.right < decision.left,
      videoContained: videoBounds.left >= media.left && videoBounds.right <= media.right && videoBounds.bottom <= media.bottom,
      controls: video.controls,
      objectFit: getComputedStyle(video).objectFit,
    };
  });
  equal(desktopReview !== null, true, 'The desktop review detail must render.');
  equal(desktopReview.threeColumns, true, 'The 1440 pixel review must keep queue, media, and decision in three columns.');
  equal(desktopReview.videoContained, true, 'The desktop review video must remain fully inside its panel.');
  equal(desktopReview.controls, true, 'Review media must expose native playback controls.');
  equal(desktopReview.objectFit, 'contain', 'Review media must preserve the complete frame.');

  let reviewVideo = page.locator('.review-media video');
  equal(await reviewVideo.evaluate(video => video.muted), false, 'VA review media must remain unmuted.');
  await open(page, '/review?sample=CS-000004');
  reviewVideo = page.locator('.review-media video');
  equal(await reviewVideo.evaluate(video => video.muted), true, 'VT review media must remain muted.');

  for (const [width, height] of [[1024, 768], [768, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await open(page, '/review?sample=CS-000001');
    const positions = await page.evaluate(() => ({
      media: document.querySelector('.review-media')?.getBoundingClientRect().top,
      decision: document.querySelector('.review-decision')?.getBoundingClientRect().top,
      context: document.querySelector('.review-context')?.getBoundingClientRect().top,
      generation: document.querySelector('.review-generation-record')?.getBoundingClientRect().top,
    }));
    equal(positions.media < positions.decision && positions.decision < positions.context && positions.context < positions.generation, true, `Review order must be media, decision, context, generation record at ${width} pixels.`);
    equal(await page.locator('.review-generation-record').isVisible(), true, `Generation record must be visible at ${width} pixels.`);
  }

  const sampleContext = await page.locator('.review-context').textContent();
  equal(sampleContext.includes('LTX-2.5'), true, 'Sample context must retain the sample model.');
  for (const value of ['INT8', 'GPU0', '3201']) equal(sampleContext.includes(value), false, `Sample context must exclude generation value ${value}.`);
  const generationRecord = await page.locator('.review-generation-record').textContent();
  for (const value of ['LTX-2.5', 'INT8', 'GPU0', '3201', '1']) equal(generationRecord.includes(value), true, `Generation record must contain ${value}.`);
  equal(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth), true, 'The 390 pixel review detail must not overflow horizontally.');
  equal(await page.locator('.review-queue').isVisible(), false, 'The 390 pixel selected view must hide the queue.');
  await page.getByRole('button', { name: 'Back to queue', exact: true }).click();
  await page.locator('.review-queue').waitFor({ state: 'visible' });
  equal(new URL(page.url()).searchParams.has('sample'), false, 'Back to queue must remove only the sample parameter.');
  equal(await page.locator('.review-detail').count(), 0, 'The mobile queue view must not retain stale detail.');

  await page.getByRole('button', { name: 'Open navigation' }).click();
  equal(await page.locator('.mobile-drawer .primary-nav__link[aria-current="page"]').textContent(), 'Review', 'Mobile navigation must mark the review route.');
  await page.keyboard.press('Escape');
  await open(page, '/archive');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  equal(await page.locator('.mobile-drawer .primary-nav__link[aria-current="page"]').textContent(), 'Archive', 'Mobile navigation must mark the archive route.');
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/archive?dataset=1&category=A-VA&page=2');
  const archivedSample = 'CS-000051';
  await page.getByRole('link', { name: archivedSample, exact: true }).click();
  equal(new URL(page.url()).pathname, '/review', 'An archive sample must open in review.');
  equal(new URL(page.url()).searchParams.get('sample'), archivedSample, 'Review must open the selected archive sample.');
  equal(new URL(page.url()).searchParams.get('returnTo'), '/archive?dataset=1&category=A-VA&page=2', 'Archive links must preserve a safe in-app source route.');
  await page.getByRole('button', { name: 'Back to previous page', exact: true }).click();
  equal(new URL(page.url()).pathname, '/archive', 'The mobile return action must return to archive.');
  equal(new URL(page.url()).searchParams.get('page'), '2', 'The mobile return action must restore archive page two.');

  await open(page, '/generate/content');
  equal(await page.locator('.generation-list').isVisible(), true, 'Mobile content must open on the list.');
  equal(await page.locator('.generation-editor').isVisible(), false, 'Mobile content must not place the editor below the list.');
  await page.locator('.generation-selection-card').first().click();
  equal(await page.locator('.generation-list').isVisible(), false, 'Selecting mobile content must open the editor.');
  equal(await page.locator('.generation-editor').isVisible(), true, 'The mobile content editor must be visible after selection.');
  equal(await page.locator('.generation-editor').evaluate(element => element.getBoundingClientRect().top < 900), true, 'The mobile content editor must open near the top of the page.');
  await page.locator('.generation-editor-back').click();
  equal(await page.locator('.generation-list').isVisible(), true, 'The mobile editor must return to the content list.');

  await open(page, '/generate/test');
  await page.evaluate(() => window.scrollTo(0, 420));
  equal(await page.evaluate(() => window.scrollY > 0), true, 'The generate page must be scrollable before switching sections.');
  await page.locator('#generate-section-select').evaluate(element => {
    element.value = 'presets';
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForURL('**/generate/presets');
  await page.waitForFunction(() => window.scrollY === 0);
  equal(await page.evaluate(() => window.scrollY), 0, 'Switching generate sections must return to the page top.');

  await open(page, '/settings');
  await expectNamedControls(page, '.app-shell', 'Global navigation and settings controls must have accessible names');
  const reviewerMenu = page.locator('.reviewer-menu');
  await reviewerMenu.locator('summary').click();
  await reviewerMenu.getByRole('link', { name: 'My statistics' }).click();
  await page.waitForURL('**/me/statistics');
  equal(await reviewerMenu.getAttribute('open'), null, 'The name menu must close after route changes.');
  await reviewerMenu.locator('summary').click();
  await page.keyboard.press('Escape');
  equal(await reviewerMenu.getAttribute('open'), null, 'Escape must close the name menu.');
  equal(await reviewerMenu.locator('summary').evaluate(element => element === document.activeElement), true, 'Closing the name menu must restore focus to its summary.');

  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/generate/jobs?job=1');
  equal(await page.locator('.generation-current-input').count(), 2, 'The API job detail must expose both completed item inputs.');

  await open(page, '/settings');
  await page.getByRole('button', { name: 'Recheck example status' }).click();
  await page.locator('#settings-example-status p').getByText(/Example status refreshed at/u).waitFor();
  equal(await page.locator('#settings-example-status').getAttribute('aria-live'), 'polite', 'The success status must use a polite live region.');

  await open(page, '/me/statistics');
  await expectNamedControls(page, '.app-shell', 'Global navigation and statistics controls must have accessible names');
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/me/statistics');
  equal(await page.locator('.statistics-chart').getAttribute('aria-hidden'), 'true', 'The visual trend chart must be hidden from screen readers.');
  equal(await page.getByRole('table').count(), 1, 'The trend must expose one table alternative to screen readers.');
  const statisticsTableAlternative = await page.locator('.statistics-activity__table-alternative').evaluate(element => ({
    position: getComputedStyle(element).position,
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }));
  equal(statisticsTableAlternative.position, 'absolute', 'The table alternative must not occupy the visual layout.');
  equal(statisticsTableAlternative.width <= 1 && statisticsTableAlternative.height <= 1, true, 'The table alternative must use standard visual hiding.');
  const statisticsHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  equal(statisticsHeight < 2200, true, `The mobile statistics page must stay compact. Height: ${statisticsHeight}`);
  await page.locator('#statistics-start-date').fill('2020-01-01');
  await page.locator('#statistics-end-date').fill('2020-01-30');
  await page.getByRole('heading', { name: 'No matching records' }).waitFor();
  await page.locator('.state-view').getByRole('button', { name: 'Reset filters' }).click();
  await page.locator('.statistics-metrics').waitFor();
  await page.locator('#statistics-start-date').fill('2026-08-11');
  await page.locator('#statistics-end-date').fill('2026-08-01');
  equal(await page.locator('#statistics-date-error').getAttribute('role'), 'alert', 'Invalid statistic dates must be announced as an alert.');

  await open(page, '/settings?state=error');
  equal(await page.locator('.state-view').getAttribute('aria-live'), 'assertive', 'Failure state must be announced immediately.');
  equal(await page.getByRole('button', { name: 'Reload' }).count(), 1, 'Failure state must provide one clear action.');

  await open(page, '/settings');
  await page.locator('body').press('Tab');
  equal(await page.locator('.skip-link').evaluate(element => element === document.activeElement), true, 'The first keyboard stop must skip to main content.');
  await page.locator('.skip-link').press('Enter');
  equal(await page.locator('#main-content').evaluate(element => element === document.activeElement), true, 'The skip link must focus the main content.');

  const reviewerlessContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const reviewerlessPage = await reviewerlessContext.newPage();
  await reviewerlessPage.goto(`${baseUrl}/workspace`, { waitUntil: 'networkidle' });
  const firstReviewerDialog = reviewerlessPage.locator('dialog[open]');
  await firstReviewerDialog.waitFor();
  await expectDialogBasics(reviewerlessPage, 'The first name dialog', false);
  await reviewerlessContext.close();

  await resetPrototypeState(page);
  const focusedViewports = [[1440, 900], [1024, 768], [768, 900], [390, 844]];
  for (const locale of ['zh-CN', 'en-US']) {
    for (const [width, height] of focusedViewports) {
      await expectReviewMediaFit(page, 'CS-000001', locale, width, height, false);
      await expectReviewMediaFit(page, 'CS-000004', locale, width, height, true);
      await expectTestGuidance(page, locale, width, height);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, '/generate/content', locale);
    const contentRelationship = await page.locator('.generation-page__subtitle').innerText();
    equal(contentRelationship.includes(locale === 'zh-CN' ? '提示词预设' : 'prompt preset'), true, `${locale} content page must explain the prompt preset relationship.`);
    equal(contentRelationship.includes(locale === 'zh-CN' ? '正提示词和负提示词' : 'positive prompt and negative prompt'), true, `${locale} content page must explain the final video input.`);

    await open(page, '/generate/presets', locale);
    const presetRelationship = await page.locator('.generation-page__subtitle').innerText();
    equal(presetRelationship.includes(locale === 'zh-CN' ? '内容方案' : 'content plan'), true, `${locale} preset page must explain the content plan relationship.`);
    equal(presetRelationship.includes(locale === 'zh-CN' ? '正面示例和反面示例' : 'Positive and negative examples'), true, `${locale} preset page must explain how examples are used.`);
    equal(presetRelationship.includes(locale === 'zh-CN' ? '正提示词和负提示词' : 'positive prompt and negative prompt'), true, `${locale} preset page must explain the final video input.`);
  }

  const routes = [
    '/workspace',
    '/generate/batches',
    '/generate/test',
    '/generate/content',
    '/generate/presets',
    '/generate/jobs',
    '/review?sample=CS-000001',
    '/archive',
    '/settings',
    '/me/statistics',
  ];
  const viewports = focusedViewports;
  for (const locale of ['zh-CN', 'en-US']) {
    for (const [width, height] of viewports) {
      for (const route of routes) {
        if ((route === '/settings' || route === '/me/statistics') && width === 768) continue;
        await expectNoOverflow(page, route, locale, width, height);
      }
    }
  }

  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
    await page.setViewportSize({ width, height });
    for (const route of ['/settings', '/me/statistics']) {
      for (const state of ['loading', 'empty', 'filtered', 'error', 'conflict']) {
        await expectNoOverflow(page, `${route}?state=${state}`, 'en-US', width, height);
      }
    }
    await open(page, '/settings');
    await page.getByRole('button', { name: 'Recheck example status' }).click();
    await page.locator('#settings-example-status p').getByText(/Example status refreshed at/u).waitFor();
    await expectContained(page.locator('.settings-page'), `Settings success state must fit at ${width} pixels.`);
  }

  equal(routerWarnings.length, 0, `React Router warnings: ${routerWarnings.join(' | ')}`);
  equal(consoleErrors.length, 0, `Browser console errors: ${consoleErrors.join(' | ')}`);
  equal(pageErrors.length, 0, `Browser page errors: ${pageErrors.join(' | ')}`);
  console.log('Browser checks passed: core interactions, dialogs, states, and bilingual viewport checks.');
} finally {
  if (browser) await browser.close();
  await server.close();
}
