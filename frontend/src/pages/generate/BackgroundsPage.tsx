import { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, Field, StatusBadge, useToast } from '../../components';
import {
  useBackgroundPresetsQuery,
  useCreateBackgroundPresetMutation,
  useDeleteBackgroundPresetMutation,
  useUpdateBackgroundPresetMutation,
} from '../../api/queries';
import type { BackgroundPreset, BackgroundPresetCreate, ResourceStatus } from '../../api/contracts';
import { formatDateTime } from '../../time';
import {
  GenerationScaffold,
  OperationFeedback,
  readGenerationDraft,
  useCommandEnter,
  useGenerationCopy,
  useGenerationDraft,
  useUnsavedChanges,
} from './shared';

export function emptyBackgroundPreset(): BackgroundPresetCreate {
  return {
    name: '',
    scene: '',
    ambientSound: '',
    participantRelationship: '',
    lighting: '',
    framing: '',
    status: 'Active',
  };
}

function backgroundInput(item: BackgroundPreset): BackgroundPresetCreate {
  const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = item;
  return input;
}

interface StoredBackgroundDraft {
  creating: boolean;
  selectedId: number | null;
  draft: BackgroundPresetCreate;
}

export function BackgroundsPage() {
  const g = useGenerationCopy();
  const { showToast } = useToast();
  const query = useBackgroundPresetsQuery();
  const createMutation = useCreateBackgroundPresetMutation();
  const updateMutation = useUpdateBackgroundPresetMutation();
  const deleteMutation = useDeleteBackgroundPresetMutation();
  const stored = useState(() => readGenerationDraft<StoredBackgroundDraft>('background-editor'))[0];
  const [selectedId, setSelectedId] = useState<number | null>(stored?.selectedId ?? null);
  const [creating, setCreating] = useState(stored?.creating ?? false);
  const [draft, setDraft] = useState<BackgroundPresetCreate>(stored?.draft ?? emptyBackgroundPreset());
  const [search, setSearch] = useState('');
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
    setDraft(backgroundInput(next));
  }, [creating, items, selected]);

  const filtered = useMemo(() => {
    const value = search.trim().toLocaleLowerCase();
    return items.filter(item => value === '' || `${item.name} ${item.scene}`.toLocaleLowerCase().includes(value));
  }, [items, search]);
  const dirty = creating
    ? JSON.stringify(draft) !== JSON.stringify(emptyBackgroundPreset())
    : selected !== null && JSON.stringify(draft) !== JSON.stringify(backgroundInput(selected));

  const applySelection = (next: number | 'new') => {
    if (next === 'new') {
      setCreating(true);
      setSelectedId(null);
      setDraft(emptyBackgroundPreset());
    } else {
      const value = items.find(item => item.id === next);
      if (!value) return;
      setCreating(false);
      setSelectedId(value.id);
      setDraft(backgroundInput(value));
    }
    setValidation(false);
    createMutation.reset();
    updateMutation.reset();
    deleteMutation.reset();
  };
  const requestSelection = (next: number | 'new') => dirty ? setPendingSelection(next) : applySelection(next);

  const save = async () => {
    if (!draft.name.trim() || !draft.scene.trim()) {
      setValidation(true);
      return;
    }
    setValidation(false);
    try {
      const value = creating || !selected
        ? await createMutation.mutateAsync(draft)
        : await updateMutation.mutateAsync({ id: selected.id, input: { ...draft, expectedRevision: selected.revision } });
      setCreating(false);
      setSelectedId(value.id);
      setDraft(backgroundInput(value));
      showToast(g('backgrounds.saved'));
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

  useGenerationDraft('background-editor', { creating, selectedId, draft }, dirty);
  const unsavedDialog = useUnsavedChanges(dirty);
  useCommandEnter(() => void save(), !createMutation.isPending && !updateMutation.isPending);

  if (query.isPending) return <GenerationScaffold title="backgrounds.title" subtitle="backgrounds.subtitle"><p role="status">{g('state.loadingBody')}</p></GenerationScaffold>;
  if (query.isError) return <GenerationScaffold title="backgrounds.title" subtitle="backgrounds.subtitle"><OperationFeedback error={query.error} onDismiss={() => void query.refetch()} /></GenerationScaffold>;

  return (
    <GenerationScaffold title="backgrounds.title" subtitle="backgrounds.subtitle" action={<Button variant="primary" onClick={() => requestSelection('new')}>{g('backgrounds.new')}</Button>}>
      {error ? <OperationFeedback error={error} onDismiss={() => { createMutation.reset(); updateMutation.reset(); deleteMutation.reset(); }} /> : null}
      <div className="generation-layout generation-layout--editor">
        <section className="panel generation-list" aria-labelledby="background-list-title">
          <div className="section-header"><h2 id="background-list-title">{g('backgrounds.list')}</h2></div>
          <Field label={g('common.search')} htmlFor="background-search"><input id="background-search" type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
          {filtered.length === 0 ? <p className="generation-empty-note">{g(items.length === 0 ? 'backgrounds.empty' : 'backgrounds.filtered')}</p> : <ul className="generation-selection-list" aria-label={g('backgrounds.list')}>{filtered.map(item => <li key={item.id}><button type="button" className={!creating && item.id === selectedId ? 'generation-selection-card is-selected' : 'generation-selection-card'} aria-pressed={!creating && item.id === selectedId} onClick={() => requestSelection(item.id)}><span className="generation-selection-card__title"><strong>{item.name}</strong><StatusBadge label={g(item.status === 'Active' ? 'content.status.Active' : 'content.status.Disabled')} kind={item.status === 'Active' ? 'complete' : 'problem'} /></span><span>{item.scene}</span><time dateTime={item.updatedAt}>{formatDateTime(item.updatedAt)}</time></button></li>)}</ul>}
        </section>
        <section className="panel generation-form generation-editor" aria-label={g('backgrounds.editor')}>
          <div className="section-header"><h2>{g(creating ? 'backgrounds.createTitle' : 'backgrounds.editor')}</h2></div>
          <div className="generation-form__grid">
            <Field label={g('backgrounds.name')} htmlFor="background-name" required><input id="background-name" value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></Field>
            <Field label={g('content.status')} htmlFor="background-status"><select id="background-status" value={draft.status} onChange={event => setDraft(current => ({ ...current, status: event.target.value as ResourceStatus }))}><option value="Active">{g('content.status.Active')}</option><option value="Disabled">{g('content.status.Disabled')}</option></select></Field>
            <Field className="generation-form__wide" label={g('backgrounds.scene')} htmlFor="background-scene" required><textarea id="background-scene" value={draft.scene} onChange={event => setDraft(current => ({ ...current, scene: event.target.value }))} /></Field>
            <Field className="generation-form__wide" label={g('backgrounds.ambientSound')} htmlFor="background-sound"><textarea id="background-sound" value={draft.ambientSound} onChange={event => setDraft(current => ({ ...current, ambientSound: event.target.value }))} /></Field>
            <Field className="generation-form__wide" label={g('backgrounds.participantRelationship')} htmlFor="background-relationship"><textarea id="background-relationship" value={draft.participantRelationship} onChange={event => setDraft(current => ({ ...current, participantRelationship: event.target.value }))} /></Field>
            <Field className="generation-form__wide" label={g('backgrounds.lighting')} htmlFor="background-lighting"><textarea id="background-lighting" value={draft.lighting} onChange={event => setDraft(current => ({ ...current, lighting: event.target.value }))} /></Field>
            <Field className="generation-form__wide" label={g('backgrounds.framing')} htmlFor="background-framing"><textarea id="background-framing" value={draft.framing} onChange={event => setDraft(current => ({ ...current, framing: event.target.value }))} /></Field>
          </div>
          {validation ? <p className="field__error" role="alert">{g('backgrounds.validation')}</p> : null}
          <div className="generation-form__actions">{!creating ? <Button className="button--danger" disabled={draft.status !== 'Disabled'} onClick={() => setDeleteOpen(true)}>{g('content.delete')}</Button> : null}<Button variant="primary" disabled={createMutation.isPending || updateMutation.isPending} onClick={() => void save()}>{g('common.save')}</Button></div>
        </section>
      </div>
      {unsavedDialog}
      <ConfirmDialog open={deleteOpen} title={g('content.deleteTitle')} body={selected ? g('content.deleteBody', { name: selected.name }) : g('content.deleteUnavailable')} confirmLabel={g('content.delete')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => void remove()} onClose={() => setDeleteOpen(false)} />
      <ConfirmDialog open={pendingSelection !== null} title={g('content.discardTitle')} body={g('content.discardBody')} confirmLabel={g('content.discard')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => { if (pendingSelection !== null) applySelection(pendingSelection); setPendingSelection(null); }} onClose={() => setPendingSelection(null)} />
    </GenerationScaffold>
  );
}
