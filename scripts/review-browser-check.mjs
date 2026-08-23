import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { createBrowserApiFixture, installPreferences, preferenceKeys } from './browser-fixtures.mjs';
import { reviewOpenApiFixture } from './review-openapi-fixture.mjs';

const playwrightModule = process.env.CONFLICTSTUDIO_PLAYWRIGHT_MODULE;
if (!playwrightModule) throw new Error('CONFLICTSTUDIO_PLAYWRIGHT_MODULE is required.');
const { chromium } = await import(pathToFileURL(playwrightModule).href);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = resolve(projectRoot, 'frontend');
const baseUrl = 'http://127.0.0.1:4174';
const artifactRoot = process.env.CONFLICTSTUDIO_BROWSER_ARTIFACT_DIR;
if (artifactRoot) mkdirSync(artifactRoot, { recursive: true });

async function open(page, route, locale = 'en-US') {
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: preferenceKeys.locale, value: locale });
  await page.reload({ waitUntil: 'networkidle' });
}

async function expectNoOverflow(page, route, locale, width, height) {
  await page.setViewportSize({ width, height });
  await open(page, route, locale);
  assert.deepEqual(await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  })), { document: 0, body: 0 }, `${locale} ${route} must not overflow at ${width}px`);
}

async function expectReviewListMediaContained(page, width) {
  if (width > 600) {
    const rows = page.locator('.review-list__results .table-shell tbody tr');
    await rows.first().waitFor();
    const geometry = await rows.evaluateAll(elements => elements.map(row => {
      const rowBox = row.getBoundingClientRect();
      const video = row.querySelector('.review-list__sample-cell video');
      const videoBox = video.getBoundingClientRect();
      return {
        rowTop: rowBox.top,
        rowBottom: rowBox.bottom,
        videoTop: videoBox.top,
        videoBottom: videoBox.bottom,
        videoWidth: videoBox.width,
        videoHeight: videoBox.height,
        objectFit: getComputedStyle(video).objectFit,
      };
    }));
    for (const item of geometry) {
      assert.equal(Math.abs(item.videoWidth - 112) < 0.5, true, `Desktop thumbnail width must stay 112px at ${width}px.`);
      assert.equal(Math.abs(item.videoHeight - 63) < 0.5, true, `Desktop thumbnail height must stay 63px at ${width}px.`);
      assert.equal(item.videoTop >= item.rowTop - 1, true, `Thumbnail top must stay inside its row at ${width}px.`);
      assert.equal(item.videoBottom <= item.rowBottom + 1, true, `Thumbnail bottom must stay inside its row at ${width}px.`);
      assert.equal(item.objectFit, 'contain');
    }
    const lastRow = await rows.last().boundingBox();
    const pagination = await page.locator('.review-list__results > .pagination').boundingBox();
    assert.equal(lastRow !== null && pagination !== null && pagination.y >= lastRow.y + lastRow.height - 1, true, `Pagination must follow the final row at ${width}px.`);
    return;
  }

  assert.equal(await page.locator('.review-list__results .table-shell').isVisible(), false);
  const cards = page.locator('.review-list__cards > li');
  await cards.first().waitFor();
  const geometry = await cards.evaluateAll(elements => elements.map(card => {
    const cardBox = card.getBoundingClientRect();
    const video = card.querySelector('video');
    const videoBox = video.getBoundingClientRect();
    return {
      cardLeft: cardBox.left,
      cardRight: cardBox.right,
      videoLeft: videoBox.left,
      videoRight: videoBox.right,
      objectFit: getComputedStyle(video).objectFit,
    };
  }));
  for (const item of geometry) {
    assert.equal(item.videoLeft >= item.cardLeft - 1 && item.videoRight <= item.cardRight + 1, true, 'Mobile thumbnail must stay inside its card.');
    assert.equal(item.objectFit, 'contain');
  }
}

const server = await createServer({
  root: frontendRoot,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 4174, strictPort: true },
});

