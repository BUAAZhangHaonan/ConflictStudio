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
  assert.match(assistantSource, /createContentScript: production && createContent/u);
  assert.match(assistantSource, /createShootingScene: production && createScene/u);
  assert.match(assistantSource, /linkNewSceneToContent: production && linkDrafts/u);
  assert.match(assistantSource, /const single = !production/u);
  assert.match(assistantSource, /\[group\.kind\]: \[item\.id\]/u);
  assert.match(assistantSource, /selection\.contentScript\.label/u);
  assert.match(assistantSource, /demographic\.ethnicity/u);
  assert.doesNotMatch(assistantSource, /submitPromptTest|submitVideoTest/u);
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
