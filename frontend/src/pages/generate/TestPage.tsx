import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, ConfirmDialog, Field, Pagination, StatusBadge } from '../../components';
import {
  useContentScenesQuery,
  useContentScriptQuery,
  useContentScriptsQuery,
  useGpuSlotsQuery,
  usePromptTemplatesQuery,
  usePromptTemplateVersionsQuery,
  usePromptTemplateVersionQuery,
  useResultItemsQuery,
  useSceneQuery,
  useSubmitPromptTestMutation,
  useSubmitVideoTestMutation,
  useTestResultsQuery,
} from '../../api/queries';
import { isModelSwitchConfirmationRequired } from '../../api/client';
import type {
  Age,
  AssistantFormState,
  Ethnicity,
  Gender,
  GpuSlotName,
  JobSource,
  TestComparisonInput,
  TestExecutionMode,
} from '../../api/contracts';
import {
  addSecondTestComparison,
  comparisonEntriesAreValid,
  defaultGenerationProfile,
  ltx25Precisions,
  models,
  precisionForModel,
} from '../../generationProfile';
import {
  allowedDirections,
  type Category,
  type ConflictDirection,
  type ModelName,
  type ModelPrecision,
} from '../../types';
import { formatDateTime } from '../../time';
import { AssistantPanel } from './AssistantPanel';
import { TestResources } from './TestResources';
import { modelPrecisionIsValid } from './testWorkflow';
import {
  ages,
  categories,
  categoryLabel,
  directionLabel,
  ethnicities,
  genders,
  GenerationScaffold,
  hideTestResult,
  hiddenTestIds,
  jobStatusKind,
  localizedName,
  OperationFeedback,
  parseSeeds,
  profileLabel,
  RelationshipGuide,
  takeSessionDraft,
  testCopyDraftKey,
  type TestCopyDraft,
  useGenerationCopy,
  useGenerationLocale,
} from './shared';
import type { GenerationKey } from '../../locales/features/generation';

type TestKind = 'PromptTest' | 'VideoTest';

interface TestForm {
  kind: TestKind;
  category: Category;
  conflictDirection: ConflictDirection | null;
  contentScriptId: number | null;
  sceneId: number | null;
  promptTemplateId: number | null;
  promptTemplateVersionId: number | null;
  age: Age;
  gender: Gender;
  ethnicity: Ethnicity;
  seed: string;
  model: ModelName;
  precision: ModelPrecision | null;
  comparisons: TestComparisonInput[];
  executionMode: TestExecutionMode;
}

function emptyForm(): TestForm {
  return {
    kind: 'PromptTest',
    category: 'A-VA',
    conflictDirection: null,
    contentScriptId: null,
    sceneId: null,
    promptTemplateId: null,
    promptTemplateVersionId: null,
    age: 25,
    gender: 'Female',
    ethnicity: 'EastAsian',
    seed: '1',
    model: defaultGenerationProfile.model,
    precision: defaultGenerationProfile.precision,
    comparisons: [{ ...defaultGenerationProfile, gpuSlot: 'GPU0' }],
    executionMode: 'Parallel',
  };
}

