import { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, Field, StatusBadge } from '../../components';
import {
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
} from './shared';
import type { GenerationKey } from '../../locales/features/generation';

interface AssistantPanelProps {
  targetSource: JobSource;
  currentForm: AssistantFormState;
  batchDraft: { id: number; revision: number } | null;
  onApply: (values: AssistantFormState) => void | Promise<void>;
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
  const create = useCreateConfigurationAssistantMutation();
  const apply = useApplyConfigurationAssistantMutation();
  const [requirement, setRequirement] = useState('');
  const [record, setRecord] = useState<ConfigurationAssistant | null>(null);
  const [selected, setSelected] = useState<ConfigurationAssistantField[]>([]);
  const [createContent, setCreateContent] = useState(false);
  const [createScene, setCreateScene] = useState(false);
  const [linkDrafts, setLinkDrafts] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [localApplyError, setLocalApplyError] = useState(false);
  const production = targetSource === 'Production';
  const suggestion = record?.suggestion ?? null;
  const changes = useMemo(
    () => suggestion === null ? [] : changedFields(currentForm, suggestion.prefill),
    [currentForm, suggestion],
  );

  useEffect(() => {
    setSelected(changes);
  }, [record?.id]);

  const requestSuggestions = async () => {
    const clean = requirement.trim();
    if (!clean || (production && batchDraft === null)) return;
    try {
      const value = await create.mutateAsync({
        targetSource,
        userRequirement: clean,
        currentForm,
        batchDraftId: production ? batchDraft?.id : null,
        batchDraftExpectedRevision: production ? batchDraft?.revision : null,
      });
      setRecord(value);
      setCreateContent(false);
      setCreateScene(false);
      setLinkDrafts(false);
      setLocalApplyError(false);
    } catch {
      return;
    }
  };

  const applySuggestion = async () => {
    if (record === null) return;
    const values = selectedValues(record.suggestion.prefill, selected);
    const createAny = createContent || createScene;
    if (production && !createAny) {
      try {
        await onApply(values);
        setLocalApplyError(false);
        setConfirmOpen(false);
      } catch {
        setLocalApplyError(true);
      }
      return;
    }
    const targetRevision = production
      ? batchDraft?.revision
      : record.testDraft?.revision;
    if (targetRevision === undefined) return;
    let saved: ConfigurationAssistant;
    try {
      saved = await apply.mutateAsync({
        id: record.id,
        input: {
          expectedRevision: record.revision,
          expectedTargetRevision: targetRevision,
          confirmedFields: production ? [] : selected,
          values: production ? {} : values,
          createContentScript: createContent,
          createShootingScene: createScene,
          linkNewSceneToContent: linkDrafts,
        },
      });
    } catch {
      return;
    }
    setRecord(saved);
    try {
      await onApply(values);
      setLocalApplyError(false);
      setConfirmOpen(false);
    } catch {
      setLocalApplyError(true);
    }
  };

  const summary = (field: ConfigurationAssistantField): string => {
    if (suggestion === null) return '';
    const value = suggestion.prefill[fieldProperty(field)];
    if (field === 'Category' && value) return categoryLabel(g, value as NonNullable<AssistantFormState['category']>);
    if (field === 'ConflictDirection') return directionLabel(g, value as NonNullable<AssistantFormState['conflictDirection']> | null);
    if (field === 'Model') return profileLabel(value as NonNullable<AssistantFormState['model']> | null, suggestion.prefill.precision ?? null);
    if (field === 'Precision') return String(value ?? g('common.none'));
    if (field === 'TargetDataset' || field === 'PromptTemplateVersion') {
      return (value as { label?: string | null } | null)?.label ?? g('common.none');
    }
    if (field === 'ContentSelections' || field === 'Demographics' || field === 'GpuSlots' || field === 'Seeds' || field === 'Comparisons') {
      return g('common.selected', { count: Array.isArray(value) ? value.length : 0 });
    }
    if (field === 'ExecutionMode' && value) return g(value === 'Parallel' ? 'test.parallel' : 'test.serial');
    return String(value ?? g('common.none'));
  };

  const error = create.error ?? apply.error;
  const canAsk = requirement.trim().length > 0 && (!production || batchDraft !== null);

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
          hint={production && batchDraft === null ? g('assistant.productionBlocked') : undefined}
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
                  <div key={group.kind}>
                    <strong>{g(('assistant.kind.' + group.kind) as GenerationKey)}</strong>
                    <ul>{group.items.map(item => (
                      <li key={item.id}>
                        <span>{item.label}</span>
                        {group.items.length === 1 ? <StatusBadge label={g('assistant.unique')} kind="complete" /> : null}
                      </li>
                    ))}</ul>
                  </div>
                ))}
              </div>
            )}
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
          {record.suggestion.newContentScriptDraft || record.suggestion.newShootingSceneDraft ? (
            <fieldset className="generation-assistant__drafts">
              <legend>{g('assistant.createDrafts')}</legend>
              {record.suggestion.newContentScriptDraft ? (
                <label><input type="checkbox" checked={createContent} onChange={event => setCreateContent(event.target.checked)} />{g('assistant.createContent')}</label>
              ) : null}
              {record.suggestion.newShootingSceneDraft ? (
                <label><input type="checkbox" checked={createScene} onChange={event => setCreateScene(event.target.checked)} />{g('assistant.createScene')}</label>
              ) : null}
              {createContent && createScene ? (
                <label><input type="checkbox" checked={linkDrafts} onChange={event => setLinkDrafts(event.target.checked)} />{g('assistant.linkDrafts')}</label>
              ) : null}
            </fieldset>
          ) : null}
          <Button
            variant="secondary"
            disabled={(selected.length === 0 && !createContent && !createScene) || apply.isPending}
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
        title={createContent || createScene ? g('assistant.createTitle') : g('assistant.applyTitle')}
        body={createContent || createScene ? g('assistant.createBody') : g('assistant.applyBody')}
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
