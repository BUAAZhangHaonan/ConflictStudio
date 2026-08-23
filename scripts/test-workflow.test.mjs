import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('../frontend/node_modules/typescript');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const helperSource = read('../frontend/src/pages/generate/testWorkflow.ts');
const formalSource = read('../frontend/src/pages/generate/formalGeneration.ts');
const profileSource = read('../frontend/src/generationProfile.ts');
const typesSource = read('../frontend/src/types.ts');
const resourcesPageSource = read('../frontend/src/pages/generate/ResourcesPage.tsx');
const editorsSource = read('../frontend/src/pages/generate/TestResources.tsx');
const assistantSource = read('../frontend/src/pages/generate/ResourceAssistantPanel.tsx');
const testPageSource = read('../frontend/src/pages/generate/TestPage.tsx');
const productionSource = read('../frontend/src/pages/generate/ProductionPage.tsx');
const resultsModelSource = read('../frontend/src/pages/generate/resultsModel.ts');
const querySource = read('../frontend/src/api/queries.ts');
const contractSource = read('../frontend/src/api/contracts.ts');
const appSource = read('../frontend/src/app/App.tsx');
const appShellSource = read('../frontend/src/components/AppShell.tsx');
const responsiveSource = read('../frontend/src/styles/responsive.css');

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
    nameZh: '测试内容', nameEn: 'Test content', category: 'A-VA', conflictDirection: null,
    mode: 'Generative', trueEmotion: 'calm', apparentEmotion: 'calm',
    sceneZh: '室内交流', sceneEn: 'Indoor conversation', triggerEventZh: '收到消息',
    triggerEventEn: 'A message arrives', psychologicalBackgroundZh: '等待结果',
    psychologicalBackgroundEn: 'Waiting for the result', dialogue: null, displayText: null,
    trueEmotionDescription: '', baseVideoPrompt: '', contentRequirementsZh: '动作清楚',
    contentRequirementsEn: 'Keep action clear', sceneSupplementZh: '', sceneSupplementEn: '',
    sceneIds: [], ...overrides,
  };
}

function productionForm(overrides = {}) {
  return {
    targetDatasetId: 4,
    displayName: 'A-VA-20260824',
    category: 'A-VA',
    conflictDirection: null,
    promptTemplateId: 8,
    promptTemplateVersionId: 9,
    selectedContent: [{
      id: 10, revision: 2, nameZh: '内容', nameEn: 'Content', mode: 'Fixed',
      scenes: [{ id: 12, revision: 1, nameZh: '场景', nameEn: 'Scene' }],
      selectedSceneIds: [12],
    }],
    demographics: [
      { age: 25, gender: 'Female', ethnicity: 'EastAsian' },
      { age: 35, gender: 'Male', ethnicity: 'White' },
    ],
    seeds: '7', model: 'LTX-2.5', precision: 'INT8', gpuSlots: ['GPU0'],
    ...overrides,
  };
}

test('manual content, scene, and prompt resources remain explicit Draft writes', () => {
  const { buildContentDraftRequest, buildSceneDraftRequest, buildVersionDraftRequest, toggleCompatibility } = loadHelper();
  assert.equal(buildContentDraftRequest(completeContent()).status, 'Draft');
  assert.equal(buildContentDraftRequest(completeContent({ category: 'C-VA', conflictDirection: 'Audio' })), null);
  assert.deepEqual([...toggleCompatibility('Fixed', [2, 5], 7)], [7]);
  assert.equal(buildSceneDraftRequest({
    nameZh: '会议室', nameEn: 'Meeting room', sceneZh: '安静的会议室', sceneEn: 'A quiet meeting room',
    ambientSoundZh: '', ambientSoundEn: '', participantRelationshipZh: '', participantRelationshipEn: '',
    lightingZh: '', lightingEn: '', framingZh: '', framingEn: '',
  }).status, 'Draft');
  assert.equal(buildVersionDraftRequest({
    organizationRules: 'Combine in order.', styleGuidance: 'Static medium shot.',
    ltxNegativePrompt: 'blur', h3NegativePrompt: 'blur',
  }, 3).expectedTemplateRevision, 3);
  assert.match(editorsSource, /useCreatePromptTemplateVersionMutation/u);
  assert.doesNotMatch(editorsSource, /useVerifyPromptTemplateVersionMutation|setConfirmAction\('verify'\)|sealVersion/u);
});

