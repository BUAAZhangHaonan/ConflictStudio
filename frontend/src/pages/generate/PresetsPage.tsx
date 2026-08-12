import { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, Field, StatusBadge, useToast } from '../../components';
import {
  useCreatePromptPresetMutation,
  useDeletePromptPresetMutation,
  usePromptPresetsQuery,
  useUpdatePromptPresetMutation,
} from '../../api/queries';
import type { PromptPreset, PromptPresetCreate, ResourceStatus } from '../../api/contracts';
import type { Category } from '../../types';
import { formatDateTime } from '../../time';
import {
  categories,
  categoryLabel,
  GenerationScaffold,
  lines,
  OperationFeedback,
  readGenerationDraft,
  useCommandEnter,
  useGenerationCopy,
  useGenerationDraft,
  useUnsavedChanges,
} from './shared';

const fixedStructureRules = ['presets.rule.subject', 'presets.rule.signal', 'presets.rule.camera'] as const;

export function emptyPromptPreset(): PromptPresetCreate {
  return {
    name: '',
    category: 'A-VA',
    styleGuidance: '',
    sceneSupplement: '',
    positiveExamples: [],
    negativeExamples: [],
    finalRenderNegativeConstraints: '',
    status: 'Active',
  };
}

function presetInput(item: PromptPreset): PromptPresetCreate {
  const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = item;
  return input;
}

export function promptPresetPayloadIsValid(value: PromptPresetCreate): boolean {
  return Boolean(value.name.trim() && value.finalRenderNegativeConstraints.trim());
}

interface StoredPresetDraft {
  creating: boolean;
  selectedId: number | null;
  draft: PromptPresetCreate;
}

