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
const dataKey = 'conflictstudio.prototype.data.v9';

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
  const routerWarnings = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
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
  await page.locator('.app-shell__sidebar .primary-nav__link[href="/workspace"]').click();
  const leaveDialog = page.getByRole('dialog');
  await leaveDialog.waitFor();
  equal(await leaveDialog.locator('.dialog__header h2').textContent(), 'Unsaved changes', 'Unsaved navigation must use the application dialog.');
  await leaveDialog.locator('.dialog__footer button').first().click();
  equal(new URL(page.url()).pathname, '/generate/batches', 'Cancelling the dialog must keep the batch page open.');
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

  const routes = [
    '/workspace',
    '/generate/batches',
    '/generate/test',
    '/generate/content',
    '/generate/presets',
    '/generate/jobs',
    '/review?sample=CS-0008',
    '/archive',
  ];
  const viewports = [[1440, 900], [1024, 768], [768, 900], [390, 844]];
  for (const locale of ['zh-CN', 'en-US']) {
    for (const [width, height] of viewports) {
      for (const route of routes) await expectNoOverflow(page, route, locale, width, height);
    }
  }

  equal(routerWarnings.length, 0, `React Router warnings: ${routerWarnings.join(' | ')}`);
  equal(pageErrors.length, 0, `Browser page errors: ${pageErrors.join(' | ')}`);
  console.log('Browser checks passed: 31 interactions and 64 bilingual viewport checks.');
} finally {
  if (browser) await browser.close();
  await server.close();
}
