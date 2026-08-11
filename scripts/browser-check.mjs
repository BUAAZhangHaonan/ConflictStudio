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
const dataKey = 'conflictstudio.prototype.data.v8';
const batchDraftKey = 'conflictstudio.generation.draft.conflictstudio.generation.batchDraft.v2';

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
}

async function setLocale(page, locale) {
  await page.evaluate(value => localStorage.setItem('conflictstudio.prototype.locale', value), locale);
}

async function makeGpusAvailable(page) {
  await page.evaluate(key => {
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error('Prototype data is missing.');
    const data = JSON.parse(raw);
    data.gpuStates = data.gpuStates.map(gpu => ({
      ...gpu,
      availability: 'Available',
      activeJobId: null,
    }));
    localStorage.setItem(key, JSON.stringify(data));
    sessionStorage.removeItem('conflictstudio.generation.draft.conflictstudio.generation.batchDraft.v2');
  }, dataKey);
}

async function expectNoOverflow(page, route, locale, width, height) {
  await page.setViewportSize({ width, height });
  await setLocale(page, locale);
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  equal(overflow.document, 0, `${locale} ${route} ${width} document overflow`);
  equal(overflow.body, 0, `${locale} ${route} ${width} body overflow`);
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
    localStorage.setItem('conflictstudio.prototype.reviewer.v2', 'reviewer-lin');
    localStorage.setItem('conflictstudio.prototype.locale', 'zh-CN');
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(`${baseUrl}/workspace`, { waitUntil: 'networkidle' });
  await makeGpusAvailable(page);
  await page.goto(`${baseUrl}/generate/batches`, { waitUntil: 'networkidle' });

  const contentFieldset = page.locator('fieldset[aria-describedby="batch-content-hint"]');
  await contentFieldset.getByRole('button', { name: '全选' }).click();
  const contentChecks = contentFieldset.locator('input[type="checkbox"]');
  equal(await contentChecks.count(), await contentChecks.evaluateAll(nodes => nodes.filter(node => node.checked).length), 'Select all must select every enabled item in the current content list.');

  const gpuFieldset = page.locator('fieldset[aria-describedby="batch-gpu-hint"]');
  const gpuChecks = gpuFieldset.locator('input[type="checkbox"]');
  if (!(await gpuChecks.nth(1).isChecked())) await gpuChecks.nth(1).check();
  equal(await gpuChecks.evaluateAll(nodes => nodes.filter(node => node.checked).length), 2, 'A production batch must allow both GPUs.');

  const quantity = page.locator('#batch-quantity');
  await quantity.fill('9');
  let linkPromptSeen = false;
  page.once('dialog', async dialog => {
    linkPromptSeen = true;
    await dialog.dismiss();
  });
  await page.getByRole('link', { name: '工作台' }).click();
  equal(linkPromptSeen, true, 'Unsaved link navigation must prompt.');
  equal(new URL(page.url()).pathname, '/generate/batches', 'Dismissed navigation must remain on the batch page.');
  await page.getByRole('button', { name: '保存当前批次' }).click();
  const savedReferences = await page.evaluate(({ dataStorageKey, draftStorageKey }) => {
    const data = JSON.parse(localStorage.getItem(dataStorageKey));
    const draft = JSON.parse(sessionStorage.getItem(draftStorageKey));
    data.gpuStates = data.gpuStates.map(gpu => ({ ...gpu, availability: 'Reserved', activeJobId: 'external-job' }));
    localStorage.setItem(dataStorageKey, JSON.stringify(data));
    return { gpus: draft.gpus, presetId: draft.presetId, contentItemIds: draft.contentItemIds };
  }, { dataStorageKey: dataKey, draftStorageKey: batchDraftKey });
  await page.reload({ waitUntil: 'networkidle' });
  equal(await gpuFieldset.locator('input[type="checkbox"]').evaluateAll(nodes => nodes.filter(node => node.checked).length), 2, 'GPU occupancy changes must not rewrite a saved draft.');
  equal(await page.locator('[data-draft-issue="gpu"]').count(), 1, 'An unavailable saved GPU must show an explicit error.');

  await page.evaluate(({ key, presetId }) => {
    const data = JSON.parse(localStorage.getItem(key));
    data.gpuStates = data.gpuStates.map(gpu => ({ ...gpu, availability: 'Available', activeJobId: null }));
    data.presets = data.presets.map(preset => preset.id === presetId ? { ...preset, status: 'Disabled' } : preset);
    localStorage.setItem(key, JSON.stringify(data));
  }, { key: dataKey, presetId: savedReferences.presetId });
  await page.reload({ waitUntil: 'networkidle' });
  equal(await page.locator('#batch-preset').inputValue(), savedReferences.presetId, 'A disabled preset must remain selected in a saved draft.');
  equal(await page.locator('[data-draft-issue="preset"]').count(), 1, 'A disabled saved preset must show an explicit error.');

  await page.evaluate(({ key, presetId, contentId }) => {
    const data = JSON.parse(localStorage.getItem(key));
    data.presets = data.presets.map(preset => preset.id === presetId ? { ...preset, status: 'Active' } : preset);
    data.contentItems = data.contentItems.map(content => content.id === contentId ? { ...content, status: 'Disabled' } : content);
    localStorage.setItem(key, JSON.stringify(data));
  }, { key: dataKey, presetId: savedReferences.presetId, contentId: savedReferences.contentItemIds[0] });
  await page.reload({ waitUntil: 'networkidle' });
  const storedContentIds = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)).contentItemIds, batchDraftKey);
  assert.deepEqual(storedContentIds, savedReferences.contentItemIds, 'A disabled content item must remain in a saved draft.');
  equal(await page.locator('[data-draft-issue="content"]').count(), 1, 'A disabled saved content item must show an explicit error.');

  await page.evaluate(({ key, contentIds }) => {
    const data = JSON.parse(localStorage.getItem(key));
    data.contentItems = data.contentItems.map(content => contentIds.includes(content.id) ? { ...content, status: 'Active' } : content);
    localStorage.setItem(key, JSON.stringify(data));
  }, { key: dataKey, contentIds: savedReferences.contentItemIds });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('link', { name: '工作台' }).click();
  equal(new URL(page.url()).pathname, '/workspace', 'Saved batch navigation must not be blocked.');

  await page.goto(`${baseUrl}/generate/batches`, { waitUntil: 'networkidle' });
  await quantity.fill('10');
  let backPromptSeen = false;
  page.once('dialog', async dialog => {
    backPromptSeen = true;
    await dialog.dismiss();
  });
  await page.goBack({ timeout: 1_000 }).catch(error => {
    if (error.name !== 'TimeoutError') throw error;
  });
  await page.waitForTimeout(100);
  equal(backPromptSeen, true, 'Browser back must prompt when the batch is unsaved.');
  equal(new URL(page.url()).pathname, '/generate/batches', 'Dismissed browser back must remain on the batch page.');

  page.once('dialog', dialog => dialog.accept());
  await page.goBack();
  await page.goto(`${baseUrl}/generate/batches`, { waitUntil: 'networkidle' });
  await page.goto(`${baseUrl}/generate/jobs`, { waitUntil: 'networkidle' });
  await page.goBack({ waitUntil: 'networkidle' });
  await page.locator('#batch-quantity').fill('11');
  let forwardPromptSeen = false;
  page.once('dialog', async dialog => {
    forwardPromptSeen = true;
    await dialog.dismiss();
  });
  await page.goForward({ timeout: 1_000 }).catch(error => {
    if (error.name !== 'TimeoutError') throw error;
  });
  await page.waitForTimeout(100);
  equal(forwardPromptSeen, true, 'Browser forward must prompt when the batch is unsaved.');
  equal(new URL(page.url()).pathname, '/generate/batches', 'Dismissed browser forward must remain on the batch page.');

  page.once('dialog', dialog => dialog.accept());
  await page.goForward({ waitUntil: 'networkidle' });
  equal(new URL(page.url()).pathname, '/generate/jobs', 'Accepted browser forward must continue.');
  await page.getByText('33/128', { exact: true }).first().waitFor();
  equal(await page.locator('[data-current-video]').count(), 2, 'A dual GPU job must show two current videos.');
  equal(await page.locator('[data-current-video]').nth(0).getByText('GPU0', { exact: true }).count(), 1, 'The first current video must show GPU 0.');
  equal(await page.locator('[data-current-video]').nth(1).getByText('GPU1', { exact: true }).count(), 1, 'The second current video must show GPU 1.');

  await page.goto(`${baseUrl}/generate/content`, { waitUntil: 'networkidle' });
  await page.locator('#content-search').fill('候选场景草稿');
  await page.getByRole('button', { name: /候选场景草稿/ }).click();
  await page.getByRole('button', { name: '删除内容' }).click();
  await page.getByRole('dialog').getByText('删除这个内容项？').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  await page.getByText('正提示词', { exact: true }).waitFor();
  await page.getByText('负提示词', { exact: true }).waitFor();

  await page.goto(`${baseUrl}/review?sample=CS-0008`, { waitUntil: 'networkidle' });
  equal(await page.locator('.review-grid').getAttribute('data-selected-sample'), 'CS-0008', 'Visible sample ids must open the requested review sample.');
  equal(page.url().includes('sample-c-'), false, 'Review URLs must not expose internal sample ids.');

  await page.goto(`${baseUrl}/archive`, { waitUntil: 'networkidle' });
  const archiveSampleCount = await page.evaluate(key => {
    const data = JSON.parse(localStorage.getItem(key));
    return data.archives.find(archive => archive.datasetId === 'dataset-main').currentSampleIds.length;
  }, dataKey);
  equal(archiveSampleCount >= 25, true, 'The formal archive must contain at least 25 complete example samples.');
  await page.getByRole('button', { name: '预览同步' }).click();
  equal(await page.locator('.archive-preview__group').count(), 1, 'Sync preview must omit empty change groups.');
  equal(await page.locator('.archive-preview__zero').count(), 0, 'Sync preview must not show extra zero values.');
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  await page.getByRole('button', { name: '下一页' }).click();
  equal(new URL(page.url()).searchParams.get('page'), '2', 'Archive page two must be reachable.');
  const pageTwoSample = await page.locator('.archive-table-shell tbody .table-link').first().textContent();
  await page.locator('.archive-table-shell tbody .table-link').first().click();
  equal(new URL(page.url()).searchParams.get('sample'), pageTwoSample?.trim(), 'Archive links must use the visible sample id.');
  await page.getByRole('button', { name: '返回归档' }).click();
  equal(new URL(page.url()).pathname, '/archive', 'Review must return to archive.');
  equal(new URL(page.url()).searchParams.get('page'), '2', 'Archive return must restore page two.');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/review?sample=CS-0008`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: '切换为英文' }).click();
  await page.getByRole('button', { name: 'Open navigation' }).waitFor();

  await page.setViewportSize({ width: 768, height: 900 });
  await setLocale(page, 'zh-CN');
  await page.goto(`${baseUrl}/review?sample=CS-0008`, { waitUntil: 'networkidle' });
  equal(await page.locator('.review-secondary-action:not([open])').count(), 2, 'Secondary review actions must start collapsed at 768 pixels.');
  const mobileOrders = await page.evaluate(() => ({
    context: getComputedStyle(document.querySelector('.review-context')).order,
    decision: getComputedStyle(document.querySelector('.review-decision')).order,
  }));
  equal(Number(mobileOrders.context) < Number(mobileOrders.decision), true, 'Key context must appear before secondary review decisions on narrow screens.');

  await page.setViewportSize({ width: 1024, height: 768 });
  await setLocale(page, 'en-US');
  await page.goto(`${baseUrl}/review?sample=CS-0008`, { waitUntil: 'networkidle' });
  const filterWidths = await page.locator('.review-filters__grid select, .review-filters__grid input').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  equal(filterWidths.every(width => width >= 220), true, 'English review filters must have enough width at 1024 pixels.');

  const routes = ['/workspace', '/generate/batches', '/generate/content', '/generate/jobs', '/review?sample=CS-0008', '/archive'];
  const viewports = [[1440, 900], [1024, 768], [768, 900], [390, 844]];
  for (const locale of ['zh-CN', 'en-US']) {
    for (const [width, height] of viewports) {
      for (const route of routes) await expectNoOverflow(page, route, locale, width, height);
    }
  }

  equal(pageErrors.length, 0, `Browser page errors: ${pageErrors.join(' | ')}`);
  console.log('Browser checks passed: 23 interactions and 48 bilingual viewport checks.');
} finally {
  if (browser) await browser.close();
  await server.close();
}