export function PresetsPage() {
  const g = useGenerationCopy();
  const { showToast } = useToast();
  const query = usePromptPresetsQuery();
  const createMutation = useCreatePromptPresetMutation();
  const updateMutation = useUpdatePromptPresetMutation();
  const deleteMutation = useDeletePromptPresetMutation();
  const stored = useState(() => readGenerationDraft<StoredPresetDraft>('preset-editor'))[0];
  const [selectedId, setSelectedId] = useState<number | null>(stored?.selectedId ?? null);
  const [creating, setCreating] = useState(stored?.creating ?? false);
  const [draft, setDraft] = useState<PromptPresetCreate>(stored?.draft ?? emptyPromptPreset());
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<Category | 'All'>('All');
  const [validation, setValidation] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<number | 'new' | null>(null);
  const items = query.data ?? [];
  const selected = items.find(item => item.id === selectedId) ?? null;
  const error = createMutation.error ?? updateMutation.error ?? deleteMutation.error ?? null;

  useEffect(() => {
    if (creating || items.length === 0) return;
    const next = selected ?? items[0];
    setSelectedId(next.id);
    setDraft(presetInput(next));
  }, [creating, items, selected]);

  const filtered = useMemo(() => {
    const value = search.trim().toLocaleLowerCase();
    return items.filter(item =>
      (categoryFilter === 'All' || item.category === categoryFilter)
      && (value === '' || item.name.toLocaleLowerCase().includes(value)),
    );
  }, [categoryFilter, items, search]);

  const dirty = creating
    ? JSON.stringify(draft) !== JSON.stringify(emptyPromptPreset())
    : selected !== null && JSON.stringify(draft) !== JSON.stringify(presetInput(selected));

  const applySelection = (next: number | 'new') => {
    if (next === 'new') {
      setCreating(true);
      setSelectedId(null);
      setDraft(emptyPromptPreset());
    } else {
      const value = items.find(item => item.id === next);
      if (!value) return;
      setCreating(false);
      setSelectedId(value.id);
      setDraft(presetInput(value));
    }
    setValidation(false);
    createMutation.reset();
    updateMutation.reset();
    deleteMutation.reset();
  };

  const requestSelection = (next: number | 'new') => dirty ? setPendingSelection(next) : applySelection(next);

  const save = async () => {
    if (!promptPresetPayloadIsValid(draft)) {
      setValidation(true);
      return;
    }
    setValidation(false);
    try {
      const value = creating || !selected
        ? await createMutation.mutateAsync(draft)
        : await updateMutation.mutateAsync({
            id: selected.id,
            input: {
              expectedRevision: selected.revision,
              name: draft.name,
              styleGuidance: draft.styleGuidance,
              sceneSupplement: draft.sceneSupplement,
              positiveExamples: draft.positiveExamples,
              negativeExamples: draft.negativeExamples,
              finalRenderNegativeConstraints: draft.finalRenderNegativeConstraints,
              status: draft.status,
            },
          });
      setCreating(false);
      setSelectedId(value.id);
      setDraft(presetInput(value));
      showToast(g('presets.saved'));
    } catch {
      // The shared safe error panel renders mutation errors.
    }
  };

  const remove = async () => {
    if (!selected) return;
    try {
      await deleteMutation.mutateAsync({ id: selected.id, expectedRevision: selected.revision });
      setDeleteOpen(false);
      const next = items.find(item => item.id !== selected.id);
      if (next) applySelection(next.id);
      else applySelection('new');
    } catch {
      setDeleteOpen(false);
    }
  };

  useGenerationDraft('preset-editor', { creating, selectedId, draft }, dirty);
  const unsavedDialog = useUnsavedChanges(dirty);
  useCommandEnter(() => void save(), !createMutation.isPending && !updateMutation.isPending);

  if (query.isPending) return <GenerationScaffold title="presets.title" subtitle="presets.subtitle"><p role="status">{g('state.loadingBody')}</p></GenerationScaffold>;
  if (query.isError) return <GenerationScaffold title="presets.title" subtitle="presets.subtitle"><OperationFeedback error={query.error} onDismiss={() => void query.refetch()} /></GenerationScaffold>;

  return (
    <GenerationScaffold title="presets.title" subtitle="presets.subtitle" action={<Button variant="primary" onClick={() => requestSelection('new')}>{g('presets.new')}</Button>}>
      {error ? <OperationFeedback error={error} onDismiss={() => { createMutation.reset(); updateMutation.reset(); deleteMutation.reset(); }} /> : null}
      <div className="generation-layout generation-layout--editor">
        <section className="panel generation-list" aria-labelledby="preset-list-title">
          <div className="section-header"><h2 id="preset-list-title">{g('presets.list')}</h2></div>
          <div className="generation-filters">
            <Field label={g('common.search')} htmlFor="preset-search"><input id="preset-search" type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
            <Field label={g('presets.categoryFilter')} htmlFor="preset-category-filter"><select id="preset-category-filter" value={categoryFilter} onChange={event => setCategoryFilter(event.target.value as Category | 'All')}><option value="All">{g('common.all')}</option>{categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}</select></Field>
          </div>
          {filtered.length === 0 ? <p className="generation-empty-note">{g(items.length === 0 ? 'presets.empty' : 'presets.filtered')}</p> : <ul className="generation-selection-list" aria-label={g('presets.tableCaption')}>{filtered.map(item => <li key={item.id}><button type="button" className={!creating && item.id === selectedId ? 'generation-selection-card generation-selection-card--preset is-selected' : 'generation-selection-card generation-selection-card--preset'} aria-pressed={!creating && item.id === selectedId} onClick={() => requestSelection(item.id)}><span className="generation-selection-card__title"><strong>{item.name}</strong><StatusBadge label={g(item.status === 'Active' ? 'content.status.Active' : 'content.status.Disabled')} kind={item.status === 'Active' ? 'complete' : 'problem'} /></span><span>{categoryLabel(g, item.category)}</span><time dateTime={item.updatedAt}>{formatDateTime(item.updatedAt)}</time></button></li>)}</ul>}
        </section>
        <section className="panel generation-form generation-editor" aria-label={g('presets.editorRegion')}>
          <div className="section-header"><h2>{g(creating ? 'presets.createTitle' : 'presets.editor')}</h2></div>
          <div className="generation-form__grid">
            <Field label={g('presets.name')} htmlFor="preset-name" required><input id="preset-name" value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></Field>
            <Field label={g('content.status')} htmlFor="preset-status"><select id="preset-status" value={draft.status} onChange={event => setDraft(current => ({ ...current, status: event.target.value as ResourceStatus }))}><option value="Active">{g('content.status.Active')}</option><option value="Disabled">{g('content.status.Disabled')}</option></select></Field>
            <Field label={g('presets.category')} htmlFor="preset-category" required><select id="preset-category" value={draft.category} disabled={!creating} onChange={event => setDraft(current => ({ ...current, category: event.target.value as Category }))}>{categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}</select></Field>
            <div className="generation-form__wide"><strong>{g('presets.fixedRules')}</strong><ol className="generation-editor__rules">{fixedStructureRules.map(rule => <li key={rule}>{g(rule)}</li>)}</ol></div>
            <Field className="generation-form__wide" label={g('presets.style')} htmlFor="preset-style"><textarea id="preset-style" value={draft.styleGuidance} onChange={event => setDraft(current => ({ ...current, styleGuidance: event.target.value }))} /></Field>
            <Field className="generation-form__wide" label={g('presets.sceneSupplement')} htmlFor="preset-scene"><textarea id="preset-scene" value={draft.sceneSupplement} onChange={event => setDraft(current => ({ ...current, sceneSupplement: event.target.value }))} /></Field>
            <Field className="generation-form__wide" label={g('presets.positive')} htmlFor="preset-positive"><textarea id="preset-positive" value={draft.positiveExamples.join('\n')} onChange={event => setDraft(current => ({ ...current, positiveExamples: lines(event.target.value) }))} /></Field>
            <Field className="generation-form__wide" label={g('presets.negative')} htmlFor="preset-negative"><textarea id="preset-negative" value={draft.negativeExamples.join('\n')} onChange={event => setDraft(current => ({ ...current, negativeExamples: lines(event.target.value) }))} /></Field>
            <Field className="generation-form__wide" label={g('presets.constraints')} htmlFor="preset-constraints" required><textarea id="preset-constraints" value={draft.finalRenderNegativeConstraints} onChange={event => setDraft(current => ({ ...current, finalRenderNegativeConstraints: event.target.value }))} /></Field>
          </div>
          {validation ? <p className="field__error" role="alert">{g('presets.validation')}</p> : null}
          <div className="generation-form__actions">{!creating ? <Button className="button--danger" disabled={draft.status !== 'Disabled'} onClick={() => setDeleteOpen(true)}>{g('content.delete')}</Button> : null}<Button variant="primary" disabled={createMutation.isPending || updateMutation.isPending} onClick={() => void save()}>{g('common.save')}</Button></div>
          <p className="generation-shortcut-hint">{g('presets.saveShortcut')}</p>
        </section>
      </div>
      {unsavedDialog}
      <ConfirmDialog open={deleteOpen} title={g('content.deleteTitle')} body={selected ? g('content.deleteBody', { name: selected.name }) : g('content.deleteUnavailable')} confirmLabel={g('content.delete')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => void remove()} onClose={() => setDeleteOpen(false)} />
      <ConfirmDialog open={pendingSelection !== null} title={g('presets.discardTitle')} body={g('presets.discardBody')} confirmLabel={g('presets.discard')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => { if (pendingSelection !== null) applySelection(pendingSelection); setPendingSelection(null); }} onClose={() => setPendingSelection(null)} />
    </GenerationScaffold>
  );
}
