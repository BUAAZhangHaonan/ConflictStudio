import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, ConfirmDialog, Field } from '../../components';
import {
  useBackgroundPresetsQuery,
  useContentPlansQuery,
  useGpuSlotsQuery,
  usePromptPresetsQuery,
  usePromptPreviewMutation,
  useSubmitTestRunMutation,
} from '../../api/queries';
import { isModelSwitchConfirmationRequired } from '../../api/client';
import type { Age, Ethnicity, Gender, GpuSlotName, TestExecutionMode } from '../../api/contracts';
import {
  addSecondTestComparison,
  comparisonEntriesAreValid,
  defaultTestComparisons,
  ltx25Precisions,
  models,
  precisionForModel,
  type GenerationProfile,
} from '../../generationProfile';
import {
  allowedDirections,
  type Category,
  type ConflictDirection,
  type ModelName,
  type ModelPrecision,
} from '../../types';
import {
  ages,
  categories,
  categoryLabel,
  directionLabel,
  ethnicities,
  genders,
  GenerationScaffold,
  localizedName,
  OperationFeedback,
  parseSeed,
  readGenerationDraft,
  saveGenerationDraft,
  useGenerationCopy,
  useGenerationLocale,
} from './shared';

interface TestComparisonForm extends GenerationProfile {
  gpuSlot: GpuSlotName;
}

interface TestForm {
  category: Category;
  conflictDirection: ConflictDirection | null;
  contentPlanId: number | null;
  promptPresetId: number | null;
  backgroundPresetId: number | null;
  age: Age;
  gender: Gender;
  ethnicity: Ethnicity;
  seed: string;
  comparisons: TestComparisonForm[];
  executionMode: TestExecutionMode;
}

function emptyForm(): TestForm {
  return {
    category: 'A-VA',
    conflictDirection: null,
    contentPlanId: null,
    promptPresetId: null,
    backgroundPresetId: null,
    age: 25,
    gender: 'Female',
    ethnicity: 'EastAsian',
    seed: '',
    comparisons: defaultTestComparisons().map(value => ({ ...value, gpuSlot: 'GPU0' })),
    executionMode: 'Parallel',
  };
}

