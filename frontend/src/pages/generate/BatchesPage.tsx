import { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, Dialog, Field, TableShell, useToast } from '../../components';
import {
  useBackgroundPresetsQuery,
  useBatchDraftsQuery,
  useContentPlansQuery,
  useDatasetsQuery,
  useGpuSlotsQuery,
  usePreviewBatchMutation,
  usePromptPresetsQuery,
  useSaveBatchDraftMutation,
  useSubmitBatchMutation,
} from '../../api/queries';
import { isModelSwitchConfirmationRequired } from '../../api/client';
import type {
  Age,
  BatchDraft,
  BatchDraftCreate,
  BatchPreview,
  Demographic,
  Ethnicity,
  Gender,
  GpuSlotName,
} from '../../api/contracts';
import { allowedDirections, type Category, type ConflictDirection, type ModelName } from '../../types';
import {
  ages,
  categories,
  categoryLabel,
  directionLabel,
  ethnicities,
  genders,
  GenerationScaffold,
  GpuPanel,
  modelSpecLabel,
  models,
  OperationFeedback,
  parseSeed,
  readGenerationDraft,
  toggleArrayValue,
  useGenerationCopy,
  useGenerationDraft,
  useUnsavedChanges,
} from './shared';

interface BatchForm {
  datasetId: number | null;
  category: Category;
  conflictDirection: ConflictDirection | null;
  model: ModelName;
  quantity: number;
  seed: string;
  contentPlanIds: number[];
  promptPresetIds: number[];
  backgroundPresetIds: number[];
  selectedAges: Age[];
  selectedGenders: Gender[];
  selectedEthnicities: Ethnicity[];
  gpuSlots: GpuSlotName[];
}

export function demographicCombinations(
  selectedAges: readonly Age[],
  selectedGenders: readonly Gender[],
  selectedEthnicities: readonly Ethnicity[],
): Demographic[] {
  return selectedAges.flatMap(age => selectedGenders.flatMap(gender =>
    selectedEthnicities.map(ethnicity => ({ age, gender, ethnicity })),
  ));
}

function emptyBatchForm(): BatchForm {
  return {
    datasetId: null,
    category: 'A-VA',
    conflictDirection: null,
    model: 'LTX-2.3',
    quantity: 8,
    seed: '',
    contentPlanIds: [],
    promptPresetIds: [],
    backgroundPresetIds: [],
    selectedAges: [25],
    selectedGenders: ['Female'],
    selectedEthnicities: ['EastAsian'],
    gpuSlots: [],
  };
}

function formFromDraft(value: BatchDraft): BatchForm {
  return {
    datasetId: value.datasetId,
    category: value.category,
    conflictDirection: value.conflictDirection,
    model: value.model,
    quantity: value.quantity,
    seed: String(value.seed),
    contentPlanIds: value.contentPlans.map(item => item.id),
    promptPresetIds: value.promptPresets.map(item => item.id),
    backgroundPresetIds: value.backgroundPresets.map(item => item.id),
    selectedAges: [...new Set(value.demographics.map(item => item.age))],
    selectedGenders: [...new Set(value.demographics.map(item => item.gender))],
    selectedEthnicities: [...new Set(value.demographics.map(item => item.ethnicity))],
    gpuSlots: value.gpuSlots,
  };
}

export function batchFormIsValid(form: BatchForm): boolean {
  const seed = parseSeed(form.seed);
  return Boolean(
    form.datasetId
    && form.quantity > 0
    && form.quantity <= 10_000
    && (seed === null || (Number.isInteger(seed) && seed >= 0 && seed < 2 ** 31))
    && form.contentPlanIds.length > 0
    && form.promptPresetIds.length > 0
    && form.backgroundPresetIds.length > 0
    && form.selectedAges.length > 0
    && form.selectedGenders.length > 0
    && form.selectedEthnicities.length > 0
    && form.gpuSlots.length >= 1
    && form.gpuSlots.length <= 2,
  );
}

