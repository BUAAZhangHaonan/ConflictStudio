import { useEffect, useMemo, useState } from 'react';
import { Button, Field } from '../../components';
import {
  useBackgroundPresetsQuery,
  useContentPlansQuery,
  usePromptPresetsQuery,
  usePromptPreviewMutation,
} from '../../api/queries';
import type { Age, Ethnicity, Gender } from '../../api/contracts';
import { allowedDirections, type Category, type ConflictDirection } from '../../types';
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
  readGenerationDraft,
  saveGenerationDraft,
  useGenerationCopy,
  useGenerationLocale,
} from './shared';

interface TestForm {
  category: Category;
  conflictDirection: ConflictDirection | null;
  contentPlanId: number | null;
  promptPresetId: number | null;
  backgroundPresetId: number | null;
  age: Age;
  gender: Gender;
  ethnicity: Ethnicity;
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
  };
}

export function TestPage() {
  const g = useGenerationCopy();
  const locale = useGenerationLocale();
  const contentQuery = useContentPlansQuery();
  const presetsQuery = usePromptPresetsQuery();
  const backgroundsQuery = useBackgroundPresetsQuery();
  const previewMutation = usePromptPreviewMutation();
  const [form, setForm] = useState<TestForm>(() => readGenerationDraft<TestForm>('test-bench') ?? emptyForm());
  const [validation, setValidation] = useState(false);
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
  const queryError = contentQuery.error ?? presetsQuery.error ?? backgroundsQuery.error ?? null;

  useEffect(() => {
    saveGenerationDraft('test-bench', form);
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
    if (!selectedContent || !selectedPreset || !selectedBackground) {
      setValidation(true);
      return;
    }
    setValidation(false);
    try {
      await previewMutation.mutateAsync({
        contentPlan: { id: selectedContent.id, expectedRevision: selectedContent.revision },
        promptPreset: { id: selectedPreset.id, expectedRevision: selectedPreset.revision },
        backgroundPreset: { id: selectedBackground.id, expectedRevision: selectedBackground.revision },
        demographic: { age: form.age, gender: form.gender, ethnicity: form.ethnicity },
      });
    } catch {
      // The shared safe error panel renders mutation errors.
    }
  };

  if (contentQuery.isPending || presetsQuery.isPending || backgroundsQuery.isPending) return <GenerationScaffold title="test.title" subtitle="test.readOnlySubtitle"><p role="status">{g('state.loadingBody')}</p></GenerationScaffold>;
  if (queryError) return <GenerationScaffold title="test.title" subtitle="test.readOnlySubtitle"><OperationFeedback error={queryError} onDismiss={() => void Promise.all([contentQuery.refetch(), presetsQuery.refetch(), backgroundsQuery.refetch()])} /></GenerationScaffold>;

  const directions = allowedDirections(form.category);
  const result = previewMutation.data;
  return (
    <GenerationScaffold title="test.title" subtitle="test.readOnlySubtitle">
      {previewMutation.isError ? <OperationFeedback error={previewMutation.error} onDismiss={() => previewMutation.reset()} /> : null}
      <div className="generation-layout">
        <section className="panel generation-form" aria-label={g('test.formRegion')}>
          <div className="section-header"><h2>{g('test.setup')}</h2></div>
          <p className="generation-section-note">{g('test.readOnlyExplanation')}</p>
          <div className="generation-form__grid">
            <Field label={g('test.category')} htmlFor="test-category"><select id="test-category" value={form.category} onChange={event => changeCategory(event.target.value as Category)}>{categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}</select></Field>
            <Field label={g('test.direction')} htmlFor="test-direction"><select id="test-direction" value={form.conflictDirection ?? ''} disabled={directions.length === 0} onChange={event => setForm(current => ({ ...current, conflictDirection: (event.target.value || null) as ConflictDirection | null, contentPlanId: null }))}>{directions.length === 0 ? <option value="">{g('common.none')}</option> : null}{directions.map(value => <option key={value} value={value}>{directionLabel(g, value)}</option>)}</select></Field>
            <Field label={g('test.content')} htmlFor="test-content"><select id="test-content" value={form.contentPlanId ?? ''} onChange={event => setForm(current => ({ ...current, contentPlanId: Number(event.target.value) }))}>{content.map(item => <option key={item.id} value={item.id}>{localizedName(locale, item)}</option>)}</select></Field>
            <Field label={g('test.preset')} htmlFor="test-preset"><select id="test-preset" value={form.promptPresetId ?? ''} onChange={event => setForm(current => ({ ...current, promptPresetId: Number(event.target.value) }))}>{presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
            <Field label={g('test.background')} htmlFor="test-background"><select id="test-background" value={form.backgroundPresetId ?? ''} onChange={event => setForm(current => ({ ...current, backgroundPresetId: Number(event.target.value) }))}>{backgrounds.map(item => <option key={item.id} value={item.id}>{localizedName(locale, item)}</option>)}</select></Field>
            <Field label={g('test.age')} htmlFor="test-age"><select id="test-age" value={form.age} onChange={event => setForm(current => ({ ...current, age: Number(event.target.value) as Age }))}>{ages.map(value => <option key={value} value={value}>{g(`demographic.age.${value}`)}</option>)}</select></Field>
            <Field label={g('test.gender')} htmlFor="test-gender"><select id="test-gender" value={form.gender} onChange={event => setForm(current => ({ ...current, gender: event.target.value as Gender }))}>{genders.map(value => <option key={value} value={value}>{g(`demographic.gender.${value}`)}</option>)}</select></Field>
            <Field label={g('test.ethnicity')} htmlFor="test-ethnicity"><select id="test-ethnicity" value={form.ethnicity} onChange={event => setForm(current => ({ ...current, ethnicity: event.target.value as Ethnicity }))}>{ethnicities.map(value => <option key={value} value={value}>{g(`demographic.ethnicity.${value}`)}</option>)}</select></Field>
          </div>
          {validation ? <p className="field__error" role="alert">{g('test.validation')}</p> : null}
          <div className="generation-form__actions"><Button variant="primary" disabled={previewMutation.isPending} onClick={() => void preview()}>{g('test.previewOnly')}</Button></div>
        </section>
        <section className="panel generation-form" aria-labelledby="test-preview-title">
          <div className="section-header"><h2 id="test-preview-title">{g('promptPreview.title')}</h2></div>
          {!result ? <p className="generation-empty-note">{g('test.previewEmpty')}</p> : <div className="generation-prompt-preview"><p>{g('test.previewSourceSummary', { content: localizedName(locale, result.contentPlan), background: localizedName(locale, result.backgroundPreset), preset: result.promptPreset.name })}</p><div className="generation-prompt-preview__field"><strong>{g(result.requiresPromptGeneration ? 'test.promptModelInput' : 'promptPreview.positive')}</strong><pre>{result.finalPositivePrompt ?? result.userInput}</pre></div><div className="generation-prompt-preview__field"><strong>{g('promptPreview.negative')}</strong><pre>{result.finalNegativePrompt}</pre></div><details><summary>{g('test.fixedRules')}</summary><pre>{result.systemInput}</pre></details></div>}
        </section>
      </div>
    </GenerationScaffold>
  );
}
