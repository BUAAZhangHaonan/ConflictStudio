import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiErrorMessage, isModelSwitchConfirmationRequired } from '../../api/client';
import { generationQueries, useBatchDraftsQuery, useContentPlansQuery, useCreateDatasetMutation, useDatasetsQuery, useGpuSlotsQuery, usePreviewBatchMutation, usePromptPresetsQuery, useSaveBatchDraftMutation, useSubmitBatchMutation } from '../../api/queries';
import type { Age, BatchDraft, BatchDraftCreate, BatchPreview, BilingualSelection, Demographic, Ethnicity, Gender, GpuSlotName } from '../../api/contracts';
import { buildGenerationProfile, ltx25Precisions, precisionForModel } from '../../generationProfile';
import { allowedDirections, type Category, type ConflictDirection, type ModelName, type ModelPrecision } from '../../types';
import { Button, ConfirmDialog, Dialog, Field, Pagination, TableShell, useToast } from '../../components';
import { ages, categories, categoryLabel, directionLabel, ethnicities, genders, GenerationScaffold, GpuPanel, localizedName, modelSpecLabel, models, OperationFeedback, parseSeed, readGenerationDraft, toggleArrayValue, useGenerationCopy, useGenerationDraft, useGenerationLocale, useUnsavedChanges } from './shared';

interface SelectedContent {
  contentPlan: BilingualSelection & { mode: 'Fixed' | 'Generative' };
  availableBackgrounds: BilingualSelection[];
  backgroundPresetIds: number[];
}

interface BatchForm {
  targetDatasetId: number | null;
  category: Category;
  conflictDirection: ConflictDirection | null;
  model: ModelName;
  precision: ModelPrecision | null;
  quantity: number;
  seed: string;
  contentSelections: SelectedContent[];
  promptPresetId: number | null;
  selectedAges: Age[];
  selectedGenders: Gender[];
  selectedEthnicities: Ethnicity[];
  gpuSlots: GpuSlotName[];
}

export function demographicCombinations(selectedAges: readonly Age[], selectedGenders: readonly Gender[], selectedEthnicities: readonly Ethnicity[]): Demographic[] {
  return selectedAges.flatMap(age => selectedGenders.flatMap(gender => selectedEthnicities.map(ethnicity => ({ age, gender, ethnicity }))));
}

function emptyBatchForm(): BatchForm {
  return {
    targetDatasetId: null,
    category: 'A-VA',
    conflictDirection: null,
    model: 'LTX-2.5',
    precision: 'INT8',
    quantity: 8,
    seed: '',
    contentSelections: [],
    promptPresetId: null,
    selectedAges: [25],
    selectedGenders: ['Female'],
    selectedEthnicities: ['EastAsian'],
    gpuSlots: [],
  };
}

function formFromDraft(value: BatchDraft): BatchForm {
  return {
    targetDatasetId: value.targetDatasetId,
    category: value.category,
    conflictDirection: value.conflictDirection,
    model: value.model,
    precision: precisionForModel(value.model, value.precision),
    quantity: value.quantity,
    seed: String(value.seed),
    contentSelections: value.contentSelections.map(selection => ({
      contentPlan: { ...selection.contentPlan, mode: selection.mode },
      availableBackgrounds: selection.compatibleBackgrounds,
      backgroundPresetIds: selection.backgroundPresets.map(background => background.id),
    })),
    promptPresetId: value.promptPreset.id,
    selectedAges: [...new Set(value.demographics.map(item => item.age))],
    selectedGenders: [...new Set(value.demographics.map(item => item.gender))],
    selectedEthnicities: [...new Set(value.demographics.map(item => item.ethnicity))],
    gpuSlots: value.gpuSlots,
  };
}

