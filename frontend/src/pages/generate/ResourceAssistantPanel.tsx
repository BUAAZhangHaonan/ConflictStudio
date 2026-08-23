import { useEffect, useState } from 'react';
import { Button, ConfirmDialog, Field, Pagination } from '../../components';
import {
  useApplyResourceAssistantMutation,
  usePromptTemplatesQuery,
  useProposeResourceAssistantMutation,
} from '../../api/queries';
import type {
  ResourceAssistantBundle,
  ResourceAssistantProposal,
  SceneCreate,
} from '../../api/contracts';
import { allowedDirections, type ConflictDirection } from '../../types';
import {
  categoryLabel,
  directionLabel,
  OperationFeedback,
  useGenerationCopy,
} from './shared';

const contentTextFields = [
  ['sceneZh', 'test.resource.settingZh'],
  ['sceneEn', 'test.resource.settingEn'],
  ['triggerEventZh', 'test.resource.eventZh'],
  ['triggerEventEn', 'test.resource.eventEn'],
  ['psychologicalBackgroundZh', 'test.resource.backgroundZh'],
  ['psychologicalBackgroundEn', 'test.resource.backgroundEn'],
  ['sceneSupplementZh', 'test.resource.supplementZh'],
  ['sceneSupplementEn', 'test.resource.supplementEn'],
] as const;

const sceneTextFields = [
  ['sceneZh', 'test.resource.sceneZh'],
  ['sceneEn', 'test.resource.sceneEn'],
  ['ambientSoundZh', 'test.resource.ambientZh'],
  ['ambientSoundEn', 'test.resource.ambientEn'],
  ['participantRelationshipZh', 'test.resource.relationshipZh'],
  ['participantRelationshipEn', 'test.resource.relationshipEn'],
  ['lightingZh', 'test.resource.lightingZh'],
  ['lightingEn', 'test.resource.lightingEn'],
  ['framingZh', 'test.resource.framingZh'],
  ['framingEn', 'test.resource.framingEn'],
] as const;

function emptyScene(): SceneCreate {
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
    status: 'Draft',
  };
}