test('Resources is a separate four-item destination with three focused tabs', () => {
  for (const route of ['/generate/resources', '/generate/test', '/generate/production', '/generate/results']) {
    assert.match(appShellSource, new RegExp(route.replaceAll('/', '\\/')));
  }
  assert.match(appSource, /const GeneratePage = lazy/u);
  assert.match(appSource, /path="\/generate\/resources" element=\{<GeneratePage section="resources" \/>\}/u);
  const navigationOrder = ['/generate/test', '/generate/production', '/generate/results', '/generate/resources']
    .map(route => appShellSource.indexOf(`to: '${route}'`));
  assert.deepEqual([...navigationOrder].sort((left, right) => left - right), navigationOrder);
  assert.match(resourcesPageSource, /ResourceAssistantPanel/u);
  assert.match(resourcesPageSource, /ResourceEditors/u);
  for (const tab of ['content', 'scenes', 'prompts']) assert.match(editorsSource, new RegExp(`'${tab}'`));
  assert.match(editorsSource, /role="tablist"/u);
  assert.match(editorsSource, /aria-selected=\{tab === value\}/u);
  assert.doesNotMatch(testPageSource, /ResourceEditors|TestResources|AssistantPanel|generation-resources-disclosure/u);
  assert.equal(existsSync(new URL('../frontend/src/pages/generate/AssistantPanel.tsx', import.meta.url)), false);
});

test('resource assistant proposes, exposes the full editable bundle, confirms, then applies once', () => {
  for (const type of ['ResourceAssistantBundle', 'ResourceAssistantProposeRequest', 'ResourceAssistantApplyRequest', 'ResourceAssistantApplyResult']) {
    assert.match(contractSource, new RegExp(`interface ${type}|type ${type}`));
  }
  assert.match(querySource, /\/api\/resource-assistant\/propose/u);
  assert.match(querySource, /\/api\/resource-assistant\/apply/u);
  assert.doesNotMatch(querySource + contractSource, /configuration-assistants|ConfigurationAssistant/u);
  assert.match(contractSource, /ResourceAssistantContentDraft = Omit<ContentScriptCreate, 'sceneIds' \| 'status'>[\s\S]*?status: 'Draft'/u);
  assert.match(contractSource, /ResourceAssistantSceneDraft = Omit<SceneCreate, 'status'>[\s\S]*?status: 'Draft'/u);
  assert.match(contractSource, /scenes: ResourceAssistantSceneDraft\[\]/u);
  assert.match(assistantSource, /userRequirement: requirement\.trim\(\)/u);
  assert.match(assistantSource, /expectedRevision: proposal\.promptTemplate\.revision/u);
  assert.match(assistantSource, /bundle: proposal\.bundle/u);
  for (const field of ['contentScript', 'scenes', 'promptTemplateVersion', 'positiveExamples', 'negativeExamples', 'ltxNegativePrompt', 'h3NegativePrompt']) assert.match(assistantSource, new RegExp(field));
  assert.match(assistantSource, /<ConfirmDialog/u);
  assert.match(assistantSource, /content\.mode === 'Generative'/u);
  assert.match(assistantSource, /content\.mode === 'Fixed'/u);
});

test('a prompt version can be verified only from its completed visible Prompt Test', () => {
  assert.match(testPageSource, /useVerifyPromptTemplateVersionMutation/u);
  assert.match(testPageSource, /setPromptTestJobId\(form\.kind === 'PromptTest' \? job\.id : null\)/u);
  assert.match(testPageSource, /testedDraftVersion = inspectedJobId === promptTestJobId[\s\S]*?inspectedItem\?\.status === 'Completed'[\s\S]*?promptOutput !== null[\s\S]*?verificationStatus === 'Draft'/u);
  assert.match(testPageSource, /verifyVersionMutation\.mutateAsync/u);
  assert.match(testPageSource, /open=\{verifyConfirmOpen\}/u);
  assert.doesNotMatch(editorsSource, /useVerifyPromptTemplateVersionMutation|verifyVersion\.mutateAsync|setConfirmAction\('verify'\)/u);
});