export function BatchesPage() {
  const g = useGenerationCopy();
  const { showToast } = useToast();
  const datasetsQuery = useDatasetsQuery();
  const contentQuery = useContentPlansQuery();
  const presetsQuery = usePromptPresetsQuery();
  const backgroundsQuery = useBackgroundPresetsQuery();
  const draftsQuery = useBatchDraftsQuery();
  const gpuQuery = useGpuSlotsQuery();
  const saveMutation = useSaveBatchDraftMutation();
  const previewMutation = usePreviewBatchMutation();
  const submitMutation = useSubmitBatchMutation();
  const stored = useState(() => readGenerationDraft<{ selectedId: number | null; form: BatchForm }>('batch-form'))[0];
  const [selectedId, setSelectedId] = useState<number | null>(stored?.selectedId ?? null);
  const [form, setForm] = useState<BatchForm>(stored?.form ?? emptyBatchForm());
  const [baseline, setBaseline] = useState<BatchForm | null>(null);
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [validation, setValidation] = useState(false);
  const [submitConfirmOpen, setSubmitConfirmOpen] = useState(false);
  const [switchConfirmOpen, setSwitchConfirmOpen] = useState(false);
  const savedDraft = (draftsQuery.data ?? []).find(item => item.id === selectedId) ?? null;
  const queries = [datasetsQuery, contentQuery, presetsQuery, backgroundsQuery, draftsQuery, gpuQuery];
  const queryError = queries.find(query => query.isError)?.error ?? null;
  const mutationError = saveMutation.error ?? previewMutation.error ?? submitMutation.error ?? null;

  useEffect(() => {
    if (stored || queries.some(query => query.isPending)) return;
    const defaults = emptyBatchForm();
    defaults.datasetId = datasetsQuery.data?.find(item => item.status === 'Active')?.id ?? null;
    defaults.gpuSlots = (gpuQuery.data ?? []).filter(item => item.availability === 'Available').slice(0, 1).map(item => item.slot);
    setForm(defaults);
    setBaseline(defaults);
  }, [datasetsQuery.data, gpuQuery.data, stored]);

  const matchingContent = useMemo(() => (contentQuery.data ?? []).filter(item =>
    item.status === 'Active' && item.category === form.category && item.conflictDirection === form.conflictDirection,
  ), [contentQuery.data, form.category, form.conflictDirection]);
  const matchingPresets = useMemo(() => (presetsQuery.data ?? []).filter(item =>
    item.status === 'Active' && item.category === form.category,
  ), [form.category, presetsQuery.data]);
  const activeBackgrounds = (backgroundsQuery.data ?? []).filter(item => item.status === 'Active');
  const dirty = baseline === null || JSON.stringify(form) !== JSON.stringify(baseline);
  const isSavedCurrent = savedDraft !== null && !dirty;

  const selectDraft = (value: string) => {
    const id = value === 'new' ? null : Number(value);
    const selected = (draftsQuery.data ?? []).find(item => item.id === id) ?? null;
    const next = selected ? formFromDraft(selected) : emptyBatchForm();
    if (!selected) {
      next.datasetId = datasetsQuery.data?.find(item => item.status === 'Active')?.id ?? null;
      next.gpuSlots = (gpuQuery.data ?? []).filter(item => item.availability === 'Available').slice(0, 1).map(item => item.slot);
    }
    setSelectedId(id);
    setForm(next);
    setBaseline(selected ? next : null);
    setPreview(null);
    setValidation(false);
  };

  const changeCategory = (category: Category) => {
    setForm(current => ({
      ...current,
      category,
      conflictDirection: allowedDirections(category)[0] ?? null,
      contentPlanIds: [],
      promptPresetIds: [],
    }));
    setPreview(null);
  };

  const payload = (): BatchDraftCreate | null => {
    if (!batchFormIsValid(form) || form.datasetId === null) return null;
    const contentById = new Map((contentQuery.data ?? []).map(item => [item.id, item]));
    const presetById = new Map((presetsQuery.data ?? []).map(item => [item.id, item]));
    const backgroundById = new Map((backgroundsQuery.data ?? []).map(item => [item.id, item]));
    const selectedContent = form.contentPlanIds.flatMap(id => contentById.get(id) ?? []);
    const selectedPresets = form.promptPresetIds.flatMap(id => presetById.get(id) ?? []);
    const selectedBackgrounds = form.backgroundPresetIds.flatMap(id => backgroundById.get(id) ?? []);
    if (selectedContent.length !== form.contentPlanIds.length || selectedPresets.length !== form.promptPresetIds.length || selectedBackgrounds.length !== form.backgroundPresetIds.length) return null;
    return {
      datasetId: form.datasetId,
      category: form.category,
      conflictDirection: form.conflictDirection,
      model: form.model,
      quantity: form.quantity,
      seed: parseSeed(form.seed),
      contentPlans: selectedContent.map(item => ({ id: item.id, expectedRevision: item.revision })),
      promptPresets: selectedPresets.map(item => ({ id: item.id, expectedRevision: item.revision })),
      backgroundPresets: selectedBackgrounds.map(item => ({ id: item.id, expectedRevision: item.revision })),
      demographics: demographicCombinations(form.selectedAges, form.selectedGenders, form.selectedEthnicities),
      gpuSlots: form.gpuSlots,
    };
  };

  const save = async () => {
    const value = payload();
    if (!value) {
      setValidation(true);
      return;
    }
    setValidation(false);
    try {
      const saved = await saveMutation.mutateAsync({
        id: savedDraft?.id ?? null,
        input: savedDraft ? { ...value, expectedRevision: savedDraft.revision } : value,
      });
      const next = formFromDraft(saved);
      setSelectedId(saved.id);
      setForm(next);
      setBaseline(next);
      setPreview(null);
      showToast(g('batches.draftSaved'));
    } catch {
      // The shared safe error panel renders mutation errors.
    }
  };

  const buildPreview = async () => {
    if (!savedDraft || dirty) return;
    try {
      setPreview(await previewMutation.mutateAsync({ id: savedDraft.id, expectedRevision: savedDraft.revision }));
    } catch {
      setPreview(null);
    }
  };

  const submit = async (confirmModelSwitch: boolean) => {
    if (!savedDraft || !preview) return;
    setSubmitConfirmOpen(false);
    setSwitchConfirmOpen(false);
    try {
      await submitMutation.mutateAsync({
        id: savedDraft.id,
        expectedRevision: preview.expectedRevision,
        expectedGpuRevisions: preview.gpuRevisions,
        confirmModelSwitch,
      });
      setPreview(null);
      showToast(g('batches.success'));
    } catch (error) {
      if (!confirmModelSwitch && isModelSwitchConfirmationRequired(error)) setSwitchConfirmOpen(true);
    }
  };

  useGenerationDraft('batch-form', { selectedId, form }, dirty);
  const unsavedDialog = useUnsavedChanges(dirty);

  if (queries.some(query => query.isPending)) return <GenerationScaffold title="batches.title" subtitle="batches.subtitle"><p role="status">{g('state.loadingBody')}</p></GenerationScaffold>;
  if (queryError) return <GenerationScaffold title="batches.title" subtitle="batches.subtitle"><OperationFeedback error={queryError} onDismiss={() => void Promise.all(queries.map(query => query.refetch()))} /></GenerationScaffold>;

  const directions = allowedDirections(form.category);
  return (
    <GenerationScaffold title="batches.title" subtitle="batches.subtitle">
      {mutationError && !switchConfirmOpen ? <OperationFeedback error={mutationError} onDismiss={() => { saveMutation.reset(); previewMutation.reset(); submitMutation.reset(); }} /> : null}
      <div className="generation-layout">
        <section className="panel generation-form" aria-label={g('batches.formRegion')}>
          <div className="section-header"><h2>{g('batches.setup')}</h2></div>
          <div className="generation-form__grid">
            <Field label={g('batches.savedDraft')} htmlFor="batch-saved-draft"><select id="batch-saved-draft" value={selectedId ?? 'new'} onChange={event => selectDraft(event.target.value)}><option value="new">{g('batches.newDraft')}</option>{(draftsQuery.data ?? []).filter(item => item.status === 'Draft').map(item => <option key={item.id} value={item.id}>{item.category} / #{item.id}</option>)}</select></Field>
            <Field label={g('batches.dataset')} htmlFor="batch-dataset" required><select id="batch-dataset" value={form.datasetId ?? ''} onChange={event => setForm(current => ({ ...current, datasetId: Number(event.target.value) }))}>{(datasetsQuery.data ?? []).filter(item => item.status === 'Active').map(item => <option key={item.id} value={item.id}>{item.name} / {item.purpose}</option>)}</select></Field>
            <Field label={g('batches.category')} htmlFor="batch-category" required><select id="batch-category" value={form.category} onChange={event => changeCategory(event.target.value as Category)}>{categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}</select></Field>
            <Field label={g('batches.direction')} htmlFor="batch-direction" required={directions.length > 0}><select id="batch-direction" value={form.conflictDirection ?? ''} disabled={directions.length === 0} onChange={event => setForm(current => ({ ...current, conflictDirection: (event.target.value || null) as ConflictDirection | null, contentPlanIds: [] }))}>{directions.length === 0 ? <option value="">{g('common.none')}</option> : null}{directions.map(value => <option key={value} value={value}>{directionLabel(g, value)}</option>)}</select></Field>
            <Field label={g('batches.model')} htmlFor="batch-model" required><select id="batch-model" value={form.model} onChange={event => setForm(current => ({ ...current, model: event.target.value as ModelName }))}>{models.map(value => <option key={value} value={value}>{g(`model.${value}`)}</option>)}</select></Field>
            <Field label={g('batches.outputProfile')} htmlFor="batch-output-profile"><textarea id="batch-output-profile" value={modelSpecLabel(g, form.model)} readOnly rows={2} /></Field>
            <Field label={g('batches.quantity')} htmlFor="batch-quantity" required><input id="batch-quantity" type="number" min="1" max="10000" value={form.quantity} onChange={event => setForm(current => ({ ...current, quantity: Number(event.target.value) }))} /></Field>
            <Field label={g('batches.seed')} htmlFor="batch-seed"><input id="batch-seed" inputMode="numeric" value={form.seed} onChange={event => setForm(current => ({ ...current, seed: event.target.value }))} /></Field>
            <fieldset className="generation-form__wide generation-fieldset"><legend>{g('batches.gpu')}</legend><div className="generation-choice-grid">{(gpuQuery.data ?? []).map(item => <label key={item.slot}><input type="checkbox" checked={form.gpuSlots.includes(item.slot)} disabled={item.availability !== 'Available' && !form.gpuSlots.includes(item.slot)} onChange={() => setForm(current => ({ ...current, gpuSlots: current.gpuSlots.includes(item.slot) ? current.gpuSlots.filter(value => value !== item.slot) : current.gpuSlots.length < 2 ? [...current.gpuSlots, item.slot] : current.gpuSlots }))} /><span>{item.slot} / {g(`gpu.${item.availability}`)}</span></label>)}</div></fieldset>
            <fieldset className="generation-form__wide generation-fieldset"><legend>{g('batches.content')}</legend><div className="generation-choice-grid">{matchingContent.map(item => <label key={item.id}><input type="checkbox" checked={form.contentPlanIds.includes(item.id)} onChange={() => setForm(current => ({ ...current, contentPlanIds: toggleArrayValue(current.contentPlanIds, item.id) }))} /><span>{item.name}</span></label>)}</div></fieldset>
            <fieldset className="generation-form__wide generation-fieldset"><legend>{g('batches.presets')}</legend><div className="generation-choice-grid">{matchingPresets.map(item => <label key={item.id}><input type="checkbox" checked={form.promptPresetIds.includes(item.id)} onChange={() => setForm(current => ({ ...current, promptPresetIds: toggleArrayValue(current.promptPresetIds, item.id) }))} /><span>{item.name}</span></label>)}</div></fieldset>
            <fieldset className="generation-form__wide generation-fieldset"><legend>{g('batches.backgrounds')}</legend><div className="generation-choice-grid">{activeBackgrounds.map(item => <label key={item.id}><input type="checkbox" checked={form.backgroundPresetIds.includes(item.id)} onChange={() => setForm(current => ({ ...current, backgroundPresetIds: toggleArrayValue(current.backgroundPresetIds, item.id) }))} /><span>{item.name}</span></label>)}</div></fieldset>
          </div>
          <fieldset className="generation-form__wide"><legend>{g('batches.demographics')}</legend><div className="generation-form__grid generation-form__grid--three"><div><strong>{g('batches.age')}</strong><div className="generation-choice-grid generation-choice-grid--compact">{ages.map(value => <label key={value}><input type="checkbox" checked={form.selectedAges.includes(value)} onChange={() => setForm(current => ({ ...current, selectedAges: toggleArrayValue(current.selectedAges, value) }))} /><span>{g(`demographic.age.${value}`)}</span></label>)}</div></div><div><strong>{g('batches.gender')}</strong><div className="generation-choice-grid generation-choice-grid--compact">{genders.map(value => <label key={value}><input type="checkbox" checked={form.selectedGenders.includes(value)} onChange={() => setForm(current => ({ ...current, selectedGenders: toggleArrayValue(current.selectedGenders, value) }))} /><span>{g(`demographic.gender.${value}`)}</span></label>)}</div></div><div><strong>{g('batches.ethnicity')}</strong><div className="generation-choice-grid generation-choice-grid--compact">{ethnicities.map(value => <label key={value}><input type="checkbox" checked={form.selectedEthnicities.includes(value)} onChange={() => setForm(current => ({ ...current, selectedEthnicities: toggleArrayValue(current.selectedEthnicities, value) }))} /><span>{g(`demographic.ethnicity.${value}`)}</span></label>)}</div></div></div><p className="field__hint">{g('batches.demographicCount', { count: demographicCombinations(form.selectedAges, form.selectedGenders, form.selectedEthnicities).length })}</p></fieldset>
          {validation ? <p className="field__error" role="alert">{g('batches.validation')}</p> : null}
          <div className="generation-form__actions"><Button onClick={() => void save()} disabled={!dirty || saveMutation.isPending}>{g('batches.saveDraft')}</Button><Button variant="primary" onClick={() => void buildPreview()} disabled={!isSavedCurrent || previewMutation.isPending}>{g('batches.preview')}</Button></div>
        </section>
        <GpuPanel />
      </div>
      {unsavedDialog}
      <Dialog open={preview !== null} title={g('batches.previewTitle')} closeLabel={g('common.close')} onClose={() => setPreview(null)} size="wide" footer={<><Button onClick={() => setPreview(null)}>{g('common.cancel')}</Button><Button variant="primary" onClick={() => setSubmitConfirmOpen(true)}>{g('batches.submit')}</Button></>}>
        {preview ? <><p>{g('batches.previewIntro', { count: preview.allocations.length })}</p><TableShell caption={g('batches.allocationCaption')} columns={[{ key: 'row', label: g('batches.sequence') }, { key: 'content', label: g('batches.contentName') }, { key: 'preset', label: g('batches.preset') }, { key: 'background', label: g('batches.background') }, { key: 'person', label: g('batches.allocation') }, { key: 'gpu', label: g('batches.gpu') }, { key: 'prompt', label: g('promptPreview.title') }]}>{preview.allocations.map(row => <tr key={row.sequence}><th scope="row">{row.sequence}/{preview.allocations.length}</th><td>{row.contentPlan.name}</td><td>{row.promptPreset.name}</td><td>{row.backgroundPreset.name}</td><td>{row.demographic.age} / {row.demographic.gender} / {row.demographic.ethnicity}</td><td>{row.gpuSlot}</td><td><details><summary>{g('promptPreview.title')}</summary><pre>{row.finalPositivePrompt ?? row.userInput}</pre><pre>{row.finalNegativePrompt}</pre></details></td></tr>)}</TableShell></> : null}
      </Dialog>
      <ConfirmDialog open={submitConfirmOpen} title={g('batches.submitConfirmTitle')} body={preview ? g('batches.submitConfirmBody', { count: preview.allocations.length }) : g('batches.confirmBody')} confirmLabel={g('common.yes')} cancelLabel={g('common.no')} closeLabel={g('common.close')} onConfirm={() => void submit(false)} onClose={() => setSubmitConfirmOpen(false)} />
      <ConfirmDialog open={switchConfirmOpen} title={g('batches.releaseModelTitle')} body={g('batches.modelSwitchConfirmation')} confirmLabel={g('common.yes')} cancelLabel={g('common.no')} closeLabel={g('common.close')} onConfirm={() => void submit(true)} onClose={() => setSwitchConfirmOpen(false)} />
    </GenerationScaffold>
  );
}
