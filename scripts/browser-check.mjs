import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import {
  createBrowserApiFixture,
  installPreferences,
  jobItemsFixture,
  preferenceKeys,
  sampleFixture,
} from './browser-fixtures.mjs';

const playwrightModule = process.env.CONFLICTSTUDIO_PLAYWRIGHT_MODULE;
if (!playwrightModule) throw new Error('CONFLICTSTUDIO_PLAYWRIGHT_MODULE is required.');
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = resolve(projectRoot, 'frontend');
const baseUrl = 'http://127.0.0.1:4173';
const artifactRoot = process.env.CONFLICTSTUDIO_BROWSER_ARTIFACT_DIR;
const timestamp = '2026-08-24T08:00:00.000Z';
const demographicsKey = 'conflictstudio.generation.lastDemographics';
if (artifactRoot) mkdirSync(artifactRoot, { recursive: true });

const promptTemplate = {
  id: 1,
  name: 'Natural conversation',
  category: 'A-VA',
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const promptVersion = {
  id: 1,
  templateId: 1,
  templateName: promptTemplate.name,
  category: 'A-VA',
  version: 1,
  organizationRules: 'Keep the response concise.',
  styleGuidance: 'Use natural restrained acting.',
  positiveExamples: ['A natural reply.'],
  negativeExamples: ['Exaggerated acting.'],
  ltxNegativePrompt: 'No subtitles.',
  h3NegativePrompt: 'No subtitles.',
  verificationStatus: 'Verified',
  revision: 1,
  createdAt: timestamp,
  verifiedAt: timestamp,
};

const assistantBundle = {
  contentScript: {
    nameZh: '建议内容', nameEn: 'Proposed content', category: 'A-VA', conflictDirection: null,
    mode: 'Fixed', status: 'Draft', trueEmotion: 'sadness', apparentEmotion: 'sadness',
    sceneZh: '安静办公室', sceneEn: 'Quiet office', triggerEventZh: '收到消息', triggerEventEn: 'A message arrives',
    psychologicalBackgroundZh: '人物保持克制', psychologicalBackgroundEn: 'The person stays restrained',
    dialogue: 'I understand.', displayText: null, trueEmotionDescription: 'The voice and face carry sadness.',
    baseVideoPrompt: 'A fixed camera records a short reply.', contentRequirementsZh: '', contentRequirementsEn: '',
    sceneSupplementZh: '', sceneSupplementEn: '',
  },
  scenes: [{
    nameZh: '建议场景', nameEn: 'Proposed scene', sceneZh: '安静办公室', sceneEn: 'Quiet office',
    ambientSoundZh: '轻微空调声', ambientSoundEn: 'Low air conditioner hum', participantRelationshipZh: '同事', participantRelationshipEn: 'Colleagues',
    lightingZh: '柔和室内光', lightingEn: 'Soft indoor light', framingZh: '中景', framingEn: 'Medium shot', status: 'Draft',
  }],
  promptTemplateVersion: {
    organizationRules: 'Keep the response concise.', styleGuidance: 'Use natural restrained acting.',
    positiveExamples: ['A natural reply.'], negativeExamples: ['Exaggerated acting.'],
    ltxNegativePrompt: 'No subtitles.', h3NegativePrompt: 'No subtitles.',
  },
};

function pageValue(values, page = 1) {
  const pageSize = 20;
  const start = (page - 1) * pageSize;
  return {
    items: values.slice(start, start + pageSize),
    page,
    pageSize,
    total: values.length,
    totalPages: Math.ceil(values.length / pageSize),
  };
}

function job(id, source, displayName) {
  return {
    id, displayName, source, datasetId: source === 'Production' ? 1 : null,
    datasetNameSnapshot: source === 'Production' ? 'Formal samples' : null,
    batchDraftId: source === 'Production' ? 1 : null, category: 'A-VA', conflictDirection: null,
    model: 'LTX-2.5', precision: 'INT8', profiles: [{ model: 'LTX-2.5', precision: 'INT8' }],
    status: 'Completed', totalCount: 1, preparedCount: 1, completedCount: 1, failedCount: 0,
    confirmModelSwitch: false, cancelRequestedAt: null, failureCode: null, failureReason: null,
    startedAt: timestamp, finishedAt: timestamp, revision: 1, createdAt: timestamp, updatedAt: timestamp,
  };
}

function generationFixture() {
  return {
    gpuSlots: [
      { slot: 'GPU0', availability: 'Available', loadedModel: 'LTX-2.5', loadedPrecision: 'INT8', serviceStatus: 'running', gpuName: 'Fixture GPU', memory: { usedMiB: 1024, totalMiB: 8192 }, activeJobId: null, revision: 2, checkedAt: timestamp, statusReason: null },
    ],
    requests: [],
    draft: null,
    appliedBody: null,
    productionJob: job(99, 'Production', 'A-VA-browser-check'),
    promptJob: job(98, 'PromptTest', 'Prompt test browser check'),
  };
}

async function installGenerationRoutes(page, api, fixture) {
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = method === 'GET' || method === 'DELETE' ? null : request.postDataJSON();
    const fulfill = (value, status = 200) => {
      fixture.requests.push({ method, path, body, query: Object.fromEntries(url.searchParams) });
      return route.fulfill({ status, json: value, headers: { 'Cache-Control': 'no-store' } });
    };

    if (method === 'GET' && path === '/api/gpu-slots') return fulfill(fixture.gpuSlots);
    if (method === 'GET' && path === '/api/content-scripts') {
      const status = url.searchParams.get('status');
      const category = url.searchParams.get('category');
      const direction = url.searchParams.get('direction');
      const search = (url.searchParams.get('search') ?? '').trim().toLocaleLowerCase('en-US');
      const values = api.state.contentScripts.filter(item => (!status || item.status === status)
        && (!category || item.category === category)
        && (!direction || item.conflictDirection === direction)
        && (!search || `${item.nameZh} ${item.nameEn}`.toLocaleLowerCase('en-US').includes(search)));
      return fulfill(pageValue(values, Number(url.searchParams.get('page') ?? 1)));
    }
    if (method === 'GET' && path === '/api/scenes') {
      const status = url.searchParams.get('status');
      const values = api.state.scenes.filter(item => !status || item.status === status);
      return fulfill(pageValue(values, Number(url.searchParams.get('page') ?? 1)));
    }
    const sceneMatch = /^\/api\/scenes\/(\d+)$/u.exec(path);
    if (method === 'GET' && sceneMatch) return fulfill(api.state.scenes.find(item => item.id === Number(sceneMatch[1])));
    if (method === 'GET' && path === '/api/prompt-templates') return fulfill(pageValue([promptTemplate], Number(url.searchParams.get('page') ?? 1)));
    if (method === 'GET' && path === '/api/prompt-templates/1/versions') return fulfill(pageValue([promptVersion], Number(url.searchParams.get('page') ?? 1)));
    if (method === 'GET' && path === '/api/prompt-template-versions/1') return fulfill(promptVersion);

    if (method === 'POST' && path === '/api/resource-assistant/propose') {
      return fulfill({ promptTemplate, bundle: structuredClone(assistantBundle) });
    }
    if (method === 'POST' && path === '/api/resource-assistant/apply') {
      fixture.appliedBody = body;
      const contentScript = { id: 901, ...body.bundle.contentScript, sceneIds: [901], revision: 1, createdAt: timestamp, updatedAt: timestamp };
      const scenes = body.bundle.scenes.map((value, index) => ({ id: 901 + index, ...value, revision: 1, createdAt: timestamp, updatedAt: timestamp }));
      const version = { id: 902, templateId: 1, templateName: promptTemplate.name, category: 'A-VA', version: 2, ...body.bundle.promptTemplateVersion, verificationStatus: 'Draft', revision: 1, createdAt: timestamp, verifiedAt: null };
      api.state.contentScripts.push(contentScript);
      api.state.scenes.push(...scenes);
      api.state.contentRelations.set(contentScript.id, scenes.map(item => item.id));
      return fulfill({ contentScript, scenes, promptTemplateVersion: version }, 201);
    }

    if ((method === 'POST' && path === '/api/batch-drafts') || (method === 'PUT' && path === '/api/batch-drafts/1')) {
      const contentSelections = body.contentSelections.map(selection => {
        const content = api.state.contentScripts.find(item => item.id === selection.contentScriptId);
        const compatibleIds = api.state.contentRelations.get(selection.contentScriptId) ?? [];
        const selectedIds = content.mode === 'Fixed' ? compatibleIds : selection.sceneIds;
        return {
          contentScript: { id: content.id, nameZh: content.nameZh, nameEn: content.nameEn, revision: content.revision },
          mode: content.mode,
          scenes: api.state.scenes.filter(item => selectedIds.includes(item.id)).map(item => ({ id: item.id, nameZh: item.nameZh, nameEn: item.nameEn, revision: item.revision })),
          compatibleScenes: api.state.scenes.filter(item => compatibleIds.includes(item.id)).map(item => ({ id: item.id, nameZh: item.nameZh, nameEn: item.nameEn, revision: item.revision })),
        };
      });
      const combinationCount = contentSelections.reduce((total, selection) => total + selection.scenes.length, 0) * body.demographics.length;
      fixture.draft = {
        id: 1, ...body, datasetRevision: 1, combinationCount, totalCount: combinationCount * body.seeds.length,
        status: 'Draft', contentSelections, promptTemplateVersion: { id: 1, name: promptTemplate.name, revision: 1 },
        revision: (fixture.draft?.revision ?? 0) + 1, createdAt: timestamp, updatedAt: timestamp,
      };
      delete fixture.draft.expectedRevision;
      return fulfill(fixture.draft, method === 'POST' ? 201 : 200);
    }
    if (method === 'POST' && path === '/api/batch-drafts/1/preview') {
      let sequence = 0;
      const allocations = fixture.draft.contentSelections.flatMap(selection => selection.scenes.flatMap(scene => fixture.draft.demographics.flatMap(demographic => fixture.draft.seeds.map(seed => ({
        sequence: sequence += 1,
        contentScript: selection.contentScript,
        promptTemplateVersion: fixture.draft.promptTemplateVersion,
        scene,
        demographic,
        gpuSlot: fixture.draft.gpuSlots[(sequence - 1) % fixture.draft.gpuSlots.length],
        model: fixture.draft.model,
        precision: fixture.draft.precision,
        seed,
        requiresPromptGeneration: true,
        systemInput: 'Fixture system input',
        userInput: 'Fixture user input',
        finalPositivePrompt: null,
        negativePrompt: 'Fixture negative prompt',
      })))));
      return fulfill({
        batchDraftId: 1,
        expectedRevision: fixture.draft.revision,
        combinationCount: fixture.draft.combinationCount,
        seedCount: fixture.draft.seeds.length,
        totalCount: fixture.draft.totalCount,
        gpuRevisions: Object.fromEntries(fixture.draft.gpuSlots.map(slot => [slot, fixture.gpuSlots.find(item => item.slot === slot)?.revision ?? 1])),
        allocations,
      });
    }
    if (method === 'POST' && path === '/api/batch-drafts/1/submit') return fulfill(fixture.productionJob, 201);
    if (method === 'POST' && path === '/api/test-runs/prompt') return fulfill(fixture.promptJob, 201);

    const productionItem = { ...jobItemsFixture[0], sampleId: 501 };
    const promptItem = { ...jobItemsFixture[0], sampleId: null, latestAttempt: null, gpuSlot: null };
    if (method === 'GET' && path === '/api/generation-results') return fulfill(pageValue([fixture.productionJob]));
    if (method === 'GET' && path === '/api/generation-results/99') return fulfill(fixture.productionJob);
    if (method === 'GET' && path === '/api/generation-results/99/items') return fulfill(pageValue([productionItem]));
    if (method === 'GET' && path === '/api/test-results') return fulfill(pageValue([fixture.promptJob]));
    if (method === 'GET' && path === '/api/test-results/98') return fulfill(fixture.promptJob);
    if (method === 'GET' && path === '/api/test-results/98/items') return fulfill(pageValue([promptItem]));

    return route.fallback();
  });
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
  assert.deepEqual(overflow, { document: 0, body: 0 }, `${locale} ${route} must fit at ${width}px.`);
}

