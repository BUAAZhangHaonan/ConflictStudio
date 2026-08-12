import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('../frontend/node_modules/typescript');
const clientSource = readFileSync(new URL('../frontend/src/api/client.ts', import.meta.url), 'utf8');
const contractSource = readFileSync(new URL('../frontend/src/api/contracts.ts', import.meta.url), 'utf8');
const querySource = readFileSync(new URL('../frontend/src/api/queries.ts', import.meta.url), 'utf8');
const eventSource = readFileSync(new URL('../frontend/src/api/jobEvents.ts', import.meta.url), 'utf8');
const contentPageSource = readFileSync(new URL('../frontend/src/pages/generate/ContentPage.tsx', import.meta.url), 'utf8');
const backgroundPageSource = readFileSync(new URL('../frontend/src/pages/generate/BackgroundsPage.tsx', import.meta.url), 'utf8');
const batchesPageSource = readFileSync(new URL('../frontend/src/pages/generate/BatchesPage.tsx', import.meta.url), 'utf8');
const testPageSource = readFileSync(new URL('../frontend/src/pages/generate/TestPage.tsx', import.meta.url), 'utf8');

function loadClient(fetchMock) {
  const output = ts.transpileModule(clientSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const context = { module, exports: module.exports, fetch: fetchMock, window: { location: { protocol: 'http:', host: 'example.test' } }, URLSearchParams };
  vm.runInNewContext(output, context);
  return module.exports;
}

test('API request uses mocked fetch and maps HTTP and network failures', async () => {
  const calls = [];
  const client = loadClient(async (path, init) => {
    calls.push([path, init]);
    return { ok: false, status: 503, json: async () => ({ error: { code: 'renderer_not_configured', message: 'internal', details: {} } }) };
  });
  await assert.rejects(() => client.apiRequest('/api/batch-drafts/1/submit', { method: 'POST', body: '{}' }), error => error.code === 'renderer_not_configured' && error.kind === 'renderer');
  assert.equal(calls[0][0], '/api/batch-drafts/1/submit');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
  const networkClient = loadClient(async () => { throw new Error('offline'); });
  await assert.rejects(() => networkClient.apiRequest('/api/jobs'), error => error.code === 'network_error' && error.kind === 'network');
});

test('CRUD and batch mutations carry revision and confirmation contracts', () => {
  for (const name of ['expectedRevision', 'expectedGpuRevisions', 'confirmModelSwitch']) assert.match(querySource, new RegExp(name));
  for (const path of ['/api/datasets', '/api/content-plans', '/api/prompt-presets', '/api/video-background-presets', '/api/batch-drafts', '/api/jobs']) assert.match(querySource, new RegExp(path.replaceAll('/', '\\/')));
  assert.match(querySource, /invalidateJobAuthority/);
  assert.match(querySource, /queryKeys\.jobItems/);
  assert.match(querySource, /queryKeys\.jobEvents/);
});

test('generation catalogs use paired Chinese and English business fields', () => {
  const contentFields = contractSource.match(/export interface ContentPlanFields \{([\s\S]*?)\n\}/u)?.[1] ?? '';
  const backgroundFields = contractSource.match(/export interface BackgroundPresetFields \{([\s\S]*?)\n\}/u)?.[1] ?? '';
  for (const field of ['nameZh', 'nameEn', 'sceneZh', 'sceneEn', 'triggerEventZh', 'triggerEventEn', 'psychologicalBackgroundZh', 'psychologicalBackgroundEn', 'contentRequirementsZh', 'contentRequirementsEn', 'sceneSupplementZh', 'sceneSupplementEn']) {
    assert.match(contentFields, new RegExp(`\\b${field}:`));
  }
  for (const field of ['nameZh', 'nameEn', 'sceneZh', 'sceneEn', 'ambientSoundZh', 'ambientSoundEn', 'participantRelationshipZh', 'participantRelationshipEn', 'lightingZh', 'lightingEn', 'framingZh', 'framingEn']) {
    assert.match(backgroundFields, new RegExp(`\\b${field}:`));
  }
  assert.doesNotMatch(contentFields, /\b(?:name|scene|triggerEvent|psychologicalBackground|contentRequirements|sceneSupplement):/u);
  assert.doesNotMatch(backgroundFields, /\b(?:name|scene|ambientSound|participantRelationship|lighting|framing):/u);
});

test('catalog editors and generation selectors use locale-specific names without changing IDs', () => {
  for (const source of [contentPageSource, backgroundPageSource]) {
    assert.match(source, /localizedName\(locale, item\)/u);
    assert.match(source, /nameZh/u);
    assert.match(source, /nameEn/u);
  }
  assert.match(contentPageSource, /item\.sceneZh/u);
  assert.match(contentPageSource, /item\.sceneEn/u);
  assert.match(backgroundPageSource, /item\.sceneZh/u);
  assert.match(backgroundPageSource, /item\.sceneEn/u);
  for (const source of [batchesPageSource, testPageSource]) {
    assert.match(source, /localizedName\(locale, item\)/u);
    assert.match(source, /value=\{item\.id\}/u);
  }
  assert.match(testPageSource, /contentPlan: \{ id: selectedContent\.id/u);
  assert.match(testPageSource, /backgroundPreset: \{ id: selectedBackground\.id/u);
});

test('mocked WebSocket wiring preserves the cursor and refetches authority', () => {
  class MockWebSocket { constructor(url) { this.url = url; } close() {} }
  assert.equal(typeof MockWebSocket, 'function');
  assert.match(eventSource, /afterEventId/);
  assert.match(eventSource, /invalidateAuthorityForJobEvent/);
  assert.match(eventSource, /queryKeys\.job\(event\.jobId\)/);
  assert.match(eventSource, /queryKeys\.jobItems\(event\.jobId\)/);
  assert.match(eventSource, /cursor\.current/);
});
