import { useEffect, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Button, ConfirmDialog, Field, StatusBadge } from '../../components';
import {
  generationQueries,
  useApplyConfigurationAssistantMutation,
  useCreateConfigurationAssistantMutation,
} from '../../api/queries';
import type {
  AssistantFormState,
  ConfigurationAssistant,
  ConfigurationAssistantField,
  JobSource,
} from '../../api/contracts';
import {
  categoryLabel,
  directionLabel,
  OperationFeedback,
  profileLabel,
  useGenerationCopy,
  useGenerationLocale,
} from './shared';
import type { GenerationKey } from '../../locales/features/generation';
import {
  assistantValuesWithCandidates,
  candidateChoicesReady,
  chooseCandidate,
  initialCandidateChoices,
  localizedCandidateLabel,
  type CandidateChoices,
} from './formalGeneration';

interface AssistantPanelProps {
  targetSource: JobSource;
  currentForm: AssistantFormState;
  batchDraft: { id: number; revision: number } | null;
  onApply: (
    values: AssistantFormState,
    applied: ConfigurationAssistant,
  ) => void | Promise<void>;
}

const assistantFields: ConfigurationAssistantField[] = [
  'TargetDataset',
  'DisplayName',
  'Category',
  'ConflictDirection',
  'Model',
  'Precision',
  'ContentSelections',
  'PromptTemplateVersion',
  'Demographics',
  'GpuSlots',
  'Seeds',
  'Comparisons',
  'ExecutionMode',
];