export function batchFormIsValid(form: BatchForm): boolean {
  const seed = parseSeed(form.seed);
  return Boolean(
    form.targetDatasetId
    && form.quantity > 0
    && form.quantity <= 10_000
    && (seed === null || (Number.isInteger(seed) && seed >= 0 && seed < 2 ** 31))
    && form.contentSelections.length > 0
    && form.contentSelections.every(item => item.backgroundPresetIds.length > 0)
    && form.promptPresetId
    && form.selectedAges.length
    && form.selectedGenders.length
    && form.selectedEthnicities.length
    && form.gpuSlots.length >= 1
    && form.gpuSlots.length <= 2
    && buildGenerationProfile(form.model, form.precision),
  );
}

export function BatchesPage() {
  const g = useGenerationCopy();
  const locale = useGenerationLocale();
  const client = useQueryClient();
  const { showToast } = useToast();
  const [datasetPage, setDatasetPage] = useState(1);
  const [contentPage, setContentPage] = useState(1);
  const [presetPage, setPresetPage] = useState(1);
  const [draftPage, setDraftPage] = useState(1);
  const datasetsQuery = useDatasetsQuery(datasetPage);
  const contentQuery = useContentPlansQuery(contentPage);
  const presetsQuery = usePromptPresetsQuery(presetPage);
  const draftsQuery = useBatchDraftsQuery(draftPage);
  const gpuQuery = useGpuSlotsQuery();
  const createDatasetMutation = useCreateDatasetMutation();
  const saveMutation = useSaveBatchDraftMutation();
  const previewMutation = usePreviewBatchMutation();
  const submitMutation = useSubmitBatchMutation();
  const stored = useState(() => readGenerationDraft<{ selectedId: number | null; form: BatchForm }>('batch-form-v3'))[0];
  const [selectedId, setSelectedId] = useState<number | null>(stored?.selectedId ?? null);
  const [form, setForm] = useState<BatchForm>(stored?.form ?? emptyBatchForm());
  const [baseline, setBaseline] = useState<BatchForm | null>(null);
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [combinationPage, setCombinationPage] = useState(1);
  const [scenePages, setScenePages] = useState<Record<number, number>>({});
  const [validation, setValidation] = useState(false);
  const [loadingContentId, setLoadingContentId] = useState<number | null>(null);
  const [contentLoadError, setContentLoadError] = useState<unknown>(null);
  const [datasetDialogOpen, setDatasetDialogOpen] = useState(false);
  const [datasetName, setDatasetName] = useState('');
  const [datasetNote, setDatasetNote] = useState('');
  const [submitConfirmOpen, setSubmitConfirmOpen] = useState(false);
  const [switchConfirmOpen, setSwitchConfirmOpen] = useState(false);
  const batchDefaultsInitialized = useRef(stored !== null);
  const draftItems = draftsQuery.data?.items ?? [];
  const savedDraft = draftItems.find(item => item.id === selectedId) ?? null;
  const queries = [datasetsQuery, contentQuery, presetsQuery, draftsQuery, gpuQuery];
  const queryError = queries.find(query => query.isError)?.error ?? null;
  const mutationError = contentLoadError ?? createDatasetMutation.error ?? saveMutation.error ?? previewMutation.error ?? submitMutation.error ?? null;

  useEffect(() => {
    if (batchDefaultsInitialized.current || queries.some(query => query.isPending)) return;
    batchDefaultsInitialized.current = true;
    const defaults = emptyBatchForm();
    defaults.targetDatasetId = datasetsQuery.data?.items.find(item => item.status === 'Active' && item.purpose === 'Formal')?.id ?? null;
    defaults.gpuSlots = (gpuQuery.data ?? []).filter(item => item.availability === 'Available').slice(0, 1).map(item => item.slot);
    setForm(defaults);
    setBaseline(defaults);
  }, [datasetsQuery.data, gpuQuery.data]);

  const matchingContent = useMemo(() => (contentQuery.data?.items ?? []).filter(item => item.status === 'Active' && item.category === form.category && item.conflictDirection === form.conflictDirection), [contentQuery.data, form.category, form.conflictDirection]);
  const matchingPresets = useMemo(() => (presetsQuery.data?.items ?? []).filter(item => item.status === 'Active' && item.category === form.category), [form.category, presetsQuery.data]);
  const targetDatasets = (datasetsQuery.data?.items ?? []).filter(item => item.status === 'Active' && item.purpose === 'Formal');
  const dirty = baseline === null || JSON.stringify(form) !== JSON.stringify(baseline);
  const isSavedCurrent = savedDraft !== null && !dirty;
  const combinations = useMemo(() => form.contentSelections.flatMap(selection => selection.backgroundPresetIds.map(backgroundId => ({
    content: selection.contentPlan,
    background: selection.availableBackgrounds.find(item => item.id === backgroundId),
  })).filter((item): item is { content: SelectedContent['contentPlan']; background: BilingualSelection } => item.background !== undefined)), [form.contentSelections]);
  const combinationTotalPages = Math.ceil(combinations.length / 20);
  const visibleCombinations = combinations.slice((combinationPage - 1) * 20, combinationPage * 20);
  const previewTotalPages = preview ? Math.ceil(preview.allocations.length / 20) : 0;
  const visiblePreview = preview?.allocations.slice((previewPage - 1) * 20, previewPage * 20) ?? [];

  const selectDraft = (value: string) => {
    const id = value === 'new' ? null : Number(value);
    const selected = draftItems.find(item => item.id === id) ?? null;
    const next = selected ? formFromDraft(selected) : emptyBatchForm();
    if (!selected) {
      next.targetDatasetId = targetDatasets[0]?.id ?? null;
      next.gpuSlots = (gpuQuery.data ?? []).filter(item => item.availability === 'Available').slice(0, 1).map(item => item.slot);
    }
    setSelectedId(id);
    setForm(next);
    setBaseline(selected && next.contentSelections.length > 0 ? next : null);
    setPreview(null);
    setValidation(false);
  };

  const changeCategory = (category: Category) => {
    setForm(current => ({ ...current, category, conflictDirection: allowedDirections(category)[0] ?? null, contentSelections: [], promptPresetId: null }));
    setContentPage(1);
    setPresetPage(1);
    setPreview(null);
  };

  const toggleContent = async (contentId: number) => {
    setContentLoadError(null);
    if (form.contentSelections.some(item => item.contentPlan.id === contentId)) {
      setForm(current => ({ ...current, contentSelections: current.contentSelections.filter(item => item.contentPlan.id !== contentId) }));
      setCombinationPage(1);
      return;
    }
    const content = matchingContent.find(item => item.id === contentId);
    if (!content) return;
    setLoadingContentId(contentId);
    try {
      const relation = await client.fetchQuery(generationQueries.contentBackgrounds(contentId));
      const selectedBackgrounds = content.mode === 'Fixed' ? relation.backgrounds.map(item => item.id) : [];
      setForm(current => ({
        ...current,
        contentSelections: [...current.contentSelections, {
          contentPlan: { id: content.id, nameZh: content.nameZh, nameEn: content.nameEn, revision: relation.contentPlanRevision, mode: content.mode },
          availableBackgrounds: relation.backgrounds,
          backgroundPresetIds: selectedBackgrounds,
        }],
      }));
      setCombinationPage(1);
    } catch (error) {
      setContentLoadError(error);
    } finally {
      setLoadingContentId(null);
    }
  };

  const changeScenes = (contentId: number, ids: number[]) => {
    setForm(current => ({
      ...current,
      contentSelections: current.contentSelections.map(item => item.contentPlan.id === contentId ? { ...item, backgroundPresetIds: ids } : item),
    }));
    setCombinationPage(1);
  };

  const payload = (): BatchDraftCreate | null => {
    const profile = buildGenerationProfile(form.model, form.precision);
    if (!batchFormIsValid(form) || form.targetDatasetId === null || form.promptPresetId === null || !profile) return null;
    return {
      targetDatasetId: form.targetDatasetId,
      category: form.category,
      conflictDirection: form.conflictDirection,
      ...profile,
      quantity: form.quantity,
      seed: parseSeed(form.seed),
      contentSelections: form.contentSelections.map(item => ({
        contentPlanId: item.contentPlan.id,
        backgroundPresetIds: item.contentPlan.mode === 'Fixed' ? [] : item.backgroundPresetIds,
      })),
      promptPresetId: form.promptPresetId,
      demographics: demographicCombinations(form.selectedAges, form.selectedGenders, form.selectedEthnicities),
      gpuSlots: form.gpuSlots,
    };
  };

  const save = async () => {
    const value = payload();
    if (!value) { setValidation(true); return; }
    setValidation(false);
    try {
      const saved = await saveMutation.mutateAsync({ id: savedDraft?.id ?? null, input: savedDraft ? { ...value, expectedRevision: savedDraft.revision } : value });
      const canonical = formFromDraft(saved);
      setSelectedId(saved.id);
      setForm(canonical);
      setBaseline(canonical);
      setPreview(null);
      showToast(g('batches.draftSaved'));
    } catch { /* The shared error panel renders the safe message. */ }
  };

  const createDataset = async (event: FormEvent) => {
    event.preventDefault();
    if (!datasetName.trim()) return;
    try {
      const created = await createDatasetMutation.mutateAsync({ name: datasetName, note: datasetNote });
      setForm(current => ({ ...current, targetDatasetId: created.id }));
      setDatasetPage(Math.max(1, Math.ceil(((datasetsQuery.data?.total ?? 0) + 1) / 20)));
      setDatasetDialogOpen(false);
      setDatasetName('');
      setDatasetNote('');
    } catch { /* The dialog keeps the human-readable error visible. */ }
  };

  const buildPreview = async () => {
    if (!savedDraft || dirty) return;
    try {
      setPreview(await previewMutation.mutateAsync({ id: savedDraft.id, expectedRevision: savedDraft.revision }));
      setPreviewPage(1);
    } catch { setPreview(null); }
  };

  const submit = async (confirmModelSwitch: boolean) => {
    if (!savedDraft || !preview) return;
    setSubmitConfirmOpen(false);
    setSwitchConfirmOpen(false);
    try {
      await submitMutation.mutateAsync({ id: savedDraft.id, expectedRevision: preview.expectedRevision, expectedGpuRevisions: preview.gpuRevisions, confirmModelSwitch });
      setPreview(null);
      showToast(g('batches.success'));
    } catch (error) {
      if (!confirmModelSwitch && isModelSwitchConfirmationRequired(error)) setSwitchConfirmOpen(true);
    }
  };

  useGenerationDraft('batch-form-v3', { selectedId, form }, dirty);
  const unsavedDialog = useUnsavedChanges(dirty);

  if (queries.some(query => query.isPending)) return <GenerationScaffold title="batches.title" subtitle="batches.subtitle"><p role="status">{g('state.loadingBody')}</p></GenerationScaffold>;
  if (queryError) return <GenerationScaffold title="batches.title" subtitle="batches.subtitle"><OperationFeedback error={queryError} onDismiss={() => void Promise.all(queries.map(query => query.refetch()))} /></GenerationScaffold>;

  const directions = allowedDirections(form.category);
  return (
    <GenerationScaffold title="batches.title" subtitle="batches.subtitle">
      {mutationError && !switchConfirmOpen ? <OperationFeedback error={mutationError} onDismiss={() => { setContentLoadError(null); createDatasetMutation.reset(); saveMutation.reset(); previewMutation.reset(); submitMutation.reset(); }} /> : null}
      <div className="generation-layout">
        <section className="panel generation-form generation-batch-workflow" aria-label={g('batches.formRegion')}>
          <section className="generation-workflow-section">
            <div className="section-header"><h2>{g('batches.savedDraft')}</h2></div>
            <Field label={g('batches.savedDraft')} htmlFor="batch-saved-draft"><select id="batch-saved-draft" value={selectedId ?? 'new'} onChange={event => selectDraft(event.target.value)}><option value="new">{g('batches.newDraft')}</option>{draftItems.filter(item => item.status === 'Draft').map(item => <option key={item.id} value={item.id}>{categoryLabel(g, item.category)} {item.id}</option>)}</select></Field>
            <Pagination page={draftsQuery.data?.page ?? draftPage} totalPages={draftsQuery.data?.totalPages ?? 0} total={draftsQuery.data?.total ?? 0} onPageChange={setDraftPage} />
          </section>

          <section className="generation-workflow-section" aria-labelledby="batch-dataset-title">
            <div className="section-header"><div><h2 id="batch-dataset-title">{g('batches.stepDataset')}</h2><p className="generation-section-note">{g('batches.datasetNote')}</p></div><Button type="button" variant="secondary" onClick={() => setDatasetDialogOpen(true)}>{g('batches.createDataset')}</Button></div>
            {targetDatasets.length === 0 ? <p className="generation-empty-note">{g('batches.noTargetDataset')}</p> : <div className="generation-choice-grid">{targetDatasets.map(item => <label key={item.id}><input type="radio" name="target-dataset" checked={form.targetDatasetId === item.id} onChange={() => setForm(current => ({ ...current, targetDatasetId: item.id }))} /><span><strong>{item.name}</strong>{item.note ? <small>{item.note}</small> : null}</span></label>)}</div>}
            <Pagination page={datasetsQuery.data?.page ?? datasetPage} totalPages={datasetsQuery.data?.totalPages ?? 0} total={datasetsQuery.data?.total ?? 0} onPageChange={setDatasetPage} />
          </section>

          <section className="generation-workflow-section" aria-labelledby="batch-content-title">
            <div className="section-header"><div><h2 id="batch-content-title">{g('batches.stepContent')}</h2><p className="generation-section-note">{g('batches.contentRole')}</p></div></div>
            <div className="generation-form__grid">
              <Field label={g('batches.category')} htmlFor="batch-category" required><select id="batch-category" value={form.category} onChange={event => changeCategory(event.target.value as Category)}>{categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}</select></Field>
              <Field label={g('batches.direction')} htmlFor="batch-direction" required={directions.length > 0}><select id="batch-direction" value={form.conflictDirection ?? ''} disabled={directions.length === 0} onChange={event => setForm(current => ({ ...current, conflictDirection: (event.target.value || null) as ConflictDirection | null, contentSelections: [] }))}>{directions.length === 0 ? <option value="">{g('common.none')}</option> : null}{directions.map(value => <option key={value} value={value}>{directionLabel(g, value)}</option>)}</select></Field>
            </div>
            {matchingContent.length === 0 ? <p className="generation-empty-note">{g('batches.noContent')}</p> : <div className="generation-choice-grid">{matchingContent.map(item => <label key={item.id}><input type="checkbox" disabled={loadingContentId === item.id} checked={form.contentSelections.some(value => value.contentPlan.id === item.id)} onChange={() => void toggleContent(item.id)} /><span>{localizedName(locale, item)}<small>{g(`content.mode.${item.mode}`)}</small></span></label>)}</div>}
            <Pagination page={contentQuery.data?.page ?? contentPage} totalPages={contentQuery.data?.totalPages ?? 0} total={contentQuery.data?.total ?? 0} onPageChange={setContentPage} />
            <div className="generation-content-scenes">
              {form.contentSelections.map(selection => {
                const currentScenePage = scenePages[selection.contentPlan.id] ?? 1;
                const sceneTotalPages = Math.ceil(selection.availableBackgrounds.length / 20);
                const visibleScenes = selection.availableBackgrounds.slice((currentScenePage - 1) * 20, currentScenePage * 20);
                return <article className="generation-content-scene" key={selection.contentPlan.id}><div className="section-header"><div><h3>{localizedName(locale, selection.contentPlan)}</h3><p>{selection.contentPlan.mode === 'Fixed' ? g('batches.fixedSceneNote') : g('batches.sceneRole')}</p></div>{selection.contentPlan.mode === 'Generative' ? <div className="generation-fieldset__toolbar"><Button type="button" variant="quiet" disabled={selection.availableBackgrounds.length === 0 || selection.backgroundPresetIds.length === selection.availableBackgrounds.length} onClick={() => changeScenes(selection.contentPlan.id, selection.availableBackgrounds.map(item => item.id))}>{g('batches.selectCompatibleScenes')}</Button><Button type="button" variant="quiet" disabled={selection.backgroundPresetIds.length === 0} onClick={() => changeScenes(selection.contentPlan.id, [])}>{g('batches.clearCompatibleScenes')}</Button></div> : null}</div>
                  {selection.availableBackgrounds.length === 0 ? <p className="field__error">{g('batches.noCompatibleScenes')}</p> : selection.contentPlan.mode === 'Fixed' ? <p className="generation-fixed-scene">{localizedName(locale, selection.availableBackgrounds[0])}</p> : <div className="generation-choice-grid">{visibleScenes.map(background => <label key={background.id}><input type="checkbox" checked={selection.backgroundPresetIds.includes(background.id)} onChange={() => changeScenes(selection.contentPlan.id, toggleArrayValue(selection.backgroundPresetIds, background.id))} /><span>{localizedName(locale, background)}</span></label>)}</div>}
                  {selection.contentPlan.mode === 'Generative' && selection.backgroundPresetIds.length === 0 ? <p className="field__error" role="status">{g('batches.sceneSelectionRequired')}</p> : null}
                  <Pagination page={currentScenePage} totalPages={sceneTotalPages} total={selection.availableBackgrounds.length} onPageChange={page => setScenePages(current => ({ ...current, [selection.contentPlan.id]: page }))} />
                </article>;
              })}
            </div>
          </section>

          <section className="generation-workflow-section" aria-labelledby="batch-preset-title">
            <div className="section-header"><div><h2 id="batch-preset-title">{g('batches.stepPrompt')}</h2><p className="generation-section-note">{g('batches.promptRole')}</p></div></div>
            {matchingPresets.length === 0 ? <p className="generation-empty-note">{g('batches.noPreset')}</p> : <div className="generation-choice-grid">{matchingPresets.map(item => <label key={item.id}><input type="radio" name="prompt-preset" checked={form.promptPresetId === item.id} onChange={() => setForm(current => ({ ...current, promptPresetId: item.id }))} /><span>{item.name}</span></label>)}</div>}
            <Pagination page={presetsQuery.data?.page ?? presetPage} totalPages={presetsQuery.data?.totalPages ?? 0} total={presetsQuery.data?.total ?? 0} onPageChange={setPresetPage} />
          </section>

          <section className="generation-workflow-section" aria-labelledby="batch-demographics-title">
            <h2 id="batch-demographics-title">{g('batches.stepDemographics')}</h2>
            <div className="generation-form__grid generation-form__grid--three"><div><strong>{g('batches.age')}</strong><div className="generation-choice-grid generation-choice-grid--compact">{ages.map(value => <label key={value}><input type="checkbox" checked={form.selectedAges.includes(value)} onChange={() => setForm(current => ({ ...current, selectedAges: toggleArrayValue(current.selectedAges, value) }))} /><span>{g(`demographic.age.${value}`)}</span></label>)}</div></div><div><strong>{g('batches.gender')}</strong><div className="generation-choice-grid generation-choice-grid--compact">{genders.map(value => <label key={value}><input type="checkbox" checked={form.selectedGenders.includes(value)} onChange={() => setForm(current => ({ ...current, selectedGenders: toggleArrayValue(current.selectedGenders, value) }))} /><span>{g(`demographic.gender.${value}`)}</span></label>)}</div></div><div><strong>{g('batches.ethnicity')}</strong><div className="generation-choice-grid generation-choice-grid--compact">{ethnicities.map(value => <label key={value}><input type="checkbox" checked={form.selectedEthnicities.includes(value)} onChange={() => setForm(current => ({ ...current, selectedEthnicities: toggleArrayValue(current.selectedEthnicities, value) }))} /><span>{g(`demographic.ethnicity.${value}`)}</span></label>)}</div></div></div>
            <p className="field__hint">{g('batches.demographicCount', { count: demographicCombinations(form.selectedAges, form.selectedGenders, form.selectedEthnicities).length })}</p>
          </section>

          <section className="generation-workflow-section" aria-labelledby="batch-config-title">
            <h2 id="batch-config-title">{g('batches.stepConfig')}</h2>
            <div className="generation-form__grid">
              <Field label={g('batches.model')} htmlFor="batch-model" required><select id="batch-model" value={form.model} onChange={event => { const model = event.target.value as ModelName; setForm(current => ({ ...current, model, precision: precisionForModel(model, current.precision) })); }}>{models.map(value => <option key={value} value={value}>{value}</option>)}</select></Field>
              {form.model === 'LTX-2.5' ? <Field label={g('batches.precision')} htmlFor="batch-precision" required><select id="batch-precision" value={form.precision ?? ''} onChange={event => setForm(current => ({ ...current, precision: event.target.value as ModelPrecision }))}>{ltx25Precisions.map(value => <option key={value} value={value}>{value}</option>)}</select></Field> : null}
              <Field label={g('batches.outputProfile')} htmlFor="batch-output-profile"><textarea id="batch-output-profile" value={modelSpecLabel(g, form.model)} readOnly rows={2} /></Field>
              <Field label={g('batches.quantity')} htmlFor="batch-quantity" required><input id="batch-quantity" type="number" min="1" max="10000" value={form.quantity} onChange={event => setForm(current => ({ ...current, quantity: Number(event.target.value) }))} /></Field>
              <Field label={g('batches.seed')} htmlFor="batch-seed"><input id="batch-seed" inputMode="numeric" value={form.seed} onChange={event => setForm(current => ({ ...current, seed: event.target.value }))} /></Field>
              <fieldset className="generation-form__wide generation-fieldset"><legend>{g('batches.gpu')}</legend><div className="generation-choice-grid">{(gpuQuery.data ?? []).map(item => <label key={item.slot}><input type="checkbox" checked={form.gpuSlots.includes(item.slot)} disabled={item.availability !== 'Available' && !form.gpuSlots.includes(item.slot)} onChange={() => setForm(current => ({ ...current, gpuSlots: current.gpuSlots.includes(item.slot) ? current.gpuSlots.filter(value => value !== item.slot) : current.gpuSlots.length < 2 ? [...current.gpuSlots, item.slot] : current.gpuSlots }))} /><span>{item.slot} {g(`gpu.${item.availability}`)}</span></label>)}</div></fieldset>
            </div>
          </section>

          <section className="generation-workflow-section" aria-labelledby="batch-combinations-title">
            <div className="section-header"><div><h2 id="batch-combinations-title">{g('batches.stepPreview')}</h2><p className="generation-section-note">{g('batches.combinationNote')}</p></div></div>
            {visibleCombinations.length === 0 ? <p className="generation-empty-note">{g('batches.noCombinations')}</p> : <ol className="generation-combination-list" start={(combinationPage - 1) * 20 + 1}>{visibleCombinations.map(item => <li key={`${item.content.id}-${item.background.id}`}><strong>{localizedName(locale, item.content)}</strong><span>{localizedName(locale, item.background)}</span></li>)}</ol>}
            <Pagination page={combinationPage} totalPages={combinationTotalPages} total={combinations.length} onPageChange={setCombinationPage} />
          </section>

          {validation ? <p className="field__error" role="alert">{g('batches.validation')}</p> : null}
          <div className="generation-form__actions generation-form__actions--with-status"><p className="generation-unsaved-status" role="status" aria-live="polite">{dirty ? g('batches.unsavedStatus') : ''}</p><Button onClick={() => void save()} disabled={!dirty || saveMutation.isPending}>{g('batches.saveDraft')}</Button><Button variant="primary" onClick={() => void buildPreview()} disabled={!isSavedCurrent || previewMutation.isPending}>{g('batches.preview')}</Button></div>
        </section>
        <GpuPanel />
      </div>
      {unsavedDialog}
      <Dialog open={datasetDialogOpen} title={g('batches.createDataset')} closeLabel={g('common.close')} onClose={() => setDatasetDialogOpen(false)} footer={<><Button onClick={() => setDatasetDialogOpen(false)}>{g('common.cancel')}</Button><Button type="submit" form="batch-create-dataset" variant="primary" busy={createDatasetMutation.isPending}>{g('common.create')}</Button></>}><form id="batch-create-dataset" className="generation-dialog-form" onSubmit={event => void createDataset(event)}><Field label={g('batches.datasetName')} htmlFor="batch-dataset-name" required><input id="batch-dataset-name" autoFocus value={datasetName} onChange={event => setDatasetName(event.target.value)} /></Field><Field label={g('batches.datasetNoteLabel')} htmlFor="batch-dataset-note"><textarea id="batch-dataset-note" value={datasetNote} onChange={event => setDatasetNote(event.target.value)} /></Field>{createDatasetMutation.error ? <p className="field__error" role="alert">{apiErrorMessage(createDatasetMutation.error, locale)}</p> : null}</form></Dialog>
      <Dialog open={preview !== null} title={g('batches.previewTitle')} closeLabel={g('common.close')} onClose={() => setPreview(null)} size="wide" footer={<><Button onClick={() => setPreview(null)}>{g('common.cancel')}</Button><Button variant="primary" onClick={() => setSubmitConfirmOpen(true)}>{g('batches.submit')}</Button></>}>{preview ? <><p>{g('batches.previewIntro', { count: preview.allocations.length })}</p><TableShell caption={g('batches.allocationCaption')} columns={[{ key: 'row', label: g('batches.sequence') }, { key: 'content', label: g('batches.contentName') }, { key: 'background', label: g('batches.background') }, { key: 'person', label: g('batches.allocation') }, { key: 'model', label: g('batches.model') }, { key: 'gpu', label: g('batches.gpu') }]}>{visiblePreview.map(row => <tr key={row.sequence}><th scope="row">{row.sequence}/{preview.allocations.length}</th><td>{localizedName(locale, row.contentPlan)}</td><td>{localizedName(locale, row.backgroundPreset)}</td><td>{row.demographic.age} {g(`demographic.gender.${row.demographic.gender}`)} {g(`demographic.ethnicity.${row.demographic.ethnicity}`)}</td><td>{row.model}{row.precision ? ` ${row.precision}` : ''}</td><td>{row.gpuSlot}</td></tr>)}</TableShell><Pagination page={previewPage} totalPages={previewTotalPages} total={preview.allocations.length} onPageChange={setPreviewPage} /></> : null}</Dialog>
      <ConfirmDialog open={submitConfirmOpen} title={g('batches.submitConfirmTitle')} body={preview ? g('batches.submitConfirmBody', { count: preview.allocations.length }) : g('batches.confirmBody')} confirmLabel={g('common.yes')} cancelLabel={g('common.no')} closeLabel={g('common.close')} onConfirm={() => void submit(false)} onClose={() => setSubmitConfirmOpen(false)} />
      <ConfirmDialog open={switchConfirmOpen} title={g('batches.releaseModelTitle')} body={g('batches.modelSwitchConfirmation')} confirmLabel={g('common.yes')} cancelLabel={g('common.no')} closeLabel={g('common.close')} onConfirm={() => void submit(true)} onClose={() => setSwitchConfirmOpen(false)} />
    </GenerationScaffold>
  );
}