async function waitForProductionDefaults(page) {
  await page.waitForFunction(() => document.querySelector('#production-template')?.value === '1');
  await page.waitForFunction(() => document.querySelector('#production-version')?.value === '1');
}

const server = await createServer({ root: frontendRoot, logLevel: 'silent', server: { host: '127.0.0.1', port: 4173, strictPort: true } });
let browser;
let context;
let tracingStarted = false;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
        }, 0);
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

  const pageErrors = [];
  const consoleErrors = [];
  const watchPage = page => {
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  };
  const api = createBrowserApiFixture();
  api.state.samples.push(sampleFixture(501));
  const fixture = generationFixture();
  const page = await context.newPage();
  watchPage(page);
  await api.install(page);
  await installGenerationRoutes(page, api, fixture);

  await open(page, '/generate/resources');
  assert.deepEqual(await page.locator('.generate-nav a').evaluateAll(links => links.map(link => link.getAttribute('href'))), [
    '/generate/test', '/generate/production', '/generate/results', '/generate/resources',
  ]);
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Content', 'Scenes', 'Prompt versions']);
  await page.locator('#resource-assistant-template').selectOption('1');
  await page.locator('#resource-assistant-requirement').fill('Create one restrained A-VA resource set.');
  await page.getByRole('button', { name: 'Prepare draft proposal', exact: true }).click();
  await page.getByRole('heading', { name: 'Review and edit proposal', exact: true }).waitFor();
  await page.locator('#assistant-content-name-en').fill('Edited proposal content');
  await page.getByRole('button', { name: 'Create all drafts', exact: true }).click();
  const applyDialog = page.getByRole('dialog', { name: 'Create this resource set' });
  await applyDialog.getByRole('button', { name: 'Create all drafts', exact: true }).click();
  await page.getByText('The content, scenes, and prompt version were created as drafts.', { exact: true }).waitFor();
  assert.equal(fixture.appliedBody.bundle.contentScript.nameEn, 'Edited proposal content');

  await open(page, '/generate/production');
  await page.evaluate(key => localStorage.removeItem(key), demographicsKey);
  await page.reload({ waitUntil: 'networkidle' });
  await waitForProductionDefaults(page);
  await page.locator('#production-dataset').selectOption('1');
  await page.locator('.generation-content-choice').filter({ hasText: 'Restrained reply' }).locator('input[type="checkbox"]').check();
  await page.locator('#production-age-0').selectOption('35');
  await page.locator('#production-gender-0').selectOption('Male');
  await page.locator('#production-ethnicity-0').selectOption('White');
  await page.getByRole('button', { name: 'Add person', exact: true }).click();
  await page.locator('#production-age-1').selectOption('45');
  await page.locator('.generation-gpu-select input[type="checkbox"]').check();
  await page.getByRole('button', { name: 'Preview all rows', exact: true }).click();
  await page.locator('.generation-preview tbody tr').nth(1).waitFor();
  assert.equal(await page.locator('.generation-preview tbody tr').count(), 2);
  assert.equal(await page.getByRole('button', { name: 'Submit generation', exact: true }).isDisabled(), false);

  await page.locator('#production-ethnicity-1').selectOption('Latino');
  await page.locator('.generation-preview tbody tr').first().waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: 'Submit generation', exact: true }).isDisabled(), true, 'A business edit must invalidate the visible preview.');
  await page.getByRole('button', { name: 'Preview all rows', exact: true }).click();
  await page.locator('.generation-preview tbody tr').nth(1).waitFor();

  const draftWrites = fixture.requests.filter(request => request.path === '/api/batch-drafts/1' || request.path === '/api/batch-drafts');
  assert.deepEqual(draftWrites.map(request => request.method), ['POST', 'PUT']);
  assert.equal(fixture.requests.filter(request => request.path === '/api/batch-drafts/1/preview').length, 2);
  await page.getByRole('button', { name: 'Submit generation', exact: true }).click();
  const submitDialog = page.getByRole('dialog', { name: 'Submit this formal generation task' });
  await submitDialog.getByRole('button', { name: 'Submit generation', exact: true }).click();
  await page.waitForURL(`${baseUrl}/generate/results?tab=production&job=99`);
  const reviewLink = page.getByRole('link', { name: 'Open in review', exact: true });
  await reviewLink.waitFor();
  const reviewUrl = new URL(await reviewLink.getAttribute('href'), baseUrl);
  assert.equal(reviewUrl.pathname, '/review/501');
  assert.equal(reviewUrl.searchParams.get('returnTo'), '/generate/results?tab=production&job=99');
  await reviewLink.click();
  await page.waitForURL(url => url.pathname === '/review/501' && url.searchParams.get('returnTo') === '/generate/results?tab=production&job=99');

  const memoryPage = await context.newPage();
  watchPage(memoryPage);
  await api.install(memoryPage);
  await installGenerationRoutes(memoryPage, api, fixture);
  await open(memoryPage, '/generate/production');
  await memoryPage.locator('#production-age-1').waitFor();
  assert.deepEqual(await memoryPage.locator('select[id^="production-age-"]').evaluateAll(elements => elements.map(element => element.value)), ['35', '45']);
  assert.deepEqual(await memoryPage.locator('select[id^="production-gender-"]').evaluateAll(elements => elements.map(element => element.value)), ['Male', 'Male']);
  assert.deepEqual(await memoryPage.locator('select[id^="production-ethnicity-"]').evaluateAll(elements => elements.map(element => element.value)), ['White', 'Latino']);

  fixture.gpuSlots = [];
  await memoryPage.reload({ waitUntil: 'networkidle' });
  await memoryPage.getByText('No GPU is available. Wait for an available GPU before previewing or submitting formal generation.', { exact: true }).waitFor();
  assert.equal(await memoryPage.getByRole('button', { name: 'Preview all rows', exact: true }).isDisabled(), true);

  await open(memoryPage, '/generate/test');
  await memoryPage.locator('#test-content').selectOption('1');
  await memoryPage.waitForFunction(() => document.querySelector('#test-scene')?.value === '1');
  await memoryPage.waitForFunction(() => document.querySelector('#test-version')?.value === '1');
  assert.equal(await memoryPage.locator('select[id^="test-gpu-"]').count(), 0, 'Prompt tests must remain GPU-independent.');
  const runButton = memoryPage.getByRole('button', { name: 'Run test', exact: true });
  assert.equal(await runButton.isDisabled(), false, 'A complete Prompt test must remain runnable with zero Available GPUs.');
  await runButton.click();
  await memoryPage.getByRole('dialog', { name: 'Run this test' }).getByRole('button', { name: 'Run test', exact: true }).click();
  await memoryPage.getByText('Final positive prompt line one.', { exact: false }).waitFor();
  await memoryPage.getByRole('radio', { name: /Video test/ }).check();
  await memoryPage.getByText('No GPU is available for a video test. Wait for an available GPU, or switch to Prompt test, which does not use a GPU.', { exact: true }).waitFor();
  assert.equal(await memoryPage.getByRole('button', { name: 'Add comparison', exact: true }).count(), 0);
  assert.equal(await memoryPage.getByRole('button', { name: 'Run test', exact: true }).isDisabled(), true);
  assert.equal(await memoryPage.evaluate(() => localStorage.getItem('conflictstudio.generation.hiddenTests')), null);

  const routes = ['/generate/resources', '/generate/test', '/generate/production', '/generate/results?tab=production&job=99'];
  for (const locale of ['en-US', 'zh-CN']) {
    const productionSubtitle = locale === 'zh-CN'
      ? '选择全部有效组合。预览会保存当前配置，并在提交前显示每一条分配。'
      : 'Choose every valid combination. Preview saves the current configuration and shows every assignment before submission.';
    for (const [width, height] of [[1440, 900], [1024, 900], [768, 900], [390, 844]]) {
      for (const route of routes) {
        await expectNoOverflow(memoryPage, route, locale, width, height);
        if (route !== '/generate/production') continue;
        assert.equal(await memoryPage.locator('.generation-page__subtitle').textContent(), productionSubtitle);
        const productionText = await memoryPage.locator('.generation-page').innerText();
        assert.equal(productionText.includes('save the batch'), false);
        assert.equal(productionText.includes('保存批次'), false);
        if (artifactRoot) await memoryPage.screenshot({ path: join(artifactRoot, `production-copy-${locale}-${width}.png`), fullPage: true });
      }
    }
  }
  if (artifactRoot) await memoryPage.screenshot({ path: join(artifactRoot, 'generation-browser-check-390.png'), fullPage: true });

  assert.deepEqual(pageErrors, [], `Page errors: ${pageErrors.join(' | ')}`);
  assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join(' | ')}`);
  console.log('Browser checks passed: generation navigation, resources, preview invalidation, GPU states, saved demographics, submission, and review entry.');
} finally {
  if (context && tracingStarted && artifactRoot) await context.tracing.stop({ path: join(artifactRoot, 'generation-browser-check-trace.zip') });
  if (browser) await browser.close();
  await server.close();
}
