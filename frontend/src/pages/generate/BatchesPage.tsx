import { useEffect, useMemo, useState } from 'react';
import {
  allowedDirections,
  type BatchDraft,
  type BatchPreview,
  type Category,
  type ConflictDirection,
  type GpuSlot,
  type ModelName,
} from '../../types';
import { useMockRepository, useRepositorySnapshot } from '../../store';
import { Button, ConfirmDialog, Dialog, Field, TableShell, useToast } from '../../components';
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
  saveGenerationDraft,
  toggleArrayValue,
  useCommandEnter,
  useGenerationCopy,
  useUnsavedChanges,
} from './shared';
import { validateBatchGpuSelection } from '../../generation';

type Age = (typeof ages)[number];
type Gender = (typeof genders)[number];
type Ethnicity = (typeof ethnicities)[number];

const batchDraftStorageKey = 'conflictstudio.generation.batchDraft';

interface StoredBatchDraft {
  datasetId?: string;
  category?: Category;
  conflictDirection?: ConflictDirection | null;
  contentItemIds?: string[];
  presetId?: string;
  model?: ModelName;
  gpus?: GpuSlot[];
  quantity?: number;
  seed?: number | null;
  ages?: Age[];
  genders?: Gender[];
  ethnicities?: Ethnicity[];
}

function modelLabel(g: ReturnType<typeof useGenerationCopy>, model: ModelName) {
  return g(model === 'LTX-2.3' ? 'model.LTX-2.3' : 'model.MiniMax H3');
}

function gpuLabel(g: ReturnType<typeof useGenerationCopy>, slot: GpuSlot) {
  return g(slot === 'GPU0' ? 'gpu.GPU0' : 'gpu.GPU1');
}

function sanitizeBatchDraft(
  raw: StoredBatchDraft | null,
  activeDatasets: readonly { id: string }[],
  presets: readonly { id: string; category: Category }[],
  gpuStates: readonly { slot: GpuSlot; availability: string }[],
): BatchDraft {
  const category = raw?.category && categories.includes(raw.category) ? raw.category : 'A-VA';
  const directionCandidates = allowedDirections(category);
  const conflictDirection = raw?.conflictDirection && directionCandidates.includes(raw.conflictDirection)
    ? raw.conflictDirection
    : directionCandidates[0] ?? null;
  const datasetId = raw?.datasetId && activeDatasets.some(item => item.id === raw.datasetId) ? raw.datasetId : activeDatasets[0]?.id ?? '';
  const categoryPresets = presets.filter(item => item.category === category);
  const presetId = raw?.presetId && categoryPresets.some(item => item.id === raw.presetId) ? raw.presetId : categoryPresets[0]?.id ?? '';
  const validModel = raw?.model === 'LTX-2.3' || raw?.model === 'MiniMax H3' ? raw.model : 'LTX-2.3';
  const availableGpus = gpuStates.filter(item => item.availability === 'Available').map(item => item.slot);
  const gpus = (raw?.gpus ?? []).filter((slot, index, values) =>
    (slot === 'GPU0' || slot === 'GPU1') && values.indexOf(slot) === index && availableGpus.includes(slot),
  ).slice(0, 2);
  const rawQuantity = raw?.quantity;
  const quantity = Number.isFinite(rawQuantity) && rawQuantity !== undefined
    ? Math.max(1, Math.min(200, Number.isInteger(rawQuantity) ? rawQuantity : Math.trunc(rawQuantity)))
    : 8;
  const seed = typeof raw?.seed === 'number' ? raw.seed : null;
  const selectedAges = (raw?.ages ?? []).filter((value: unknown): value is Age => ages.includes(value as Age));
  const selectedGenders = (raw?.genders ?? []).filter((value: unknown): value is Gender => genders.includes(value as Gender));
  const selectedEthnicities = (raw?.ethnicities ?? []).filter((value: unknown): value is Ethnicity =>
    ethnicities.includes(value as Ethnicity),
  );
  return {
    datasetId,
    category,
    conflictDirection,
    contentItemIds: raw?.contentItemIds?.slice() ?? [],
    presetId,
    model: validModel,
    gpus: gpus.length > 0 ? gpus : availableGpus.slice(0, 1),
    quantity,
    seed,
    ages: selectedAges.length === 0 ? [25, 35] : selectedAges,
    genders: selectedGenders.length === 0 ? ['Male', 'Female'] : selectedGenders,
    ethnicities: selectedEthnicities.length === 0 ? ['EastAsian'] : selectedEthnicities,
  };
}

