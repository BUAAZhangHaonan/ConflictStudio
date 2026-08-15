import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { createBrowserApiFixture, installPreferences, jobItemsFixture, preferenceKeys } from './browser-fixtures.mjs';

const playwrightModule = process.env.CONFLICTSTUDIO_PLAYWRIGHT_MODULE;
if (!playwrightModule) throw new Error('CONFLICTSTUDIO_PLAYWRIGHT_MODULE is required.');
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = resolve(projectRoot, 'frontend');
const baseUrl = 'http://127.0.0.1:4173';
const artifactRoot = process.env.CONFLICTSTUDIO_BROWSER_ARTIFACT_DIR;
if (artifactRoot) mkdirSync(artifactRoot, { recursive: true });

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
  assert.deepEqual(overflow, { document: 0, body: 0 }, `${locale} ${route} must fit at ${width}px.`);
}

async function expectDialogFocus(page, name) {
  const dialog = page.getByRole('dialog', { name });
  await dialog.waitFor();
  assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, `${name} must receive focus.`);
  return dialog;
}

function sectionWithHeading(page, name) {
  return page.getByRole('heading', { name, exact: true }).locator('xpath=ancestor::section[1]');
}

async function expectPaginationState(pagination, { page, totalPages, total }) {
  await pagination.waitFor();
  assert.match(await pagination.innerText(), new RegExp(`Page ${page} of ${totalPages}.*${total} records`, 'su'));
  assert.equal(await pagination.getByRole('button', { name: 'Previous', exact: true }).isDisabled(), page === 1);
  assert.equal(await pagination.getByRole('button', { name: 'Next', exact: true }).isDisabled(), page === totalPages);
}

async function expectPaginationBelow(content, pagination, message) {
  const [contentBounds, paginationBounds] = await Promise.all([
    content.boundingBox(),
    pagination.boundingBox(),
  ]);
  assert.ok(contentBounds && paginationBounds, `${message} must be visible.`);
  assert.equal(paginationBounds.y >= contentBounds.y + contentBounds.height - 1, true, `${message} must be below the growing content.`);
}

async function expectCount(locator, count, message) {
  if (count > 0) await locator.nth(count - 1).waitFor();
  await locator.nth(count).waitFor({ state: 'detached' });
  assert.equal(await locator.count(), count, message);
}

