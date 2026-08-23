import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('../frontend/node_modules/typescript');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const helperSource = read('../frontend/src/pages/generate/testWorkflow.ts');
const profileSource = read('../frontend/src/generationProfile.ts');
const typesSource = read('../frontend/src/types.ts');
const resourcesSource = read('../frontend/src/pages/generate/TestResources.tsx');
const pageSource = read('../frontend/src/pages/generate/TestPage.tsx');
const assistantSource = read('../frontend/src/pages/generate/AssistantPanel.tsx');
const productionSource = read('../frontend/src/pages/generate/ProductionPage.tsx');
const sharedSource = read('../frontend/src/pages/generate/shared.tsx');
const querySource = read('../frontend/src/api/queries.ts');

function loadCommonJs(source, dependencies = {}) {
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: identifier => {
      if (!(identifier in dependencies)) throw new Error('Unexpected import: ' + identifier);
      return dependencies[identifier];
    },
  });
  return module.exports;
}

function loadHelper() {
  const types = loadCommonJs(typesSource);
  const profile = loadCommonJs(profileSource, { './types': types });
  return loadCommonJs(helperSource, {
    '../../generationProfile': profile,
    '../../types': types,
  });
}

function completeContent(overrides = {}) {
  return {
    nameZh: '测试内容',
    nameEn: 'Test content',
    category: 'A-VA',
    conflictDirection: null,
    mode: 'Generative',
    trueEmotion: 'calm',
    apparentEmotion: 'calm',
    sceneZh: '室内交流',
    sceneEn: 'Indoor conversation',
    triggerEventZh: '收到消息',
    triggerEventEn: 'A message arrives',
    psychologicalBackgroundZh: '等待结果',
    psychologicalBackgroundEn: 'Waiting for the result',
    dialogue: null,
    displayText: null,
    trueEmotionDescription: '',
    baseVideoPrompt: '',
    contentRequirementsZh: '保持动作清楚',
    contentRequirementsEn: 'Keep the action clear',
    sceneSupplementZh: '',
    sceneSupplementEn: '',
    sceneIds: [],
    ...overrides,
  };
}

test('draft content and scene requests stay Draft and require valid fields', () => {
  const { buildContentDraftRequest, buildSceneDraftRequest } = loadHelper();
  const content = buildContentDraftRequest(completeContent());
  assert.equal(content.status, 'Draft');
  assert.equal(buildContentDraftRequest(completeContent({ category: 'C-VA', conflictDirection: 'Audio' })), null);
  assert.equal(buildContentDraftRequest(completeContent({
    mode: 'Fixed',
    sceneIds: [4],
    baseVideoPrompt: 'Static medium shot',
    trueEmotionDescription: 'Calm expression',
    dialogue: 'I understand.',
    contentRequirementsZh: '',
    contentRequirementsEn: '',
  })).status, 'Draft');
  assert.equal(buildSceneDraftRequest({
    nameZh: '会议室',
    nameEn: 'Meeting room',
    sceneZh: '安静的会议室',
    sceneEn: 'A quiet meeting room',
    ambientSoundZh: '',
    ambientSoundEn: '',
    participantRelationshipZh: '',
    participantRelationshipEn: '',
    lightingZh: '',
    lightingEn: '',
    framingZh: '',
    framingEn: '',
  }).status, 'Draft');
});

test('compatibility selection records only explicit pairs', () => {
  const { toggleCompatibility } = loadHelper();
  assert.deepEqual([...toggleCompatibility('Generative', [2], 5)], [2, 5]);
  assert.deepEqual([...toggleCompatibility('Generative', [2, 5], 2)], [5]);
  assert.deepEqual([...toggleCompatibility('Fixed', [2, 5], 7)], [7]);
  assert.match(resourcesSource, /sceneIds: toggleCompatibility\(current\.mode, current\.sceneIds, scene\.id\)/u);
  assert.doesNotMatch(resourcesSource, /flatMap|Cartesian|all pairs/iu);
});