function draftsMatch(a: BatchPreview['draft'], b: BatchPreview['draft']) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function BatchesPage() {
  const g = useGenerationCopy();
  const repository = useMockRepository();
  const snapshot = useRepositorySnapshot();
  const { showToast } = useToast();
  const activeDatasets = snapshot.data.datasets.filter(item => item.status === 'Active');
  const [storedDraft] = useState(() => readGenerationDraft(batchDraftStorageKey) as StoredBatchDraft | null);
  const initialDraft = useMemo(
    () => sanitizeBatchDraft(storedDraft, activeDatasets, snapshot.data.presets, snapshot.data.gpuStates),
    [storedDraft, activeDatasets, snapshot.data.gpuStates, snapshot.data.presets],
  );
  const [datasetId, setDatasetId] = useState(() => initialDraft.datasetId);
  const [category, setCategory] = useState(() => initialDraft.category);
  const [direction, setDirection] = useState<ConflictDirection | null>(() => initialDraft.conflictDirection);
  const [contentIds, setContentIds] = useState<string[]>(() => initialDraft.contentItemIds);
  const [presetId, setPresetId] = useState(() => initialDraft.presetId);
  const [model, setModel] = useState<ModelName>(() => initialDraft.model);
  const [selectedGpus, setSelectedGpus] = useState<GpuSlot[]>(() => initialDraft.gpus);
  const [quantity, setQuantity] = useState(() => initialDraft.quantity);
  const [seed, setSeed] = useState(() => {
    const value = initialDraft.seed;
    return value === null ? '' : String(value);
  });
  const [selectedAges, setSelectedAges] = useState<Array<Age>>(() => initialDraft.ages);
  const [selectedGenders, setSelectedGenders] = useState<Array<Gender>>(() =>
    initialDraft.genders,
  );
  const [selectedEthnicities, setSelectedEthnicities] = useState<Array<Ethnicity>>(() =>
    initialDraft.ethnicities,
  );
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [failure, setFailure] = useState<null | 'Conflict' | 'NotFound' | 'InvalidInput' | 'Unavailable'>(null);
  const [validation, setValidation] = useState(false);
  const [gpuValidation, setGpuValidation] = useState(false);
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [showReleaseConfirm, setShowReleaseConfirm] = useState(false);
  const [savedDraft, setSavedDraft] = useState<BatchDraft>(() => initialDraft);
  const directions = allowedDirections(category);
  const draft = useMemo(() => ({
    datasetId,
    category,
    conflictDirection: direction,
    contentItemIds: contentIds,
    presetId,
    model,
    gpus: selectedGpus,
    quantity,
    seed: parseSeed(seed),
    ages: selectedAges,
    genders: selectedGenders,
    ethnicities: selectedEthnicities,
  }), [datasetId, category, direction, contentIds, presetId, model, selectedGpus, quantity, seed, selectedAges, selectedGenders, selectedEthnicities]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const matchingContent = useMemo(
    () => snapshot.data.contentItems.filter(item =>
      item.status === 'Active' && item.category === category && item.conflictDirection === direction,
    ),
    [category, direction, snapshot.data.contentItems],
  );
  const matchingPresets = useMemo(
    () => snapshot.data.presets.filter(item => item.category === category),
    [category, snapshot.data.presets],
  );
  const isPreviewCurrent = preview ? draftsMatch(preview.draft, draft) : false;
  const gpuSelectionError = validateBatchGpuSelection(selectedGpus, snapshot.data.gpuStates);

  const selectedGpuStates = selectedGpus.map(slot => snapshot.data.gpuStates.find(item => item.slot === slot)).filter(Boolean);
  const isBlockedGpuState = (item: (typeof snapshot.data.gpuStates)[number]) => item.availability !== 'Available';
  const needsModelRelease = (item: (typeof snapshot.data.gpuStates)[number] | undefined, nextModel: ModelName) => {
    if (!item) return false;
    if (!item.loadedModel || item.loadedModel === nextModel) return false;
    return item.availability === 'Available';
  };

  const changeCategory = (nextCategory: Category) => {
    setCategory(nextCategory);
    const nextDirection = allowedDirections(nextCategory)[0] ?? null;
    setDirection(nextDirection);
    setContentIds([]);
    setPresetId(snapshot.data.presets.find(item => item.category === nextCategory)?.id ?? '');
  };

  useEffect(() => {
    setContentIds(current => current.filter(id => matchingContent.some(item => item.id === id)));
  }, [matchingContent]);

  useEffect(() => {
    if (preview && !draftsMatch(preview.draft, draft)) setPreview(null);
  }, [draft, preview]);

  useUnsavedChanges(dirty);

  const saveDraft = () => {
    if (gpuSelectionError) {
      setGpuValidation(gpuSelectionError !== 'Unavailable');
      setFailure(gpuSelectionError === 'Unavailable' ? 'Unavailable' : null);
      return;
    }
    saveGenerationDraft(batchDraftStorageKey, draft);
    setSavedDraft(draft);
    setGpuValidation(false);
    setFailure(null);
    showToast(g('batches.draftSaved'));
  };

  const toggleGpu = (slot: GpuSlot) => {
    const state = snapshot.data.gpuStates.find(item => item.slot === slot);
    if (!state || state.availability !== 'Available') return;
    setSelectedGpus(current => current.includes(slot)
      ? current.filter(item => item !== slot)
      : current.length < 2
        ? [...current, slot]
        : current,
    );
  };

  const selectAllContent = () => {
    const allIds = matchingContent.map(item => item.id);
    const allSelected = allIds.length > 0 && allIds.every(id => contentIds.includes(id));
    setContentIds(allSelected ? [] : allIds);
  };

  const buildPreview = () => {
    const gpuError = gpuSelectionError;
    if (gpuError) {
      setFailure(gpuError === 'Unavailable' ? 'Unavailable' : null);
      setGpuValidation(gpuError !== 'Unavailable');
      setValidation(false);
      setPreview(null);
      return;
    }
    const result = repository.previewBatch(draft);
    if (!result.ok) {
      setValidation(result.kind === 'InvalidInput');
      setFailure(result.kind === 'InvalidInput' ? null : result.kind);
      return;
    }
    setValidation(false);
    setGpuValidation(false);
    setFailure(null);
    setPreview(result.value);
  };

  const submit = () => {
    if (!preview || !isPreviewCurrent) {
      setPreview(null);
      return;
    }
    if (validateBatchGpuSelection(preview.draft.gpus, snapshot.data.gpuStates)) {
      setFailure('Unavailable');
      setPreview(null);
      return;
    }
    if (preview.draft.gpus.some(slot => needsModelRelease(
      snapshot.data.gpuStates.find(item => item.slot === slot),
      preview.draft.model,
    ))) {
      setShowReleaseConfirm(true);
      return;
    }
    setShowSubmitConfirm(true);
  };

  const confirmRelease = () => {
    if (!preview) {
      setShowReleaseConfirm(false);
      return;
    }
    const switchTargets = preview.draft.gpus
      .map(slot => snapshot.data.gpuStates.find(item => item.slot === slot))
      .filter(item => item && needsModelRelease(item, preview.draft.model));
    if (switchTargets.length === 0 || switchTargets.some(item => !item || isBlockedGpuState(item))) {
      setShowReleaseConfirm(false);
      return;
    }
    setShowReleaseConfirm(false);
    setShowSubmitConfirm(true);
  };

  const confirmSubmit = () => {
    if (!preview || !isPreviewCurrent) {
      setShowSubmitConfirm(false);
      setPreview(null);
      return;
    }
    const result = repository.submitBatch(preview);
    setShowSubmitConfirm(false);
    if (!result.ok) {
      setPreview(null);
      setFailure(result.kind);
      return;
    }
    setPreview(null);
    setFailure(null);
    showToast(g('batches.success'));
  };

  const currentGpuReleaseTargets = selectedGpuStates.filter(item => item && needsModelRelease(item, model));
  const submitConfirmBody = preview
    ? g('batches.submitConfirmBody', { count: preview.allocations.length })
    : g('batches.confirmBody');
  const releaseModelSwitchBody = currentGpuReleaseTargets.length > 0
    ? currentGpuReleaseTargets.map(item => g('batches.releaseModelBody', {
      gpu: gpuLabel(g, item!.slot),
      currentModel: modelLabel(g, item!.loadedModel!),
      nextModel: modelLabel(g, model),
    })).join(' ')
    : g('batches.noLoadedModel');

  useCommandEnter(() => {
    if (isPreviewCurrent) submit();
  });

  return (
    <GenerationScaffold title={'batches.title'} subtitle={'batches.subtitle'}>
      {failure ? <OperationFeedback kind={failure} onDismiss={() => setFailure(null)} /> : null}
      <div className="generation-layout">
        <section className="panel generation-form" aria-label={g('batches.formRegion')}>
          <div className="section-header"><h2>{g('batches.setup')}</h2></div>
          <div className="generation-form__grid">
            <Field label={g('batches.dataset')} htmlFor="batch-dataset" required>
              <select id="batch-dataset" value={datasetId} onChange={event => setDatasetId(event.target.value)}>
                {activeDatasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
              </select>
            </Field>
            <Field label={g('batches.category')} htmlFor="batch-category" required>
              <select id="batch-category" value={category} onChange={event => changeCategory(event.target.value as Category)}>
                {categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}
              </select>
            </Field>
            <Field label={g('batches.direction')} htmlFor="batch-direction" required={directions.length > 0}>
              <select
                id="batch-direction"
                value={direction ?? ''}
                disabled={directions.length === 0}
                onChange={event => setDirection((event.target.value || null) as ConflictDirection | null)}
              >
                {directions.length === 0 ? <option value="">{g('common.none')}</option> : null}
                {directions.map(value => <option key={value} value={value}>{directionLabel(g, value)}</option>)}
              </select>
            </Field>
            <Field label={g('batches.preset')} htmlFor="batch-preset" required>
              <select id="batch-preset" value={presetId} onChange={event => setPresetId(event.target.value)}>
                {matchingPresets.length === 0 ? <option value="">{g('batches.noPreset')}</option> : null}
                {matchingPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
            </Field>
            <Field label={g('batches.model')} htmlFor="batch-model" required>
              <select id="batch-model" value={model} onChange={event => setModel(event.target.value as ModelName)}>
                {models.map(value => <option key={value} value={value}>{modelLabel(g, value)}</option>)}
              </select>
            </Field>
            <Field label={g('batches.outputProfile')} htmlFor="batch-output-profile">
              <input id="batch-output-profile" value={modelSpecLabel(g, model)} readOnly />
            </Field>
            <fieldset className="generation-fieldset" aria-describedby="batch-gpu-hint">
              <legend>{g('batches.gpu')}</legend>
              <p id="batch-gpu-hint" className="field__hint">{g('batches.gpuHint')}</p>
              <div className="generation-choice-grid">
                {snapshot.data.gpuStates.map(item => (
                  <label key={item.slot}>
                    <input
                      type="checkbox"
                      checked={selectedGpus.includes(item.slot)}
                      disabled={isBlockedGpuState(item)}
                      onChange={() => toggleGpu(item.slot)}
                    />
                    <span>{gpuLabel(g, item.slot)} / {g(`gpu.${item.availability}`)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label={g('batches.quantity')} htmlFor="batch-quantity" required>
              <input id="batch-quantity" type="number" min="1" max="200" value={quantity} onChange={event => setQuantity(Number(event.target.value))} />
            </Field>
            <Field label={g('batches.seed')} htmlFor="batch-seed">
              <input id="batch-seed" inputMode="numeric" value={seed} onChange={event => setSeed(event.target.value)} placeholder={g('batches.seedPlaceholder')} />
            </Field>
            <fieldset className="generation-form__wide generation-fieldset" aria-describedby="batch-content-hint">
              <legend>{g('batches.content')}</legend>
              <div className="generation-fieldset__toolbar">
                {matchingContent.length > 0 ? (
                  <Button variant="quiet" onClick={selectAllContent}>
                    {g(matchingContent.every(item => contentIds.includes(item.id)) ? 'batches.clearAll' : 'batches.selectAll')}
                  </Button>
                ) : null}
              </div>
              <p id="batch-content-hint" className="field__hint">{g('batches.contentHint')}</p>
              {matchingContent.length === 0 ? <p className="generation-empty-note">{g('batches.noContent')}</p> : (
                <div className="generation-choice-grid">
                  {matchingContent.map(item => (
                    <label key={item.id}>
                      <input type="checkbox" checked={contentIds.includes(item.id)} onChange={() => setContentIds(toggleArrayValue(contentIds, item.id))} />
                      <span>{item.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          </div>
          <fieldset className="generation-form__wide">
            <legend>{g('batches.demographics')}</legend>
            <div className="generation-form__grid generation-form__grid--three">
              <div>
                <strong>{g('batches.age')}</strong>
                <div className="generation-choice-grid generation-choice-grid--compact">
                  {ages.map(value => <label key={value}><input type="checkbox" checked={selectedAges.includes(value)} onChange={() => setSelectedAges(toggleArrayValue(selectedAges, value))} /><span>{g(`demographic.age.${value}`)}</span></label>)}
                </div>
              </div>
              <div>
                <strong>{g('batches.gender')}</strong>
                <div className="generation-choice-grid generation-choice-grid--compact">
                  {genders.map(value => <label key={value}><input type="checkbox" checked={selectedGenders.includes(value)} onChange={() => setSelectedGenders(toggleArrayValue(selectedGenders, value))} /><span>{g(`demographic.gender.${value}`)}</span></label>)}
                </div>
              </div>
              <div>
                <strong>{g('batches.ethnicity')}</strong>
                <div className="generation-choice-grid generation-choice-grid--compact">
                  {ethnicities.map(value => <label key={value}><input type="checkbox" checked={selectedEthnicities.includes(value)} onChange={() => setSelectedEthnicities(toggleArrayValue(selectedEthnicities, value))} /><span>{g(`demographic.ethnicity.${value}`)}</span></label>)}
                </div>
              </div>
            </div>
          </fieldset>
          {validation ? <p className="field__error" role="alert">{g('batches.validation')}</p> : null}
          {gpuValidation ? <p className="field__error" role="alert">{g('batches.gpuValidation')}</p> : null}
          <div className="generation-form__actions">
            <Button onClick={saveDraft} disabled={!dirty || gpuSelectionError === 'Unavailable'}>{g('batches.saveDraft')}</Button>
            <Button
              variant="primary"
              onClick={buildPreview}
              disabled={dirty}
              title={dirty ? g('batches.saveBeforePreview') : undefined}
            >
              {g('batches.preview')}
            </Button>
          </div>
          <p className="generation-shortcut-hint">{g('batches.submitShortcut')}</p>
        </section>
        <GpuPanel />
      </div>
      <Dialog
        open={preview !== null}
        title={g('batches.previewTitle')}
        closeLabel={g('common.close')}
        onClose={() => setPreview(null)}
        size="wide"
        footer={<><Button onClick={() => setPreview(null)}>{g('common.cancel')}</Button><Button variant="primary" onClick={submit}>{g('batches.submit')}</Button></>}
      >
        {preview ? (
          <>
            <p className="generation-preview-summary">{g('batches.previewIntro', { count: preview.allocations.length })}</p>
            <p className="generation-preview-summary">
              {g(preview.draft.gpus.length === 2 ? 'batches.dynamicGpuTwo' : 'batches.dynamicGpuOne', {
                gpus: preview.draft.gpus.map(slot => gpuLabel(g, slot)).join(', '),
                model: modelLabel(g, preview.draft.model),
              })}
            </p>
            <TableShell
              caption={g('batches.allocationCaption')}
              columns={[
                { key: 'row', label: g('batches.sequence') },
                { key: 'content', label: g('batches.contentName') },
                { key: 'category', label: g('batches.category') },
                { key: 'allocation', label: g('batches.allocation') },
                { key: 'model', label: g('batches.model') },
              ]}
            >
              {preview.allocations.map(row => (
                <tr key={row.sequence}>
                  <th scope="row">{row.sequence}</th>
                  <td>{row.contentItemName}</td>
                  <td>{categoryLabel(g, row.category)}</td>
                  <td>{g(`demographic.age.${row.age}`)} / {g(`demographic.gender.${row.gender}`)} / {g(`demographic.ethnicity.${row.ethnicity}`)}</td>
                  <td>{modelLabel(g, row.model)}</td>
                </tr>
              ))}
            </TableShell>
            <p className="generation-preview-summary">{g('batches.confirmBody')}</p>
          </>
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={showReleaseConfirm}
        title={g('batches.releaseModelTitle')}
        body={releaseModelSwitchBody}
        confirmLabel={g('common.yes')}
        cancelLabel={g('common.no')}
        closeLabel={g('common.close')}
        onConfirm={confirmRelease}
        onClose={() => setShowReleaseConfirm(false)}
      />
      <ConfirmDialog
        open={showSubmitConfirm}
        title={g('batches.submitConfirmTitle')}
        body={submitConfirmBody}
        confirmLabel={g('common.yes')}
        cancelLabel={g('common.no')}
        closeLabel={g('common.close')}
        onConfirm={confirmSubmit}
        onClose={() => setShowSubmitConfirm(false)}
      />
    </GenerationScaffold>
  );
}