export function TestPage() {
  const g = useGenerationCopy();
  const locale = useGenerationLocale();
  const [copied] = useState(() => takeSessionDraft<TestCopyDraft>(testCopyDraftKey));
  const [form, setForm] = useState<TestForm>(() => copied ? {
    ...emptyForm(),
    kind: copied.kind,
    category: copied.category,
    conflictDirection: copied.conflictDirection,
    contentScriptId: copied.contentScriptId,
    sceneId: copied.sceneId,
    promptTemplateVersionId: copied.promptTemplateVersionId,
    age: copied.age,
    gender: copied.gender,
    ethnicity: copied.ethnicity,
    seed: String(copied.seed),
    model: copied.model,
    precision: copied.precision,
    comparisons: copied.comparisons,
    executionMode: copied.executionMode,
  } : emptyForm());
  const [contentPage, setContentPage] = useState(1);
  const [templatePage, setTemplatePage] = useState(1);
  const [versionPage, setVersionPage] = useState(1);
  const [validation, setValidation] = useState(false);
  const [runConfirmOpen, setRunConfirmOpen] = useState(false);
  const [switchConfirmOpen, setSwitchConfirmOpen] = useState(false);
  const [inspectedJobId, setInspectedJobId] = useState<number | null>(null);
  const [testedVersionIds, setTestedVersionIds] = useState<Set<number>>(() => new Set());
  const [hiddenIds, setHiddenIds] = useState(hiddenTestIds);

  const contentQuery = useContentScriptsQuery(contentPage);
  const selectedContentQuery = useContentScriptQuery(form.contentScriptId);
  const templatesQuery = usePromptTemplatesQuery(templatePage);
  const versionsQuery = usePromptTemplateVersionsQuery(form.promptTemplateId, versionPage);
  const selectedVersionDetailQuery = usePromptTemplateVersionQuery(form.promptTemplateVersionId);
  const scenesQuery = useContentScenesQuery(form.contentScriptId);
  const sceneQuery = useSceneQuery(form.sceneId);
  const gpuQuery = useGpuSlotsQuery();
  const recentQuery = useTestResultsQuery(1);
  const inspectedItemsQuery = useResultItemsQuery('test', inspectedJobId, 1);
  const promptTestMutation = useSubmitPromptTestMutation();
  const videoTestMutation = useSubmitVideoTestMutation();

  const content = useMemo(
    () => (contentQuery.data?.items ?? []).filter(item =>
      item.status === 'Active'
      && item.category === form.category
      && item.conflictDirection === form.conflictDirection),
    [contentQuery.data, form.category, form.conflictDirection],
  );
  const templates = useMemo(
    () => (templatesQuery.data?.items ?? []).filter(item => item.category === form.category),
    [form.category, templatesQuery.data],
  );
  const versions = useMemo(
    () => (versionsQuery.data?.items ?? []).filter(item => item.category === form.category),
    [form.category, versionsQuery.data],
  );
  const scenes = scenesQuery.data?.scenes ?? [];
  const contentDetail = selectedContentQuery.data;
  const selectedContent = content.find(item => item.id === form.contentScriptId)
    ?? (contentDetail?.status === 'Active'
      && contentDetail.category === form.category
      && contentDetail.conflictDirection === form.conflictDirection ? contentDetail : null);
  const versionDetail = selectedVersionDetailQuery.data;
  const selectedVersion = versions.find(item => item.id === form.promptTemplateVersionId)
    ?? (versionDetail?.category === form.category ? versionDetail : null);
  const contentOptions = selectedContent && !content.some(item => item.id === selectedContent.id)
    ? [selectedContent, ...content]
    : content;
  const templateOptions = selectedVersion && !templates.some(item => item.id === selectedVersion.templateId)
    ? [{ id: selectedVersion.templateId, name: selectedVersion.templateName, category: selectedVersion.category }, ...templates]
    : templates;
  const versionOptions = selectedVersion && !versions.some(item => item.id === selectedVersion.id)
    ? [selectedVersion, ...versions]
    : versions;
  const selectedScene = scenes.find(item => item.id === form.sceneId) ?? null;
  const selectedSceneIsActive = sceneQuery.data?.status === 'Active';
  const gpuBySlot = new Map((gpuQuery.data ?? []).map(slot => [slot.slot, slot]));
  const seeds = parseSeeds(form.seed);
  const directions = allowedDirections(form.category);
  const recent = (recentQuery.data?.items ?? []).filter(item => !hiddenIds.includes(item.id)).slice(0, 5);
  const inspectedItem = inspectedItemsQuery.data?.items[0] ?? null;
  const promptOutput = inspectedItem?.promptResult ?? null;
  const queryError = contentQuery.error ?? selectedContentQuery.error ?? templatesQuery.error ?? versionsQuery.error
    ?? selectedVersionDetailQuery.error ?? scenesQuery.error ?? sceneQuery.error ?? gpuQuery.error
    ?? recentQuery.error ?? inspectedItemsQuery.error;
  const mutationError = promptTestMutation.error ?? videoTestMutation.error;

  useEffect(() => {
    if (selectedContent !== null) return;
    if (form.contentScriptId !== null && selectedContentQuery.isPending) return;
    setForm(current => ({ ...current, contentScriptId: content[0]?.id ?? null, sceneId: null }));
  }, [content, form.contentScriptId, selectedContent, selectedContentQuery.isPending]);

  useEffect(() => {
    if (selectedVersion !== null) {
      if (form.promptTemplateId !== selectedVersion.templateId) {
        setForm(current => ({ ...current, promptTemplateId: selectedVersion.templateId }));
      }
      return;
    }
    if (form.promptTemplateVersionId !== null && selectedVersionDetailQuery.isPending) return;
    if (!templates.some(item => item.id === form.promptTemplateId)) {
      setForm(current => ({
        ...current,
        promptTemplateId: templates[0]?.id ?? null,
        promptTemplateVersionId: null,
      }));
    }
  }, [form.promptTemplateId, form.promptTemplateVersionId, selectedVersion, selectedVersionDetailQuery.isPending, templates]);

  useEffect(() => {
    if (selectedVersion !== null) return;
    if (form.promptTemplateVersionId !== null && selectedVersionDetailQuery.isPending) return;
    setForm(current => ({ ...current, promptTemplateVersionId: versions[0]?.id ?? null }));
  }, [form.promptTemplateVersionId, selectedVersion, selectedVersionDetailQuery.isPending, versions]);

  useEffect(() => {
    if (scenes.some(item => item.id === form.sceneId)) return;
    if (form.sceneId !== null && scenesQuery.isPending) return;
    setForm(current => ({ ...current, sceneId: scenes[0]?.id ?? null }));
  }, [form.sceneId, scenes, scenesQuery.isPending]);

  const changeCategory = (category: Category) => {
    setForm(current => ({
      ...current,
      category,
      conflictDirection: allowedDirections(category)[0] ?? null,
      contentScriptId: null,
      sceneId: null,
      promptTemplateId: null,
      promptTemplateVersionId: null,
    }));
    setContentPage(1);
    setTemplatePage(1);
    setVersionPage(1);
    setValidation(false);
  };

  const videoSettingsValid = () => {
    if (!comparisonEntriesAreValid(form.comparisons) || seeds?.length !== 1) return false;
    const slots = new Set(form.comparisons.map(item => item.gpuSlot));
    if (form.comparisons.length > 1 && form.executionMode === 'Parallel' && slots.size !== form.comparisons.length) return false;
    if (form.comparisons.length > 1 && form.executionMode === 'Serial' && slots.size !== 1) return false;
    return [...slots].every(slot => gpuBySlot.has(slot));
  };

  const settingsValid = Boolean(
    selectedContent
    && selectedScene
    && selectedSceneIsActive
    && selectedVersion
    && (form.kind === 'PromptTest'
      ? modelPrecisionIsValid(form.model, form.precision)
      : videoSettingsValid()),
  );

  const runTest = async (confirmModelSwitch: boolean) => {
    if (!settingsValid || !selectedContent || !selectedScene || !selectedVersion) {
      setValidation(true);
      setRunConfirmOpen(false);
      return;
    }
    const common = {
      contentScript: { id: selectedContent.id, expectedRevision: selectedContent.revision },
      promptTemplateVersion: { id: selectedVersion.id, expectedRevision: selectedVersion.revision },
      scene: { id: selectedScene.id, expectedRevision: selectedScene.revision },
      demographic: { age: form.age, gender: form.gender, ethnicity: form.ethnicity },
    };
    try {
      const job = form.kind === 'PromptTest'
        ? await promptTestMutation.mutateAsync({ ...common, model: form.model, precision: form.precision })
        : await videoTestMutation.mutateAsync({
          ...common,
          seed: seeds?.[0] ?? null,
          comparisons: form.comparisons,
          executionMode: form.executionMode,
          expectedGpuRevisions: Object.fromEntries(
            [...new Set(form.comparisons.map(item => item.gpuSlot))]
              .map(slot => [slot, gpuBySlot.get(slot)!.revision])),
          confirmModelSwitch,
        });
      setInspectedJobId(job.id);
      if (form.kind === 'PromptTest') {
        setTestedVersionIds(current => new Set(current).add(selectedVersion.id));
      }
      setValidation(false);
    } catch (error) {
      if (!confirmModelSwitch && isModelSwitchConfirmationRequired(error)) setSwitchConfirmOpen(true);
    } finally {
      setRunConfirmOpen(false);
    }
  };

  const assistantForm: AssistantFormState = {
    category: form.category,
    conflictDirection: form.conflictDirection,
    model: form.kind === 'PromptTest' ? form.model : form.comparisons[0].model,
    precision: form.kind === 'PromptTest' ? form.precision : form.comparisons[0].precision,
    contentSelections: selectedContent && selectedScene ? [{
      contentScript: {
        id: selectedContent.id,
        expectedRevision: selectedContent.revision,
        label: localizedName(locale, selectedContent),
      },
      scenes: [{
        id: selectedScene.id,
        expectedRevision: selectedScene.revision,
        label: localizedName(locale, selectedScene),
      }],
    }] : null,
    promptTemplateVersion: selectedVersion ? {
      id: selectedVersion.id,
      expectedRevision: selectedVersion.revision,
      label: g('test.versionOption', { category: categoryLabel(g, selectedVersion.category), version: selectedVersion.version }),
    } : null,
    demographics: [{ age: form.age, gender: form.gender, ethnicity: form.ethnicity }],
    seeds,
    comparisons: form.kind === 'VideoTest' ? form.comparisons : null,
    executionMode: form.kind === 'VideoTest' ? form.executionMode : null,
  };

  const applyAssistant = (values: AssistantFormState) => {
    setForm(current => {
      const person = values.demographics?.[0];
      const selection = values.contentSelections?.[0];
      const targetCategory = values.category ?? current.category;
      const targetDirection = values.conflictDirection !== undefined
        ? values.conflictDirection
        : current.conflictDirection;
      const classificationChanged = targetCategory !== current.category || targetDirection !== current.conflictDirection;
      return {
        ...current,
        category: targetCategory,
        conflictDirection: targetDirection,
        contentScriptId: selection?.contentScript.id ?? (classificationChanged ? null : current.contentScriptId),
        sceneId: selection?.scenes[0]?.id ?? (classificationChanged ? null : current.sceneId),
        promptTemplateVersionId: values.promptTemplateVersion?.id ?? current.promptTemplateVersionId,
        age: person?.age ?? current.age,
        gender: person?.gender ?? current.gender,
        ethnicity: person?.ethnicity ?? current.ethnicity,
        seed: values.seeds?.[0] === undefined ? current.seed : String(values.seeds[0]),
        model: values.model ?? current.model,
        precision: values.model ? precisionForModel(values.model, values.precision) : current.precision,
        comparisons: values.comparisons?.length ? values.comparisons : current.comparisons,
        executionMode: values.executionMode ?? current.executionMode,
      };
    });
    setValidation(false);
  };

  const addComparison = () => {
    const profiles = addSecondTestComparison(form.comparisons);
    setForm(current => ({
      ...current,
      comparisons: profiles.map((profile, index) => ({
        ...profile,
        gpuSlot: index === 0 ? current.comparisons[0].gpuSlot : 'GPU1',
      })),
    }));
  };

  return (
    <GenerationScaffold title="test.title" subtitle="test.subtitle">
      <AssistantPanel
        targetSource={form.kind as JobSource}
        currentForm={assistantForm}
        batchDraft={null}
        onApply={applyAssistant}
      />
      <RelationshipGuide production={false} />
      {copied ? <p className="generation-isolation-note" role="status">{g('test.copied')}</p> : null}
      {queryError ? <OperationFeedback error={queryError} onDismiss={() => void Promise.all([
        contentQuery.refetch(), selectedContentQuery.refetch(), templatesQuery.refetch(), versionsQuery.refetch(),
        selectedVersionDetailQuery.refetch(), scenesQuery.refetch(), sceneQuery.refetch(), gpuQuery.refetch(),
        recentQuery.refetch(), inspectedItemsQuery.refetch(),
      ])} /> : null}
      {mutationError && !switchConfirmOpen ? <OperationFeedback error={mutationError} onDismiss={() => {
        promptTestMutation.reset();
        videoTestMutation.reset();
      }} /> : null}

      <div className="generation-test-layout">
        <section className="panel generation-form" aria-labelledby="test-form-title">
          <div className="section-header"><h2 id="test-form-title">{g('test.form')}</h2></div>
          <fieldset className="generation-kind">
            <legend>{g('test.type')}</legend>
            <label>
              <input type="radio" name="test-kind" checked={form.kind === 'PromptTest'} onChange={() => setForm(current => ({ ...current, kind: 'PromptTest' }))} />
              <span><strong>{g('test.prompt')}</strong>{g('test.promptHint')}</span>
            </label>
            <label>
              <input type="radio" name="test-kind" checked={form.kind === 'VideoTest'} onChange={() => setForm(current => ({ ...current, kind: 'VideoTest' }))} />
              <span><strong>{g('test.video')}</strong>{g('test.videoHint')}</span>
            </label>
          </fieldset>

          <div className="generation-form__grid">
            <Field label={g('test.taskType')} htmlFor="test-category"><select id="test-category" value={form.category} onChange={event => changeCategory(event.target.value as Category)}>{categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}</select></Field>
            <Field label={g('test.direction')} htmlFor="test-direction"><select id="test-direction" value={form.conflictDirection ?? ''} disabled={directions.length === 0} onChange={event => setForm(current => ({ ...current, conflictDirection: (event.target.value || null) as ConflictDirection | null, contentScriptId: null, sceneId: null }))}>{directions.length === 0 ? <option value="">{g('common.none')}</option> : null}{directions.map(value => <option key={value} value={value}>{directionLabel(g, value)}</option>)}</select></Field>
            <Field label={g('test.content')} htmlFor="test-content"><select id="test-content" value={form.contentScriptId ?? ''} onChange={event => setForm(current => ({ ...current, contentScriptId: event.target.value ? Number(event.target.value) : null, sceneId: null }))}>{content.length === 0 ? <option value="">{g('state.filtered')}</option> : null}{contentOptions.map(item => <option key={item.id} value={item.id}>{localizedName(locale, item)}</option>)}</select></Field>
            <Field label={g('test.scene')} htmlFor="test-scene"><select id="test-scene" value={form.sceneId ?? ''} disabled={scenes.length === 0} onChange={event => setForm(current => ({ ...current, sceneId: event.target.value ? Number(event.target.value) : null }))}>{scenes.length === 0 ? <option value="">{g('state.filtered')}</option> : null}{scenes.map(item => <option key={item.id} value={item.id}>{localizedName(locale, item)}</option>)}</select></Field>
            <Field label={g('test.template')} htmlFor="test-template"><select id="test-template" value={form.promptTemplateId ?? ''} onChange={event => { setForm(current => ({ ...current, promptTemplateId: event.target.value ? Number(event.target.value) : null, promptTemplateVersionId: null })); setVersionPage(1); }}><option value="">{g('common.none')}</option>{templateOptions.map(item => <option key={item.id} value={item.id}>{categoryLabel(g, item.category)}</option>)}</select></Field>
            <Field label={g('test.version')} htmlFor="test-version"><select id="test-version" value={form.promptTemplateVersionId ?? ''} onChange={event => setForm(current => ({ ...current, promptTemplateVersionId: event.target.value ? Number(event.target.value) : null }))}><option value="">{g('common.none')}</option>{versionOptions.map(item => <option key={item.id} value={item.id}>{g('test.versionOption', { category: categoryLabel(g, item.category), version: item.version })} {g(item.verificationStatus === 'Verified' ? 'test.resource.verified' : 'test.resource.draft')}</option>)}</select></Field>
          </div>

          <div className="generation-source-pages">
            <div><span>{g('test.contentPage')}</span><Pagination page={contentQuery.data?.page ?? contentPage} totalPages={contentQuery.data?.totalPages ?? 0} total={contentQuery.data?.total ?? 0} onPageChange={setContentPage} /></div>
            <div><span>{g('test.templatePage')}</span><Pagination page={templatesQuery.data?.page ?? templatePage} totalPages={templatesQuery.data?.totalPages ?? 0} total={templatesQuery.data?.total ?? 0} onPageChange={setTemplatePage} /></div>
            <div><span>{g('test.versionPage')}</span><Pagination page={versionsQuery.data?.page ?? versionPage} totalPages={versionsQuery.data?.totalPages ?? 0} total={versionsQuery.data?.total ?? 0} onPageChange={setVersionPage} /></div>
          </div>

          <fieldset className="generation-person">
            <legend>{g('test.person')}</legend>
            <div className="generation-form__grid generation-form__grid--three">
              <Field label={g('test.age')} htmlFor="test-age"><select id="test-age" value={form.age} onChange={event => setForm(current => ({ ...current, age: Number(event.target.value) as Age }))}>{ages.map(value => <option key={value} value={value}>{g(('demographic.age.' + value) as GenerationKey)}</option>)}</select></Field>
              <Field label={g('test.gender')} htmlFor="test-gender"><select id="test-gender" value={form.gender} onChange={event => setForm(current => ({ ...current, gender: event.target.value as Gender }))}>{genders.map(value => <option key={value} value={value}>{g(('demographic.gender.' + value) as GenerationKey)}</option>)}</select></Field>
              <Field label={g('test.ethnicity')} htmlFor="test-ethnicity"><select id="test-ethnicity" value={form.ethnicity} onChange={event => setForm(current => ({ ...current, ethnicity: event.target.value as Ethnicity }))}>{ethnicities.map(value => <option key={value} value={value}>{g(('demographic.ethnicity.' + value) as GenerationKey)}</option>)}</select></Field>
            </div>
          </fieldset>

          {form.kind === 'PromptTest' ? (
            <div className="generation-form__grid">
              <Field label={g('test.model')} htmlFor="test-model"><select id="test-model" value={form.model} onChange={event => { const model = event.target.value as ModelName; setForm(current => ({ ...current, model, precision: precisionForModel(model, current.precision) })); }}>{models.map(value => <option key={value} value={value}>{g(('model.' + value) as GenerationKey)}</option>)}</select></Field>
              {form.model === 'LTX-2.5' ? <Field label={g('test.precision')} htmlFor="test-precision"><select id="test-precision" value={form.precision ?? ''} onChange={event => setForm(current => ({ ...current, precision: event.target.value as ModelPrecision }))}>{ltx25Precisions.map(value => <option key={value} value={value}>{g(('precision.' + value) as GenerationKey)}</option>)}</select></Field> : null}
            </div>
          ) : (
            <fieldset className="generation-comparisons">
              <legend>{g('test.model')}</legend>
              {form.comparisons.length > 1 ? <Field label={g('test.execution')} htmlFor="test-execution"><select id="test-execution" value={form.executionMode} onChange={event => setForm(current => ({ ...current, executionMode: event.target.value as TestExecutionMode }))}><option value="Parallel">{g('test.parallel')}</option><option value="Serial">{g('test.serial')}</option></select></Field> : null}
              {form.comparisons.map((comparison, index) => <div className="generation-comparisons__row" key={index}>
                <Field label={g('test.model')} htmlFor={'test-model-' + index}><select id={'test-model-' + index} value={comparison.model} onChange={event => { const model = event.target.value as ModelName; setForm(current => ({ ...current, comparisons: current.comparisons.map((item, itemIndex) => itemIndex === index ? { ...item, model, precision: precisionForModel(model, item.precision) } : item) })); }}>{models.map(value => <option key={value} value={value}>{g(('model.' + value) as GenerationKey)}</option>)}</select></Field>
                {comparison.model === 'LTX-2.5' ? <Field label={g('test.precision')} htmlFor={'test-precision-' + index}><select id={'test-precision-' + index} value={comparison.precision ?? ''} onChange={event => setForm(current => ({ ...current, comparisons: current.comparisons.map((item, itemIndex) => itemIndex === index ? { ...item, precision: event.target.value as ModelPrecision } : item) }))}>{ltx25Precisions.map(value => <option key={value} value={value}>{g(('precision.' + value) as GenerationKey)}</option>)}</select></Field> : null}
                <Field label={g('test.gpu')} htmlFor={'test-gpu-' + index}><select id={'test-gpu-' + index} value={comparison.gpuSlot} onChange={event => setForm(current => ({ ...current, comparisons: current.comparisons.map((item, itemIndex) => itemIndex === index ? { ...item, gpuSlot: event.target.value as GpuSlotName } : item) }))}>{(gpuQuery.data ?? []).map(value => <option key={value.slot} value={value.slot}>{g(('gpu.' + value.slot) as GenerationKey)} {g(('gpu.' + value.availability) as GenerationKey)}</option>)}</select></Field>
                {form.comparisons.length > 1 ? <Button variant="quiet" onClick={() => setForm(current => ({ ...current, comparisons: current.comparisons.filter((_, itemIndex) => itemIndex !== index) }))}>{g('test.removeComparison')}</Button> : null}
              </div>)}
              {form.comparisons.length < 2 ? <Button variant="secondary" onClick={addComparison}>{g('test.addComparison')}</Button> : null}
            </fieldset>
          )}

          <Field label={g('test.seed')} htmlFor="test-seed" hint={g('test.seedHint')}><input id="test-seed" inputMode="numeric" disabled={form.kind === 'PromptTest'} value={form.seed} onChange={event => setForm(current => ({ ...current, seed: event.target.value }))} /></Field>
          {validation ? <p className="field__error" role="alert">{g('test.validation')}</p> : null}
          <div className="generation-form__actions"><Button variant="primary" disabled={!settingsValid} onClick={() => setRunConfirmOpen(true)}>{g('test.run')}</Button></div>
        </section>

        <section className="panel generation-test-preview" aria-labelledby="test-output-title">
          <div className="section-header"><h2 id="test-output-title">{g('test.output')}</h2></div>
          <p>{g('test.outputHint')}</p>
          {inspectedJobId === null ? <p>{g('test.outputEmpty')}</p> : <>
            <p className="generation-isolation-note">{g('test.resultReady')}</p>
            {inspectedItemsQuery.isPending ? <p role="status">{g('common.loading')}</p> : null}
            {promptOutput ? <div className="generation-prompt-output">
              <Field label={g('test.positive')} htmlFor="test-positive-output"><textarea id="test-positive-output" value={promptOutput.finalPositivePrompt} readOnly /></Field>
              <Field label={g('test.negative')} htmlFor="test-negative-output"><textarea id="test-negative-output" value={promptOutput.negativePrompt} readOnly /></Field>
            </div> : <p>{g('test.outputPending')}</p>}
            <Link className="button button--secondary" to={'/generate/results?tab=test&job=' + inspectedJobId}>{g('test.inspectResult')}</Link>
          </>}
        </section>
      </div>

      <section className="panel generation-test-history" aria-labelledby="test-latest-title">
        <div className="section-header"><div><h2 id="test-latest-title">{g('test.latest')}</h2><p>{g('test.latestHint')}</p></div><Link className="button button--secondary" to="/generate/results?tab=test">{g('test.viewAll')}</Link></div>
        <p className="generation-isolation-note">{g('test.isolation')}</p>
        {recent.length === 0 ? <p>{g('state.empty')}</p> : <ul className="generation-job-list">{recent.map(job => <li key={job.id}><div className="generation-job-row"><div><strong>{job.displayName}</strong><span>{g(('source.' + job.source) as GenerationKey)}</span></div><StatusBadge label={g(('job.' + job.status) as GenerationKey)} kind={jobStatusKind(job.status)} /><span>{profileLabel(job.model, job.precision)}</span><time dateTime={job.updatedAt}>{formatDateTime(job.updatedAt)}</time><div className="generation-row-actions"><Link className="button button--quiet" to={'/generate/results?tab=test&job=' + job.id}>{g('common.view')}</Link><Button variant="quiet" onClick={() => setHiddenIds(hideTestResult(job.id))}>{g('common.hide')}</Button></div></div></li>)}</ul>}
      </section>

      <details className="panel generation-resources-disclosure">
        <summary>{g('test.resource.manage')}</summary>
        <TestResources
          testedVersionIds={testedVersionIds}
          onVersionCreated={(id, templateId) => setForm(current => ({
            ...current,
            promptTemplateId: templateId,
            promptTemplateVersionId: id,
          }))}
          onVersionVerified={id => setForm(current => ({ ...current, promptTemplateVersionId: id }))}
        />
      </details>

      <ConfirmDialog open={runConfirmOpen} title={g('test.runTitle')} body={g('test.runBody')} confirmLabel={g('test.run')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => void runTest(false)} onClose={() => setRunConfirmOpen(false)} busy={promptTestMutation.isPending || videoTestMutation.isPending} />
      <ConfirmDialog open={switchConfirmOpen} title={g('production.switchTitle')} body={g('production.switchBody')} confirmLabel={g('common.confirm')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => void runTest(true)} onClose={() => setSwitchConfirmOpen(false)} busy={videoTestMutation.isPending} />
    </GenerationScaffold>
  );
}