export function TestPage() {
  const g = useGenerationCopy();
  const navigate = useNavigate();
  const locale = useGenerationLocale();
  const contentQuery = useContentPlansQuery();
  const presetsQuery = usePromptPresetsQuery();
  const backgroundsQuery = useBackgroundPresetsQuery();
  const gpuQuery = useGpuSlotsQuery();
  const previewMutation = usePromptPreviewMutation();
  const submitMutation = useSubmitTestRunMutation();
  const [form, setForm] = useState<TestForm>(() => readGenerationDraft<TestForm>('test-bench-v3') ?? emptyForm());
  const [validation, setValidation] = useState(false);
  const [submitConfirmOpen, setSubmitConfirmOpen] = useState(false);
  const [switchConfirmOpen, setSwitchConfirmOpen] = useState(false);
  const [previewedFormKey, setPreviewedFormKey] = useState<string | null>(null);
  const content = useMemo(() => (contentQuery.data ?? []).filter(item =>
    item.status === 'Active' && item.category === form.category && item.conflictDirection === form.conflictDirection,
  ), [contentQuery.data, form.category, form.conflictDirection]);
  const presets = useMemo(() => (presetsQuery.data ?? []).filter(item =>
    item.status === 'Active' && item.category === form.category,
  ), [form.category, presetsQuery.data]);
  const backgrounds = useMemo(
    () => (backgroundsQuery.data ?? []).filter(item => item.status === 'Active'),
    [backgroundsQuery.data],
  );
  const selectedContent = content.find(item => item.id === form.contentPlanId) ?? null;
  const selectedPreset = presets.find(item => item.id === form.promptPresetId) ?? null;
  const selectedBackground = backgrounds.find(item => item.id === form.backgroundPresetId) ?? null;
  const formKey = JSON.stringify({
    form,
    contentRevision: selectedContent?.revision ?? null,
    presetRevision: selectedPreset?.revision ?? null,
    backgroundRevision: selectedBackground?.revision ?? null,
  });
  const result = previewedFormKey === formKey ? previewMutation.data : undefined;
  const queryError = contentQuery.error ?? presetsQuery.error ?? backgroundsQuery.error ?? null;

  useEffect(() => {
    saveGenerationDraft('test-bench-v3', form);
  }, [form]);

  useEffect(() => {
    setForm(current => ({
      ...current,
      contentPlanId: content.some(item => item.id === current.contentPlanId) ? current.contentPlanId : content[0]?.id ?? null,
      promptPresetId: presets.some(item => item.id === current.promptPresetId) ? current.promptPresetId : presets[0]?.id ?? null,
      backgroundPresetId: backgrounds.some(item => item.id === current.backgroundPresetId) ? current.backgroundPresetId : backgrounds[0]?.id ?? null,
    }));
  }, [content, presets, backgrounds]);

  const changeCategory = (category: Category) => {
    setForm(current => ({
      ...current,
      category,
      conflictDirection: allowedDirections(category)[0] ?? null,
      contentPlanId: null,
      promptPresetId: null,
    }));
    previewMutation.reset();
  };

  const preview = async () => {
    const seed = parseSeed(form.seed);
    if (
      !selectedContent
      || !selectedPreset
      || !selectedBackground
      || !comparisonEntriesAreValid(form.comparisons)
      || (seed !== null && (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 31))
    ) {
      setValidation(true);
      return;
    }
    setValidation(false);
    const submittedFormKey = formKey;
    try {
      await previewMutation.mutateAsync({
        contentPlan: { id: selectedContent.id, expectedRevision: selectedContent.revision },
        promptPreset: { id: selectedPreset.id, expectedRevision: selectedPreset.revision },
        backgroundPreset: { id: selectedBackground.id, expectedRevision: selectedBackground.revision },
        demographic: { age: form.age, gender: form.gender, ethnicity: form.ethnicity },
      });
      setPreviewedFormKey(submittedFormKey);
    } catch {
      setPreviewedFormKey(null);
      // The shared safe error panel renders mutation errors.
    }
  };

  const submit = async (confirmModelSwitch: boolean) => {
    const seed = parseSeed(form.seed);
    const slots = new Set(form.comparisons.map(value => value.gpuSlot));
    const gpuBySlot = new Map((gpuQuery.data ?? []).map(value => [value.slot, value]));
    const validExecution = form.comparisons.length === 1
      || (form.executionMode === 'Parallel' ? slots.size === form.comparisons.length : slots.size === 1);
    const validSeed = seed === null || (Number.isInteger(seed) && seed >= 0 && seed < 2 ** 31);
    if (
      !result
      || !selectedContent
      || !selectedPreset
      || !selectedBackground
      || !comparisonEntriesAreValid(form.comparisons)
      || !validSeed
      || !validExecution
      || [...slots].some(slot => !gpuBySlot.has(slot))
    ) {
      setValidation(true);
      setSubmitConfirmOpen(false);
      return;
    }
    try {
      const job = await submitMutation.mutateAsync({
        contentPlan: { id: selectedContent.id, expectedRevision: selectedContent.revision },
        promptPreset: { id: selectedPreset.id, expectedRevision: selectedPreset.revision },
        backgroundPreset: { id: selectedBackground.id, expectedRevision: selectedBackground.revision },
        demographic: { age: form.age, gender: form.gender, ethnicity: form.ethnicity },
        seed,
        comparisons: form.comparisons,
        executionMode: form.executionMode,
        expectedGpuRevisions: Object.fromEntries([...slots].map(slot => [slot, gpuBySlot.get(slot)!.revision])),
        confirmModelSwitch,
      });
      navigate(`/generate/jobs?job=${job.id}`);
    } catch (error) {
      if (!confirmModelSwitch && isModelSwitchConfirmationRequired(error)) setSwitchConfirmOpen(true);
    } finally {
      setSubmitConfirmOpen(false);
    }
  };

  if (contentQuery.isPending || presetsQuery.isPending || backgroundsQuery.isPending || gpuQuery.isPending) return <GenerationScaffold title="test.title" subtitle="test.subtitle"><p role="status">{g('state.loadingBody')}</p></GenerationScaffold>;
  if (queryError || gpuQuery.error) return <GenerationScaffold title="test.title" subtitle="test.subtitle"><OperationFeedback error={queryError ?? gpuQuery.error} onDismiss={() => void Promise.all([contentQuery.refetch(), presetsQuery.refetch(), backgroundsQuery.refetch(), gpuQuery.refetch()])} /></GenerationScaffold>;

  const directions = allowedDirections(form.category);
  return (
    <GenerationScaffold title="test.title" subtitle="test.subtitle">
      {previewMutation.isError ? <OperationFeedback error={previewMutation.error} onDismiss={() => previewMutation.reset()} /> : null}
      {submitMutation.isError && !switchConfirmOpen ? <OperationFeedback error={submitMutation.error} onDismiss={() => submitMutation.reset()} /> : null}
      <div className="generation-layout">
        <section className="panel generation-form" aria-label={g('test.formRegion')}>
          <div className="section-header"><h2>{g('test.setup')}</h2></div>
          <p className="generation-section-note">{g('test.setupNote')}</p>
          <div className="generation-form__grid">
            <Field label={g('test.category')} htmlFor="test-category"><select id="test-category" value={form.category} onChange={event => changeCategory(event.target.value as Category)}>{categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}</select></Field>
            <Field label={g('test.direction')} htmlFor="test-direction"><select id="test-direction" value={form.conflictDirection ?? ''} disabled={directions.length === 0} onChange={event => setForm(current => ({ ...current, conflictDirection: (event.target.value || null) as ConflictDirection | null, contentPlanId: null }))}>{directions.length === 0 ? <option value="">{g('common.none')}</option> : null}{directions.map(value => <option key={value} value={value}>{directionLabel(g, value)}</option>)}</select></Field>
            <Field label={g('test.content')} htmlFor="test-content"><select id="test-content" value={form.contentPlanId ?? ''} onChange={event => setForm(current => ({ ...current, contentPlanId: Number(event.target.value) }))}>{content.map(item => <option key={item.id} value={item.id}>{localizedName(locale, item)}</option>)}</select></Field>
            <Field label={g('test.preset')} htmlFor="test-preset"><select id="test-preset" value={form.promptPresetId ?? ''} onChange={event => setForm(current => ({ ...current, promptPresetId: Number(event.target.value) }))}>{presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
            <Field label={g('test.background')} htmlFor="test-background"><select id="test-background" value={form.backgroundPresetId ?? ''} onChange={event => setForm(current => ({ ...current, backgroundPresetId: Number(event.target.value) }))}>{backgrounds.map(item => <option key={item.id} value={item.id}>{localizedName(locale, item)}</option>)}</select></Field>
            <Field label={g('test.age')} htmlFor="test-age"><select id="test-age" value={form.age} onChange={event => setForm(current => ({ ...current, age: Number(event.target.value) as Age }))}>{ages.map(value => <option key={value} value={value}>{g(`demographic.age.${value}`)}</option>)}</select></Field>
            <Field label={g('test.gender')} htmlFor="test-gender"><select id="test-gender" value={form.gender} onChange={event => setForm(current => ({ ...current, gender: event.target.value as Gender }))}>{genders.map(value => <option key={value} value={value}>{g(`demographic.gender.${value}`)}</option>)}</select></Field>
            <Field label={g('test.ethnicity')} htmlFor="test-ethnicity"><select id="test-ethnicity" value={form.ethnicity} onChange={event => setForm(current => ({ ...current, ethnicity: event.target.value as Ethnicity }))}>{ethnicities.map(value => <option key={value} value={value}>{g(`demographic.ethnicity.${value}`)}</option>)}</select></Field>
            <Field label={g('test.seed')} htmlFor="test-seed"><input id="test-seed" inputMode="numeric" placeholder={g('test.seedPlaceholder')} value={form.seed} onChange={event => setForm(current => ({ ...current, seed: event.target.value }))} /></Field>
          </div>
          <fieldset className="generation-comparisons">
            <legend>{g('test.comparisons')}</legend>
            {form.comparisons.length > 1 ? <Field label={g('test.execution')} htmlFor="test-execution"><select id="test-execution" value={form.executionMode} onChange={event => setForm(current => ({ ...current, executionMode: event.target.value as TestExecutionMode }))}><option value="Parallel">{g('test.parallel')}</option><option value="Serial">{g('test.serial')}</option></select></Field> : null}
            {form.comparisons.map((comparison, index) => (
              <div className="generation-comparisons__row" key={index}>
                <Field label={g('test.model')} htmlFor={`test-model-${index}`}>
                  <select id={`test-model-${index}`} value={comparison.model} onChange={event => { const model = event.target.value as ModelName; setForm(current => ({ ...current, comparisons: current.comparisons.map((item, itemIndex) => itemIndex === index ? { ...item, model, precision: precisionForModel(model, item.precision) } : item) })); }}>
                    {models.map(value => <option key={value} value={value}>{value}</option>)}
                  </select>
                </Field>
                {comparison.model === 'LTX-2.5' ? (
                  <Field label={g('test.precision')} htmlFor={`test-precision-${index}`}>
                    <select id={`test-precision-${index}`} value={comparison.precision ?? ''} onChange={event => setForm(current => ({ ...current, comparisons: current.comparisons.map((item, itemIndex) => itemIndex === index ? { ...item, precision: event.target.value as ModelPrecision } : item) }))}>
                      {ltx25Precisions.map(value => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </Field>
                ) : null}
                <Field label={g('test.gpu')} htmlFor={`test-gpu-${index}`}><select id={`test-gpu-${index}`} value={comparison.gpuSlot} onChange={event => setForm(current => ({ ...current, comparisons: current.comparisons.map((item, itemIndex) => itemIndex === index ? { ...item, gpuSlot: event.target.value as GpuSlotName } : item) }))}>{(gpuQuery.data ?? []).map(value => <option key={value.slot} value={value.slot}>{value.slot}</option>)}</select></Field>
                {form.comparisons.length > 1 ? <Button variant="quiet" onClick={() => setForm(current => ({ ...current, comparisons: current.comparisons.filter((_, itemIndex) => itemIndex !== index) }))}>{g('test.removeComparison')}</Button> : null}
              </div>
            ))}
            {form.comparisons.length < 2 ? <Button variant="secondary" onClick={() => setForm(current => ({ ...current, comparisons: addSecondTestComparison(current.comparisons).map((item, index) => ({ ...item, gpuSlot: index === 0 ? current.comparisons[0].gpuSlot : 'GPU1' })) }))}>{g('test.addComparison')}</Button> : null}
          </fieldset>
          {validation ? <p className="field__error" role="alert">{g('test.validation')}</p> : null}
          <div className="generation-form__actions"><Button variant="secondary" disabled={previewMutation.isPending} onClick={() => void preview()}>{g('test.previewOnly')}</Button><Button variant="primary" disabled={!result || submitMutation.isPending} onClick={() => setSubmitConfirmOpen(true)}>{g('test.run')}</Button></div>
        </section>
        <section className="panel generation-form" aria-labelledby="test-preview-title">
          <div className="section-header"><h2 id="test-preview-title">{g('promptPreview.title')}</h2></div>
          {!result ? <p className="generation-empty-note">{g('test.previewEmpty')}</p> : <div className="generation-prompt-preview"><p>{g('test.previewSourceSummary', { content: localizedName(locale, result.contentPlan), background: localizedName(locale, result.backgroundPreset), preset: result.promptPreset.name })}</p><p>{g('test.sharedSeed', { seed: parseSeed(form.seed) ?? g('test.randomSeed') })}</p><p>{form.comparisons.map(item => item.precision ? `${item.model} ${item.precision}` : item.model).join(' / ')}</p><div className="generation-prompt-preview__field"><strong>{g(result.requiresPromptGeneration ? 'test.promptModelInput' : 'promptPreview.positive')}</strong><pre>{result.finalPositivePrompt ?? result.userInput}</pre></div><div className="generation-prompt-preview__field"><strong>{g('promptPreview.negative')}</strong><pre>{result.finalNegativePrompt}</pre></div><details><summary>{g('test.fixedRules')}</summary><pre>{result.systemInput}</pre></details></div>}
        </section>
      </div>
      <ConfirmDialog open={submitConfirmOpen} title={g('test.previewTitle')} body={g('test.previewBody', { count: form.comparisons.length })} confirmLabel={g('test.run')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => void submit(false)} onClose={() => setSubmitConfirmOpen(false)} />
      <ConfirmDialog open={switchConfirmOpen} title={g('batches.releaseModelTitle')} body={g('batches.modelSwitchConfirmation')} confirmLabel={g('common.yes')} cancelLabel={g('common.no')} closeLabel={g('common.close')} onConfirm={() => void submit(true)} onClose={() => setSwitchConfirmOpen(false)} />
    </GenerationScaffold>
  );
}