test('internal batch drafts have no browse or restore query', () => {
  assert.doesNotMatch(querySource, /useBatchDraftsQuery|useBatchDraftQuery|batchDraftsPage|batchDraft: \(id/u);
  assert.doesNotMatch(querySource, /apiRequest<Page<BatchDraft>>|generationQueries\.batchDraft/u);
  assert.match(querySource, /id === null \? apiRequest<BatchDraft>\('\/api\/batch-drafts'/u);
  assert.match(querySource, /apiRequest<BatchPreview>\('\/api\/batch-drafts\/' \+ id \+ '\/preview'/u);
});

test('content list filtering is sent to the server before pagination', () => {
  for (const field of ['status', 'category', 'direction']) assert.match(querySource, new RegExp(`params\\.set\\('${field}', filter\\.${field}\\)`));
  assert.match(testPageSource, /status: 'Active'/u);
  assert.match(testPageSource, /category: form\.category/u);
  assert.match(productionSource, /status: 'Active'/u);
  assert.match(productionSource, /category: form\.category/u);
  assert.match(productionSource, /direction: form\.conflictDirection/u);
  assert.match(editorsSource, /\{ status: 'Draft' \}/u);
});

test('formal generation preserves the exact demographic list without a Cartesian expansion', () => {
  const { buildBatchDraftRequest } = loadCommonJs(formalSource);
  const form = productionForm();
  const request = buildBatchDraftRequest(form, [7], new Set(['GPU0']));
  assert.deepEqual(JSON.parse(JSON.stringify(request.demographics)), form.demographics);
  assert.equal(request.demographics.length, 2);
  assert.equal(buildBatchDraftRequest({ ...form, demographics: [form.demographics[0], { ...form.demographics[0] }] }, [7], new Set(['GPU0'])), null);
  assert.doesNotMatch(formalSource, /flatMap|selectedAges|selectedGenders|selectedEthnicities|productionFormFromDraft/u);
  assert.match(productionSource, /lastDemographicsKey/u);
  assert.match(productionSource, /localStorage\.setItem\(lastDemographicsKey, JSON\.stringify\(form\.demographics\)\)/u);
  assert.match(productionSource, /current\.demographics\.map/u);
});

test('Preview saves or updates the internal draft before requesting allocations', () => {
  const saveIndex = productionSource.indexOf('saveMutation.mutateAsync');
  const previewIndex = productionSource.indexOf('previewMutation.mutateAsync', saveIndex);
  assert.equal(saveIndex >= 0 && previewIndex > saveIndex, true);
  assert.match(productionSource, /expectedRevision: value\.revision/u);
  assert.doesNotMatch(productionSource, /saveConfirmOpen|production\.saveTitle|<GpuPanel/u);
  assert.match(productionSource, /disabled=\{saveMutation\.isPending \|\| previewMutation\.isPending\}/u);
});

test('Test and Production use only API-reported Available GPU slots and no literal slot choice', () => {
  assert.match(testPageSource, /filter\(slot => slot\.availability === 'Available'\)/u);
  assert.match(productionSource, /filter\(slot => slot\.availability === 'Available'\)/u);
  assert.doesNotMatch(testPageSource + productionSource + resultsModelSource, /['"]GPU[01]['"]/u);
  assert.match(testPageSource, /availableGpuSlots\.map\(value => <option/u);
  assert.match(productionSource, /availableGpuOptions\.map\(slot/u);
});

test('the bilingual generation navigation remains usable at 390 pixels', () => {
  assert.match(responsiveSource, /@media \(max-width: 390px\)[\s\S]*?\.generate-nav \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/u);
  assert.match(responsiveSource, /\.generate-nav a \{[\s\S]*?text-align: center/u);
});
