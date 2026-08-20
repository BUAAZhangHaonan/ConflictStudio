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
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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

  const listRoute = '/review?decision=Pending&page=2';
  await open(page, listRoute);
  await page.getByRole('button', { name: 'CS-000021', exact: true }).click();
  await page.waitForURL(`${baseUrl}/review/21`);
  await page.getByRole('button', { name: 'Back to review list', exact: true }).click();
  await page.waitForURL(`${baseUrl}${listRoute}`);
  assert.equal(await page.getByRole('button', { name: 'CS-000021', exact: true }).count(), 1);

  await open(page, '/review/4');
  const detailText = await page.locator('.review-detail-page').innerText();
  for (const forbidden of ['Seed', 'Positive prompt', 'Negative prompt', 'Attempt', 'GPU', 'VLM', 'Keyboard shortcut']) {
    assert.equal(detailText.includes(forbidden), false, `Review detail must not show ${forbidden}`);
  }
  assert.equal(await page.getByRole('button', { name: 'Play source video with audio', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Play source video with audio', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Show silent primary video', exact: true }).count(), 1);

  const note = page.getByLabel('Note');
  await note.fill('Checked media and emotion.');
  await page.getByText('Saved', { exact: true }).waitFor({ timeout: 3000 });
  assert.equal(api.state.requests.some(request => request.method === 'PUT' && request.path === '/api/samples/4/review-note-draft'), true);

  await page.getByRole('button', { name: 'Accepted', exact: true }).click();
  await page.getByRole('dialog', { name: 'Confirm review' }).getByRole('button', { name: 'Save and continue', exact: true }).click();
  await page.waitForURL(/\/review\/\d+$/u);
  assert.equal(api.state.requests.some(request => request.method === 'POST' && request.path === '/api/reviews'), true);

  await open(page, '/review/1');
  await page.getByText('This content has no available shooting scene, so generation is not available now.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open generation', exact: true }).getAttribute('href'), '/generate/production');

  const archiveRoute = '/archive?dataset=1&search=CS-&category=C-VA&page=2';
  await open(page, archiveRoute);
  await page.getByRole('link', { name: 'CS-000031', exact: true }).click();
  const detailUrl = new URL(page.url());
  assert.equal(detailUrl.pathname, '/review/31');
  assert.equal(detailUrl.searchParams.get('returnTo'), archiveRoute);
  await page.getByRole('button', { name: 'Back to review list', exact: true }).click();
  await page.waitForURL(`${baseUrl}${archiveRoute}`);

  for (const locale of ['zh-CN', 'en-US']) {
    for (const [width, height] of [[1440, 900], [1024, 900], [768, 900], [390, 844]]) {
      for (const route of ['/review', '/review/4', '/archive?dataset=1&page=2']) {
        await expectNoOverflow(page, route, locale, width, height);
      }
    }
  }

  assert.equal(api.state.mediaRequests > 0, true);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  if (artifactRoot) await page.screenshot({ path: join(artifactRoot, 'review-archive.png'), fullPage: true });
  console.log('Review browser checks passed.');
} finally {
  if (context && tracingStarted && artifactRoot) await context.tracing.stop({ path: join(artifactRoot, 'review-browser-trace.zip') });
  if (browser) await browser.close();
  await server.close();
}
