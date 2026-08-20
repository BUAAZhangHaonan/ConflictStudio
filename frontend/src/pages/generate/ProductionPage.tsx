import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Button, ConfirmDialog, Field, Pagination, TableShell } from '../../components';
import {
  generationQueries,
  useDatasetQuery,
  useDatasetsQuery,
  useGpuSlotsQuery,
  usePreviewBatchMutation,
  usePromptTemplatesQuery,
  usePromptTemplateVersionQuery,
  usePromptTemplateVersionsQuery,
  useSaveBatchDraftMutation,
  useSubmitBatchMutation,
  useContentScriptsQuery,
} from '../../api/queries';
import { isModelSwitchConfirmationRequired } from '../../api/client';
import type {
  AssistantFormState,
  BatchDraft,
  GpuSlotName,
} from '../../api/contracts';
import { defaultGenerationProfile, ltx25Precisions, models, precisionForModel } from '../../generationProfile';
import { allowedDirections, type Category, type ConflictDirection, type ModelName, type ModelPrecision } from '../../types';
import { formatCompactDateTime } from '../../time';
import { AssistantPanel } from './AssistantPanel';
import {
  ages,
  categories,
  categoryLabel,
  directionLabel,
  ethnicities,
  genders,
  GenerationScaffold,
  GpuPanel,
  localizedName,
  OperationFeedback,
  parseSeeds,
  RelationshipGuide,
  toggleValue,
  useGenerationCopy,
  useDebouncedValue,
  useGenerationLocale,
  useUnsavedChanges,
} from './shared';
import type { GenerationKey } from '../../locales/features/generation';
import {
  buildBatchDraftRequest,
  demographics,
  type ProductionForm,
  type SelectedContent,
} from './formalGeneration';

function defaultName(category: Category): string {
  return category + '-' + formatCompactDateTime(new Date());
}

function emptyForm(): ProductionForm {
  return {
    targetDatasetId: null,
    displayName: defaultName('A-VA'),
    category: 'A-VA',
    conflictDirection: null,
    promptTemplateId: null,
    promptTemplateVersionId: null,
    selectedContent: [],
    selectedAges: [...ages],
    selectedGenders: [...genders],
    selectedEthnicities: [...ethnicities],
    seeds: '1',
    model: defaultGenerationProfile.model,
    precision: defaultGenerationProfile.precision,
    gpuSlots: ['GPU0'],
  };
}

