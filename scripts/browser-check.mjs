import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import {
  createBrowserApiFixture,
  gpuSlotsFixture,
  installPreferences,
  preferenceKeys,
} from './browser-fixtures.mjs';

const playwrightModule = process.env.CONFLICTSTUDIO_PLAYWRIGHT_MODULE;
if (!playwrightModule) throw new Error('CONFLICTSTUDIO_PLAYWRIGHT_MODULE is required.');
const { chromium } = await import(pathToFileURL(playwrightModule).href);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = resolve(projectRoot, 'frontend');
const baseUrl = 'http://127.0.0.1:4173';
const artifactRoot = process.env.CONFLICTSTUDIO_BROWSER_ARTIFACT_DIR;
if (artifactRoot) mkdirSync(artifactRoot, { recursive: true });
const gpuSlotContractKeys = [
  'activeJobId', 'availability', 'checkedAt', 'gpuName', 'loadedModel',
  'loadedPrecision', 'memory', 'revision', 'serviceStatus', 'slot', 'statusReason',
];
for (const slot of gpuSlotsFixture) {
  assert.deepEqual(Object.keys(slot).sort(), gpuSlotContractKeys, `${slot.slot} fixture must match the current GPU slot response contract.`);
  assert.deepEqual(Object.keys(slot.memory).sort(), ['totalMiB', 'usedMiB'], `${slot.slot} memory fixture must match the current GPU memory response contract.`);
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
}

async function setLocale(page, locale) {
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: preferenceKeys.locale, value: locale });
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

