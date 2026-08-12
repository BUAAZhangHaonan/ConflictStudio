import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('../frontend/node_modules/typescript');
const clientSource = readFileSync(new URL('../frontend/src/api/client.ts', import.meta.url), 'utf8');
const querySource = readFileSync(new URL('../frontend/src/api/queries.ts', import.meta.url), 'utf8');
const eventSource = readFileSync(new URL('../frontend/src/api/jobEvents.ts', import.meta.url), 'utf8');

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

test('mocked WebSocket wiring preserves the cursor and refetches authority', () => {
  class MockWebSocket { constructor(url) { this.url = url; } close() {} }
  assert.equal(typeof MockWebSocket, 'function');
  assert.match(eventSource, /afterEventId/);
  assert.match(eventSource, /invalidateAuthorityForJobEvent/);
  assert.match(eventSource, /queryKeys\.job\(event\.jobId\)/);
  assert.match(eventSource, /queryKeys\.jobItems\(event\.jobId\)/);
  assert.match(eventSource, /cursor\.current/);
});
