import type {
  AssistantFormState,
  BatchDraft,
  BatchDraftCreate,
  BilingualSelection,
  ConfigurationCandidateGroup,
  ConfigurationCandidateKind,
  Demographic,
  GpuSlotName,
} from '../../api/contracts';
import type { Category, ConflictDirection, ModelName, ModelPrecision } from '../../types';

export interface SelectedContent {
  id: number;
  revision: number;
  nameZh: string;
  nameEn: string;
  mode: 'Fixed' | 'Generative';
  scenes: BilingualSelection[];
  selectedSceneIds: number[];
}

export interface ProductionForm {
  targetDatasetId: number | null;
  displayName: string;
  category: Category;
  conflictDirection: ConflictDirection | null;
  promptTemplateId: number | null;
  promptTemplateVersionId: number | null;
  selectedContent: SelectedContent[];
  selectedAges: number[];
  selectedGenders: Demographic['gender'][];
  selectedEthnicities: Demographic['ethnicity'][];
  seeds: string;
  model: ModelName;
  precision: ModelPrecision | null;
  gpuSlots: GpuSlotName[];
}

export interface CandidateChoices {
  Dataset: number | null;
  ContentScript: number[];
  ShootingScene: number[];
  PromptTemplateVersion: number | null;
}

const singleCandidateKinds: ConfigurationCandidateKind[] = ['Dataset', 'PromptTemplateVersion'];

function groupFor(
  groups: readonly ConfigurationCandidateGroup[],
  kind: ConfigurationCandidateKind,
): ConfigurationCandidateGroup | undefined {
  return groups.find(group => group.kind === kind);
}

export function initialCandidateChoices(
  groups: readonly ConfigurationCandidateGroup[],
): CandidateChoices {
  const only = (kind: ConfigurationCandidateKind): number[] => {
    const items = groupFor(groups, kind)?.items ?? [];
    return items.length === 1 ? [items[0].id] : [];
  };
  return {
    Dataset: only('Dataset')[0] ?? null,
    ContentScript: only('ContentScript'),
    ShootingScene: only('ShootingScene'),
    PromptTemplateVersion: only('PromptTemplateVersion')[0] ?? null,
  };
}

export function chooseCandidate(
  choices: CandidateChoices,
  kind: ConfigurationCandidateKind,
  id: number,
): CandidateChoices {
  if (singleCandidateKinds.includes(kind)) {
    return { ...choices, [kind]: id };
  }
  if (kind === 'ContentScript') {
    return {
      ...choices,
      ContentScript: choices.ContentScript.includes(id)
        ? choices.ContentScript.filter(value => value !== id)
        : [...choices.ContentScript, id],
    };
  }
  return {
    ...choices,
    ShootingScene: choices.ShootingScene.includes(id)
      ? choices.ShootingScene.filter(value => value !== id)
      : [...choices.ShootingScene, id],
  };
}

export function localizedCandidateLabel(
  kind: ConfigurationCandidateKind,
  label: string,
  locale: 'zh-CN' | 'en-US',
): string {
  if (kind !== 'ContentScript' && kind !== 'ShootingScene') return label;
  const separator = label.indexOf(' / ');
  if (separator < 0) return label;
  return locale === 'zh-CN'
    ? label.slice(0, separator)
    : label.slice(separator + 3);
}

function selectedCandidate(
  groups: readonly ConfigurationCandidateGroup[],
  kind: 'Dataset' | 'PromptTemplateVersion',
  id: number | null,
) {
  if (id === null) return null;
  return groupFor(groups, kind)?.items.find(item => item.id === id) ?? null;
}

export function assistantValuesWithCandidates(
  prefill: AssistantFormState,
  groups: readonly ConfigurationCandidateGroup[],
  choices: CandidateChoices,
  scenesByContent: Readonly<Record<number, readonly BilingualSelection[]>>,
): AssistantFormState {
  const values: AssistantFormState = { ...prefill };
  const dataset = selectedCandidate(groups, 'Dataset', choices.Dataset);
  if (dataset) {
    values.targetDataset = {
      id: dataset.id,
      expectedRevision: dataset.revision,
      label: dataset.label,
    };
  }
  const template = selectedCandidate(
    groups,
    'PromptTemplateVersion',
    choices.PromptTemplateVersion,
  );
  if (template) {
    values.promptTemplateVersion = {
      id: template.id,
      expectedRevision: template.revision,
      label: template.label,
    };
  }

  const contentGroup = groupFor(groups, 'ContentScript');
  const sceneGroup = groupFor(groups, 'ShootingScene');
  if (contentGroup || sceneGroup) {
    const contentCandidates = contentGroup
      ? contentGroup.items.filter(item => choices.ContentScript.includes(item.id))
      : (prefill.contentSelections ?? []).map(selection => ({
          id: selection.contentScript.id,
          revision: selection.contentScript.expectedRevision,
          label: selection.contentScript.label ?? '',
        }));
    const sceneCandidates = sceneGroup
      ? sceneGroup.items.filter(item => choices.ShootingScene.includes(item.id))
      : [];
    const selections = contentCandidates.map(content => {
      const existing = prefill.contentSelections?.find(
        selection => selection.contentScript.id === content.id,
      );
      const scenes = sceneGroup
        ? sceneCandidates
            .filter(scene => scenesByContent[content.id]?.some(value => value.id === scene.id))
            .map(scene => ({
              id: scene.id,
              expectedRevision: scene.revision,
              label: scene.label,
            }))
        : existing?.scenes ?? [];
      return {
        contentScript: {
          id: content.id,
          expectedRevision: content.revision,
          label: content.label,
        },
        scenes,
      };
    });
    if (selections.length > 0 && selections.every(selection => selection.scenes.length > 0)) {
      values.contentSelections = selections;
    }
  }
  return values;
}