async function expectJobPromptLayout(page, locale, width, height) {
  await page.setViewportSize({ width, height });
  await open(page, '/generate/jobs?job=1', locale);
  const detail = page.locator('.generation-job-detail');
  await detail.waitFor();
  equal(await detail.isVisible(), true, `${locale} job detail must be visible at ${width} pixels.`);
  const card = page.locator('.generation-result-card').first();
  const blocks = card.locator('.generation-current-input__prompt');
  equal(await blocks.count(), 2, `${locale} job result must show separate positive and negative prompt blocks at ${width} pixels.`);
  const layout = await blocks.evaluateAll(elements => elements.map(element => {
    const bounds = element.getBoundingClientRect();
    const cardBounds = element.closest('.generation-result-card')?.getBoundingClientRect();
    const pre = element.querySelector('pre');
    return {
      top: bounds.top,
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
      cardLeft: cardBounds?.left ?? 0,
      cardRight: cardBounds?.right ?? 0,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      whiteSpace: pre ? getComputedStyle(pre).whiteSpace : '',
    };
  }));
  equal(layout[1].top >= layout[0].bottom + 6, true, `${locale} prompt blocks must not overlap at ${width} pixels.`);
  equal(layout.every(item => item.left >= item.cardLeft && item.right <= item.cardRight), true, `${locale} prompt blocks must stay inside the result card at ${width} pixels.`);
  equal(layout.every(item => item.scrollWidth <= item.clientWidth), true, `${locale} prompt blocks must wrap long text at ${width} pixels.`);
  equal(layout.every(item => item.whiteSpace === 'pre-wrap'), true, `${locale} prompt blocks must preserve line breaks at ${width} pixels.`);
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

async function resetBrowserSession(page) {
  await page.evaluate(() => {
    sessionStorage.clear();
  });
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
let context;
let tracingStarted = false;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await installPreferences(context);
  if (artifactRoot) {
    await context.tracing.start({ screenshots: true, snapshots: true });
    tracingStarted = true;
  }
  const page = await context.newPage();
  const api = createBrowserApiFixture();
  await api.install(page);
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
  equal(await page.evaluate(key => localStorage.getItem(key), preferenceKeys.reviewerId), '1', 'The current reviewer must come from browser preferences.');
  equal(await page.getByRole('columnheader', { name: 'Purpose', exact: true }).count(), 1, 'The dataset purpose column must use the translated user-facing label.');
  equal((await page.locator('.workspace-datasets').innerText()).includes('workspaceSettingsStatistics.workspace.datasets.purposeLabel'), false, 'The workspace must not expose an internal translation key.');
  const datasetNameLayout = await page.locator('.workspace-dataset-name').evaluateAll(elements => elements.map(element => {
    const titleElement = element.querySelector('.workspace-dataset-name__title');
    const noteElement = element.querySelector('.workspace-dataset-name__note');
    const title = titleElement?.getBoundingClientRect();
    const note = noteElement?.getBoundingClientRect();
    return { titleBottom: title?.bottom ?? 0, noteTop: note?.top ?? 0, noteFontSize: noteElement ? Number.parseFloat(getComputedStyle(noteElement).fontSize) : 0, titleFontSize: titleElement ? Number.parseFloat(getComputedStyle(titleElement).fontSize) : 0 };
  }));
  equal(datasetNameLayout.every(item => item.noteTop >= item.titleBottom && item.noteFontSize < item.titleFontSize), true, 'Dataset notes must appear as a smaller second line below the name.');

  await open(page, '/generate/batches');
  const gpuFieldset = page.getByRole('group', { name: 'GPU', exact: true });
  const gpuChecks = gpuFieldset.locator('input[type="checkbox"]');
  equal(await gpuChecks.count(), 2, 'The production batch must show two GPUs.');
  equal(await gpuChecks.evaluateAll(nodes => nodes.every(node => !node.disabled)), true, 'Both available GPUs must be selectable.');
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
  const promptPresetChecks = page.getByRole('group', { name: 'Prompt presets', exact: true }).locator('input[type="checkbox"]');
  await promptPresetChecks.first().check();
  const contentSelectionBeforeScenes = await contentChecks.evaluateAll(nodes => nodes.map(node => node.checked));
  const promptSelectionBeforeScenes = await promptPresetChecks.evaluateAll(nodes => nodes.map(node => node.checked));
  const sceneFieldset = page.getByRole('group', { name: 'Scene presets', exact: true });
  const sceneChecks = sceneFieldset.locator('input[type="checkbox"]');
  equal(await sceneChecks.count(), 2, 'Only active scene presets must be available to the batch.');
  const selectAllScenes = sceneFieldset.getByRole('button', { name: 'Select all scene presets', exact: true });
  await selectAllScenes.click();
  equal(await sceneChecks.evaluateAll(nodes => nodes.filter(node => node.checked).length), 2, 'Select all scene presets must select every active scene preset.');
  assert.deepEqual(await contentChecks.evaluateAll(nodes => nodes.map(node => node.checked)), contentSelectionBeforeScenes, 'Selecting scene presets must not change content items.');
  assert.deepEqual(await promptPresetChecks.evaluateAll(nodes => nodes.map(node => node.checked)), promptSelectionBeforeScenes, 'Selecting scene presets must not change prompt presets.');
  equal(await selectAllScenes.isDisabled(), true, 'Select all scene presets must become disabled after every available scene is selected.');
  const unsavedBatchStatus = page.locator('.generation-unsaved-status');
  equal(await unsavedBatchStatus.textContent(), 'Unsaved changes', 'Selecting all scene presets must show the unsaved batch status.');
  equal(await unsavedBatchStatus.getAttribute('role'), 'status', 'The unsaved batch status must be exposed to assistive technology.');
  equal(await page.getByRole('button', { name: 'Save batch draft' }).isEnabled(), true, 'Selecting all scene presets must enable saving the batch.');
  if (artifactRoot) {
    await page.waitForFunction(() => sessionStorage.getItem('conflictstudio.generation.draft.batch-form-v2') !== null);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(artifactRoot, 'batch-unsaved-390-en.png'), fullPage: true });
    const storedBatchDraft = await page.evaluate(() => sessionStorage.getItem('conflictstudio.generation.draft.batch-form-v2'));
    const screenshotPage = await context.newPage();
    await api.install(screenshotPage);
    await screenshotPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await screenshotPage.evaluate(({ localeKey, draftKey, draft }) => {
      localStorage.setItem(localeKey, 'zh-CN');
      sessionStorage.setItem(draftKey, draft);
    }, { localeKey: preferenceKeys.locale, draftKey: 'conflictstudio.generation.draft.batch-form-v2', draft: storedBatchDraft });
    await screenshotPage.setViewportSize({ width: 1440, height: 900 });
    await screenshotPage.goto(`${baseUrl}/generate/batches`, { waitUntil: 'networkidle' });
    await screenshotPage.locator('.generation-unsaved-status').filter({ hasText: '有未保存的更改' }).waitFor();
    await screenshotPage.screenshot({ path: join(artifactRoot, 'batch-unsaved-1440-zh.png'), fullPage: true });
    await screenshotPage.close();
    await page.setViewportSize({ width: 1440, height: 900 });
  }

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
  await page.waitForFunction(() => document.querySelector('#batch-saved-draft')?.value !== 'new');
  await page.waitForFunction(() => document.querySelector('.generation-unsaved-status')?.textContent === '');
  equal(await unsavedBatchStatus.textContent(), '', 'The unsaved batch status must clear after the save succeeds.');
  assert.deepEqual(api.state.batchDrafts[0].backgroundPresets.map(item => item.id), [1, 2], 'The saved batch must persist every selected active scene preset.');

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

  for (const locale of ['zh-CN', 'en-US']) {
    for (const [width, height] of [[1440, 900], [1024, 768], [768, 900], [390, 844]]) {
      await expectJobPromptLayout(page, locale, width, height);
    }
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

  for (const [width, height] of [[1024, 768], [768, 900]]) {
    await page.setViewportSize({ width, height });
    await open(page, '/workspace');
    equal(await page.locator('.workspace-datasets .table-shell table').evaluate(element => getComputedStyle(element).display), 'block', `The ${width} pixel workspace must use the compact dataset layout.`);
    await expectContained(page.locator('.workspace-datasets .table-shell'), `The ${width} pixel dataset layout must not require horizontal scrolling.`);
    const actionBounds = await page.locator('.workspace-datasets__actions .button').evaluateAll(elements => elements.map(element => {
      const bounds = element.getBoundingClientRect();
      const panel = element.closest('.workspace-datasets')?.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, panelLeft: panel?.left ?? 0, panelRight: panel?.right ?? 0 };
    }));
    equal(actionBounds.every(bounds => bounds.left >= bounds.panelLeft && bounds.right <= bounds.panelRight), true, `Dataset actions must remain visible at ${width} pixels.`);
    if (artifactRoot && width === 1024) await page.screenshot({ path: join(artifactRoot, 'workspace-1024.png'), fullPage: true });
  }

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
  for (const value of ['BF16', 'GPU0', '424243', '9001']) equal(sampleContext.includes(value), false, `Sample context must exclude generation value ${value}.`);
  const generationRecord = await page.locator('.review-generation-record').textContent();
  for (const value of ['LTX-2.5', 'BF16', 'GPU0', '424243', '3']) equal(generationRecord.includes(value), true, `Generation record must contain ${value}.`);
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
  await open(page, '/archive?dataset=1&search=CS-&category=C-VA&page=2');
  const archivedSample = 'CS-000051';
  await page.getByRole('link', { name: archivedSample, exact: true }).click();
  equal(new URL(page.url()).pathname, '/review', 'An archive sample must open in review.');
  equal(new URL(page.url()).searchParams.get('sample'), archivedSample, 'Review must open the selected archive sample.');
  equal(new URL(page.url()).searchParams.get('returnTo'), '/archive?dataset=1&search=CS-&category=C-VA&page=2', 'Archive links must preserve the exact source filters and page.');
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('unrelatedHistory', '1');
    history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.getByRole('button', { name: 'Back to previous page', exact: true }).click();
  equal(new URL(page.url()).pathname, '/archive', 'The mobile return action must return to archive.');
  equal(new URL(page.url()).searchParams.get('page'), '2', 'The mobile return action must restore archive page two.');
  equal(new URL(page.url()).searchParams.get('search'), 'CS-', 'The mobile return action must restore the archive search filter.');
  equal(new URL(page.url()).searchParams.get('category'), 'C-VA', 'The mobile return action must restore the archive category filter.');

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
  equal((await page.locator('.settings-service-list').innerText()).includes('2 datasets'), true, 'Settings must show the datasets API response.');
  equal((await page.locator('.settings-service-list').innerText()).includes('Installed'), true, 'Settings must show the health API renderer state.');
  equal(await page.locator('.settings-gpu-row').count(), 2, 'Settings must show both GPU API records.');
  const originalGpu0 = { ...gpuSlotsFixture[0] };
  const statusCases = [
    ['Available', 'Ready for a task', '可以运行任务'],
    ['Reserved', 'Reserved for a task', '已为任务预留'],
    ['Busy', 'Busy with another task', '正在处理其他任务'],
    ['ExternalOccupied', 'In use by another process', '被其他进程占用'],
    ['Unknown', 'Current ownership cannot be confirmed', '无法确认当前归属'],
  ];
  for (const [availability, englishReason, chineseReason] of statusCases) {
    Object.assign(gpuSlotsFixture[0], originalGpu0, { availability, activeJobId: null, loadedModel: null, loadedPrecision: null, serviceStatus: 'stopped' });
    await open(page, '/settings', 'en-US');
    const englishRow = await page.locator('.settings-gpu-row').first().innerText();
    equal(englishRow.includes(englishReason), true, `${availability} must have an English reason.`);
    if (availability !== 'Available') equal(englishRow.includes('Ready for a task'), false, `${availability} must not claim that a task can start.`);
    await open(page, '/settings', 'zh-CN');
    const chineseRow = await page.locator('.settings-gpu-row').first().innerText();
    equal(chineseRow.includes(chineseReason), true, `${availability} must have a Chinese reason.`);
    if (availability !== 'Available') equal(chineseRow.includes('可以运行任务'), false, `${availability} must not claim that a task can start in Chinese.`);
  }
  Object.assign(gpuSlotsFixture[0], originalGpu0);
  await open(page, '/settings', 'en-US');
  await page.getByRole('button', { name: 'Check again' }).click();
  await page.locator('.settings-services__recheck').getByText('Current status is shown below.').waitFor();
  equal(await page.locator('.settings-services__recheck').getAttribute('aria-live'), 'polite', 'The service recheck result must use a polite live region.');

  await page.locator('#new-reviewer-name').fill('Avery');
  await page.getByRole('button', { name: 'Add name' }).click();
  await page.locator('.settings-reviewer-list').getByText('Avery', { exact: true }).waitFor();
  const reviewerCreate = api.state.requests.findLast(request => request.method === 'POST' && request.path === '/api/reviewers');
  assert.deepEqual(reviewerCreate?.body, { name: 'Avery' }, 'Reviewer creation must use the current Reviewer contract.');
  await page.getByRole('button', { name: 'Rename current name' }).click();
  const renameDialog = page.getByRole('dialog', { name: 'Rename current name' });
  await renameDialog.locator('#rename-reviewer-name').fill('Alex');
  await renameDialog.getByRole('button', { name: 'Save name' }).click();
  await page.locator('.settings-reviewer-list').getByText('Alex', { exact: true }).waitFor();
  const reviewerRename = api.state.requests.findLast(request => request.method === 'PATCH' && request.path === '/api/reviewers/2');
  assert.deepEqual(reviewerRename?.body, { name: 'Alex', expectedRevision: 1 }, 'Reviewer rename must send its expected revision.');

  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/review?sample=CS-000001');
  await page.getByRole('button', { name: 'Accepted', exact: true }).click();
  await page.waitForFunction(() => new URL(window.location.href).searchParams.get('sample') === 'CS-000002');
  const singleReview = api.state.requests.findLast(request => request.method === 'POST' && request.path === '/api/reviews');
  assert.deepEqual(singleReview?.body, { sampleId: 1, reviewerId: 2, decision: 'Accepted', note: '', expectedRevision: 1, expectedReviewRevision: 0 }, 'Single review must send the complete revision-aware contract.');
  await page.getByRole('button', { name: 'Back to queue', exact: true }).click();
  const queueChecks = page.locator('.review-queue__check input');
  await queueChecks.nth(0).check();
  await queueChecks.nth(1).check();
  await page.getByRole('button', { name: 'Apply to selected samples' }).click();
  const batchDialog = page.getByRole('dialog');
  await batchDialog.getByRole('button', { name: 'Apply Accepted' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.review-queue__check input:checked').length === 0);
  const batchReview = api.state.requests.findLast(request => request.method === 'POST' && request.path === '/api/reviews/batch');
  equal(batchReview?.body.items.length, 2, 'Batch review must include every selected sample.');
  equal(batchReview?.body.items.every(item => item.reviewerId === 2 && item.expectedRevision === 1 && item.expectedReviewRevision === 0), true, 'Batch review items must use the current reviewer and both revision fields.');

  await open(page, '/archive');
  await page.getByRole('button', { name: 'Preview sync' }).click();
  await page.getByRole('heading', { name: 'Sync preview' }).waitFor();
  const archivePreview = api.state.requests.findLast(request => request.method === 'POST' && request.path === '/api/archives/preview');
  assert.deepEqual(archivePreview?.body, { datasetId: 1 }, 'Archive preview must use the selected dataset.');
  await page.getByRole('button', { name: 'Sync archive' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sync archive' }).click();
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  const archiveSync = api.state.requests.findLast(request => request.method === 'POST' && request.path === '/api/archives/sync');
  assert.deepEqual(Object.keys(archiveSync?.body ?? {}).sort(), ['added', 'datasetId', 'expectedArchiveRevision', 'removed', 'unchangedCount', 'updated'], 'Archive sync must send the complete preview contract.');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download JSONL' }).click();
  const manifestDownload = await downloadPromise;
  equal(manifestDownload.suggestedFilename(), 'manifest.jsonl', 'Archive manifest must download as JSONL.');

  await open(page, '/me/statistics');
  await expectNamedControls(page, '.app-shell', 'Global navigation and statistics controls must have accessible names');
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/me/statistics');
  equal(await page.locator('.statistics-chart').getAttribute('role'), 'img', 'The visual trend chart must have an accessible image role.');
  equal(await page.getByRole('table').count(), 1, 'The trend must expose one table alternative to screen readers.');
  const statisticsHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  equal(statisticsHeight < 2200, true, `The mobile statistics page must stay compact. Height: ${statisticsHeight}`);
  equal((await page.locator('.statistics-metrics').innerText()).includes('4'), true, 'The statistics page must render a nonzero API response.');
  await page.locator('#statistics-start').fill('2020-01-01');
  await page.locator('#statistics-end').fill('2020-01-30');
  await page.getByRole('heading', { name: 'No matching records' }).waitFor();
  const zeroStatisticsRequest = api.state.requests.findLast(request => request.method === 'GET' && request.path.endsWith('/statistics') && request.query.endDate === '2020-01-30');
  equal(Boolean(zeroStatisticsRequest), true, 'The statistics page must request the zero-result date range from the API.');
  await page.locator('.state-view').getByRole('button', { name: 'Clear filters' }).click();
  await page.locator('.statistics-metrics').waitFor();
  await page.locator('#statistics-start').fill('2026-08-11');
  await page.locator('#statistics-end').fill('2026-08-01');
  const statisticsStart = page.locator('#statistics-start');
  equal(await statisticsStart.getAttribute('aria-invalid'), 'true', 'An invalid statistics range must mark the start date as invalid.');
  const statisticsErrorId = await statisticsStart.getAttribute('aria-describedby');
  equal(Boolean(statisticsErrorId), true, 'An invalid statistics range must connect the start date to its error message.');
  equal(await page.locator(`[id=${JSON.stringify(statisticsErrorId)}]`).getAttribute('role'), 'alert', 'Invalid statistic dates must be announced as an alert.');

  await open(page, '/settings');
  await page.locator('body').press('Tab');
  equal(await page.locator('.skip-link').evaluate(element => element === document.activeElement), true, 'The first keyboard stop must skip to main content.');
  await page.locator('.skip-link').press('Enter');
  equal(await page.locator('#main-content').evaluate(element => element === document.activeElement), true, 'The skip link must focus the main content.');

  const reviewerlessContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const reviewerlessPage = await reviewerlessContext.newPage();
  await createBrowserApiFixture({ reviewers: [] }).install(reviewerlessPage);
  await reviewerlessPage.goto(`${baseUrl}/workspace`, { waitUntil: 'networkidle' });
  const firstReviewerDialog = reviewerlessPage.locator('dialog[open]');
  await firstReviewerDialog.waitFor();
  await expectDialogBasics(reviewerlessPage, 'The first name dialog', false);
  equal(await firstReviewerDialog.locator('input[type="radio"]').count(), 0, 'An empty Reviewer API must not show preset names.');
  equal(await firstReviewerDialog.locator('#first-reviewer-name').isVisible(), true, 'An empty Reviewer API must ask the user to create the first name.');
  await reviewerlessContext.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/review?sample=CS-000001', 'zh-CN');
  const chineseTransferTrigger = page.getByRole('button', { name: '修改类别', exact: true });
  await chineseTransferTrigger.click();
  const chineseTransferDialog = page.getByRole('dialog', { name: '修改样本类别' });
  await chineseTransferDialog.waitFor();
  equal((await chineseTransferDialog.textContent()).includes('保留的真实情感'), true, 'The Chinese classification dialog must explain the preserved true emotion.');
  equal((await chineseTransferDialog.textContent()).includes('修改后的表面情感'), true, 'The Chinese aligned form must show the automatic apparent emotion.');
  await page.keyboard.press('Tab');
  equal(await chineseTransferDialog.evaluate(element => element.contains(document.activeElement)), true, 'Tab must remain inside the classification dialog.');
  await page.keyboard.press('Escape');
  await chineseTransferDialog.waitFor({ state: 'hidden' });
  equal(await chineseTransferTrigger.evaluate(element => element === document.activeElement), true, 'Closing the classification dialog must restore focus to its trigger.');

  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/review?sample=CS-000004', 'en-US');
  await page.getByRole('button', { name: 'Change category', exact: true }).click();
  let classificationDialog = page.getByRole('dialog', { name: 'Change sample category' });
  const apparentEmotionInput = classificationDialog.getByLabel('New apparent emotion');
  await apparentEmotionInput.fill('sadness');
  equal(await classificationDialog.getByText('The apparent emotion must differ from the true emotion.').count(), 1, 'Matching emotions must show a field error.');
  equal(await classificationDialog.getByRole('button', { name: 'Save category change' }).isDisabled(), true, 'Matching emotions must disable classification submission.');
  await apparentEmotionInput.fill('calm');
  await classificationDialog.getByLabel('Modality carrying the true emotion').selectOption('Text');
  await classificationDialog.getByLabel('True emotion description after the change').fill('The text carries sadness while the face appears calm.');
  await classificationDialog.getByRole('button', { name: 'Save category change' }).click();
  await classificationDialog.waitFor({ state: 'hidden' });
  const alignedToConflict = api.state.requests.findLast(request => request.method === 'PATCH' && request.path === '/api/samples/4/classification');
  assert.deepEqual(alignedToConflict?.body, {
    expectedRevision: 1,
    targetCategory: 'C-VT',
    conflictDirection: 'Text',
    apparentEmotion: 'calm',
    trueEmotionDescription: 'The text carries sadness while the face appears calm.',
  }, 'A to C must send the apparent emotion, description, direction, and current revision.');
  await page.locator('.review-context').getByText('calm', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Change category', exact: true }).click();
  classificationDialog = page.getByRole('dialog', { name: 'Change sample category' });
  equal(await classificationDialog.getByLabel('New apparent emotion').count(), 0, 'C to A must not offer an editable apparent emotion.');
  equal((await classificationDialog.textContent()).includes('Apparent emotion after the change'), true, 'C to A must show the automatic aligned emotion.');
  await classificationDialog.getByLabel('True emotion description after the change').fill('The text and face now carry the same sadness.');
  await classificationDialog.getByRole('button', { name: 'Save category change' }).click();
  await classificationDialog.waitFor({ state: 'hidden' });
  const conflictToAligned = api.state.requests.findLast(request => request.method === 'PATCH' && request.path === '/api/samples/4/classification');
  assert.deepEqual(conflictToAligned?.body, {
    expectedRevision: 2,
    targetCategory: 'A-VT',
    conflictDirection: null,
    trueEmotionDescription: 'The text and face now carry the same sadness.',
  }, 'C to A must omit apparent emotion and let the service align it with the preserved true emotion.');
  await page.locator('.review-context').getByText('sadness', { exact: true }).first().waitFor();

  await resetBrowserSession(page);
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
    for (const route of ['/settings', '/me/statistics']) await expectNoOverflow(page, route, 'en-US', width, height);
    await open(page, '/settings');
    await page.getByRole('button', { name: 'Check again' }).click();
    await page.locator('.settings-services__recheck').getByText('Current status is shown below.').waitFor();
    await expectContained(page.locator('.settings-page'), `Settings success state must fit at ${width} pixels.`);
  }

  equal(api.state.requests.some(request => request.method === 'GET' && request.path === '/api/health'), true, 'Settings must read health from the API.');
  equal(api.state.requests.some(request => request.method === 'GET' && request.path === '/api/datasets'), true, 'Settings and filters must read datasets from the API.');
  equal(api.state.requests.some(request => request.method === 'GET' && request.path === '/api/gpu-slots'), true, 'Settings and generation must read GPU status from the API.');
  equal(api.state.requests.some(request => request.method === 'GET' && request.path === '/api/archives'), true, 'Archive must read its status from the API.');
  equal(api.state.mediaRequests > 0, true, 'Review and archive media must use the network media route.');
  if (artifactRoot) await page.screenshot({ path: join(artifactRoot, 'browser-check-final-390.png'), fullPage: true });

  equal(routerWarnings.length, 0, `React Router warnings: ${routerWarnings.join(' | ')}`);
  equal(consoleErrors.length, 0, `Browser console errors: ${consoleErrors.join(' | ')}`);
  equal(pageErrors.length, 0, `Browser page errors: ${pageErrors.join(' | ')}`);
  console.log('Browser checks passed: core interactions, dialogs, states, and bilingual viewport checks.');
} finally {
  if (context && tracingStarted && artifactRoot) await context.tracing.stop({ path: join(artifactRoot, 'browser-check-trace.zip') });
  if (browser) await browser.close();
  await server.close();
}