let browser;
let context;
let gateContext;
let createGateContext;
let tracingStarted = false;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });

  gateContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await installPreferences(gateContext);
  const gateApi = createBrowserApiFixture();
  const gatePage = await gateContext.newPage();
  await gateApi.install(gatePage);
  await open(gatePage, '/review');
  await gatePage.getByRole('heading', { name: 'Review', exact: true }).waitFor();
  assert.equal(await gatePage.evaluate(key => localStorage.getItem(key), preferenceKeys.reviewerId), '25');
  assert.equal(await gatePage.evaluate(key => localStorage.getItem(key), preferenceKeys.reviewerName), 'zhanghaonan');
  assert.equal(gateApi.state.requests.some(request => request.method === 'GET' && request.path === '/api/reviewers' && request.query.page === '2'), true);
  await gateContext.close();
  gateContext = null;

  createGateContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const createGateApi = createBrowserApiFixture({
    reviewers: Array.from({ length: 24 }, (_, index) => ({
      id: index + 1,
      name: index === 0 ? 'Lin' : `Reviewer ${index + 1}`,
      revision: 1,
      createdAt: '2026-08-14T08:00:00.000Z',
      updatedAt: '2026-08-14T08:00:00.000Z',
    })),
  });
  const createGatePage = await createGateContext.newPage();
  await createGateApi.install(createGatePage);
  await open(createGatePage, '/review');
  await createGatePage.getByRole('heading', { name: 'Reviewer required', exact: true }).waitFor();
  assert.equal(await createGatePage.getByRole('textbox').count(), 0);
  assert.equal(await createGatePage.getByRole('radio').count(), 0);
  await createGatePage.getByRole('button', { name: 'Create zhanghaonan and enter review', exact: true }).click();
  await createGatePage.getByRole('heading', { name: 'Review', exact: true }).waitFor();
  const createReviewerRequest = createGateApi.state.requests.find(request => request.method === 'POST' && request.path === '/api/reviewers');
  assert.equal(createReviewerRequest?.body?.name, 'zhanghaonan');
  await createGateContext.close();
  createGateContext = null;

  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installPreferences(context, 'en-US', { id: 25, name: 'zhanghaonan' });
  if (artifactRoot) {
    await context.tracing.start({ screenshots: true, snapshots: true });
    tracingStarted = true;
  }
  const api = createBrowserApiFixture({ noteDraftDelayMs: 180 });
  const page = await context.newPage();
  await api.install(page);
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const listRoute = '/review?decision=Pending&page=2';
  await open(page, listRoute);
  assert.equal(await page.locator('details.review-list__filters').getAttribute('open'), null);
  await page.locator('details.review-list__filters > summary').click();
  const datasetSelect = page.locator('#review-list-dataset');
  await datasetSelect.getByRole('option', { name: 'Dataset 22', exact: true }).waitFor({ state: 'attached' });
  assert.equal(api.state.requests.some(request => request.method === 'GET' && request.path === '/api/datasets' && request.query.page === '2'), true);
  await datasetSelect.selectOption('22');
  await page.waitForURL(url => url.searchParams.get('datasetId') === '22');
  await page.waitForFunction(() => document.querySelector('#review-list-dataset')?.value === '22');
  assert.equal(await datasetSelect.inputValue(), '22');
  await open(page, listRoute);
  const legacyConsoleErrorStart = consoleErrors.length;
  const legacyReviewResponse = await page.evaluate(async payload => {
    const response = await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, value: await response.json() };
  }, {
    sampleId: 3,
    reviewerId: 25,
    decision: 'Rejected',
    expectedSampleRevision: 1,
    expectedReviewRevision: 0,
    expectedNoteDraftRevision: 0,
    queue: { decision: 'All' },
  });
  assert.equal(legacyReviewResponse.status, 422);
  assert.deepEqual(legacyReviewResponse.value.error.details.unknown, ['expectedSampleRevision']);
  assert.deepEqual(legacyReviewResponse.value.error.details.missing, ['expectedRevision']);
  const legacyConsoleErrors = consoleErrors.splice(legacyConsoleErrorStart);
  assert.deepEqual(legacyConsoleErrors, ['Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)']);

  await page.evaluate(() => window.scrollTo({ top: 360, behavior: 'instant' }));
  const firstDetailButton = page.getByRole('button', { name: 'CS-000021', exact: true });
  await firstDetailButton.scrollIntoViewIfNeeded();
  const savedScroll = await page.evaluate(() => window.scrollY);
  await firstDetailButton.click();
  let detailUrl = new URL(page.url());
  assert.equal(detailUrl.pathname, '/review/21');
  assert.equal(detailUrl.searchParams.get('returnTo'), listRoute);
  await page.getByRole('heading', { name: 'CS-000021', exact: true }).waitFor();

  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/review/20');
  await page.getByRole('heading', { name: 'CS-000020', exact: true }).waitFor();
  detailUrl = new URL(page.url());
  assert.equal(detailUrl.searchParams.get('returnTo'), '/review?decision=Pending');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/review/21');
  await page.getByRole('heading', { name: 'CS-000021', exact: true }).waitFor();
  detailUrl = new URL(page.url());
  assert.equal(detailUrl.searchParams.get('returnTo'), listRoute);
  await page.getByRole('button', { name: 'Back to review list', exact: true }).click();
  await page.waitForURL(`${baseUrl}${listRoute}`);
  await page.waitForFunction(expected => Math.abs(window.scrollY - expected) < 4, savedScroll);

  await open(page, '/review/4?returnTo=%2Freview');
  const quickNote = page.getByLabel('Note');
  await quickNote.fill('Saved before a quick return.');
  const quickReturnRequestStart = api.state.requests.length;
  const quickReturnClick = page.getByRole('button', { name: 'Back to review list', exact: true }).click();
  await page.getByText('Saving', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/review/4');
  assert.equal(await page.getByRole('button', { name: 'Previous', exact: true }).isDisabled(), true);
  await quickReturnClick;
  await page.waitForURL(`${baseUrl}/review`);
  const quickReturnRequests = api.state.requests.slice(quickReturnRequestStart);
  assert.equal(quickReturnRequests.some(request => request.method === 'PUT' && request.path === '/api/samples/4/review-note-draft'), true);
  await open(page, '/review/4?returnTo=%2Freview');
  await page.getByLabel('Note').waitFor();
  assert.equal(await page.getByLabel('Note').inputValue(), 'Saved before a quick return.');

  await open(page, '/review?decision=Pending');
  await page.getByRole('checkbox', { name: 'Select CS-000002', exact: true }).check();
  const requestStart = api.state.requests.length;
  await page.getByRole('button', { name: 'Apply to selected samples', exact: true }).click();
  await page.getByRole('dialog', { name: 'Confirm batch decision' }).waitFor();
  const preparedRequests = api.state.requests.slice(requestStart);
  assert.equal(preparedRequests.some(request => request.method === 'GET' && request.path === '/api/samples/2/review-note-draft'), true);
  assert.equal(preparedRequests.some(request => request.method === 'POST' && request.path === '/api/reviews/batch'), false);
  const batchResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/reviews/batch' && response.request().method() === 'POST');
  await page.getByRole('dialog', { name: 'Confirm batch decision' }).getByRole('button', { name: 'Apply Accepted', exact: true }).click();
  assert.equal((await batchResponse).status(), 201);
  const batchRequest = [...api.state.requests].reverse().find(request => request.method === 'POST' && request.path === '/api/reviews/batch');
  assert.deepEqual(Object.keys(batchRequest.body), reviewOpenApiFixture.ReviewBatchCreate.properties);
  assert.deepEqual(Object.keys(batchRequest.body.items[0]).sort(), [...reviewOpenApiFixture.ReviewBatchItem.properties].sort());
  assert.equal(batchRequest.body.items[0].expectedRevision, 1);
  assert.equal(Object.hasOwn(batchRequest.body.items[0], 'expectedSampleRevision'), false);

  await page.evaluate(() => sessionStorage.clear());
  await open(page, '/review/1');
  await page.getByText('This sample needs regeneration before it can be accepted. It can still be rejected.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Accepted', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Rejected', exact: true }).isDisabled(), false);

  await open(page, '/review/4?returnTo=%2Freview%3Fdecision%3DPending');
  const detailText = await page.locator('.review-detail-page').innerText();
  for (const forbidden of ['Seed', 'Positive prompt', 'Negative prompt', 'Attempt', 'GPU', 'VLM', 'Keyboard shortcut']) {
    assert.equal(detailText.includes(forbidden), false, `Review detail must not show ${forbidden}`);
  }
  assert.equal(await page.getByRole('button', { name: 'Play source video with audio', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Play source video with audio', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Show silent primary video', exact: true }).count(), 1);

  const resultsReturnTo = '/generate/results?tab=production&job=1&page=2';
  await open(page, `/review/5?returnTo=${encodeURIComponent(resultsReturnTo)}`);
  const resultsReviewRequestStart = api.state.requests.length;
  await page.getByLabel('Note').fill('Saved before the Results review decision.');
  const decisionClick = page.getByRole('button', { name: 'Accepted', exact: true }).click();
  await page.getByText('Saving', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Back to generation results', exact: true }).isDisabled(), true);
  await decisionClick;
  await page.getByRole('dialog', { name: 'Confirm review' }).waitFor();
  await page.getByRole('dialog', { name: 'Confirm review' }).getByRole('button', { name: 'Save and continue', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/review/6');
  detailUrl = new URL(page.url());
  assert.equal(detailUrl.searchParams.get('returnTo'), resultsReturnTo);
  const resultsReviewRequests = api.state.requests.slice(resultsReviewRequestStart);
  const resultsPutIndex = resultsReviewRequests.findIndex(request => request.method === 'PUT' && request.path === '/api/samples/5/review-note-draft');
  const resultsPostIndex = resultsReviewRequests.findIndex(request => request.method === 'POST' && request.path === '/api/reviews');
  assert.equal(resultsPutIndex >= 0 && resultsPostIndex > resultsPutIndex, true);
  const resultsReviewRequest = resultsReviewRequests[resultsPostIndex];
  assert.deepEqual(Object.keys(resultsReviewRequest.body).sort(), [...reviewOpenApiFixture.ReviewCreate.properties].sort());
  assert.equal(resultsReviewRequest.body.expectedRevision, 1);
  assert.equal(Object.hasOwn(resultsReviewRequest.body, 'expectedSampleRevision'), false);
  await page.getByRole('button', { name: 'Back to generation results', exact: true }).click();
  await page.waitForURL(`${baseUrl}${resultsReturnTo}`);

  await open(page, '/review/5?returnTo=%2Freview');
  await page.getByText('Review history (1)', { exact: true }).click();
  await page.locator('.review-detail__history-list').getByText('Accepted', { exact: true }).waitFor();
  assert.equal(api.state.requests.some(request => request.method === 'GET' && request.path === '/api/reviews'), true);

  await open(page, '/review/31?returnTo=%2Freview%3Fdecision%3DAccepted');
  await page.getByRole('button', { name: 'Return to pending', exact: true }).click();
  await page.getByRole('dialog', { name: 'Return to pending review?' }).getByRole('button', { name: 'Return to pending', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/review/32');
  const withdrawRequest = [...api.state.requests].reverse().find(request => request.method === 'POST' && request.path === '/api/reviews');
  assert.equal(withdrawRequest?.body?.decision, 'Pending');

  const archiveRoute = '/archive?dataset=1&search=CS-&category=C-VA&page=2';
  await open(page, archiveRoute);
  await page.getByRole('link', { name: 'CS-000031', exact: true }).click();
  detailUrl = new URL(page.url());
  assert.equal(detailUrl.pathname, '/review/31');
  assert.equal(detailUrl.searchParams.get('returnTo'), archiveRoute);
  await page.getByRole('button', { name: 'Back to review list', exact: true }).click();
  await page.waitForURL(`${baseUrl}${archiveRoute}`);

  for (const locale of ['zh-CN', 'en-US']) {
    const listBackLabel = locale === 'zh-CN' ? '返回审核列表' : 'Back to review list';
    const resultsBackLabel = locale === 'zh-CN' ? '返回生成结果' : 'Back to generation results';
    for (const [width, height] of [[1440, 900], [1024, 900], [768, 900], [390, 844]]) {
      await expectNoOverflow(page, '/review', locale, width, height);
      await expectReviewListMediaContained(page, width);
      if (artifactRoot) await page.screenshot({ path: join(artifactRoot, `review-list-${locale}-${width}.png`), fullPage: true });

      await expectNoOverflow(page, '/review/4?returnTo=%2Freview', locale, width, height);
      await page.getByRole('button', { name: listBackLabel, exact: true }).waitFor();

      const resultsDetailRoute = `/review/5?returnTo=${encodeURIComponent(resultsReturnTo)}`;
      await expectNoOverflow(page, resultsDetailRoute, locale, width, height);
      await page.getByRole('button', { name: resultsBackLabel, exact: true }).waitFor();
      if (artifactRoot) await page.screenshot({ path: join(artifactRoot, `review-results-return-${locale}-${width}.png`), fullPage: true });

      await expectNoOverflow(page, '/archive?dataset=1&page=2', locale, width, height);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/review/4?returnTo=%2Freview', 'en-US');
  assert.equal(await page.locator('.review-detail__media video').evaluate(element => getComputedStyle(element).objectFit), 'contain');

  assert.equal(api.state.mediaRequests > 0, true);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  if (artifactRoot) await page.screenshot({ path: join(artifactRoot, 'review-archive.png'), fullPage: true });
  console.log('Review browser checks passed.');
} finally {
  if (gateContext) await gateContext.close();
  if (createGateContext) await createGateContext.close();
  if (context && tracingStarted && artifactRoot) await context.tracing.stop({ path: join(artifactRoot, 'review-browser-trace.zip') });
  if (browser) await browser.close();
  await server.close();
}