export function candidateChoicesReady(
  groups: readonly ConfigurationCandidateGroup[],
  choices: CandidateChoices,
  values: AssistantFormState,
): boolean {
  for (const group of groups) {
    if (group.items.length < 2) continue;
    const selected = choices[group.kind];
    if (Array.isArray(selected) ? selected.length === 0 : selected === null) return false;
  }
  if (groupFor(groups, 'ContentScript') || groupFor(groups, 'ShootingScene')) {
    return Boolean(
      values.contentSelections?.length
      && values.contentSelections.every(selection => selection.scenes.length > 0),
    );
  }
  return true;
}

export function demographics(form: ProductionForm): Demographic[] {
  return form.selectedAges.flatMap(age =>
    form.selectedGenders.flatMap(gender =>
      form.selectedEthnicities.map(ethnicity => ({
        age: age as Demographic['age'],
        gender,
        ethnicity,
      }))));
}

export function buildBatchDraftRequest(
  form: ProductionForm,
  seedValues: number[] | null,
  availableGpuSlots: ReadonlySet<GpuSlotName>,
): BatchDraftCreate | null {
  const people = demographics(form);
  const contentIds = form.selectedContent.map(item => item.id);
  const gpuSlots = [...new Set(form.gpuSlots)];
  const selectionsValid = form.selectedContent.length > 0 && form.selectedContent.every(item => {
    const activeSceneIds = new Set(item.scenes.map(scene => scene.id));
    if (item.mode === 'Fixed') {
      return item.scenes.length === 1
        && item.selectedSceneIds.length === 1
        && item.selectedSceneIds[0] === item.scenes[0].id;
    }
    return item.selectedSceneIds.length > 0
      && item.selectedSceneIds.every(sceneId => activeSceneIds.has(sceneId));
  });
  if (
    form.targetDatasetId === null
    || !form.displayName.trim()
    || form.promptTemplateVersionId === null
    || !selectionsValid
    || new Set(contentIds).size !== contentIds.length
    || people.length === 0
    || seedValues === null
    || seedValues.length === 0
    || new Set(seedValues).size !== seedValues.length
    || gpuSlots.length < 1
    || gpuSlots.length > 2
    || !gpuSlots.every(slot => availableGpuSlots.has(slot))
  ) return null;

  return {
    targetDatasetId: form.targetDatasetId,
    displayName: form.displayName.trim(),
    category: form.category,
    conflictDirection: form.conflictDirection,
    model: form.model,
    precision: form.precision,
    contentSelections: form.selectedContent.map(item => ({
      contentScriptId: item.id,
      sceneIds: item.mode === 'Fixed' ? [] : item.selectedSceneIds,
    })),
    promptTemplateVersionId: form.promptTemplateVersionId,
    demographics: people,
    gpuSlots,
    seeds: seedValues,
  };
}

export function productionFormFromDraft(
  draft: BatchDraft,
  promptTemplateId: number,
): ProductionForm {
  return {
    targetDatasetId: draft.targetDatasetId,
    displayName: draft.displayName ?? '',
    category: draft.category,
    conflictDirection: draft.conflictDirection,
    promptTemplateId,
    promptTemplateVersionId: draft.promptTemplateVersion.id,
    selectedContent: draft.contentSelections.map(selection => ({
      id: selection.contentScript.id,
      revision: selection.contentScript.revision,
      nameZh: selection.contentScript.nameZh,
      nameEn: selection.contentScript.nameEn,
      mode: selection.mode,
      scenes: selection.compatibleScenes,
      selectedSceneIds: selection.scenes.map(scene => scene.id),
    })),
    selectedAges: [...new Set(draft.demographics.map(item => item.age))],
    selectedGenders: [...new Set(draft.demographics.map(item => item.gender))],
    selectedEthnicities: [...new Set(draft.demographics.map(item => item.ethnicity))],
    seeds: draft.seeds.join(', '),
    model: draft.model,
    precision: draft.precision,
    gpuSlots: [...draft.gpuSlots],
  };
}
