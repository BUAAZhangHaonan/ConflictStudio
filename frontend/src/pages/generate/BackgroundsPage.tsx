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
  localizedName,
  OperationFeedback,
  readGenerationDraft,
  useCommandEnter,
  useGenerationCopy,
  useGenerationDraft,
  useGenerationLocale,
  useUnsavedChanges,
} from './shared';

export function emptyBackgroundPreset(): BackgroundPresetCreate {
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
  const locale = useGenerationLocale();
  const { showToast } = useToast();
  const query = useBackgroundPresetsQuery();
  const createMutation = useCreateBackgroundPresetMutation();
  const updateMutation = useUpdateBackgroundPresetMutation();
  const deleteMutation = useDeleteBackgroundPresetMutation();
  const stored = useState(() => readGenerationDraft<StoredBackgroundDraft>('background-editor-bilingual'))[0];
  const [selectedId, setSelectedId] = useState<number | null>(stored?.selectedId ?? null);
  const [creating, setCreating] = useState(stored?.creating ?? false);
  const [draft, setDraft] = useState<BackgroundPresetCreate>(stored?.draft ?? emptyBackgroundPreset());
  const [search, setSearch] = useState('');
  const [validation, setValidation] = useState(false);
  const [mobileEditor, setMobileEditor] = useState(false);
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
    return items.filter(item => value === '' || [
      item.nameZh,
      item.nameEn,
      item.sceneZh,
      item.sceneEn,
    ].join(' ').toLocaleLowerCase().includes(value));
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
    setMobileEditor(true);
    createMutation.reset();
    updateMutation.reset();
    deleteMutation.reset();
  };
  const requestSelection = (next: number | 'new') => dirty ? setPendingSelection(next) : applySelection(next);

  const save = async () => {
    if (!draft.nameZh.trim() || !draft.nameEn.trim() || !draft.sceneZh.trim() || !draft.sceneEn.trim()) {
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

  useGenerationDraft('background-editor-bilingual', { creating, selectedId, draft }, dirty);
  const unsavedDialog = useUnsavedChanges(dirty);
  useCommandEnter(() => void save(), !createMutation.isPending && !updateMutation.isPending);

  if (query.isPending) return <GenerationScaffold title="backgrounds.title" subtitle="backgrounds.subtitle"><p role="status">{g('state.loadingBody')}</p></GenerationScaffold>;
  if (query.isError) return <GenerationScaffold title="backgrounds.title" subtitle="backgrounds.subtitle"><OperationFeedback error={query.error} onDismiss={() => void query.refetch()} /></GenerationScaffold>;

  return (
    <GenerationScaffold title="backgrounds.title" subtitle="backgrounds.subtitle" action={<Button variant="primary" onClick={() => requestSelection('new')}>{g('backgrounds.new')}</Button>}>
      {error ? <OperationFeedback error={error} onDismiss={() => { createMutation.reset(); updateMutation.reset(); deleteMutation.reset(); }} /> : null}
      <div className={`generation-layout generation-layout--editor${mobileEditor ? ' generation-layout--mobile-editor' : ''}`}>
        <section className="panel generation-list" aria-labelledby="background-list-title">
          <div className="section-header"><h2 id="background-list-title">{g('backgrounds.list')}</h2></div>
          <Field label={g('common.search')} htmlFor="background-search"><input id="background-search" type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
          {filtered.length === 0 ? <p className="generation-empty-note">{g(items.length === 0 ? 'backgrounds.empty' : 'backgrounds.filtered')}</p> : <ul className="generation-selection-list" aria-label={g('backgrounds.list')}>{filtered.map(item => <li key={item.id}><button type="button" className={!creating && item.id === selectedId ? 'generation-selection-card is-selected' : 'generation-selection-card'} aria-pressed={!creating && item.id === selectedId} onClick={() => requestSelection(item.id)}><span className="generation-selection-card__title"><strong>{localizedName(locale, item)}</strong><StatusBadge label={g(item.status === 'Active' ? 'content.status.Active' : 'content.status.Disabled')} kind={item.status === 'Active' ? 'complete' : 'problem'} /></span><span>{locale === 'zh-CN' ? item.sceneZh : item.sceneEn}</span><time dateTime={item.updatedAt}>{formatDateTime(item.updatedAt)}</time></button></li>)}</ul>}
        </section>
        <section className="panel generation-form generation-editor" aria-label={g('backgrounds.editor')}>
          <div className="section-header generation-editor__heading"><Button className="generation-editor-back" variant="quiet" onClick={() => setMobileEditor(false)}>{g('common.backToList')}</Button><h2>{g(creating ? 'backgrounds.createTitle' : 'backgrounds.editor')}</h2></div>
          <div className="generation-form__grid">
            <Field label={g('content.status')} htmlFor="background-status"><select id="background-status" value={draft.status} onChange={event => setDraft(current => ({ ...current, status: event.target.value as ResourceStatus }))}><option value="Active">{g('content.status.Active')}</option><option value="Disabled">{g('content.status.Disabled')}</option></select></Field>
          </div>
          <div className="generation-bilingual-editor">
            <fieldset className="generation-language-panel" lang="zh-CN">
              <legend>{g('common.chinese')}</legend>
              <Field label={g('backgrounds.name')} htmlFor="background-name-zh" required><input id="background-name-zh" value={draft.nameZh} onChange={event => setDraft(current => ({ ...current, nameZh: event.target.value }))} /></Field>
              <Field label={g('backgrounds.scene')} htmlFor="background-scene-zh" required><textarea id="background-scene-zh" value={draft.sceneZh} onChange={event => setDraft(current => ({ ...current, sceneZh: event.target.value }))} /></Field>
              <Field label={g('backgrounds.ambientSound')} htmlFor="background-sound-zh"><textarea id="background-sound-zh" value={draft.ambientSoundZh} onChange={event => setDraft(current => ({ ...current, ambientSoundZh: event.target.value }))} /></Field>
              <Field label={g('backgrounds.participantRelationship')} htmlFor="background-relationship-zh"><textarea id="background-relationship-zh" value={draft.participantRelationshipZh} onChange={event => setDraft(current => ({ ...current, participantRelationshipZh: event.target.value }))} /></Field>
              <Field label={g('backgrounds.lighting')} htmlFor="background-lighting-zh"><textarea id="background-lighting-zh" value={draft.lightingZh} onChange={event => setDraft(current => ({ ...current, lightingZh: event.target.value }))} /></Field>
              <Field label={g('backgrounds.framing')} htmlFor="background-framing-zh"><textarea id="background-framing-zh" value={draft.framingZh} onChange={event => setDraft(current => ({ ...current, framingZh: event.target.value }))} /></Field>
            </fieldset>
            <fieldset className="generation-language-panel" lang="en">
              <legend>{g('common.english')}</legend>
              <Field label={g('backgrounds.name')} htmlFor="background-name-en" required><input id="background-name-en" value={draft.nameEn} onChange={event => setDraft(current => ({ ...current, nameEn: event.target.value }))} /></Field>
              <Field label={g('backgrounds.scene')} htmlFor="background-scene-en" required><textarea id="background-scene-en" value={draft.sceneEn} onChange={event => setDraft(current => ({ ...current, sceneEn: event.target.value }))} /></Field>
              <Field label={g('backgrounds.ambientSound')} htmlFor="background-sound-en"><textarea id="background-sound-en" value={draft.ambientSoundEn} onChange={event => setDraft(current => ({ ...current, ambientSoundEn: event.target.value }))} /></Field>
              <Field label={g('backgrounds.participantRelationship')} htmlFor="background-relationship-en"><textarea id="background-relationship-en" value={draft.participantRelationshipEn} onChange={event => setDraft(current => ({ ...current, participantRelationshipEn: event.target.value }))} /></Field>
              <Field label={g('backgrounds.lighting')} htmlFor="background-lighting-en"><textarea id="background-lighting-en" value={draft.lightingEn} onChange={event => setDraft(current => ({ ...current, lightingEn: event.target.value }))} /></Field>
              <Field label={g('backgrounds.framing')} htmlFor="background-framing-en"><textarea id="background-framing-en" value={draft.framingEn} onChange={event => setDraft(current => ({ ...current, framingEn: event.target.value }))} /></Field>
            </fieldset>
          </div>
          {validation ? <p className="field__error" role="alert">{g('backgrounds.validation')}</p> : null}
          <div className="generation-form__actions">{!creating ? <Button className="button--danger" disabled={draft.status !== 'Disabled'} onClick={() => setDeleteOpen(true)}>{g('content.delete')}</Button> : null}<Button variant="primary" disabled={createMutation.isPending || updateMutation.isPending} onClick={() => void save()}>{g('common.save')}</Button></div>
        </section>
      </div>
      {unsavedDialog}
      <ConfirmDialog open={deleteOpen} title={g('content.deleteTitle')} body={selected ? g('content.deleteBody', { name: localizedName(locale, selected) }) : g('content.deleteUnavailable')} confirmLabel={g('content.delete')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => void remove()} onClose={() => setDeleteOpen(false)} />
      <ConfirmDialog open={pendingSelection !== null} title={g('content.discardTitle')} body={g('content.discardBody')} confirmLabel={g('content.discard')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => { if (pendingSelection !== null) applySelection(pendingSelection); setPendingSelection(null); }} onClose={() => setPendingSelection(null)} />
    </GenerationScaffold>
  );
}
