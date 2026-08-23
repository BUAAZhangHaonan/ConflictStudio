import type {
  BatchDraftCreate,
  BilingualSelection,
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
  demographics: Demographic[];
  seeds: string;
  model: ModelName;
  precision: ModelPrecision | null;
  gpuSlots: GpuSlotName[];
}

function demographicKey(value: Demographic): string {
  return [value.age, value.gender, value.ethnicity].join(':');
}

export function buildBatchDraftRequest(
  form: ProductionForm,
  seedValues: number[] | null,
  availableGpuSlots: ReadonlySet<GpuSlotName>,
): BatchDraftCreate | null {
  const contentIds = form.selectedContent.map(item => item.id);
  const gpuSlots = [...new Set(form.gpuSlots)];
  const demographics = form.demographics.map(value => ({ ...value }));
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
    || demographics.length === 0
    || new Set(demographics.map(demographicKey)).size !== demographics.length
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
    demographics,
    gpuSlots,
    seeds: seedValues,
  };
}