function examplesFromText(value: string): string[] {
  return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

export function ResourceAssistantPanel() {
  const g = useGenerationCopy();
  const [templatePage, setTemplatePage] = useState(1);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [requirement, setRequirement] = useState('');
  const [proposal, setProposal] = useState<ResourceAssistantProposal | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applied, setApplied] = useState(false);
  const templatesQuery = usePromptTemplatesQuery(templatePage);
  const proposeMutation = useProposeResourceAssistantMutation();
  const applyMutation = useApplyResourceAssistantMutation();
  const templates = templatesQuery.data?.items ?? [];
  const selectedTemplate = templates.find(item => item.id === templateId) ?? null;

  useEffect(() => {
    if (templates.some(item => item.id === templateId)) return;
    setTemplateId(templates[0]?.id ?? null);
  }, [templateId, templates]);

  const updateBundle = (update: (bundle: ResourceAssistantBundle) => ResourceAssistantBundle) => {
    setProposal(current => current ? { ...current, bundle: update(current.bundle) } : current);
    setApplied(false);
  };

  const propose = async () => {
    if (!selectedTemplate || !requirement.trim()) return;
    try {
      const value = await proposeMutation.mutateAsync({
        userRequirement: requirement.trim(),
        promptTemplate: { id: selectedTemplate.id, expectedRevision: selectedTemplate.revision },
      });
      setProposal(value);
      setApplied(false);
    } catch {
      return;
    }
  };

  const apply = async () => {
    if (!proposal) return;
    try {
      await applyMutation.mutateAsync({
        promptTemplate: {
          id: proposal.promptTemplate.id,
          expectedRevision: proposal.promptTemplate.revision,
        },
        bundle: proposal.bundle,
      });
      setConfirmOpen(false);
      setProposal(null);
      setRequirement('');
      setApplied(true);
    } catch {
      return;
    }
  };

  const error = templatesQuery.error ?? proposeMutation.error ?? applyMutation.error;
  const bundle = proposal?.bundle ?? null;
  const content = bundle?.contentScript ?? null;
  const directions = content ? allowedDirections(content.category) : [];

  return <section className="panel generation-resource-assistant" aria-labelledby="resource-assistant-title">
    <div className="section-header">
      <div><h2 id="resource-assistant-title">{g('resources.assistant.title')}</h2><p>{g('resources.assistant.hint')}</p></div>
    </div>
    {error ? <OperationFeedback error={error} onDismiss={() => {
      void templatesQuery.refetch();
      proposeMutation.reset();
      applyMutation.reset();
    }} /> : null}
    {applied ? <p className="generation-resource-assistant__success" role="status">{g('resources.assistant.applied')}</p> : null}
    <div className="generation-form__grid">
      <Field label={g('test.template')} htmlFor="resource-assistant-template">
        <select id="resource-assistant-template" value={templateId ?? ''} onChange={event => { setTemplateId(event.target.value ? Number(event.target.value) : null); setProposal(null); }}>
          <option value="">{g('common.none')}</option>
          {templates.map(item => <option key={item.id} value={item.id}>{g('resources.assistant.templateOption', { name: item.name, category: categoryLabel(g, item.category) })}</option>)}
        </select>
      </Field>
      <Field label={g('resources.assistant.requirement')} htmlFor="resource-assistant-requirement">
        <textarea id="resource-assistant-requirement" value={requirement} onChange={event => setRequirement(event.target.value)} />
      </Field>
    </div>
    <div className="generation-form__actions">
      <Button variant="secondary" busy={proposeMutation.isPending} disabled={!selectedTemplate || !requirement.trim()} onClick={() => void propose()}>{g('resources.assistant.propose')}</Button>
    </div>
    <Pagination page={templatesQuery.data?.page ?? templatePage} totalPages={templatesQuery.data?.totalPages ?? 0} total={templatesQuery.data?.total ?? 0} onPageChange={page => { setTemplatePage(page); setProposal(null); }} />

    {proposal && bundle && content ? <div className="generation-resource-assistant__proposal">
      <div className="section-header"><div><h3>{g('resources.assistant.reviewTitle')}</h3><p>{g('resources.assistant.reviewHint')}</p></div></div>
      <fieldset className="generation-resource-assistant__group">
        <legend>{g('test.resource.contentTitle')}</legend>
        <div className="generation-form__grid">
          <Field label={g('test.resource.nameZh')} htmlFor="assistant-content-name-zh"><input id="assistant-content-name-zh" value={content.nameZh} onChange={event => updateBundle(value => ({ ...value, contentScript: { ...value.contentScript, nameZh: event.target.value } }))} /></Field>
          <Field label={g('test.resource.nameEn')} htmlFor="assistant-content-name-en"><input id="assistant-content-name-en" value={content.nameEn} onChange={event => updateBundle(value => ({ ...value, contentScript: { ...value.contentScript, nameEn: event.target.value } }))} /></Field>
          <Field label={g('test.taskType')} htmlFor="assistant-content-category"><input id="assistant-content-category" value={categoryLabel(g, content.category)} readOnly /></Field>
          <Field label={g('test.direction')} htmlFor="assistant-content-direction"><select id="assistant-content-direction" value={content.conflictDirection ?? ''} disabled={directions.length === 0} onChange={event => updateBundle(value => ({ ...value, contentScript: { ...value.contentScript, conflictDirection: (event.target.value || null) as ConflictDirection | null } }))}>{directions.length === 0 ? <option value="">{g('common.none')}</option> : null}{directions.map(direction => <option key={direction} value={direction}>{directionLabel(g, direction)}</option>)}</select></Field>
          <Field label={g('test.resource.mode')} htmlFor="assistant-content-mode"><select id="assistant-content-mode" value={content.mode} onChange={event => updateBundle(value => ({ ...value, contentScript: { ...value.contentScript, mode: event.target.value as ResourceAssistantBundle['contentScript']['mode'] }, scenes: event.target.value === 'Fixed' ? value.scenes.slice(0, 1) : value.scenes }))}><option value="Fixed">{g('assistant.mode.Fixed')}</option><option value="Generative">{g('assistant.mode.Generative')}</option></select></Field>
          <Field label={g('test.resource.trueEmotion')} htmlFor="assistant-content-true"><input id="assistant-content-true" value={content.trueEmotion} onChange={event => updateBundle(value => ({ ...value, contentScript: { ...value.contentScript, trueEmotion: event.target.value } }))} /></Field>
          <Field label={g('test.resource.apparentEmotion')} htmlFor="assistant-content-apparent"><input id="assistant-content-apparent" value={content.apparentEmotion} onChange={event => updateBundle(value => ({ ...value, contentScript: { ...value.contentScript, apparentEmotion: event.target.value } }))} /></Field>
        </div>
        {contentTextFields.map(([field, key]) => <Field key={field} label={g(key)} htmlFor={'assistant-content-' + field}><textarea id={'assistant-content-' + field} value={content[field]} onChange={event => updateBundle(value => ({ ...value, contentScript: { ...value.contentScript, [field]: event.target.value } }))} /></Field>)}
        {content.category.endsWith('-VA')
          ? <Field label={g('test.resource.dialogue')} htmlFor="assistant-content-dialogue"><textarea id="assistant-content-dialogue" value={content.dialogue ?? ''} onChange={event => updateBundle(value => ({ ...value, contentScript: { ...value.contentScript, dialogue: event.target.value || null } }))} /></Field>
          : <Field label={g('test.resource.displayText')} htmlFor="assistant-content-display"><textarea id="assistant-content-display" value={content.displayText ?? ''} onChange={event => updateBundle(value => ({ ...value, contentScript: { ...value.contentScript, displayText: event.target.value || null } }))} /></Field>}
        {content.mode === 'Fixed' ? <>
          <Field label={g('test.resource.emotionDescription')} htmlFor="assistant-content-emotion-description"><textarea id="assistant-content-emotion-description" value={content.trueEmotionDescription} onChange={event => updateBundle(value => ({ ...value, contentScript: { ...value.contentScript, trueEmotionDescription: event.target.value } }))} /></Field>
          <Field label={g('test.resource.basePrompt')} htmlFor="assistant-content-base-prompt"><textarea id="assistant-content-base-prompt" value={content.baseVideoPrompt} onChange={event => updateBundle(value => ({ ...value, contentScript: { ...value.contentScript, baseVideoPrompt: event.target.value } }))} /></Field>
        </> : <>
          <Field label={g('test.resource.requirementsZh')} htmlFor="assistant-content-requirements-zh"><textarea id="assistant-content-requirements-zh" value={content.contentRequirementsZh} onChange={event => updateBundle(value => ({ ...value, contentScript: { ...value.contentScript, contentRequirementsZh: event.target.value } }))} /></Field>
          <Field label={g('test.resource.requirementsEn')} htmlFor="assistant-content-requirements-en"><textarea id="assistant-content-requirements-en" value={content.contentRequirementsEn} onChange={event => updateBundle(value => ({ ...value, contentScript: { ...value.contentScript, contentRequirementsEn: event.target.value } }))} /></Field>
        </>}
      </fieldset>

      <fieldset className="generation-resource-assistant__group">
        <legend>{g('test.resource.sceneTitle')}</legend>
        {bundle.scenes.map((scene, index) => <div className="generation-resource-assistant__scene" key={index}>
          <div className="generation-form__grid">
            <Field label={g('test.resource.nameZh')} htmlFor={'assistant-scene-name-zh-' + index}><input id={'assistant-scene-name-zh-' + index} value={scene.nameZh} onChange={event => updateBundle(value => ({ ...value, scenes: value.scenes.map((item, itemIndex) => itemIndex === index ? { ...item, nameZh: event.target.value } : item) }))} /></Field>
            <Field label={g('test.resource.nameEn')} htmlFor={'assistant-scene-name-en-' + index}><input id={'assistant-scene-name-en-' + index} value={scene.nameEn} onChange={event => updateBundle(value => ({ ...value, scenes: value.scenes.map((item, itemIndex) => itemIndex === index ? { ...item, nameEn: event.target.value } : item) }))} /></Field>
          </div>
          {sceneTextFields.map(([field, key]) => <Field key={field} label={g(key)} htmlFor={'assistant-scene-' + field + '-' + index}><textarea id={'assistant-scene-' + field + '-' + index} value={scene[field]} onChange={event => updateBundle(value => ({ ...value, scenes: value.scenes.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: event.target.value } : item) }))} /></Field>)}
          <Button variant="quiet" disabled={content.mode === 'Fixed' || bundle.scenes.length === 1} onClick={() => updateBundle(value => ({ ...value, scenes: value.scenes.filter((_, itemIndex) => itemIndex !== index) }))}>{g('resources.assistant.removeScene')}</Button>
        </div>)}
        {content.mode === 'Generative' ? <Button variant="secondary" onClick={() => updateBundle(value => ({ ...value, scenes: [...value.scenes, emptyScene()] }))}>{g('resources.assistant.addScene')}</Button> : null}
      </fieldset>

      <fieldset className="generation-resource-assistant__group">
        <legend>{g('test.resource.versionTitle')}</legend>
        <Field label={g('test.resource.rules')} htmlFor="assistant-version-rules"><textarea id="assistant-version-rules" value={bundle.promptTemplateVersion.organizationRules} onChange={event => updateBundle(value => ({ ...value, promptTemplateVersion: { ...value.promptTemplateVersion, organizationRules: event.target.value } }))} /></Field>
        <Field label={g('test.resource.style')} htmlFor="assistant-version-style"><textarea id="assistant-version-style" value={bundle.promptTemplateVersion.styleGuidance} onChange={event => updateBundle(value => ({ ...value, promptTemplateVersion: { ...value.promptTemplateVersion, styleGuidance: event.target.value } }))} /></Field>
        <Field label={g('resources.assistant.positiveExamples')} htmlFor="assistant-version-positive"><textarea id="assistant-version-positive" value={bundle.promptTemplateVersion.positiveExamples.join('\n')} onChange={event => updateBundle(value => ({ ...value, promptTemplateVersion: { ...value.promptTemplateVersion, positiveExamples: examplesFromText(event.target.value) } }))} /></Field>
        <Field label={g('resources.assistant.negativeExamples')} htmlFor="assistant-version-negative"><textarea id="assistant-version-negative" value={bundle.promptTemplateVersion.negativeExamples.join('\n')} onChange={event => updateBundle(value => ({ ...value, promptTemplateVersion: { ...value.promptTemplateVersion, negativeExamples: examplesFromText(event.target.value) } }))} /></Field>
        <Field label={g('test.resource.ltxNegative')} htmlFor="assistant-version-ltx"><textarea id="assistant-version-ltx" value={bundle.promptTemplateVersion.ltxNegativePrompt} onChange={event => updateBundle(value => ({ ...value, promptTemplateVersion: { ...value.promptTemplateVersion, ltxNegativePrompt: event.target.value } }))} /></Field>
        <Field label={g('test.resource.h3Negative')} htmlFor="assistant-version-h3"><textarea id="assistant-version-h3" value={bundle.promptTemplateVersion.h3NegativePrompt} onChange={event => updateBundle(value => ({ ...value, promptTemplateVersion: { ...value.promptTemplateVersion, h3NegativePrompt: event.target.value } }))} /></Field>
      </fieldset>
      <div className="generation-form__actions">
        <Button variant="primary" onClick={() => setConfirmOpen(true)}>{g('resources.assistant.apply')}</Button>
      </div>
    </div> : null}

    <ConfirmDialog open={confirmOpen} title={g('resources.assistant.confirmTitle')} body={g('resources.assistant.confirmBody')} confirmLabel={g('resources.assistant.apply')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} busy={applyMutation.isPending} onConfirm={() => void apply()} onClose={() => setConfirmOpen(false)} />
  </section>;
}