const server = await createServer({ root: frontendRoot, logLevel: 'silent', server: { host: '127.0.0.1', port: 4173, strictPort: true } });
let browser;
let context;
let tracingStarted = false;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await installPreferences(context);
  await context.addInitScript(() => {
    class FixtureWebSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = 0;
      onopen = null;
      onmessage = null;
      onerror = null;
      onclose = null;
      constructor(url) {
        this.url = url;
        window.setTimeout(() => {
          this.readyState = FixtureWebSocket.OPEN;
          this.onopen?.(new Event('open'));
          for (let index = 0; index < 25; index += 1) {
            const event = {
              id: 46 + index,
              jobId: 1,
              itemId: 1,
              eventType: 'ItemRenderProgress',
              payload: { preparedCount: 128, completedCount: index, failedCount: 0, totalCount: 128, slotCount: 2, sequence: 1, gpuSlot: 'GPU0', failureCode: null, failureReason: null, progressValue: index, progressMaximum: 25 },
              createdAt: '2026-08-15T08:00:00.000Z',
            };
            this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }));
          }
        }, 30);
      }
      close() {
        this.readyState = FixtureWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
      send() {}
    }
    window.WebSocket = FixtureWebSocket;
  });
  if (artifactRoot) {
    await context.tracing.start({ screenshots: true, snapshots: true });
    tracingStarted = true;
  }
  const page = await context.newPage();
  const api = createBrowserApiFixture();
  await api.install(page);
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await open(page, '/workspace');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), preferenceKeys.reviewerId), '1');
  assert.equal(await page.getByRole('columnheader', { name: 'Purpose', exact: true }).count(), 1);
  assert.equal(await page.locator('.workspace-datasets tbody tr').count(), 20, 'Workspace must render one server page of 20 datasets.');
  assert.match(await page.locator('.workspace-datasets .pagination').innerText(), /Page 1 of 2.*22 records/su);
  for (const [label, total] of [['Pending review', '30'], ['Running jobs', '12'], ['Failed jobs', '12'], ['Pending archive', '25']]) {
    const metric = page.locator('.workspace-metric-link').filter({ hasText: label });
    assert.equal(await metric.locator('.metric__value').innerText(), total, `${label} must use the server total, not the first page count.`);
  }
  await expectPaginationState(page.locator('.workspace-jobs > .pagination'), { page: 1, totalPages: 2, total: 24 });
  assert.equal(await page.locator('.workspace-job-card').count(), 20, 'Workspace tasks must keep a 20-row server page.');
  await page.locator('#workspace-dataset-search').fill('Dataset 22');
  await expectCount(page.locator('.workspace-datasets tbody tr'), 1, 'Dataset search must be applied before pagination.');
  assert.equal(await page.locator('.workspace-datasets tbody tr').first().innerText().then(text => text.includes('Dataset 22')), true);
  await page.locator('#workspace-dataset-search').fill('');
  await expectCount(page.locator('.workspace-datasets tbody tr'), 20, 'Clearing dataset search must restore the server page.');
  const nameRows = await page.locator('.workspace-dataset-name').evaluateAll(elements => elements.map(element => {
    const name = element.querySelector('.workspace-dataset-name__title')?.getBoundingClientRect();
    const note = element.querySelector('.workspace-dataset-name__note')?.getBoundingClientRect();
    return { nameBottom: name?.bottom ?? 0, noteTop: note?.top ?? 0 };
  }));
  assert.equal(nameRows.every(row => row.noteTop >= row.nameBottom), true, 'Dataset notes must be below names.');

  const inactiveRow = page.locator('.workspace-datasets tbody tr').filter({ hasText: 'Dataset 3' });
  await inactiveRow.getByRole('button', { name: 'Enable', exact: true }).click();
  let dialog = await expectDialogFocus(page, 'Enable dataset?');
  await dialog.getByRole('button', { name: 'Enable dataset' }).click();
  await inactiveRow.getByRole('button', { name: 'Disable', exact: true }).click();
  dialog = await expectDialogFocus(page, 'Disable dataset?');
  await dialog.getByRole('button', { name: 'Disable dataset' }).click();
  await inactiveRow.getByRole('button', { name: 'Delete', exact: true }).click();
  dialog = await expectDialogFocus(page, 'Delete dataset?');
  assert.match(await dialog.innerText(), /Dataset 3.*Only an empty dataset can be deleted/su);
  await dialog.getByRole('button', { name: 'Delete dataset' }).click();
  await inactiveRow.waitFor({ state: 'detached' });

  const nonEmptyRow = page.locator('.workspace-datasets tbody tr').filter({ hasText: 'Formal samples' });
  await nonEmptyRow.getByRole('button', { name: 'Disable', exact: true }).click();
  await page.getByRole('dialog', { name: 'Disable dataset?' }).getByRole('button', { name: 'Disable dataset' }).click();
  await nonEmptyRow.getByRole('button', { name: 'Delete', exact: true }).click();
  dialog = await expectDialogFocus(page, 'Delete dataset?');
  await dialog.getByRole('button', { name: 'Delete dataset' }).click();
  await dialog.getByText('This dataset contains samples or related records. Remove those records before deleting it.').waitFor();
  assert.equal(await dialog.isVisible(), true, 'A failed nonempty deletion must keep the dialog open.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await nonEmptyRow.getByRole('button', { name: 'Enable', exact: true }).click();
  await page.getByRole('dialog', { name: 'Enable dataset?' }).getByRole('button', { name: 'Enable dataset' }).click();

  await open(page, '/generate/batches');
  const datasetSection = sectionWithHeading(page, '1. Destination dataset');
  const contentSection = sectionWithHeading(page, '2. Content plans and video scenes');
  const promptSection = sectionWithHeading(page, '3. Prompt preset');
  assert.match(await contentSection.innerText(), /Content plans define the plot, emotions, and dialogue.*video scene defines the location, props, environment, and camera/su);
  assert.match(await promptSection.innerText(), /writing style.*examples.*negative prompt/su);
  assert.equal(await datasetSection.locator('.generation-choice-grid input[type="radio"]').count() <= 20, true);
  await datasetSection.getByRole('button', { name: 'Create dataset' }).click();
  dialog = await expectDialogFocus(page, 'Create dataset');
  await dialog.getByLabel('Dataset name').fill('New formal dataset');
  await dialog.getByLabel('Note').fill('Created from the batch form');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('input[name="target-dataset"]')].some(input => input.checked));
  const createDatasetRequest = api.state.requests.findLast(request => request.method === 'POST' && request.path === '/api/datasets');
  assert.deepEqual(createDatasetRequest?.body, { name: 'New formal dataset', note: 'Created from the batch form' });

  const contentChecks = contentSection.locator(':scope > .generation-choice-grid input[type="checkbox"]');
  assert.equal(await contentChecks.count(), 2);
  await contentChecks.nth(0).click();
  const fixedScene = contentSection.locator('.generation-content-scene').filter({ hasText: 'Restrained reply' });
  await fixedScene.waitFor();
  assert.match(await fixedScene.innerText(), /already includes one source scene/i);
  assert.equal(await fixedScene.locator('input').count(), 0, 'Fixed content must not expose another scene selector.');
  await contentChecks.nth(1).click();
  const generatedScenes = contentSection.locator('.generation-content-scene').filter({ hasText: 'Unexpected call' });
  await generatedScenes.waitFor();
  const sceneChecks = generatedScenes.locator('input[type="checkbox"]');
  assert.equal(await sceneChecks.count(), 2);
  await generatedScenes.getByRole('button', { name: 'Select all available scenes' }).click();
  assert.equal(await sceneChecks.evaluateAll(nodes => nodes.every(node => node.checked)), true);
  await generatedScenes.getByRole('button', { name: 'Clear scenes' }).click();
  await generatedScenes.getByText('Choose at least one video scene for this content plan.').waitFor();
  await sceneChecks.first().check();
  await promptSection.locator('input[type="radio"]').first().check();
  const combinations = sectionWithHeading(page, '6. Combination preview').locator('.generation-combination-list li');
  assert.equal(await combinations.count(), 2, 'Preview must show actual content and scene pairs only.');
  await page.getByRole('button', { name: 'Save batch draft' }).click();
  await page.waitForFunction(() => document.querySelector('.generation-unsaved-status')?.textContent === '');
  const batchRequest = api.state.requests.findLast(request => request.method === 'POST' && request.path === '/api/batch-drafts');
  assert.deepEqual(batchRequest?.body.contentSelections, [
    { contentPlanId: 1, backgroundPresetIds: [] },
    { contentPlanId: 2, backgroundPresetIds: [1] },
  ]);
  await page.getByLabel('Saved draft').selectOption('new');
  await page.getByLabel('Saved draft').selectOption('1');
  assert.equal(await page.locator('input[name="target-dataset"]:checked').count(), 1, 'Saved target dataset must be restored.');
  assert.equal(await contentSection.locator(':scope > .generation-choice-grid input[type="checkbox"]:checked').count(), 2, 'Saved content selections must be restored.');
  assert.equal(await generatedScenes.locator('input[type="checkbox"]:checked').count(), 1, 'Saved scene selections must be restored.');
  assert.equal(await promptSection.locator('input[type="radio"]:checked').count(), 1, 'Saved prompt preset must be restored.');
  assert.equal(await page.locator('#batch-model').inputValue(), 'LTX-2.5');
  assert.equal(await page.locator('#batch-precision').inputValue(), 'INT8');
  await page.locator('#batch-quantity').fill('3');
  await page.getByRole('button', { name: 'Save batch draft' }).click();
  await page.waitForFunction(() => document.querySelector('.generation-unsaved-status')?.textContent === '');
  const resaveRequest = api.state.requests.findLast(request => request.method === 'PUT' && request.path === '/api/batch-drafts/1');
  assert.deepEqual(resaveRequest?.body.contentSelections, batchRequest.body.contentSelections, 'Re-saving a restored draft must retain every content and scene selection.');
  assert.equal(resaveRequest?.body.targetDatasetId, batchRequest.body.targetDatasetId);
  assert.equal(resaveRequest?.body.promptPresetId, batchRequest.body.promptPresetId);
  assert.equal('backgroundPresets' in batchRequest.body, false, 'The removed global scene contract must not be sent.');

  await open(page, '/generate/content');
  assert.equal(await page.locator('.generation-selection-list > li').count(), 2);
  await page.locator('.generation-selection-card').filter({ hasText: 'Restrained reply' }).click();
  const fixedEditor = page.locator('.generation-compatible-scenes');
  assert.equal(await fixedEditor.locator('input[type="radio"]').count(), 2, 'Fixed content must expose one source-scene choice.');
  assert.equal(await fixedEditor.locator('input[type="radio"]:checked').count(), 1, 'Fixed content must keep exactly one source scene selected.');
  await page.locator('.generation-selection-card').filter({ hasText: 'Unexpected call' }).click();
  const compatibilityChecks = page.locator('.generation-compatible-scenes input[type="checkbox"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.generation-compatible-scenes input[type="checkbox"]')].length === 2 && [...document.querySelectorAll('.generation-compatible-scenes input[type="checkbox"]')].every(input => input.checked));
  await compatibilityChecks.nth(1).uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Content item saved.').waitFor();
  const contentUpdateRequest = api.state.requests.findLast(request => request.method === 'PATCH' && request.path === '/api/content-plans/2');
  assert.deepEqual(contentUpdateRequest?.body.backgroundPresetIds, [1]);

  await open(page, '/generate/presets');
  assert.equal(await page.locator('body').innerText().then(text => text.includes('Scene supplement')), false, 'Prompt presets must not show the removed scene supplement.');

  api.state.jobs[0] = { ...api.state.jobs[0], status: 'Running', finishedAt: null };
  jobItemsFixture[20].latestAttempt.failureReason = 'RendererError: CUDA device 0 failed with a private backend trace.';
  await open(page, '/generate/jobs?job=1');
  const jobList = page.locator('.generation-job-list');
  const jobPagination = page.locator('.generation-list .pagination');
  const itemsSection = page.locator('.generation-job-section').filter({ has: page.getByRole('heading', { name: 'Video items' }) });
  const itemPagination = itemsSection.locator('.pagination');
  const eventsSection = page.locator('.generation-job-section').filter({ has: page.getByRole('heading', { name: 'Events' }) });
  const eventPagination = eventsSection.locator('.pagination');
  await expectCount(jobList.locator(':scope > li'), 20, 'Job list must render 20 rows.');
  await expectCount(page.locator('.generation-result-card'), 20, 'Job results must render 20 rows.');
  await expectCount(page.locator('.generation-log-list > li'), 20, 'Job logs must render 20 rows.');
  await expectPaginationState(jobPagination, { page: 1, totalPages: 2, total: 25 });
  await expectPaginationBelow(jobList, jobPagination, 'Job pagination');
  await expectPaginationState(itemPagination, { page: 1, totalPages: 2, total: 25 });
  await expectPaginationBelow(page.locator('.generation-result-cards'), itemPagination, 'Video item pagination');
  await expectPaginationState(eventPagination, { page: 1, totalPages: 3, total: 45 });
  await expectPaginationBelow(page.locator('.generation-log-list'), eventPagination, 'Task log pagination');
  await page.getByRole('button', { name: /Show 25 new log entries/ }).waitFor();
  assert.equal(await page.locator('.generation-log-list > li').count(), 20, 'Live events must not grow the current log DOM.');
  const jobDetailName = await page.locator('.generation-job-detail h2').first().textContent();
  await jobPagination.getByRole('button', { name: 'Next', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expectCount(jobList.locator(':scope > li'), 5, 'The final task page must render the remaining rows.');
  await expectPaginationState(jobPagination, { page: 2, totalPages: 2, total: 25 });
  assert.equal(await page.locator('.generation-job-detail h2').first().textContent(), jobDetailName, 'Changing the job list page must keep the selected job.');
  await jobPagination.getByRole('button', { name: 'Previous', exact: true }).focus();
  await page.keyboard.press('Space');
  await expectCount(jobList.locator(':scope > li'), 20, 'Previous must return to the first task page by keyboard.');
  await itemPagination.getByRole('button', { name: 'Next', exact: true }).click();
  await expectCount(page.locator('.generation-result-card'), 5, 'The final video item page must render the remaining rows.');
  await expectPaginationState(itemPagination, { page: 2, totalPages: 2, total: 25 });
  await page.locator('.generation-result-card').first().getByRole('button', { name: /Attempt history/ }).click();
  await expectCount(page.locator('.generation-attempt-list > li'), 20, 'Attempt history must render 20 rows on the first page.');
  const attemptSection = page.locator('.generation-job-section').filter({ has: page.getByRole('heading', { name: 'Attempt history' }) });
  const attemptPagination = attemptSection.locator('.pagination');
  await expectPaginationState(attemptPagination, { page: 1, totalPages: 2, total: 25 });
  assert.equal((await attemptSection.innerText()).includes('RendererError:'), false, 'Attempt history must not expose the backend failure reason.');
  assert.match(await attemptSection.innerText(), /The task could not be completed\./u, 'Attempt failures must use the stable localized message.');
  await attemptPagination.getByRole('button', { name: 'Next', exact: true }).click();
  await expectCount(page.locator('.generation-attempt-list > li'), 5, 'Attempt history must render the remaining rows on the final page.');
  await expectPaginationState(attemptPagination, { page: 2, totalPages: 2, total: 25 });

  await eventPagination.getByRole('button', { name: 'Next', exact: true }).click();
  await expectCount(page.locator('.generation-log-list > li'), 20, 'The second log page must render 20 entries.');
  await expectPaginationState(eventPagination, { page: 2, totalPages: 3, total: 45 });
  await eventPagination.getByRole('button', { name: 'Next', exact: true }).click();
  await expectCount(page.locator('.generation-log-list > li'), 5, 'The last log page must render the remaining entries.');
  await expectPaginationState(eventPagination, { page: 3, totalPages: 3, total: 45 });

  await open(page, '/generate/test');
  assert.equal(await page.locator('.generation-job-list > li').count() <= 20, true, 'Test history must use one server page.');

  await open(page, '/review');
  const reviewList = page.locator('.review-queue__list');
  const reviewPagination = page.locator('.review-queue .pagination');
  const reviewDatasetPagination = page.locator('.review-dataset-picker .pagination');
  await expectPaginationState(reviewDatasetPagination, { page: 1, totalPages: 2, total: 22 });
  await reviewDatasetPagination.getByRole('button', { name: 'Next', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#review-dataset-filter option').length === 3);
  assert.equal(await page.locator('#review-dataset-filter option').count(), 3, 'The second dataset page must expose its two datasets plus the all option.');
  await reviewDatasetPagination.getByRole('button', { name: 'Previous', exact: true }).click();
  await expectCount(reviewList.locator(':scope > li'), 20, 'Review queue must render 20 rows.');
  await expectPaginationState(reviewPagination, { page: 1, totalPages: 2, total: 30 });
  await expectPaginationBelow(reviewList, reviewPagination, 'Review queue pagination');
  await page.locator('.review-queue__item').first().click();
  assert.equal(new URL(page.url()).searchParams.get('sampleId'), '1');
  await page.locator('.review-media video').waitFor();
  await reviewPagination.getByRole('button', { name: 'Next', exact: true }).click();
  await expectCount(reviewList.locator(':scope > li'), 10, 'The last review page must render the remaining entries.');
  await expectPaginationState(reviewPagination, { page: 2, totalPages: 2, total: 30 });
  assert.equal(new URL(page.url()).searchParams.get('sampleId'), '1', 'Changing the review queue page must keep the selected sample.');
  await reviewPagination.getByRole('button', { name: 'Previous', exact: true }).click();
  await expectCount(reviewList.locator(':scope > li'), 20, 'Previous must return to the first review page.');

  await open(page, '/archive?dataset=1&page=2');
  const archiveRows = page.locator('.archive-list-panel tbody tr');
  const archivePagination = page.locator('.archive-list-panel .pagination');
  await expectCount(archiveRows, 10, 'Archive must render only the current 20-sample server page.');
  await expectPaginationState(archivePagination, { page: 2, totalPages: 3, total: 55 });
  await expectPaginationBelow(page.locator('.archive-table-shell'), archivePagination, 'Archive pagination');
  await archivePagination.getByRole('button', { name: 'Next', exact: true }).click();
  await expectCount(page.locator('.archive-list-panel tbody tr'), 15, 'The final archive server page must render its remaining archived rows.');
  await expectPaginationState(archivePagination, { page: 3, totalPages: 3, total: 55 });
  await archivePagination.getByRole('button', { name: 'Previous', exact: true }).click();
  await expectCount(archiveRows, 10, 'Previous must return to the prior archive page.');
  await archiveRows.first().getByRole('link').click();
  assert.equal(new URL(page.url()).searchParams.get('sampleId'), '31');
  assert.equal(new URL(page.url()).searchParams.get('returnTo'), '/archive?dataset=1&page=2');
  await page.getByRole('button', { name: 'Back to previous page' }).click();
  await page.waitForURL(`${baseUrl}/archive?dataset=1&page=2`);

  await open(page, '/settings');
  await page.evaluate(keys => {
    localStorage.setItem(keys.reviewerId, '25');
    localStorage.setItem(keys.reviewerName, 'Stale name');
  }, preferenceKeys);
  await page.reload({ waitUntil: 'networkidle' });
  assert.match(await page.locator('.settings-current-reviewer').innerText(), /Reviewer 25/su, 'Settings must load the current reviewer independently of page one.');
  assert.equal(api.state.requests.some(request => request.method === 'GET' && request.path === '/api/reviewers/25'), true);
  const reviewerList = page.locator('.settings-reviewer-list');
  const reviewerPagination = page.locator('.settings-reviewers .pagination');
  await expectCount(page.locator('.settings-reviewer-choice'), 20, 'Reviewer names must render 20 rows.');
  await expectPaginationState(reviewerPagination, { page: 1, totalPages: 2, total: 25 });
  await expectPaginationBelow(reviewerList, reviewerPagination, 'Reviewer pagination');
  const reviewerAlignment = await page.locator('.settings-reviewer-choice').first().evaluate(label => {
    const radio = label.querySelector('input')?.getBoundingClientRect();
    const name = label.querySelector('span')?.getBoundingClientRect();
    return { radioCenter: radio ? radio.top + radio.height / 2 : 0, textCenter: name ? name.top + name.height / 2 : 0 };
  });
  assert.equal(Math.abs(reviewerAlignment.radioCenter - reviewerAlignment.textCenter) <= 4, true, 'Reviewer radio must align with the name line.');
  await reviewerPagination.getByRole('button', { name: 'Next', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expectCount(page.locator('.settings-reviewer-choice'), 5, 'The final reviewer page must render the remaining names.');
  await expectPaginationState(reviewerPagination, { page: 2, totalPages: 2, total: 25 });
  assert.equal(await page.locator('.settings-reviewer-choice input:checked').inputValue(), 'on', 'The current reviewer must remain selected when its page opens.');

  await open(page, '/me/statistics');
  const statisticsDatasetPagination = page.locator('.statistics-dataset-picker .pagination');
  await expectPaginationState(statisticsDatasetPagination, { page: 1, totalPages: 2, total: 22 });
  await statisticsDatasetPagination.getByRole('button', { name: 'Next', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#statistics-dataset option').length === 3);
  assert.equal(await page.locator('#statistics-dataset option').count(), 3, 'Statistics must expose the second server page of datasets.');
  await page.locator('#statistics-dataset-search').fill('Validation samples');
  await page.waitForFunction(() => document.querySelectorAll('#statistics-dataset option').length === 2);
  assert.equal(await page.locator('#statistics-dataset option').count(), 2, 'Statistics dataset search must keep the all option and one server result.');

  const routes = ['/workspace', '/generate/batches', '/generate/test', '/generate/content', '/generate/presets', '/generate/jobs?job=1', '/review?sampleId=1', '/archive?dataset=1&page=2', '/settings', '/me/statistics'];
  for (const locale of ['zh-CN', 'en-US']) {
    for (const [width, height] of [[1440, 900], [1024, 768], [768, 900], [390, 844]]) {
      for (const route of routes) await expectNoOverflow(page, route, locale, width, height);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/settings', 'en-US');
  const mobileAlignment = await page.locator('.settings-reviewer-choice').first().evaluate(label => {
    const radio = label.querySelector('input')?.getBoundingClientRect();
    const name = label.querySelector('span')?.getBoundingClientRect();
    return { radioCenter: radio ? radio.top + radio.height / 2 : 0, textCenter: name ? name.top + name.height / 2 : 0 };
  });
  assert.equal(Math.abs(mobileAlignment.radioCenter - mobileAlignment.textCenter) <= 4, true, 'Reviewer radio must align at 390px.');
  if (artifactRoot) await page.screenshot({ path: join(artifactRoot, 'browser-check-final-390.png'), fullPage: true });

  assert.deepEqual(pageErrors, [], `Page errors: ${pageErrors.join(' | ')}`);
  const expectedConflictMessage = 'Failed to load resource: the server responded with a status of 409 (Conflict)';
  assert.equal(consoleErrors.filter(message => message === expectedConflictMessage).length, 1, 'The intentional nonempty dataset deletion must be the only 409 resource error.');
  assert.deepEqual(consoleErrors.filter(message => message !== expectedConflictMessage), [], `Unexpected console errors: ${consoleErrors.join(' | ')}`);
  console.log('Browser checks passed: workflow, lifecycle, pagination, live logs, reviewer alignment, bilingual layout.');
} finally {
  if (context && tracingStarted && artifactRoot) await context.tracing.stop({ path: join(artifactRoot, 'browser-check-trace.zip') });
  if (browser) await browser.close();
  await server.close();
}
