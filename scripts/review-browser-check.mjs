import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { createBrowserApiFixture, installPreferences, preferenceKeys } from './browser-fixtures.mjs';

const playwrightModule = process.env.CONFLICTSTUDIO_PLAYWRIGHT_MODULE;
if (!playwrightModule) throw new Error('CONFLICTSTUDIO_PLAYWRIGHT_MODULE is required.');
const { chromium } = await import(pathToFileURL(playwrightModule).href);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = resolve(projectRoot, 'frontend');
const baseUrl = 'http://127.0.0.1:4174';
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
  assert.deepEqual(overflow, { document: 0, body: 0 }, `${locale} ${route} must not overflow at ${width}px.`);
}

async function waitForFrame(page) {
  await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
}

const server = await createServer({
  root: frontendRoot,
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 4174, strictPort: true },
});

let browser;
let context;
let tracingStarted = false;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await installPreferences(context);
  if (artifactRoot) {
    await context.tracing.start({ screenshots: true, snapshots: true });
    tracingStarted = true;
  }
  const api = createBrowserApiFixture();
  const page = await context.newPage();
  await api.install(page);
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await open(page, '/review', 'en-US');
  await page.locator('#review-search').fill('CS-000');
  await page.locator('#review-dataset-filter').selectOption('1');
  await page.locator('#review-category-filter').selectOption('C-VA');
  const queueList = page.locator('.review-queue__list');
  const target = page.locator('.review-queue__item').filter({ hasText: 'CS-000006' });
  assert.equal(await target.count(), 1, 'The mobile scroll test must target exactly CS-000006.');
  await target.scrollIntoViewIfNeeded();
  await queueList.evaluate(element => { element.scrollTop = 160; });
  await page.evaluate(() => window.scrollTo(0, Math.min(420, document.documentElement.scrollHeight - innerHeight)));
  const before = {
    page: await page.evaluate(() => window.scrollY),
    queue: await queueList.evaluate(element => element.scrollTop),
    search: await page.locator('#review-search').inputValue(),
    dataset: await page.locator('#review-dataset-filter').inputValue(),
    category: await page.locator('#review-category-filter').inputValue(),
  };
  assert.ok(before.page > 0, 'The mobile queue must have a nonzero page scroll before opening a sample.');
  assert.ok(before.queue > 0, 'The mobile queue must have a nonzero internal scroll before opening a sample.');
  await target.click();
  await page.locator('.review-detail').waitFor();
  await waitForFrame(page);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'Opening mobile detail must move the page to the top.');
  assert.equal(await page.locator('.review-queue').isVisible(), false, '390px selected view must hide the queue.');
  for (const selector of ['.review-media video', '.review-context', '.review-generation-record', '.review-decision']) {
    assert.equal(await page.locator(selector).isVisible(), true, `390px selected view must show ${selector}.`);
  }
  const detailBounds = await page.locator('.review-detail__navigation').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom, viewportHeight: innerHeight };
  });
  assert.equal(detailBounds.top >= 0 && detailBounds.bottom <= detailBounds.viewportHeight, true, 'The detail navigation must open inside the viewport.');
  const videoBounds = await page.locator('.review-media video').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom, viewportHeight: innerHeight };
  });
  assert.equal(videoBounds.top >= 0 && videoBounds.top < videoBounds.viewportHeight, true, 'The review video must start within the mobile viewport.');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, '390px selected review must not overflow horizontally.');
  if (artifactRoot) await page.screenshot({ path: join(artifactRoot, 'review-mobile-detail.png'), fullPage: true });

  const sampleContext = await page.locator('.review-context').textContent();
  assert.equal(sampleContext.includes('LTX-2.5'), true, 'Sample context must keep the model.');
  for (const value of ['BF16', 'GPU1', '424248', '9006']) assert.equal(sampleContext.includes(value), false, `Sample context must not contain ${value}.`);
  const generationRecord = await page.locator('.review-generation-record').textContent();
  for (const value of ['LTX-2.5', 'BF16', 'GPU1', '424248', '3']) assert.equal(generationRecord.includes(value), true, `Generation record must contain ${value}.`);

  await page.getByRole('button', { name: 'Back to queue', exact: true }).click();
  await page.locator('.review-queue').waitFor({ state: 'visible' });
  await waitForFrame(page);
  assert.equal(await page.evaluate(() => window.scrollY), before.page, 'Returning must restore window.scrollY exactly.');
  assert.equal(await queueList.evaluate(element => element.scrollTop), before.queue, 'Returning must restore queue scrollTop exactly.');
  assert.equal(await page.locator('#review-search').inputValue(), before.search, 'Returning must preserve search.');
  assert.equal(await page.locator('#review-dataset-filter').inputValue(), before.dataset, 'Returning must preserve dataset filter.');
  assert.equal(await page.locator('#review-category-filter').inputValue(), before.category, 'Returning must preserve category filter.');
  assert.equal(await page.locator('.review-queue').evaluate(element => element === document.activeElement), true, 'Returning must focus the queue without changing scroll.');

  for (const [locale, labels] of [
    ['en-US', ['Generation record', 'Attempt revision']],
    ['zh-CN', ['生成记录', '尝试序号']],
  ]) {
    await open(page, '/review?sample=CS-000002', locale);
    const text = await page.locator('.review-generation-record').textContent();
    for (const label of labels) assert.equal(text.includes(label), true, `${locale} must show ${label}.`);
  }

  for (const [locale, labels] of [
    ['en-US', { action: 'Change category', title: 'Change sample category', emotion: 'New apparent emotion', description: 'True emotion description after the change' }],
    ['zh-CN', { action: '修改类别', title: '修改样本类别', emotion: '新的表面情感', description: '修改后的真实情感描述' }],
  ]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, '/review?sample=CS-000004', locale);
    await page.getByRole('button', { name: labels.action, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: labels.title });
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel(labels.emotion).isVisible(), true, `${locale} must show the apparent emotion field for A to C.`);
    assert.equal(await dialog.getByLabel(labels.description).isVisible(), true, `${locale} must show the description field for A to C.`);
    const bounds = await dialog.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight };
    });
    assert.equal(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height, true, `${locale} classification dialog must fit the 390px viewport.`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, `${locale} classification dialog must not create horizontal overflow.`);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  }

  await open(page, `/review?sample=CS-000001&returnTo=${encodeURIComponent('https://example.com/archive')}`, 'en-US');
  assert.equal(await page.getByRole('button', { name: 'Back to previous page', exact: true }).count(), 0, 'Unsafe returnTo must not render a source return action.');
  await page.getByRole('button', { name: 'Back to queue', exact: true }).click();
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

  await page.setViewportSize({ width: 390, height: 844 });
  const archiveLocation = '/archive?dataset=1&search=CS-&category=C-VA&page=2';
  await open(page, archiveLocation, 'en-US');
  const pageTwoIds = await page.locator('.archive-list-panel tbody th a').allTextContents();
  assert.deepEqual(pageTwoIds, ['CS-000051', 'CS-000052', 'CS-000053', 'CS-000054', 'CS-000055'], 'Archive page two must contain the expected 20-item-page remainder.');
  await page.getByRole('link', { name: 'CS-000051', exact: true }).click();
  assert.equal(new URL(page.url()).searchParams.get('returnTo'), archiveLocation);
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('unrelatedHistory', '1');
    history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.getByRole('button', { name: 'Back to previous page', exact: true }).click();
  await page.waitForURL(`${baseUrl}${archiveLocation}`);
  assert.equal(`${new URL(page.url()).pathname}${new URL(page.url()).search}`, archiveLocation, 'Archive return must ignore unrelated history and restore the exact URL.');
  assert.equal(await page.locator('.archive-filter--search input').inputValue(), 'CS-', 'Archive return must restore search.');
  assert.equal(await page.locator('.archive-filter select').inputValue(), 'C-VA', 'Archive return must restore category.');
  assert.equal(await page.locator('.archive-pagination select').inputValue(), '2', 'Archive return must restore page two.');
  assert.deepEqual(await page.locator('.archive-list-panel tbody th a').allTextContents(), pageTwoIds, 'Archive return must restore the same sample set.');

  await page.getByRole('button', { name: 'Preview sync' }).click();
  await page.getByRole('button', { name: 'Sync archive' }).click();
  const syncDialog = page.getByRole('dialog');
  await syncDialog.waitFor();
  assert.equal(await syncDialog.evaluate(element => element.contains(document.activeElement)), true, 'Sync dialog must move focus inside.');
  await page.keyboard.press('Tab');
  assert.equal(await syncDialog.evaluate(element => element.contains(document.activeElement)), true, 'Tab must remain inside the sync dialog.');
  await page.keyboard.press('Escape');
  await syncDialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: 'Sync archive' }).evaluate(element => element === document.activeElement), true, 'Closing the dialog must restore focus to its trigger.');

  const routes = ['/review', '/review?sample=CS-000001', '/archive?dataset=1&category=C-VA&page=2'];
  for (const locale of ['zh-CN', 'en-US']) {
    for (const [width, height] of [[1440, 900], [768, 900], [390, 844]]) {
      for (const route of routes) await expectNoOverflow(page, route, locale, width, height);
    }
  }
  for (const locale of ['zh-CN', 'en-US']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, '/review?sample=CS-000001', locale);
    assert.equal(await page.locator('.review-media video').isVisible(), true, `${locale} mobile review must show media.`);
    assert.equal(await page.locator('body').textContent().then(text => text.includes('workspaceSettingsStatistics.') || text.includes('reviewArchive.')), false, `${locale} must not expose translation keys.`);
  }

  assert.equal(api.state.mediaRequests > 0, true, 'Review and archive must request media through the route fixture.');
  assert.deepEqual(pageErrors, [], `Page errors: ${pageErrors.join(' | ')}`);
  assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join(' | ')}`);
  if (artifactRoot) await page.screenshot({ path: join(artifactRoot, 'review-archive-final-390.png'), fullPage: true });
  console.log('Review browser checks passed: mobile scroll restoration, safe archive returns, bilingual layout, keyboard focus, and media layout.');
} finally {
  if (context && tracingStarted && artifactRoot) await context.tracing.stop({ path: join(artifactRoot, 'review-browser-trace.zip') });
  if (browser) await browser.close();
  await server.close();
}