test('new prompt versions are immutable drafts and verification needs a same-page prompt test', () => {
  const { buildVersionDraftRequest, canVerifyTestedVersion } = loadHelper();
  const request = buildVersionDraftRequest({
    organizationRules: 'Combine content, scene and person details in order.',
    styleGuidance: 'Use a static medium shot.',
    ltxNegativePrompt: 'blur, artifacts',
    h3NegativePrompt: 'blur, artifacts',
  }, 3);
  assert.equal(request.expectedTemplateRevision, 3);
  assert.deepEqual([...request.positiveExamples], []);
  assert.deepEqual([...request.negativeExamples], []);
  const draft = { id: 8, verificationStatus: 'Draft' };
  assert.equal(canVerifyTestedVersion(draft, new Set([8])), true);
  assert.equal(canVerifyTestedVersion(draft, new Set()), false);
  assert.equal(canVerifyTestedVersion({ ...draft, verificationStatus: 'Verified' }, new Set([8])), false);
  assert.match(resourcesSource, /useCreatePromptTemplateVersionMutation/u);
  assert.match(resourcesSource, /useVerifyPromptTemplateVersionMutation/u);
  assert.match(resourcesSource, /ConfirmDialog/u);
  assert.doesNotMatch(resourcesSource, /updatePromptTemplateVersion|positiveExamples|negativeExamples/u);
});

test('prompt-only and video tests use current endpoints and expose complete final prompts', () => {
  assert.match(pageSource, /promptTestMutation\.mutateAsync/u);
  assert.match(pageSource, /videoTestMutation\.mutateAsync/u);
  assert.match(pageSource, /promptOutput\.finalPositivePrompt/u);
  assert.match(pageSource, /promptOutput\.negativePrompt/u);
  assert.match(pageSource, /useResultItemsQuery\('test'/u);
  assert.match(querySource, /\/api\/test-runs\/prompt/u);
  assert.match(querySource, /\/api\/test-runs\/video/u);
  assert.doesNotMatch(pageSource, /systemInput|userInput|temporaryInputs|positiveExamples|negativeExamples/u);
});

test('model precision rules accept only supported combinations', () => {
  const { modelPrecisionIsValid, precisionOptionsForModel } = loadHelper();
  assert.equal(modelPrecisionIsValid('LTX-2.5', 'INT8'), true);
  assert.equal(modelPrecisionIsValid('LTX-2.5', 'BF16'), true);
  assert.equal(modelPrecisionIsValid('LTX-2.5', null), false);
  assert.equal(modelPrecisionIsValid('LTX-2.3', null), true);
  assert.equal(modelPrecisionIsValid('LTX-2.3', 'INT8'), false);
  assert.equal(modelPrecisionIsValid('MiniMax H3', null), true);
  assert.deepEqual([...precisionOptionsForModel('LTX-2.5')], ['BF16', 'INT8']);
});

test('assistant applies visible Test suggestions once and cannot create resources or run tests', () => {
  assert.match(assistantSource, /ConfirmDialog/u);
  assert.match(assistantSource, /createContentScript: false/u);
  assert.match(assistantSource, /createShootingScene: false/u);
  assert.match(assistantSource, /linkNewSceneToContent: false/u);
  assert.match(assistantSource, /const single = !production/u);
  assert.match(assistantSource, /\[group\.kind\]: \[item\.id\]/u);
  assert.match(assistantSource, /selection\.contentScript\.label/u);
  assert.match(assistantSource, /demographic\.ethnicity/u);
  assert.doesNotMatch(assistantSource, /submitPromptTest|submitVideoTest|createContent \|\| createScene/u);
});

test('formal assistant works before saving and applying only dirties the visible form', () => {
  assert.match(assistantSource, /const canAsk = requirement\.trim\(\)\.length > 0/u);
  assert.doesNotMatch(assistantSource, /production && batchDraft === null/u);
  assert.match(assistantSource, /batchDraftId: production \? batchDraft\?\.id : null/u);
  assert.match(productionSource, /const applyAssistant = async \(values: AssistantFormState\)/u);
  assert.match(productionSource, /setUserEdited\(true\)/u);
  assert.doesNotMatch(productionSource, /productionFormFromDraft|setSavedFormSignature\(JSON\.stringify\(nextForm\)\)/u);
  assert.match(productionSource, /disabled=\{!savedDraft \|\| dirty\}/u);
  assert.match(productionSource, /disabled=\{!preview \|\| dirty\}/u);
});

test('content search is debounced, paginated, and keeps explicit selections', () => {
  assert.match(sharedSource, /window\.setTimeout\(\(\) => setDebounced\(value\), delay\)/u);
  assert.match(sharedSource, /delay = 300/u);
  assert.match(querySource, /filter\.search\?\.trim\(\)/u);
  assert.match(querySource, /params\.set\('search', filter\.search\.trim\(\)\)/u);
  assert.match(pageSource, /id="test-content-search"/u);
  assert.match(productionSource, /id="production-content-search"/u);
  assert.match(productionSource, /selectedContent: \[\.\.\.current\.selectedContent, next\]/u);
  assert.match(productionSource, /selectedContent: \[\]/u);
  assert.doesNotMatch(pageSource, /content\[0\]\?\.id/u);
  assert.match(pageSource, /test\.noContentMatches/u);
  assert.match(productionSource, /production\.noContentMatches/u);
});

test('Test scene selection stays stable while scene data is empty', () => {
  assert.match(pageSource, /const EMPTY_SCENES: readonly Scene\[\] = \[\];/u);
  assert.match(pageSource, /const scenes = scenesQuery\.data\?\.scenes \?\? EMPTY_SCENES;/u);
  assert.doesNotMatch(pageSource, /scenesQuery\.data\?\.scenes \?\? \[\]/u);
  assert.match(pageSource, /current\.sceneId === firstSceneId\s*\?\s*current\s*:\s*\{ \.\.\.current, sceneId: firstSceneId \}/u);
  assert.match(pageSource, /\}, \[firstSceneId, form\.sceneId, scenesQuery\.isPending, selectedSceneExists\]\);/u);
});