function fieldProperty(field: ConfigurationAssistantField): keyof AssistantFormState {
  const mapping: Record<ConfigurationAssistantField, keyof AssistantFormState> = {
    TargetDataset: 'targetDataset',
    DisplayName: 'displayName',
    Category: 'category',
    ConflictDirection: 'conflictDirection',
    Model: 'model',
    Precision: 'precision',
    ContentSelections: 'contentSelections',
    PromptTemplateVersion: 'promptTemplateVersion',
    Demographics: 'demographics',
    GpuSlots: 'gpuSlots',
    Seeds: 'seeds',
    Comparisons: 'comparisons',
    ExecutionMode: 'executionMode',
  };
  return mapping[field];
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function changedFields(current: AssistantFormState, suggestion: AssistantFormState): ConfigurationAssistantField[] {
  return assistantFields.filter(field => {
    const property = fieldProperty(field);
    return property in suggestion && !sameValue(current[property], suggestion[property]);
  });
}

function selectedValues(
  suggestion: AssistantFormState,
  selected: readonly ConfigurationAssistantField[],
): AssistantFormState {
  const values: AssistantFormState = {};
  for (const field of selected) {
    const property = fieldProperty(field);
    Object.assign(values, { [property]: suggestion[property] });
  }
  return values;
}

export function AssistantPanel({
  targetSource,
  currentForm,
  batchDraft,
  onApply,
}: AssistantPanelProps) {
  const g = useGenerationCopy();
  const locale = useGenerationLocale();
  const create = useCreateConfigurationAssistantMutation();
  const apply = useApplyConfigurationAssistantMutation();
  const [requirement, setRequirement] = useState('');
  const [record, setRecord] = useState<ConfigurationAssistant | null>(null);
  const [selected, setSelected] = useState<ConfigurationAssistantField[]>([]);
  const [candidateChoices, setCandidateChoices] = useState<CandidateChoices>({
    Dataset: null,
    ContentScript: [],
    ShootingScene: [],
    PromptTemplateVersion: null,
  });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [localApplyError, setLocalApplyError] = useState(false);
  const production = targetSource === 'Production';
  const suggestion = record?.suggestion ?? null;
  const contentCandidates = suggestion?.candidates
    .find(group => group.kind === 'ContentScript')?.items ?? [];
  const candidateSceneQueries = useQueries({
    queries: contentCandidates.map(candidate => generationQueries.contentScenes(candidate.id)),
  });
  const scenesByContent = Object.fromEntries(
    contentCandidates.map((candidate, index) => [
      candidate.id,
      candidateSceneQueries[index]?.data?.scenes ?? [],
    ]),
  );
  const candidateValues = useMemo(
    () => suggestion === null
      ? {}
      : assistantValuesWithCandidates(
          suggestion.prefill,
          suggestion.candidates,
          candidateChoices,
          scenesByContent,
        ),
    [candidateChoices, scenesByContent, suggestion],
  );
  const changes = useMemo(
    () => suggestion === null ? [] : changedFields(currentForm, candidateValues),
    [candidateValues, currentForm, suggestion],
  );
  const candidatesReady = suggestion === null
    || (
      candidateSceneQueries.every(query => !query.isPending)
      && candidateChoicesReady(suggestion.candidates, candidateChoices, candidateValues)
    );

  useEffect(() => {
    setCandidateChoices(
      suggestion === null
        ? {
            Dataset: null,
            ContentScript: [],
            ShootingScene: [],
            PromptTemplateVersion: null,
          }
        : initialCandidateChoices(suggestion.candidates),
    );
  }, [record?.id]);

  useEffect(() => {
    setSelected(changes);
  }, [record?.id, JSON.stringify(candidateValues)]);

  const requestSuggestions = async () => {
    const clean = requirement.trim();
    if (!clean) return;
    try {
      const value = await create.mutateAsync({
        targetSource,
        userRequirement: clean,
        currentForm,
        batchDraftId: production ? batchDraft?.id : null,
        batchDraftExpectedRevision: production ? batchDraft?.revision : null,
      });
      setRecord(value);
      setLocalApplyError(false);
    } catch {
      return;
    }
  };

  const applySuggestion = async () => {
    if (record === null) return;
    const values = selectedValues(candidateValues, selected);
    const targetRevision = production
      ? batchDraft?.revision ?? null
      : record.testDraft?.revision;
    if ((!production && targetRevision === undefined) || !candidatesReady) return;
    let saved: ConfigurationAssistant;
    try {
      saved = await apply.mutateAsync({
        id: record.id,
        input: {
          expectedRevision: record.revision,
          expectedTargetRevision: targetRevision,
          confirmedFields: selected,
          values,
          createContentScript: false,
          createShootingScene: false,
          linkNewSceneToContent: false,
        },
      });
    } catch {
      return;
    }
    setRecord(saved);
    try {
      await onApply(saved.appliedValues ?? values, saved);
      setLocalApplyError(false);
      setConfirmOpen(false);
    } catch {
      setLocalApplyError(true);
    }
  };

  const summary = (field: ConfigurationAssistantField): string => {
    if (suggestion === null) return '';
    const value = candidateValues[fieldProperty(field)];
    if (field === 'Category' && value) return categoryLabel(g, value as NonNullable<AssistantFormState['category']>);
    if (field === 'ConflictDirection') return directionLabel(g, value as NonNullable<AssistantFormState['conflictDirection']> | null);
    if (field === 'Model') return profileLabel(value as NonNullable<AssistantFormState['model']> | null, candidateValues.precision ?? null);
    if (field === 'Precision') return String(value ?? g('common.none'));
    if (field === 'TargetDataset' || field === 'PromptTemplateVersion') {
      return (value as { label?: string | null } | null)?.label ?? g('common.none');
    }
    if (field === 'ContentSelections') {
      return (value as NonNullable<AssistantFormState['contentSelections']> | null)?.map(selection => {
        const content = selection.contentScript.label ?? String(selection.contentScript.id);
        const scenes = selection.scenes.map(scene => scene.label ?? String(scene.id)).join(', ');
        return content + ': ' + scenes;
      }).join('; ') ?? g('common.none');
    }
    if (field === 'Demographics') {
      return (value as NonNullable<AssistantFormState['demographics']> | null)?.map(person => [
        g(('demographic.age.' + person.age) as GenerationKey),
        g(('demographic.gender.' + person.gender) as GenerationKey),
        g(('demographic.ethnicity.' + person.ethnicity) as GenerationKey),
      ].join(', ')).join('; ') ?? g('common.none');
    }
    if (field === 'GpuSlots') {
      return (value as NonNullable<AssistantFormState['gpuSlots']> | null)?.map(slot =>
        g(('gpu.' + slot) as GenerationKey)).join(', ') ?? g('common.none');
    }
    if (field === 'Seeds') {
      return (value as NonNullable<AssistantFormState['seeds']> | null)?.join(', ') ?? g('common.none');
    }
    if (field === 'Comparisons') {
      return (value as NonNullable<AssistantFormState['comparisons']> | null)?.map(comparison =>
        profileLabel(comparison.model, comparison.precision) + ' ' + g(('gpu.' + comparison.gpuSlot) as GenerationKey)
      ).join(', ') ?? g('common.none');
    }
    if (field === 'ExecutionMode' && value) return g(value === 'Parallel' ? 'test.parallel' : 'test.serial');
    return String(value ?? g('common.none'));
  };

  const error = create.error ?? apply.error
    ?? candidateSceneQueries.find(query => query.error)?.error;
  const canAsk = requirement.trim().length > 0;
  const text = (value: string | null | undefined): string => value?.trim() || g('common.none');
  const localized = (zh: string, en: string): string => locale === 'zh-CN' ? zh : en;
  const contentDraft = suggestion?.newContentScriptDraft ?? null;
  const sceneDraft = suggestion?.newShootingSceneDraft ?? null;

  return (
    <section className="panel generation-assistant" aria-labelledby="assistant-title">
      <div className="section-header">
        <div>
          <h2 id="assistant-title">{g('assistant.title')}</h2>
          <p>{g(production ? 'assistant.productionHint' : 'assistant.testHint')}</p>
        </div>
      </div>
      <div className="generation-assistant__input">
        <Field
          label={g('assistant.input')}
          htmlFor="assistant-requirement"
        >
          <textarea
            id="assistant-requirement"
            value={requirement}
            placeholder={g(production ? 'assistant.placeholderProduction' : 'assistant.placeholderTest')}
            onChange={event => setRequirement(event.target.value)}
          />
        </Field>
        <Button
          variant="primary"
          busy={create.isPending}
          disabled={!canAsk}
          onClick={() => void requestSuggestions()}
        >
          {g('assistant.ask')}
        </Button>
      </div>
      {error ? <OperationFeedback error={error} onDismiss={() => { create.reset(); apply.reset(); }} /> : null}
      {localApplyError ? <p className="field__error" role="alert">{g('assistant.selectionChanged')}</p> : null}
      {record ? (
        <div className="generation-assistant__result">
          <p role="status">{g('assistant.saved')}</p>
          <section>
            <h3>{g('assistant.missing')}</h3>
            {record.suggestion.missingFields.length === 0 ? (
              <p>{g('assistant.noMissing')}</p>
            ) : (
              <ul>{record.suggestion.missingFields.map(field => (
                <li key={field}>{g(('assistant.field.' + field) as GenerationKey)}</li>
              ))}</ul>
            )}
          </section>
          <section>
            <h3>{g('assistant.candidates')}</h3>
            {record.suggestion.candidates.length === 0 ? <p>{g('common.none')}</p> : (
              <div className="generation-assistant__candidates">
                {record.suggestion.candidates.map(group => (
                  <fieldset key={group.kind}>
                    <legend>{g(('assistant.kind.' + group.kind) as GenerationKey)}</legend>
                    <ul>{group.items.map(item => {
                      const current = candidateChoices[group.kind];
                      const checked = Array.isArray(current)
                        ? current.includes(item.id)
                        : current === item.id;
                      const single = !production
                        || group.kind === 'Dataset'
                        || group.kind === 'PromptTemplateVersion';
                      return <li key={item.id}>
                        <label>
                          <input
                            type={single ? 'radio' : 'checkbox'}
                            name={single ? 'assistant-' + record.id + '-' + group.kind : undefined}
                            checked={checked}
                            onChange={() => setCandidateChoices(value => {
                              if (production) return chooseCandidate(value, group.kind, item.id);
                              if (group.kind === 'ContentScript' || group.kind === 'ShootingScene') {
                                return { ...value, [group.kind]: [item.id] };
                              }
                              return { ...value, [group.kind]: item.id };
                            })}
                          />
                          <span>{localizedCandidateLabel(group.kind, item.label, locale)}</span>
                        </label>
                        {group.items.length === 1 ? <StatusBadge label={g('assistant.unique')} kind="complete" /> : null}
                      </li>;
                    })}</ul>
                  </fieldset>
                ))}
              </div>
            )}
            {!candidatesReady ? <p className="field__error" role="alert">{g('assistant.candidatesIncomplete')}</p> : null}
          </section>
          <section>
            <h3>{g('assistant.changes')}</h3>
            {changes.length === 0 ? <p>{g('assistant.noChanges')}</p> : (
              <ul className="generation-assistant__changes">
                {changes.map(field => (
                  <li key={field}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.includes(field)}
                        onChange={() => setSelected(values =>
                          values.includes(field)
                            ? values.filter(value => value !== field)
                            : [...values, field],
                        )}
                      />
                      <span><strong>{g(('assistant.field.' + field) as GenerationKey)}</strong>{summary(field)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {record.suggestion.failureAdvice.length > 0 ? (
            <section><h3>{g('assistant.advice')}</h3><ul>{record.suggestion.failureAdvice.map(value => <li key={value}>{value}</li>)}</ul></section>
          ) : null}
          {contentDraft || sceneDraft ? (
            <fieldset className="generation-assistant__drafts">
              <legend>{g('assistant.proposedDrafts')}</legend>
              {contentDraft ? (
                <section className="generation-assistant__draft-detail">
                  <h4>{g('assistant.proposedContent')}</h4>
                  <dl>
                    <div><dt>{g('assistant.draft.name')}</dt><dd>{localized(contentDraft.nameZh, contentDraft.nameEn)}</dd></div>
                    <div><dt>{g('assistant.draft.category')}</dt><dd>{categoryLabel(g, contentDraft.category)}</dd></div>
                    <div><dt>{g('assistant.draft.direction')}</dt><dd>{directionLabel(g, contentDraft.conflictDirection)}</dd></div>
                    <div><dt>{g('assistant.draft.mode')}</dt><dd>{g(('assistant.mode.' + contentDraft.mode) as GenerationKey)}</dd></div>
                    <div><dt>{g('assistant.draft.status')}</dt><dd>{g('assistant.status.Draft')}</dd></div>
                    <div><dt>{g('assistant.draft.trueEmotion')}</dt><dd>{text(contentDraft.trueEmotion)}</dd></div>
                    <div><dt>{g('assistant.draft.apparentEmotion')}</dt><dd>{text(contentDraft.apparentEmotion)}</dd></div>
                    <div><dt>{g('assistant.draft.setting')}</dt><dd>{text(localized(contentDraft.sceneZh, contentDraft.sceneEn))}</dd></div>
                    <div><dt>{g('assistant.draft.trigger')}</dt><dd>{text(localized(contentDraft.triggerEventZh, contentDraft.triggerEventEn))}</dd></div>
                    <div><dt>{g('assistant.draft.background')}</dt><dd>{text(localized(contentDraft.psychologicalBackgroundZh, contentDraft.psychologicalBackgroundEn))}</dd></div>
                    <div><dt>{g('assistant.draft.dialogue')}</dt><dd>{text(contentDraft.dialogue)}</dd></div>
                    <div><dt>{g('assistant.draft.displayText')}</dt><dd>{text(contentDraft.displayText)}</dd></div>
                    <div><dt>{g('assistant.draft.emotionDescription')}</dt><dd>{text(contentDraft.trueEmotionDescription)}</dd></div>
                    <div><dt>{g('assistant.draft.basePrompt')}</dt><dd>{text(contentDraft.baseVideoPrompt)}</dd></div>
                    <div><dt>{g('assistant.draft.requirements')}</dt><dd>{text(localized(contentDraft.contentRequirementsZh, contentDraft.contentRequirementsEn))}</dd></div>
                    <div><dt>{g('assistant.draft.supplement')}</dt><dd>{text(localized(contentDraft.sceneSupplementZh, contentDraft.sceneSupplementEn))}</dd></div>
                    <div><dt>{g('assistant.draft.allowedScenes')}</dt><dd>{g('common.selected', { count: contentDraft.sceneIds.length })}</dd></div>
                  </dl>
                </section>
              ) : null}
              {sceneDraft ? (
                <section className="generation-assistant__draft-detail">
                  <h4>{g('assistant.proposedScene')}</h4>
                  <dl>
                    <div><dt>{g('assistant.draft.name')}</dt><dd>{localized(sceneDraft.nameZh, sceneDraft.nameEn)}</dd></div>
                    <div><dt>{g('assistant.draft.status')}</dt><dd>{g('assistant.status.Draft')}</dd></div>
                    <div><dt>{g('assistant.draft.setting')}</dt><dd>{text(localized(sceneDraft.sceneZh, sceneDraft.sceneEn))}</dd></div>
                    <div><dt>{g('assistant.draft.ambient')}</dt><dd>{text(localized(sceneDraft.ambientSoundZh, sceneDraft.ambientSoundEn))}</dd></div>
                    <div><dt>{g('assistant.draft.relationship')}</dt><dd>{text(localized(sceneDraft.participantRelationshipZh, sceneDraft.participantRelationshipEn))}</dd></div>
                    <div><dt>{g('assistant.draft.lighting')}</dt><dd>{text(localized(sceneDraft.lightingZh, sceneDraft.lightingEn))}</dd></div>
                    <div><dt>{g('assistant.draft.framing')}</dt><dd>{text(localized(sceneDraft.framingZh, sceneDraft.framingEn))}</dd></div>
                  </dl>
                </section>
              ) : null}
            </fieldset>
          ) : null}
          <Button
            variant="secondary"
            disabled={!candidatesReady || record.status !== 'Pending' || selected.length === 0 || apply.isPending}
            onClick={() => {
              setLocalApplyError(false);
              setConfirmOpen(true);
            }}
          >
            {g('assistant.apply')}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmOpen}
        title={g('assistant.applyTitle')}
        body={g('assistant.applyBody')}
        confirmLabel={g('common.apply')}
        cancelLabel={g('common.cancel')}
        closeLabel={g('common.close')}
        onConfirm={() => void applySuggestion()}
        onClose={() => setConfirmOpen(false)}
        busy={apply.isPending}
      />
    </section>
  );
}