export function ProductionPage() {
  const g = useGenerationCopy();
  const locale = useGenerationLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ProductionForm>(emptyForm);
  const [datasetSearch, setDatasetSearch] = useState('');
  const [datasetPage, setDatasetPage] = useState(1);
  const [contentSearch, setContentSearch] = useState('');
  const debouncedContentSearch = useDebouncedValue(contentSearch);
  const [contentPage, setContentPage] = useState(1);
  const [templatePage, setTemplatePage] = useState(1);
  const [versionPage, setVersionPage] = useState(1);
  const [savedDraft, setSavedDraft] = useState<BatchDraft | null>(null);
  const [userEdited, setUserEdited] = useState(false);
  const [savedFormSignature, setSavedFormSignature] = useState(() => JSON.stringify(form));
  const [previewPage, setPreviewPage] = useState(1);
  const [validation, setValidation] = useState(false);
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);
  const [submitConfirmOpen, setSubmitConfirmOpen] = useState(false);
  const [switchConfirmOpen, setSwitchConfirmOpen] = useState(false);

  const datasetsQuery = useDatasetsQuery(datasetPage, { status: 'Active', ...(datasetSearch.trim() ? { search: datasetSearch } : {}) });
  const selectedDatasetQuery = useDatasetQuery(form.targetDatasetId);
  const contentQuery = useContentScriptsQuery(contentPage, {
    ...(debouncedContentSearch.trim() ? { search: debouncedContentSearch } : {}),
  });
  const templatesQuery = usePromptTemplatesQuery(templatePage);
  const versionsQuery = usePromptTemplateVersionsQuery(form.promptTemplateId, versionPage);
  const selectedVersionQuery = usePromptTemplateVersionQuery(form.promptTemplateVersionId);
  const gpuQuery = useGpuSlotsQuery();
  const saveMutation = useSaveBatchDraftMutation();
  const previewMutation = usePreviewBatchMutation();
  const submitMutation = useSubmitBatchMutation();

  const content = useMemo(
    () => (contentQuery.data?.items ?? []).filter(item =>
      item.status === 'Active'
      && item.category === form.category
      && item.conflictDirection === form.conflictDirection),
    [contentQuery.data, form.category, form.conflictDirection],
  );
  const sceneQueries = useQueries({
    queries: content.map(item => generationQueries.contentScenes(item.id)),
  });
  const scenesByContent = new Map(content.map((item, index) => [item.id, sceneQueries[index]?.data?.scenes ?? []]));
  const templates = useMemo(
    () => (templatesQuery.data?.items ?? []).filter(item => item.category === form.category),
    [form.category, templatesQuery.data],
  );
  const versions = useMemo(
    () => (versionsQuery.data?.items ?? []).filter(item =>
      item.category === form.category && item.verificationStatus === 'Verified'),
    [form.category, versionsQuery.data],
  );
  const versionDetail = selectedVersionQuery.data;
  const selectedVersion = versions.find(item => item.id === form.promptTemplateVersionId)
    ?? (versionDetail?.category === form.category && versionDetail.verificationStatus === 'Verified' ? versionDetail : null);
  const templateOptions = selectedVersion && !templates.some(item => item.id === selectedVersion.templateId)
    ? [{ id: selectedVersion.templateId, name: selectedVersion.templateName, category: selectedVersion.category }, ...templates]
    : templates;
  const versionOptions = selectedVersion && !versions.some(item => item.id === selectedVersion.id)
    ? [selectedVersion, ...versions]
    : versions;
  const activeDatasets = (datasetsQuery.data?.items ?? []).filter(
    item => item.status === 'Active' && item.purpose === 'Formal',
  );
  const datasetOptions = selectedDatasetQuery.data?.status === 'Active'
    && selectedDatasetQuery.data.purpose === 'Formal'
    && !activeDatasets.some(item => item.id === selectedDatasetQuery.data?.id)
    ? [selectedDatasetQuery.data, ...activeDatasets]
    : activeDatasets;
  const availableGpuSlots = new Set(
    (gpuQuery.data ?? [])
      .filter(slot => slot.availability === 'Available')
      .map(slot => slot.slot),
  );
  const request = buildBatchDraftRequest(form, parseSeeds(form.seeds), availableGpuSlots);
  const dirty = userEdited && JSON.stringify(form) !== savedFormSignature;
  const people = demographics(form);
  const seedValues = parseSeeds(form.seeds) ?? [];
  const sceneCount = form.selectedContent.reduce((total, item) => total + item.selectedSceneIds.length, 0);
  const localTotal = sceneCount * people.length * seedValues.length;
  const preview = previewMutation.data?.batchDraftId === savedDraft?.id ? previewMutation.data : null;
  const countSummary = (combinations: number, seeds: number, videos: number) => g('production.count', {
    combinations: g(combinations === 1 ? 'production.combinationCount_one' : 'production.combinationCount_other', { count: combinations }),
    seeds: g(seeds === 1 ? 'production.seedCount_one' : 'production.seedCount_other', { count: seeds }),
    videos: g(videos === 1 ? 'production.videoCount_one' : 'production.videoCount_other', { count: videos }),
  });
  const submitCount = preview?.totalCount ?? localTotal;
  const submitBodyKey = submitCount === 1 ? 'production.submitBody_one' : 'production.submitBody_other';
  const previewRows = preview?.allocations.slice((previewPage - 1) * 20, previewPage * 20) ?? [];
  const previewPages = preview ? Math.ceil(preview.allocations.length / 20) : 0;
  const queryError = datasetsQuery.error ?? selectedDatasetQuery.error ?? contentQuery.error
    ?? templatesQuery.error ?? versionsQuery.error ?? selectedVersionQuery.error ?? gpuQuery.error
    ?? sceneQueries.find(item => item.error)?.error;
  const mutationError = saveMutation.error ?? previewMutation.error ?? submitMutation.error;

  const unsavedDialog = useUnsavedChanges(dirty);

  useEffect(() => {
    if (selectedVersion !== null) {
      if (form.promptTemplateId !== selectedVersion.templateId) {
        setForm(current => ({ ...current, promptTemplateId: selectedVersion.templateId }));
      }
      return;
    }
    if (form.promptTemplateVersionId !== null && selectedVersionQuery.isPending) return;
    if (!templates.some(item => item.id === form.promptTemplateId)) {
      setForm(current => ({ ...current, promptTemplateId: templates[0]?.id ?? null, promptTemplateVersionId: null }));
    }
  }, [form.promptTemplateId, form.promptTemplateVersionId, selectedVersion, selectedVersionQuery.isPending, templates]);

  useEffect(() => {
    if (selectedVersion !== null) return;
    if (form.promptTemplateVersionId !== null && selectedVersionQuery.isPending) return;
    setForm(current => ({ ...current, promptTemplateVersionId: versions[0]?.id ?? null }));
  }, [form.promptTemplateVersionId, selectedVersion, selectedVersionQuery.isPending, versions]);

  const changeCategory = (category: Category) => {
    setForm(current => ({
      ...current,
      category,
      conflictDirection: allowedDirections(category)[0] ?? null,
      displayName: defaultName(category),
      promptTemplateId: null,
      promptTemplateVersionId: null,
      selectedContent: [],
    }));
    setContentPage(1);
    setTemplatePage(1);
    setVersionPage(1);
    setSavedDraft(null);
    previewMutation.reset();
  };

  const contentChoice = (id: number): SelectedContent | null => {
    const item = content.find(value => value.id === id);
    const scenes = scenesByContent.get(id) ?? [];
    if (!item || scenes.length === 0) return null;
    return {
      id: item.id,
      revision: item.revision,
      nameZh: item.nameZh,
      nameEn: item.nameEn,
      mode: item.mode,
      scenes,
      selectedSceneIds: item.mode === 'Fixed' ? [scenes[0].id] : [],
    };
  };

  const toggleContent = (id: number) => {
    setForm(current => {
      const selected = current.selectedContent.some(item => item.id === id);
      if (selected) return { ...current, selectedContent: current.selectedContent.filter(item => item.id !== id) };
      const next = contentChoice(id);
      return next ? { ...current, selectedContent: [...current.selectedContent, next] } : current;
    });
    previewMutation.reset();
    setUserEdited(true);
  };

  const selectPage = () => {
    setUserEdited(true);
    const choices = content.map(item => contentChoice(item.id)).filter((item): item is SelectedContent => item !== null);
    setForm(current => ({
      ...current,
      selectedContent: [
        ...current.selectedContent.filter(item => !content.some(pageItem => pageItem.id === item.id)),
        ...choices.map(item => item.mode === 'Generative'
          ? { ...item, selectedSceneIds: item.scenes.map(scene => scene.id) }
          : item),
      ],
    }));
    previewMutation.reset();
  };

  const clearPage = () => {
    setUserEdited(true);
    setForm(current => ({
      ...current,
      selectedContent: current.selectedContent.filter(item => !content.some(pageItem => pageItem.id === item.id)),
    }));
    previewMutation.reset();
  };

  const toggleScene = (contentId: number, sceneId: number) => {
    setForm(current => ({
      ...current,
      selectedContent: current.selectedContent.map(item =>
        item.id === contentId ? { ...item, selectedSceneIds: toggleValue(item.selectedSceneIds, sceneId) } : item),
    }));
    previewMutation.reset();
  };

  const save = async () => {
    if (!request) {
      setValidation(true);
      setSaveConfirmOpen(false);
      return;
    }
    try {
      const value = await saveMutation.mutateAsync({
        id: savedDraft?.id ?? null,
        input: savedDraft ? { ...request, expectedRevision: savedDraft.revision } : request,
      });
      setSavedDraft(value);
      setSavedFormSignature(JSON.stringify(form));
      previewMutation.reset();
      setUserEdited(false);
      setValidation(false);
    } finally {
      setSaveConfirmOpen(false);
    }
  };

  const buildPreview = async () => {
    if (!savedDraft || dirty) {
      setValidation(true);
      return;
    }
    try {
      await previewMutation.mutateAsync({ id: savedDraft.id, expectedRevision: savedDraft.revision });
      setPreviewPage(1);
      setValidation(false);
    } catch {
      return;
    }
  };

  const submit = async (confirmModelSwitch: boolean) => {
    if (!savedDraft || !preview || dirty) {
      setValidation(true);
      setSubmitConfirmOpen(false);
      return;
    }
    try {
      const job = await submitMutation.mutateAsync({
        id: savedDraft.id,
        expectedRevision: savedDraft.revision,
        expectedGpuRevisions: preview.gpuRevisions,
        confirmModelSwitch,
      });
      navigate('/generate/results?tab=production&job=' + job.id);
    } catch (error) {
      if (!confirmModelSwitch && isModelSwitchConfirmationRequired(error)) setSwitchConfirmOpen(true);
    } finally {
      setSubmitConfirmOpen(false);
    }
  };

  const assistantForm: AssistantFormState = {
    targetDataset: selectedDatasetQuery.data ? {
      id: selectedDatasetQuery.data.id,
      expectedRevision: selectedDatasetQuery.data.revision,
      label: selectedDatasetQuery.data.name,
    } : null,
    displayName: form.displayName,
    category: form.category,
    conflictDirection: form.conflictDirection,
    model: form.model,
    precision: form.precision,
    contentSelections: form.selectedContent.length === 0 ? null : form.selectedContent.map(item => ({
      contentScript: {
        id: item.id,
        expectedRevision: item.revision,
        label: localizedName(locale, item),
      },
      scenes: item.scenes.filter(scene => item.selectedSceneIds.includes(scene.id)).map(scene => ({
        id: scene.id,
        expectedRevision: scene.revision,
        label: localizedName(locale, scene),
      })),
    })),
    promptTemplateVersion: selectedVersion ? {
      id: selectedVersion.id,
      expectedRevision: selectedVersion.revision,
      label: g('test.versionOption', { category: categoryLabel(g, selectedVersion.category), version: selectedVersion.version }),
    } : null,
    demographics: people,
    gpuSlots: form.gpuSlots,
    seeds: seedValues,
  };

  const applyAssistant = async (values: AssistantFormState) => {
    const nextCategory = values.category ?? form.category;
    const nextDirection = 'conflictDirection' in values
      ? values.conflictDirection ?? null
      : form.conflictDirection;
    const classificationChanged = nextCategory !== form.category
      || nextDirection !== form.conflictDirection;

    let nextContent = classificationChanged ? [] : form.selectedContent;
    if ('contentSelections' in values) {
      nextContent = await Promise.all((values.contentSelections ?? []).map(async selection => {
        const [contentScript, compatibleScenes] = await Promise.all([
          queryClient.fetchQuery(generationQueries.contentScript(selection.contentScript.id)),
          queryClient.fetchQuery(generationQueries.contentScenes(selection.contentScript.id)),
        ]);
        const selectedSceneIds = selection.scenes.map(scene => scene.id);
        return {
          id: contentScript.id,
          revision: contentScript.revision,
          nameZh: contentScript.nameZh,
          nameEn: contentScript.nameEn,
          mode: contentScript.mode,
          scenes: compatibleScenes.scenes,
          selectedSceneIds,
        } satisfies SelectedContent;
      }));
    }

    let nextTemplateId = form.promptTemplateId;
    let nextTemplateVersionId = form.promptTemplateVersionId;
    if ('promptTemplateVersion' in values) {
      nextTemplateVersionId = values.promptTemplateVersion?.id ?? null;
      nextTemplateId = null;
      if (nextTemplateVersionId !== null) {
        const version = await queryClient.fetchQuery(
          generationQueries.promptTemplateVersion(nextTemplateVersionId),
        );
        nextTemplateId = version.templateId;
      }
    }

    const nextModel = values.model ?? form.model;
    const nextPrecision = 'model' in values || 'precision' in values
      ? precisionForModel(nextModel, values.precision ?? form.precision)
      : form.precision;
    const peopleValues = values.demographics ?? null;

    setForm(current => ({
      ...current,
      targetDatasetId: 'targetDataset' in values ? values.targetDataset?.id ?? null : current.targetDatasetId,
      displayName: values.displayName ?? current.displayName,
      category: nextCategory,
      conflictDirection: nextDirection,
      promptTemplateId: nextTemplateId,
      promptTemplateVersionId: nextTemplateVersionId,
      selectedContent: nextContent,
      selectedAges: peopleValues ? [...new Set(peopleValues.map(person => person.age))] : current.selectedAges,
      selectedGenders: peopleValues ? [...new Set(peopleValues.map(person => person.gender))] : current.selectedGenders,
      selectedEthnicities: peopleValues ? [...new Set(peopleValues.map(person => person.ethnicity))] : current.selectedEthnicities,
      seeds: values.seeds ? values.seeds.join(', ') : current.seeds,
      model: nextModel,
      precision: nextPrecision,
      gpuSlots: values.gpuSlots ?? current.gpuSlots,
    }));
    if (classificationChanged || 'contentSelections' in values) setContentPage(1);
    setUserEdited(true);
    setValidation(false);
    previewMutation.reset();
  };

  const selectedDatasetName = selectedDatasetQuery.data?.name ?? '';
  const canSelectPage = content.length > 0 && sceneQueries.every(item => !item.isPending);
  const directions = allowedDirections(form.category);

  return (
    <GenerationScaffold title="production.title" subtitle="production.subtitle">
      <AssistantPanel
        targetSource="Production"
        currentForm={assistantForm}
        batchDraft={savedDraft ? { id: savedDraft.id, revision: savedDraft.revision } : null}
        onApply={applyAssistant}
      />
      <RelationshipGuide production />
      {queryError ? <OperationFeedback error={queryError} onDismiss={() => void Promise.all([
        datasetsQuery.refetch(),
        selectedDatasetQuery.refetch(),
        contentQuery.refetch(),
        templatesQuery.refetch(),
        versionsQuery.refetch(),
        selectedVersionQuery.refetch(),
        gpuQuery.refetch(),
      ])} /> : null}
      {mutationError && !switchConfirmOpen ? <OperationFeedback error={mutationError} onDismiss={() => {
        saveMutation.reset();
        previewMutation.reset();
        submitMutation.reset();
      }} /> : null}

      <section
        className="panel generation-form generation-production-form"
        aria-labelledby="production-form-title"
        onChangeCapture={event => {
          const id = (event.target as HTMLElement).id;
          if (id !== 'production-dataset-search' && id !== 'production-content-search') setUserEdited(true);
        }}
      >
        <div className="section-header"><h2 id="production-form-title">{g('production.form')}</h2></div>

        <fieldset className="generation-production-section">
          <legend>{g('production.sectionBatch')}</legend>
          <div className="generation-form__grid">
            <Field label={g('production.name')} htmlFor="production-name"><input id="production-name" maxLength={40} value={form.displayName} onChange={event => setForm(current => ({ ...current, displayName: event.target.value }))} /></Field>
            <Field label={g('production.datasetSearch')} htmlFor="production-dataset-search"><input id="production-dataset-search" type="search" value={datasetSearch} onChange={event => { setDatasetSearch(event.target.value); setDatasetPage(1); }} /></Field>
            <Field label={g('production.dataset')} htmlFor="production-dataset"><select id="production-dataset" value={form.targetDatasetId ?? ''} onChange={event => setForm(current => ({ ...current, targetDatasetId: event.target.value ? Number(event.target.value) : null }))}><option value="">{g('common.none')}</option>{datasetOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
            <Field label={g('production.taskType')} htmlFor="production-category"><select id="production-category" value={form.category} onChange={event => changeCategory(event.target.value as Category)}>{categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}</select></Field>
            <Field label={g('production.direction')} htmlFor="production-direction"><select id="production-direction" value={form.conflictDirection ?? ''} disabled={directions.length === 0} onChange={event => setForm(current => ({ ...current, conflictDirection: (event.target.value || null) as ConflictDirection | null, selectedContent: [] }))}>{directions.length === 0 ? <option value="">{g('common.none')}</option> : null}{directions.map(value => <option key={value} value={value}>{directionLabel(g, value)}</option>)}</select></Field>
          </div>
          <Pagination page={datasetsQuery.data?.page ?? datasetPage} totalPages={datasetsQuery.data?.totalPages ?? 0} total={datasetsQuery.data?.total ?? 0} onPageChange={setDatasetPage} />
        </fieldset>

        <fieldset className="generation-production-section">
          <legend>{g('production.sectionContent')}</legend>
          <p>{g('state.catalogLimited')}</p>
          <Field label={g('production.contentSearch')} htmlFor="production-content-search">
            <input id="production-content-search" type="search" value={contentSearch} onChange={event => { setContentSearch(event.target.value); setContentPage(1); }} />
          </Field>
          <p role="status">{g('production.selectedCount', { count: form.selectedContent.length })}</p>
          <div className="generation-selection-actions">
            <Button variant="secondary" disabled={!canSelectPage} onClick={selectPage}>{g('production.selectPage')}</Button>
            <Button variant="quiet" onClick={clearPage}>{g('production.clearPage')}</Button>
            <Button variant="quiet" onClick={() => { setUserEdited(true); setForm(current => ({ ...current, selectedContent: [] })); }}>{g('production.clearAll')}</Button>
          </div>
          <div className="generation-content-list">
            {content.length === 0 ? <p>{g('production.noContentMatches')}</p> : content.map(item => {
              const selected = form.selectedContent.find(value => value.id === item.id);
              const scenes = scenesByContent.get(item.id) ?? [];
              return <article className="generation-content-choice" key={item.id}>
                <label><input type="checkbox" checked={Boolean(selected)} disabled={scenes.length === 0} onChange={() => toggleContent(item.id)} /><span><strong>{localizedName(locale, item)} {categoryLabel(g, item.category)}</strong>{scenes.length === 0 ? g('production.noScenes') : item.mode === 'Fixed' ? g('production.fixedScene') : g('production.chooseScenes')}</span></label>
                {selected ? <div className="generation-scene-choices">{selected.scenes.map(scene => <label key={scene.id}><input type="checkbox" checked={selected.selectedSceneIds.includes(scene.id)} disabled={selected.mode === 'Fixed'} onChange={() => toggleScene(selected.id, scene.id)} />{localizedName(locale, scene)}</label>)}</div> : null}
              </article>;
            })}
          </div>
          <Pagination page={contentQuery.data?.page ?? contentPage} totalPages={contentQuery.data?.totalPages ?? 0} total={contentQuery.data?.total ?? 0} onPageChange={setContentPage} />
          <div className="generation-form__grid">
            <Field label={g('production.template')} htmlFor="production-template"><select id="production-template" value={form.promptTemplateId ?? ''} onChange={event => { setForm(current => ({ ...current, promptTemplateId: event.target.value ? Number(event.target.value) : null, promptTemplateVersionId: null })); setVersionPage(1); }}><option value="">{templateOptions.length === 0 ? g('state.filtered') : g('common.none')}</option>{templateOptions.map(item => <option key={item.id} value={item.id}>{categoryLabel(g, item.category)}</option>)}</select></Field>
            <Field label={g('production.version')} htmlFor="production-version"><select id="production-version" value={form.promptTemplateVersionId ?? ''} onChange={event => setForm(current => ({ ...current, promptTemplateVersionId: event.target.value ? Number(event.target.value) : null }))}><option value="">{versionOptions.length === 0 ? g('state.filtered') : g('common.none')}</option>{versionOptions.map(item => <option key={item.id} value={item.id}>{g('test.versionOption', { category: categoryLabel(g, item.category), version: item.version })}</option>)}</select></Field>
          </div>
          <div className="generation-source-pages">
            <div><span>{g('production.templatePage')}</span><Pagination page={templatesQuery.data?.page ?? templatePage} totalPages={templatesQuery.data?.totalPages ?? 0} total={templatesQuery.data?.total ?? 0} onPageChange={setTemplatePage} /></div>
            <div><span>{g('production.versionPage')}</span><Pagination page={versionsQuery.data?.page ?? versionPage} totalPages={versionsQuery.data?.totalPages ?? 0} total={versionsQuery.data?.total ?? 0} onPageChange={setVersionPage} /></div>
          </div>
        </fieldset>

        <fieldset className="generation-production-section">
          <legend>{g('production.sectionPeople')}</legend>
          <div className="generation-check-groups">
            <fieldset><legend>{g('production.ages')}</legend>{ages.map(value => <label key={value}><input type="checkbox" checked={form.selectedAges.includes(value)} onChange={() => setForm(current => ({ ...current, selectedAges: toggleValue(current.selectedAges, value) }))} />{g(('demographic.age.' + value) as GenerationKey)}</label>)}</fieldset>
            <fieldset><legend>{g('production.genders')}</legend>{genders.map(value => <label key={value}><input type="checkbox" checked={form.selectedGenders.includes(value)} onChange={() => setForm(current => ({ ...current, selectedGenders: toggleValue(current.selectedGenders, value) }))} />{g(('demographic.gender.' + value) as GenerationKey)}</label>)}</fieldset>
            <fieldset><legend>{g('production.ethnicities')}</legend>{ethnicities.map(value => <label key={value}><input type="checkbox" checked={form.selectedEthnicities.includes(value)} onChange={() => setForm(current => ({ ...current, selectedEthnicities: toggleValue(current.selectedEthnicities, value) }))} />{g(('demographic.ethnicity.' + value) as GenerationKey)}</label>)}</fieldset>
          </div>
          <Field label={g('production.seeds')} htmlFor="production-seeds" hint={g('production.seedsHint')}><input id="production-seeds" value={form.seeds} onChange={event => setForm(current => ({ ...current, seeds: event.target.value }))} /></Field>
        </fieldset>

        <fieldset className="generation-production-section">
          <legend>{g('production.sectionModel')}</legend>
          <div className="generation-form__grid">
            <Field label={g('production.model')} htmlFor="production-model"><select id="production-model" value={form.model} onChange={event => { const model = event.target.value as ModelName; setForm(current => ({ ...current, model, precision: precisionForModel(model, current.precision) })); }}>{models.map(value => <option key={value} value={value}>{g(('model.' + value) as GenerationKey)}</option>)}</select></Field>
            {form.model === 'LTX-2.5' ? <Field label={g('production.precision')} htmlFor="production-precision"><select id="production-precision" value={form.precision ?? ''} onChange={event => setForm(current => ({ ...current, precision: event.target.value as ModelPrecision }))}>{ltx25Precisions.map(value => <option key={value} value={value}>{g(('precision.' + value) as GenerationKey)}</option>)}</select></Field> : null}
          </div>
          <fieldset className="generation-gpu-select"><legend>{g('production.gpus')}</legend>{(gpuQuery.data ?? []).map(slot => {
            const checked = form.gpuSlots.includes(slot.slot);
            return <label key={slot.slot}><input type="checkbox" checked={checked} disabled={slot.availability !== 'Available' && !checked} onChange={() => setForm(current => ({ ...current, gpuSlots: toggleValue(current.gpuSlots, slot.slot) }))} />{g(('gpu.' + slot.slot) as GenerationKey)} {g(('gpu.' + slot.availability) as GenerationKey)}</label>;
          })}</fieldset>
          <GpuPanel />
        </fieldset>

        <p className="generation-count" role="status">{countSummary(sceneCount * people.length, seedValues.length, localTotal)}</p>
        {validation ? <p className="field__error" role="alert">{g('production.validation')}</p> : null}
        <div className="generation-form__actions">
          <Button variant="secondary" onClick={() => setSaveConfirmOpen(true)}>{g('production.save')}</Button>
          <Button variant="secondary" disabled={!savedDraft || dirty} onClick={() => void buildPreview()}>{g('production.preview')}</Button>
          <Button variant="primary" disabled={!preview || dirty} onClick={() => setSubmitConfirmOpen(true)}>{g('production.submit')}</Button>
        </div>
      </section>

      <section className="panel generation-preview" aria-labelledby="production-preview-title">
        <div className="section-header"><div><h2 id="production-preview-title">{g('production.previewTitle')}</h2><p>{g('production.previewHint')}</p></div></div>
        {!preview ? <p>{g('state.empty')}</p> : <>
          <p>{countSummary(preview.combinationCount, preview.seedCount, preview.totalCount)}</p>
          <TableShell caption={g('production.previewTitle')} columns={[
            { key: 'sequence', label: g('production.sequence') },
            { key: 'content', label: g('production.content') },
            { key: 'scene', label: g('test.scene') },
            { key: 'person', label: g('production.person') },
            { key: 'seed', label: g('production.seeds') },
            { key: 'gpu', label: g('production.assignment') },
          ]}>{previewRows.map(row => <tr key={row.sequence}>
            <td>{row.sequence}</td>
            <td>{localizedName(locale, row.contentScript)}</td>
            <td>{localizedName(locale, row.scene)}</td>
            <td>{g(('demographic.age.' + row.demographic.age) as GenerationKey)} {g(('demographic.gender.' + row.demographic.gender) as GenerationKey)} {g(('demographic.ethnicity.' + row.demographic.ethnicity) as GenerationKey)}</td>
            <td>{row.seed}</td>
            <td>{g(('gpu.' + row.gpuSlot) as GenerationKey)}</td>
          </tr>)}</TableShell>
          <Pagination page={previewPage} totalPages={previewPages} total={preview.allocations.length} onPageChange={setPreviewPage} />
        </>}
      </section>

      {unsavedDialog}
      <ConfirmDialog open={saveConfirmOpen} title={g('production.saveTitle')} body={g('production.saveBody')} confirmLabel={g('production.save')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => void save()} onClose={() => setSaveConfirmOpen(false)} busy={saveMutation.isPending} />
      <ConfirmDialog open={submitConfirmOpen} title={g('production.submitTitle')} body={g(submitBodyKey, { count: submitCount, dataset: selectedDatasetName })} confirmLabel={g('production.submit')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => void submit(false)} onClose={() => setSubmitConfirmOpen(false)} busy={submitMutation.isPending} />
      <ConfirmDialog open={switchConfirmOpen} title={g('production.switchTitle')} body={g('production.switchBody')} confirmLabel={g('common.confirm')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => void submit(true)} onClose={() => setSwitchConfirmOpen(false)} busy={submitMutation.isPending} />
    </GenerationScaffold>
  );
}
