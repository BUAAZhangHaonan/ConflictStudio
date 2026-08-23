import type {
  ContentScript,
  ContentScriptCreate,
  PromptTemplateVersionCreate,
  Scene,
  SceneCreate,
} from '../../api/contracts';
import { ltx25Precisions } from '../../generationProfile';
import { allowedDirections, type Category, type ModelName, type ModelPrecision } from '../../types';

export type ContentDraftForm = Omit<ContentScriptCreate, 'status'>;
export type SceneDraftForm = Omit<SceneCreate, 'status'>;

export interface VersionDraftForm {
  organizationRules: string;
  styleGuidance: string;
  ltxNegativePrompt: string;
  h3NegativePrompt: string;
}

export function emptyContentDraft(category: Category = 'A-VA'): ContentDraftForm {
  return {
    nameZh: '',
    nameEn: '',
    category,
    conflictDirection: allowedDirections(category)[0] ?? null,
    mode: 'Generative',
    trueEmotion: '',
    apparentEmotion: '',
    sceneZh: '',
    sceneEn: '',
    triggerEventZh: '',
    triggerEventEn: '',
    psychologicalBackgroundZh: '',
    psychologicalBackgroundEn: '',
    dialogue: null,
    displayText: null,
    trueEmotionDescription: '',
    baseVideoPrompt: '',
    contentRequirementsZh: '',
    contentRequirementsEn: '',
    sceneSupplementZh: '',
    sceneSupplementEn: '',
    sceneIds: [],
  };
}

export function contentDraftFromResource(value: ContentScript): ContentDraftForm {
  const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, status: _status, ...form } = value;
  return form;
}

export function buildContentDraftRequest(form: ContentDraftForm): ContentScriptCreate | null {
  const required = [
    form.nameZh,
    form.nameEn,
    form.trueEmotion,
    form.apparentEmotion,
    form.sceneZh,
    form.sceneEn,
    form.triggerEventZh,
    form.triggerEventEn,
    form.psychologicalBackgroundZh,
    form.psychologicalBackgroundEn,
  ];
  const aligned = form.category.startsWith('A-');
  const directionValid = aligned
    ? form.conflictDirection === null
    : form.conflictDirection !== null && allowedDirections(form.category).includes(form.conflictDirection);
  const emotionValid = aligned
    ? form.trueEmotion.trim() === form.apparentEmotion.trim()
    : form.trueEmotion.trim() !== form.apparentEmotion.trim();
  const fixedValid = form.mode !== 'Fixed' || (
    form.sceneIds.length === 1
    && Boolean(form.baseVideoPrompt.trim())
    && Boolean(form.trueEmotionDescription.trim())
    && (form.category.endsWith('-VA') ? Boolean(form.dialogue?.trim()) : Boolean(form.displayText?.trim()))
  );
  const generatedValid = form.mode !== 'Generative'
    || Boolean(form.contentRequirementsZh.trim() && form.contentRequirementsEn.trim());
  if (
    required.some(value => !value.trim())
    || !directionValid
    || !emotionValid
    || !fixedValid
    || !generatedValid
    || new Set(form.sceneIds).size !== form.sceneIds.length
  ) return null;
  return { ...form, status: 'Draft' };
}

export function toggleCompatibility(
  mode: ContentDraftForm['mode'],
  selected: readonly number[],
  sceneId: number,
): number[] {
  if (mode === 'Fixed') return [sceneId];
  return selected.includes(sceneId)
    ? selected.filter(value => value !== sceneId)
    : [...selected, sceneId];
}

export function emptySceneDraft(): SceneDraftForm {
  return {
    nameZh: '',
    nameEn: '',
    sceneZh: '',
    sceneEn: '',
    ambientSoundZh: '',
    ambientSoundEn: '',
    participantRelationshipZh: '',
    participantRelationshipEn: '',
    lightingZh: '',
    lightingEn: '',
    framingZh: '',
    framingEn: '',
  };
}

export function sceneDraftFromResource(value: Scene): SceneDraftForm {
  const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, status: _status, ...form } = value;
  return form;
}

export function buildSceneDraftRequest(form: SceneDraftForm): SceneCreate | null {
  if ([form.nameZh, form.nameEn, form.sceneZh, form.sceneEn].some(value => !value.trim())) return null;
  return { ...form, status: 'Draft' };
}

export function emptyVersionDraft(): VersionDraftForm {
  return {
    organizationRules: '',
    styleGuidance: '',
    ltxNegativePrompt: '',
    h3NegativePrompt: '',
  };
}

export function buildVersionDraftRequest(
  form: VersionDraftForm,
  expectedTemplateRevision: number | null,
): PromptTemplateVersionCreate | null {
  if (
    expectedTemplateRevision === null
    || [form.organizationRules, form.styleGuidance, form.ltxNegativePrompt, form.h3NegativePrompt]
      .some(value => !value.trim())
  ) return null;
  return {
    expectedTemplateRevision,
    organizationRules: form.organizationRules.trim(),
    styleGuidance: form.styleGuidance.trim(),
    positiveExamples: [],
    negativeExamples: [],
    ltxNegativePrompt: form.ltxNegativePrompt.trim(),
    h3NegativePrompt: form.h3NegativePrompt.trim(),
  };
}

export function precisionOptionsForModel(model: ModelName): readonly (ModelPrecision | null)[] {
  return model === 'LTX-2.5' ? ltx25Precisions : [null];
}

export function modelPrecisionIsValid(model: ModelName, precision: ModelPrecision | null): boolean {
  return precisionOptionsForModel(model).includes(precision);
}