test('all Test controls are state controlled and formal dataset promotion is absent', () => {
  assert.doesNotMatch(`${pageSource}\n${resourcesSource}`, /defaultValue=/u);
  for (const id of ['test-category', 'test-content', 'test-scene', 'test-template', 'test-version', 'test-model']) {
    assert.match(pageSource, new RegExp(`id="${id}" value=\\{`));
  }
  for (const id of ['resource-content-select', 'resource-scene-select', 'resource-template-select', 'resource-version-select']) {
    assert.match(resourcesSource, new RegExp(`id="${id}" value=\\{`));
  }
  assert.doesNotMatch(`${pageSource}\n${resourcesSource}`, /promote|formal dataset control|datasetId|targetDataset/iu);
});

test('frequent Test controls come before collapsed resource management and templates show their class', () => {
  const formIndex = pageSource.indexOf('generation-test-layout');
  const historyIndex = pageSource.indexOf('generation-test-history');
  const resourcesIndex = pageSource.indexOf('generation-resources-disclosure');
  assert.equal(formIndex >= 0 && historyIndex > formIndex && resourcesIndex > historyIndex, true);
  assert.match(pageSource, /<details className="panel generation-resources-disclosure">/u);
  assert.doesNotMatch(pageSource, /<details className="panel generation-resources-disclosure" open/u);
  assert.match(pageSource, /categoryLabel\(g, item\.category\)/u);
  assert.match(pageSource, /test\.versionOption/u);
});

test('resource template selectors show category and version instead of internal names', () => {
  assert.match(resourcesSource, /categoryLabel\(g, item\.category\)/u);
  assert.match(resourcesSource, /g\('test\.versionOption', \{ category: categoryLabel\(g, item\.category\), version: item\.version \}\)/u);
  assert.doesNotMatch(resourcesSource, />\{item\.name\}<\/option>/u);
  assert.doesNotMatch(resourcesSource, />\{item\.templateName\} \{item\.version\}<\/option>/u);
});
