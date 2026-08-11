import assert from 'node:assert/strict';
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
  const gpuFieldset = page.locator('fieldset[aria-describedby="batch-gpu-hint"]');
  const gpuChecks = gpuFieldset.locator('input[type="checkbox"]');
  equal(await gpuChecks.count(), 2, 'The production batch must show two GPUs.');
  equal(await gpuChecks.evaluateAll(nodes => nodes.every(node => !node.disabled)), true, 'Both example GPUs must be selectable.');
  if (!(await gpuChecks.nth(0).isChecked())) await gpuChecks.nth(0).check();
  if (!(await gpuChecks.nth(1).isChecked())) await gpuChecks.nth(1).check();
  equal(await gpuChecks.evaluateAll(nodes => nodes.filter(node => node.checked).length), 2, 'A production batch must allow both GPUs.');

  const contentFieldset = page.locator('fieldset[aria-describedby="batch-content-hint"]');
  await contentFieldset.getByRole('button').click();
  const contentChecks = contentFieldset.locator('input[type="checkbox"]');
  equal(await contentChecks.count(), await contentChecks.evaluateAll(nodes => nodes.filter(node => node.checked).length), 'Select all must cover the enabled content shown for the batch.');

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
  const promptParts = await page.locator('.generation-prompt-preview pre').allTextContents();
  equal(promptParts.length, 2, 'The content editor must show final positive and negative prompts.');
  equal(promptParts.every(value => !/[\u3400-\u9fff]/u.test(value)), true, 'Final video prompts must contain only explicit English fragments.');
  equal(await page.locator('#content-emotion option:checked').textContent(), '悲伤', 'Chinese content emotion must be localized.');

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/generate/content');
  equal(await page.locator('#content-search').getAttribute('placeholder'), 'Search name or scene', 'The mobile content search prompt must remain complete and concise.');
  equal(await page.locator('#content-search').evaluate(element => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return false;
    context.font = getComputedStyle(element).font;
    const placeholder = element.getAttribute('placeholder') ?? '';
    return context.measureText(placeholder).width + 28 <= element.clientWidth;
  }), true, 'The mobile content search prompt must fit inside the field.');

  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 768 });
    await open(page, '/generate/jobs?job=job-dual-history');
    await expectContained(page.locator('.generation-layout--jobs .generation-list'), `The job list must not overflow at ${width} pixels.`);
    await expectContained(page.locator('.generation-layout--jobs .generation-filters'), `The job filters must not overflow at ${width} pixels.`);
    await page.getByText('128/128', { exact: true }).first().waitFor();
    const assignedGpus = await page.locator('.generation-item-list li span:nth-of-type(2)').allTextContents();
    equal(assignedGpus.includes('GPU0') && assignedGpus.includes('GPU1'), true, 'Historical dual GPU items must preserve both GPU assignments.');
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/generate/jobs');
  equal(await page.locator('.generation-job-detail').isVisible(), false, 'Mobile jobs must open on the list.');
  await page.locator('.generation-job-row').first().click();
  equal(await page.locator('.generation-list').isVisible(), false, 'Selecting a mobile job must show its detail directly.');
  equal(await page.locator('.generation-job-detail').isVisible(), true, 'The selected mobile job detail must be visible.');
  await page.locator('.generation-job-back').click();
  equal(await page.locator('.generation-list').isVisible(), true, 'The mobile detail must return to the job list.');

  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/generate/test');
  const testLayout = await page.evaluate(() => {
    const gpu = document.querySelector('.generation-test-workflow > .generation-gpus').getBoundingClientRect();
    const form = document.querySelector('.generation-test-workflow > .generation-form').getBoundingClientRect();
    return { gpuTop: gpu.top, formTop: form.top, height: document.documentElement.scrollHeight };
  });
  equal(testLayout.gpuTop < testLayout.formTop, true, 'GPU status must appear before test configuration.');
  equal(testLayout.height < 2600, true, 'The desktop test bench must avoid an excessively tall page.');
  equal(await page.locator('.generation-test-section').count(), 3, 'The test workflow must separate configuration, model comparison, and prompts.');

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
  const categoryFit = await page.locator('#test-category').evaluate(element => {
    const selected = element instanceof HTMLSelectElement ? element.selectedOptions[0]?.textContent ?? '' : '';
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return false;
    context.font = getComputedStyle(element).font;
    return context.measureText(selected).width + 46 <= element.clientWidth;
  });
  equal(categoryFit, true, 'The test category must be fully visible at 1024 pixels.');

  await page.setViewportSize({ width: 768, height: 900 });
  await open(page, '/workspace');
  equal(await page.locator('.workspace-datasets .table-shell table').evaluate(element => getComputedStyle(element).display), 'block', 'The 768 pixel workspace must use the compact dataset layout.');
  await expectContained(page.locator('.workspace-datasets .table-shell'), 'The compact dataset layout must not require horizontal scrolling.');

  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/review?sample=CS-0008');
  const reviewHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  equal(reviewHeight < 1500, true, 'Visually hidden review text must not create a tall document.');
  const selectedSample = () => page.locator('.review-grid').getAttribute('data-selected-sample');
  const firstId = await selectedSample();
  await page.keyboard.press('j');
  const secondId = await selectedSample();
  await page.keyboard.press('j');
  const thirdId = await selectedSample();
  equal(firstId !== secondId && secondId !== thirdId, true, 'J must continue moving through the review queue while a queue button has focus.');
  await page.keyboard.press('k');
  equal(await selectedSample(), secondId, 'K must move back through the review queue.');
  await page.locator('#review-note').focus();
  await page.keyboard.press('j');
  equal(await selectedSample(), secondId, 'J must not run inside a text area.');

  await open(page, '/review?sample=CS-0008');
  let reviewVideo = page.locator('.review-media video');
  equal(await reviewVideo.evaluate(video => video.muted), false, 'VA review media must remain unmuted.');
  await page.locator('body').press('Space');
  await page.waitForTimeout(500);
  const vaPlayback = await reviewVideo.evaluate(video => ({
    currentTime: video.currentTime,
    paused: video.paused,
    readyState: video.readyState,
    error: video.error?.message ?? null,
  }));
  equal(
    vaPlayback.currentTime > 0.08 && !vaPlayback.paused,
    true,
    `Space must start actual VA playback. State: ${JSON.stringify(vaPlayback)}`,
  );
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.review-grid')?.getAttribute('data-selected-sample') !== 'CS-0008');
  equal(await reviewVideo.evaluate(video => video.paused && video.currentTime === 0), true, 'Switching samples must pause and reset review media.');

  await open(page, '/review?sample=CS-0010');
  reviewVideo = page.locator('.review-media video');
  equal(await reviewVideo.evaluate(video => video.muted), true, 'VT review media must remain muted.');
  equal(await reviewVideo.evaluate(video => video.controls), true, 'Review media must expose native playback controls.');
  await page.locator('body').press('Space');
  await page.waitForTimeout(500);
  const vtPlayback = await reviewVideo.evaluate(video => ({
    currentTime: video.currentTime,
    paused: video.paused,
    readyState: video.readyState,
    error: video.error?.message ?? null,
  }));
  equal(
    vtPlayback.currentTime > 0.08 && !vtPlayback.paused,
    true,
    `Space must start actual VT playback. State: ${JSON.stringify(vtPlayback)}`,
  );
  equal(consoleErrors.length, 0, `Review playback console errors: ${consoleErrors.join(' | ')}`);

  for (const [width, height] of [[1024, 768], [768, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await open(page, '/review?sample=CS-0008');
    const positions = await page.evaluate(() => ({
      media: document.querySelector('.review-media').getBoundingClientRect().top,
      decision: document.querySelector('.review-decision').getBoundingClientRect().top,
      context: document.querySelector('.review-context').getBoundingClientRect().top,
    }));
    equal(positions.media < positions.decision && positions.decision < positions.context, true, `Review order must be media, decision, context at ${width} pixels.`);
    equal(await page.locator('.review-secondary-action:not([open])').count(), 2, `Secondary review actions must start collapsed at ${width} pixels.`);
  }
  equal(await page.evaluate(() => document.documentElement.scrollHeight < 2200), true, 'The mobile review detail must remain compact.');

  await page.getByRole('button', { name: 'Open navigation' }).click();
  equal(await page.locator('.mobile-drawer .primary-nav__link[aria-current="page"]').textContent(), 'Review', 'Mobile navigation must mark the review route.');
  await page.keyboard.press('Escape');
  await open(page, '/archive');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  equal(await page.locator('.mobile-drawer .primary-nav__link[aria-current="page"]').textContent(), 'Archive', 'Mobile navigation must mark the archive route.');
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/archive?dataset=dataset-main&page=2');
  const archivedSample = await page.locator('.archive-list-panel tbody .table-link').first().textContent();
  await page.locator('.archive-list-panel tbody .table-link').first().click();
  equal(new URL(page.url()).pathname, '/review', 'An archive sample must open in review.');
  equal(new URL(page.url()).searchParams.get('sample'), archivedSample, 'Review must open the selected archive sample.');
  await page.locator('.review-media__back').click();
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
  await open(page, '/generate/jobs?job=job-completed');
  const testSnapshotBefore = await page.locator('.generation-current-input').innerText();
  await page.evaluate(key => {
    const data = JSON.parse(localStorage.getItem(key));
    const job = data.jobs.find(item => item.id === 'job-completed');
    const content = data.contentItems.find(item => item.id === job.testInput.contentItemId);
    const preset = data.presets.find(item => item.id === job.testInput.presetId);
    content.name = 'Edited after submission';
    content.videoPrompt = 'Edited prompt after submission.';
    preset.name = 'Edited preset after submission';
    preset.renderNegativeConstraints = 'Edited negative prompt after submission.';
    localStorage.setItem(key, JSON.stringify(data));
  }, dataKey);
  await page.reload({ waitUntil: 'networkidle' });
  equal(await page.locator('.generation-current-input').innerText(), testSnapshotBefore, 'Historical test task input must come only from its immutable snapshot.');
  await resetPrototypeState(page);

  await open(page, '/archive');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSONL' }).click();
  const archiveDownload = await downloadEvent;
  const archiveStream = await archiveDownload.createReadStream();
  let archiveText = '';
  for await (const chunk of archiveStream) archiveText += chunk.toString('utf8');
  const archiveRecords = archiveText.trim().split('\n').map(line => JSON.parse(line));
  const vtRecords = archiveRecords.filter(record => record.protocol === 'VT');
  equal(vtRecords.length > 0, true, 'The example archive must include VT records.');
  equal(vtRecords.every(record => Object.keys(record.media).join(',') === 'primary_asset_id'), true, 'VT delivery records must include only the silent primary video asset.');
  equal(archiveRecords.every(record => !('thumbnail_asset_id' in record.media)), true, 'Archive delivery records must exclude thumbnails.');

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/workspace');
  const createDatasetButton = page.getByRole('button', { name: 'Create dataset' });
  await createDatasetButton.click();
  await expectDialogBasics(page, 'The create dataset dialog');
  equal(await createDatasetButton.evaluate(element => element === document.activeElement), true, 'Closing the create dataset dialog must restore trigger focus.');

  await open(page, '/settings');
  const renameButton = page.getByRole('button', { name: 'Rename current name' });
  await renameButton.click();
  await expectDialogBasics(page, 'The rename dialog');
  await expectFocus(page, renameButton, 'Closing the rename dialog must restore trigger focus.');

  await open(page, '/generate/content');
  await page.locator('.generation-selection-card').first().click();
  await page.locator('#content-name').fill('Updated content name');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expectDialogBasics(page, 'The content save dialog');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });

  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, '/generate/test');
  await page.getByRole('button', { name: 'Review test' }).click();
  await expectDialogBasics(page, 'The test review dialog');

  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/generate/jobs?job=job-queued');
  await page.getByRole('button', { name: 'Cancel job' }).click();
  await expectDialogBasics(page, 'The cancel job dialog');

  await open(page, '/review?sample=CS-0008');
  const modality = page.locator('#review-direction');
  const currentModality = await modality.inputValue();
  const nextModality = await modality.locator('option').evaluateAll((options, current) =>
    options.map(option => option.value).find(value => value !== current) ?? '', currentModality);
  if (nextModality) {
    await modality.selectOption(nextModality);
    const saveModalityButton = page.getByRole('button', { name: 'Save modality' });
    await saveModalityButton.click();
    await expectDialogBasics(page, 'The modality dialog');
    await expectFocus(page, saveModalityButton, 'Escape from the modality dialog must restore its trigger focus.');
  }

  await open(page, '/archive');
  const previewSyncButton = page.getByRole('button', { name: 'Preview sync' });
  await previewSyncButton.click();
  await expectDialogBasics(page, 'The archive preview dialog');
  await expectFocus(page, previewSyncButton, 'Escape from the archive preview must restore its trigger focus.');

  await open(page, '/workspace');
  await page.getByRole('button', { name: /Edit dataset/u }).first().click();
  await expectDialogBasics(page, 'The edit dataset dialog');
  await page.getByRole('button', { name: /Disable dataset/u }).first().click();
  await expectDialogBasics(page, 'The disable dataset dialog');

  await open(page, '/generate/batches');
  let batchContent = page.locator('fieldset[aria-describedby="batch-content-hint"]');
  await batchContent.getByRole('button').click();
  await page.getByRole('button', { name: 'Save batch draft' }).click();
  await page.getByRole('button', { name: 'Preview allocation' }).click();
  await expectDialogBasics(page, 'The batch allocation dialog');

  await resetPrototypeState(page);
  const productionGpuChecks = page.locator('fieldset[aria-describedby="batch-gpu-hint"] input[type="checkbox"]');
  if (!(await productionGpuChecks.nth(0).isChecked())) await productionGpuChecks.nth(0).check();
  if (!(await productionGpuChecks.nth(1).isChecked())) await productionGpuChecks.nth(1).check();
  batchContent = page.locator('fieldset[aria-describedby="batch-content-hint"]');
  await batchContent.getByRole('button').click();
  await page.getByRole('button', { name: 'Save batch draft' }).click();
  await page.getByRole('button', { name: 'Preview allocation' }).click();
  let submitBatchButton = page.getByRole('dialog').getByRole('button', { name: 'Submit batch' });
  await submitBatchButton.click();
  await expectDialogBasics(page, 'The loaded model replacement dialog');
  await expectFocus(page, submitBatchButton, 'Escape from model replacement must restore its trigger focus.');
  await submitBatchButton.click();
  await page.locator('dialog[open]').last().getByRole('button', { name: 'Yes' }).click();
  const submitConfirmation = page.locator('dialog[open]').last();
  await submitConfirmation.waitFor();
  await submitConfirmation.getByRole('button', { name: 'Yes' }).click();
  const submittedJob = await page.evaluate(key => {
    const data = JSON.parse(localStorage.getItem(key));
    const job = data.jobs[0];
    return {
      id: job.id,
      status: job.status,
      completedCount: job.completedCount,
      itemStatuses: job.items.map(item => item.status),
      itemGpus: job.items.map(item => item.gpuId),
    };
  }, dataKey);
  equal(submittedJob.status, 'Running', 'A submitted production batch must start immediately.');
  equal(submittedJob.completedCount, 0, 'A new production batch must not fabricate completed videos.');
  equal(submittedJob.itemStatuses.slice(0, 2).join(','), 'Running,Running', 'A dual GPU batch must start its first two videos.');
  equal(submittedJob.itemStatuses.slice(2).every(status => status === 'Queued'), true, 'Remaining production videos must wait in order.');
  equal(submittedJob.itemGpus.slice(0, 2).join(','), 'GPU0,GPU1', 'The first two videos must run on separate selected GPUs.');
  await open(page, `/generate/jobs?job=${submittedJob.id}`);
  equal(await page.locator('.generation-current-input').count(), 2, 'Task details must immediately show both running videos.');
  equal(await page.getByText(/^0\//u).first().isVisible(), true, 'New task progress must start from zero completed videos.');
  await open(page, '/generate/batches');
  await resetPrototypeState(page);
  batchContent = page.locator('fieldset[aria-describedby="batch-content-hint"]');
  await batchContent.getByRole('button').click();
  await page.getByRole('button', { name: 'Save batch draft' }).click();
  await page.getByRole('button', { name: 'Preview allocation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit batch' }).click();
  await page.locator('dialog[open]').last().waitFor();
  await page.keyboard.press('Escape');

  await resetPrototypeState(page);
  await page.locator('#batch-model').selectOption('MiniMax H3');
  batchContent = page.locator('fieldset[aria-describedby="batch-content-hint"]');
  await batchContent.getByRole('button').click();
  await page.getByRole('button', { name: 'Save batch draft' }).click();
  await page.getByRole('button', { name: 'Preview allocation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit batch' }).click();
  await expectDialogBasics(page, 'The loaded model replacement dialog');
  await page.keyboard.press('Escape');

  await resetPrototypeState(page);
  await open(page, '/generate/content');
  let draftContentCard = page.locator('.generation-selection-card').filter({ hasText: 'Draft' });
  await draftContentCard.click();
  await page.locator('#content-status').selectOption('Active');
  await expectDialogBasics(page, 'The content activation dialog');
  await page.locator('#content-status').selectOption('Disabled');
  await expectDialogBasics(page, 'The content disable dialog');
  const deleteContentButton = page.getByRole('button', { name: 'Delete content' });
  await deleteContentButton.click();
  await expectDialogBasics(page, 'The content deletion dialog');
  await expectFocus(page, deleteContentButton, 'Escape from content deletion must restore its trigger focus.');
  await page.locator('#content-name').fill('Unsaved content edit');
  await page.locator('.generation-selection-card').first().click();
  await expectDialogBasics(page, 'The content discard dialog');

  await resetPrototypeState(page);
  await open(page, '/generate/presets');
  await page.locator('#preset-style').fill('Natural acting with stable movement.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expectDialogBasics(page, 'The preset save dialog');
  await page.locator('#preset-style').fill('Unsaved preset edit.');
  await page.locator('.generation-selection-card').nth(1).click();
  await expectDialogBasics(page, 'The preset discard dialog');

  await resetPrototypeState(page);
  await open(page, '/generate/test');
  let testCard = page.locator('.generation-result-card').filter({ hasText: 'Waiting to start' });
  await testCard.getByRole('button', { name: 'Cancel job' }).click();
  await expectDialogBasics(page, 'The test cancellation dialog');
  testCard = page.locator('.generation-result-card').filter({ hasText: 'Cancelled' });
  await testCard.getByRole('button', { name: 'Retry job' }).click();
  await expectDialogBasics(page, 'The test retry dialog');
  testCard = page.locator('.generation-result-card').filter({ hasText: 'Completed' });
  await testCard.getByRole('button', { name: 'Keep result' }).click();
  await expectDialogBasics(page, 'The test keep dialog');

  await open(page, '/generate/jobs?job=job-cancelled');
  await page.getByRole('button', { name: 'Retry job' }).click();
  await expectDialogBasics(page, 'The job retry dialog');
  await open(page, '/generate/jobs?job=job-completed');
  await page.getByRole('button', { name: 'Keep result' }).click();
  await expectDialogBasics(page, 'The job keep dialog');
  await open(page, '/generate/jobs?job=job-result-current');
  await page.getByRole('button', { name: 'Edit result' }).click();
  await expectDialogBasics(page, 'The result editor dialog');
  await page.getByRole('button', { name: 'Edit result' }).click();
  await page.locator('#job-result-video-prompt').fill('A revised prompt that requires rendering.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expectDialogBasics(page, 'The rerender confirmation dialog');
  await page.keyboard.press('Escape');

  await open(page, '/review?sample=CS-0008');
  await page.locator('.review-secondary-action').first().locator('summary').click();
  await page.locator('.review-transfer').getByRole('button').click();
  await expectDialogBasics(page, 'The category transfer dialog');
  await page.locator('.review-queue__check input').first().check();
  await page.locator('[data-review-batch] summary').click();
  await page.locator('[data-review-batch]').getByRole('button').click();
  await expectDialogBasics(page, 'The batch review dialog');

  await open(page, '/archive');
  await page.getByRole('button', { name: 'Preview sync' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sync archive' }).click();
  await expectDialogBasics(page, 'The archive sync dialog');
  await page.keyboard.press('Escape');

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

  const routes = [
    '/workspace',
    '/generate/batches',
    '/generate/test',
    '/generate/content',
    '/generate/presets',
    '/generate/jobs',
    '/review?sample=CS-0008',
    '/archive',
    '/settings',
    '/me/statistics',
  ];
  const viewports = [[1440, 900], [1024, 768], [768, 900], [390, 844]];
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
