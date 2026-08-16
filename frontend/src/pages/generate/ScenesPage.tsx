import { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, Field, Pagination, StatusBadge, useToast } from '../../components';
import {
  useScenesQuery,
  useCreateSceneMutation,
  useDeleteSceneMutation,
  useUpdateSceneMutation,
} from '../../api/queries';
import type { Scene, SceneCreate, ResourceStatus } from '../../api/contracts';
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

export function emptyScene(): SceneCreate {
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

function sceneInput(item: Scene): SceneCreate {
  const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = item;
  return input;
}

interface StoredSceneDraft {
  creating: boolean;
  selectedId: number | null;
  draft: SceneCreate;
}

export function ScenesPage() {
  const g = useGenerationCopy();
  const locale = useGenerationLocale();
  const { showToast } = useToast();
  const [page, setPage] = useState(1);
  const query = useScenesQuery(page);
  const createMutation = useCreateSceneMutation();
  const updateMutation = useUpdateSceneMutation();
  const deleteMutation = useDeleteSceneMutation();
  const stored = useState(() => readGenerationDraft<StoredSceneDraft>('scene-editor-bilingual'))[0];
  const [selectedId, setSelectedId] = useState<number | null>(stored?.selectedId ?? null);
  const [creating, setCreating] = useState(stored?.creating ?? false);
  const [draft, setDraft] = useState<SceneCreate>(stored?.draft ?? emptyScene());
  const [search, setSearch] = useState('');
  const [validation, setValidation] = useState(false);
  const [mobileEditor, setMobileEditor] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<number | 'new' | null>(null);
  const items = query.data?.items ?? [];
  const selected = items.find(item => item.id === selectedId) ?? null;
  const error = createMutation.error ?? updateMutation.error ?? deleteMutation.error ?? null;

  useEffect(() => {
    if (creating || items.length === 0) return;
    const next = selected ?? items[0];
    setSelectedId(next.id);
    setDraft(sceneInput(next));
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
    ? JSON.stringify(draft) !== JSON.stringify(emptyScene())
    : selected !== null && JSON.stringify(draft) !== JSON.stringify(sceneInput(selected));

  const applySelection = (next: number | 'new') => {
    if (next === 'new') {
      setCreating(true);
      setSelectedId(null);
      setDraft(emptyScene());
    } else {
      const value = items.find(item => item.id === next);
      if (!value) return;
      setCreating(false);
      setSelectedId(value.id);
      setDraft(sceneInput(value));
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
      setDraft(sceneInput(value));
      showToast(g('scenes.saved'));
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

  useGenerationDraft('scene-editor-bilingual', { creating, selectedId, draft }, dirty);
  const unsavedDialog = useUnsavedChanges(dirty);
  useCommandEnter(() => void save(), !createMutation.isPending && !updateMutation.isPending);

  if (query.isPending) return <GenerationScaffold title="scenes.title" subtitle="scenes.subtitle"><p role="status">{g('state.loadingBody')}</p></GenerationScaffold>;
  if (query.isError) return <GenerationScaffold title="scenes.title" subtitle="scenes.subtitle"><OperationFeedback error={query.error} onDismiss={() => void query.refetch()} /></GenerationScaffold>;

  return (
    <GenerationScaffold title="scenes.title" subtitle="scenes.subtitle" action={<Button variant="primary" onClick={() => requestSelection('new')}>{g('scenes.new')}</Button>}>
      {error ? <OperationFeedback error={error} onDismiss={() => { createMutation.reset(); updateMutation.reset(); deleteMutation.reset(); }} /> : null}
      <div className={`generation-layout generation-layout--editor${mobileEditor ? ' generation-layout--mobile-editor' : ''}`}>
        <section className="panel generation-list" aria-labelledby="scene-list-title">
          <div className="section-header"><h2 id="scene-list-title">{g('scenes.list')}</h2></div>
          <Field label={g('common.search')} htmlFor="scene-search"><input id="scene-search" type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
          {filtered.length === 0 ? <p className="generation-empty-note">{g(items.length === 0 ? 'scenes.empty' : 'scenes.filtered')}</p> : <ul className="generation-selection-list" aria-label={g('scenes.list')}>{filtered.map(item => <li key={item.id}><button type="button" className={!creating && item.id === selectedId ? 'generation-selection-card is-selected' : 'generation-selection-card'} aria-pressed={!creating && item.id === selectedId} onClick={() => requestSelection(item.id)}><span className="generation-selection-card__title"><strong>{localizedName(locale, item)}</strong><StatusBadge label={g(item.status === 'Active' ? 'content.status.Active' : 'content.status.Disabled')} kind={item.status === 'Active' ? 'complete' : 'problem'} /></span><span>{locale === 'zh-CN' ? item.sceneZh : item.sceneEn}</span><time dateTime={item.updatedAt}>{formatDateTime(item.updatedAt)}</time></button></li>)}</ul>}
          <Pagination page={query.data?.page ?? page} totalPages={query.data?.totalPages ?? 0} total={query.data?.total ?? 0} onPageChange={setPage} />
        </section>
        <section className="panel generation-form generation-editor" aria-label={g('scenes.editor')}>
          <div className="section-header generation-editor__heading"><Button className="generation-editor-back" variant="quiet" onClick={() => setMobileEditor(false)}>{g('common.backToList')}</Button><h2>{g(creating ? 'scenes.createTitle' : 'scenes.editor')}</h2></div>
          <div className="generation-form__grid">
            <Field label={g('content.status')} htmlFor="scene-status"><select id="scene-status" value={draft.status} onChange={event => setDraft(current => ({ ...current, status: event.target.value as ResourceStatus }))}><option value="Active">{g('content.status.Active')}</option><option value="Disabled">{g('content.status.Disabled')}</option></select></Field>
          </div>
          <div className="generation-bilingual-editor">
            <fieldset className="generation-language-panel" lang="zh-CN">
              <legend>{g('common.chinese')}</legend>
              <Field label={g('scenes.name')} htmlFor="scene-name-zh" required><input id="scene-name-zh" value={draft.nameZh} onChange={event => setDraft(current => ({ ...current, nameZh: event.target.value }))} /></Field>
              <Field label={g('scenes.scene')} htmlFor="scene-scene-zh" required><textarea id="scene-scene-zh" value={draft.sceneZh} onChange={event => setDraft(current => ({ ...current, sceneZh: event.target.value }))} /></Field>
              <Field label={g('scenes.ambientSound')} htmlFor="scene-sound-zh"><textarea id="scene-sound-zh" value={draft.ambientSoundZh} onChange={event => setDraft(current => ({ ...current, ambientSoundZh: event.target.value }))} /></Field>
              <Field label={g('scenes.participantRelationship')} htmlFor="scene-relationship-zh"><textarea id="scene-relationship-zh" value={draft.participantRelationshipZh} onChange={event => setDraft(current => ({ ...current, participantRelationshipZh: event.target.value }))} /></Field>
              <Field label={g('scenes.lighting')} htmlFor="scene-lighting-zh"><textarea id="scene-lighting-zh" value={draft.lightingZh} onChange={event => setDraft(current => ({ ...current, lightingZh: event.target.value }))} /></Field>
              <Field label={g('scenes.framing')} htmlFor="scene-framing-zh"><textarea id="scene-framing-zh" value={draft.framingZh} onChange={event => setDraft(current => ({ ...current, framingZh: event.target.value }))} /></Field>
            </fieldset>
            <fieldset className="generation-language-panel" lang="en">
              <legend>{g('common.english')}</legend>
              <Field label={g('scenes.name')} htmlFor="scene-name-en" required><input id="scene-name-en" value={draft.nameEn} onChange={event => setDraft(current => ({ ...current, nameEn: event.target.value }))} /></Field>
              <Field label={g('scenes.scene')} htmlFor="scene-scene-en" required><textarea id="scene-scene-en" value={draft.sceneEn} onChange={event => setDraft(current => ({ ...current, sceneEn: event.target.value }))} /></Field>
              <Field label={g('scenes.ambientSound')} htmlFor="scene-sound-en"><textarea id="scene-sound-en" value={draft.ambientSoundEn} onChange={event => setDraft(current => ({ ...current, ambientSoundEn: event.target.value }))} /></Field>
              <Field label={g('scenes.participantRelationship')} htmlFor="scene-relationship-en"><textarea id="scene-relationship-en" value={draft.participantRelationshipEn} onChange={event => setDraft(current => ({ ...current, participantRelationshipEn: event.target.value }))} /></Field>
              <Field label={g('scenes.lighting')} htmlFor="scene-lighting-en"><textarea id="scene-lighting-en" value={draft.lightingEn} onChange={event => setDraft(current => ({ ...current, lightingEn: event.target.value }))} /></Field>
              <Field label={g('scenes.framing')} htmlFor="scene-framing-en"><textarea id="scene-framing-en" value={draft.framingEn} onChange={event => setDraft(current => ({ ...current, framingEn: event.target.value }))} /></Field>
            </fieldset>
          </div>
          {validation ? <p className="field__error" role="alert">{g('scenes.validation')}</p> : null}
          <div className="generation-form__actions">{!creating ? <Button className="button--danger" disabled={draft.status !== 'Disabled'} onClick={() => setDeleteOpen(true)}>{g('content.delete')}</Button> : null}<Button variant="primary" disabled={createMutation.isPending || updateMutation.isPending} onClick={() => void save()}>{g('common.save')}</Button></div>
        </section>
      </div>
      {unsavedDialog}
      <ConfirmDialog open={deleteOpen} title={g('content.deleteTitle')} body={selected ? g('content.deleteBody', { name: localizedName(locale, selected) }) : g('content.deleteUnavailable')} confirmLabel={g('content.delete')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => void remove()} onClose={() => setDeleteOpen(false)} />
      <ConfirmDialog open={pendingSelection !== null} title={g('content.discardTitle')} body={g('content.discardBody')} confirmLabel={g('content.discard')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => { if (pendingSelection !== null) applySelection(pendingSelection); setPendingSelection(null); }} onClose={() => setPendingSelection(null)} />
    </GenerationScaffold>
  );
}
