import { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, Field, StatusBadge, useToast } from '../../components';
import {
  useContentPlansQuery,
  useCreateContentPlanMutation,
  useDeleteContentPlanMutation,
  useUpdateContentPlanMutation,
} from '../../api/queries';
import type { ContentPlan, ContentPlanCreate } from '../../api/contracts';
import { formatDateTime } from '../../time';
import { allowedDirections, type Category, type ConflictDirection, type ContentMode, type ContentStatus } from '../../types';
import {
  categories,
  categoryLabel,
  directionLabel,
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

const contentStatuses: ContentStatus[] = ['Draft', 'Active', 'Disabled'];
const contentModes: ContentMode[] = ['Fixed', 'Generative'];

export function emptyContentPlan(): ContentPlanCreate {
  return {
    nameZh: '',
    nameEn: '',
    category: 'A-VA',
    conflictDirection: null,
    mode: 'Fixed',
    status: 'Draft',
    trueEmotion: '',
    apparentEmotion: '',
    sceneZh: '',
    sceneEn: '',
    triggerEventZh: '',
    triggerEventEn: '',
    psychologicalBackgroundZh: '',
    psychologicalBackgroundEn: '',
    dialogue: '',
    displayText: null,
    trueEmotionDescription: '',
    baseVideoPrompt: '',
    contentRequirementsZh: '',
    contentRequirementsEn: '',
    sceneSupplementZh: '',
    sceneSupplementEn: '',
  };
}

function contentInput(item: ContentPlan): ContentPlanCreate {
  const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = item;
  return input;
}

export function contentPlanPayloadIsValid(value: ContentPlanCreate): boolean {
  const aligned = value.category.startsWith('A-');
  const emotionRelationValid = aligned
    ? value.trueEmotion.trim().toLocaleLowerCase() === value.apparentEmotion.trim().toLocaleLowerCase()
    : value.trueEmotion.trim().toLocaleLowerCase() !== value.apparentEmotion.trim().toLocaleLowerCase();
  const modeFieldsValid = value.mode === 'Generative'
    ? Boolean(value.contentRequirementsZh.trim() && value.contentRequirementsEn.trim())
    : Boolean(
        value.baseVideoPrompt.trim()
        && value.trueEmotionDescription.trim()
        && (value.category.endsWith('-VA') ? value.dialogue?.trim() : value.displayText?.trim()),
      );
  return Boolean(
    value.nameZh.trim()
    && value.nameEn.trim()
    && value.trueEmotion.trim()
    && value.apparentEmotion.trim()
    && value.sceneZh.trim()
    && value.sceneEn.trim()
    && value.triggerEventZh.trim()
    && value.triggerEventEn.trim()
    && value.psychologicalBackgroundZh.trim()
    && value.psychologicalBackgroundEn.trim()
    && emotionRelationValid
    && modeFieldsValid,
  );
}

function statusKind(status: ContentStatus) {
  if (status === 'Active') return 'complete' as const;
  if (status === 'Disabled') return 'problem' as const;
  return 'neutral' as const;
}

interface StoredContentDraft {
  creating: boolean;
  selectedId: number | null;
  draft: ContentPlanCreate;
}

export function ContentPage() {
  const g = useGenerationCopy();
  const locale = useGenerationLocale();
  const { showToast } = useToast();
  const contentQuery = useContentPlansQuery();
  const createMutation = useCreateContentPlanMutation();
  const updateMutation = useUpdateContentPlanMutation();
  const deleteMutation = useDeleteContentPlanMutation();
  const stored = useState(() => readGenerationDraft<StoredContentDraft>('content-editor-bilingual'))[0];
  const [selectedId, setSelectedId] = useState<number | null>(stored?.selectedId ?? null);
  const [creating, setCreating] = useState(stored?.creating ?? false);
  const [draft, setDraft] = useState<ContentPlanCreate>(stored?.draft ?? emptyContentPlan());
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<Category | 'All'>('All');
  const [statusFilter, setStatusFilter] = useState<ContentStatus | 'All'>('All');
  const [validation, setValidation] = useState(false);
  const [mobileEditor, setMobileEditor] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<number | 'new' | null>(null);
  const items = contentQuery.data ?? [];
  const selected = items.find(item => item.id === selectedId) ?? null;
  const error = createMutation.error ?? updateMutation.error ?? deleteMutation.error ?? null;

  useEffect(() => {
    if (creating || items.length === 0) return;
    const next = selected ?? items[0];
    setSelectedId(next.id);
    setDraft(contentInput(next));
  }, [creating, items, selected]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return items.filter(item =>
      (categoryFilter === 'All' || item.category === categoryFilter)
      && (statusFilter === 'All' || item.status === statusFilter)
      && (query === '' || [
        item.nameZh,
        item.nameEn,
        item.sceneZh,
        item.sceneEn,
      ].join(' ').toLocaleLowerCase().includes(query)),
    );
  }, [categoryFilter, items, search, statusFilter]);

  const dirty = creating
    ? JSON.stringify(draft) !== JSON.stringify(emptyContentPlan())
    : selected !== null && JSON.stringify(draft) !== JSON.stringify(contentInput(selected));

  const applySelection = (next: number | 'new') => {
    if (next === 'new') {
      setCreating(true);
      setSelectedId(null);
      setDraft(emptyContentPlan());
    } else {
      const item = items.find(value => value.id === next);
      if (!item) return;
      setCreating(false);
      setSelectedId(item.id);
      setDraft(contentInput(item));
    }
    setValidation(false);
    setMobileEditor(true);
    createMutation.reset();
    updateMutation.reset();
    deleteMutation.reset();
  };

  const requestSelection = (next: number | 'new') => {
    if (dirty) setPendingSelection(next);
    else applySelection(next);
  };

  const changeCategory = (category: Category) => {
    const direction = allowedDirections(category)[0] ?? null;
    setDraft(current => ({
      ...current,
      category,
      conflictDirection: direction,
      dialogue: category.endsWith('-VA') ? (current.dialogue ?? '') : null,
      displayText: category.endsWith('-VT') ? (current.displayText ?? '') : null,
    }));
  };

  const save = async () => {
    if (!contentPlanPayloadIsValid(draft)) {
      setValidation(true);
      return;
    }
    setValidation(false);
    try {
      const value = creating || !selected
        ? await createMutation.mutateAsync(draft)
        : await updateMutation.mutateAsync({
            id: selected.id,
            input: (({ category: _category, ...changes }) => ({ ...changes, expectedRevision: selected.revision }))(draft),
          });
      setCreating(false);
      setSelectedId(value.id);
      setDraft(contentInput(value));
      showToast(g('content.saved'));
    } catch {
      // The shared safe error panel renders mutation errors.
    }
  };

  const remove = async () => {
    if (!selected) return;
    try {
      await deleteMutation.mutateAsync({ id: selected.id, expectedRevision: selected.revision });
      setDeleteOpen(false);
      const next = items.find(item => item.id !== selected.id) ?? null;
      if (next) applySelection(next.id);
      else applySelection('new');
      showToast(g('content.deleted'));
    } catch {
      setDeleteOpen(false);
    }
  };

  useGenerationDraft('content-editor-bilingual', { creating, selectedId, draft }, dirty);
  const unsavedDialog = useUnsavedChanges(dirty);
  useCommandEnter(() => void save(), !createMutation.isPending && !updateMutation.isPending);

  if (contentQuery.isPending) {
    return <GenerationScaffold title="content.title" subtitle="content.subtitle"><p role="status">{g('state.loadingBody')}</p></GenerationScaffold>;
  }
  if (contentQuery.isError) {
    return <GenerationScaffold title="content.title" subtitle="content.subtitle"><OperationFeedback error={contentQuery.error} onDismiss={() => void contentQuery.refetch()} /></GenerationScaffold>;
  }

  const directions = allowedDirections(draft.category);
  return (
    <GenerationScaffold
      title="content.title"
      subtitle="content.subtitle"
      action={<Button variant="primary" onClick={() => requestSelection('new')}>{g('content.new')}</Button>}
    >
      {error ? <OperationFeedback error={error} onDismiss={() => { createMutation.reset(); updateMutation.reset(); deleteMutation.reset(); }} /> : null}
      <div className={`generation-layout generation-layout--editor${mobileEditor ? ' generation-layout--mobile-editor' : ''}`}>
        <section className="panel generation-list" aria-labelledby="content-list-title">
          <div className="section-header"><h2 id="content-list-title">{g('content.list')}</h2></div>
          <div className="generation-filters">
            <Field label={g('common.search')} htmlFor="content-search"><input id="content-search" type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
            <Field label={g('content.categoryFilter')} htmlFor="content-category-filter"><select id="content-category-filter" value={categoryFilter} onChange={event => setCategoryFilter(event.target.value as Category | 'All')}><option value="All">{g('common.all')}</option>{categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}</select></Field>
            <Field label={g('content.statusFilter')} htmlFor="content-status-filter"><select id="content-status-filter" value={statusFilter} onChange={event => setStatusFilter(event.target.value as ContentStatus | 'All')}><option value="All">{g('common.all')}</option>{contentStatuses.map(value => <option key={value} value={value}>{g(`content.status.${value}`)}</option>)}</select></Field>
          </div>
          {filtered.length === 0 ? <p className="generation-empty-note">{g(items.length === 0 ? 'content.empty' : 'content.filtered')}</p> : (
            <ul className="generation-selection-list" aria-label={g('content.tableCaption')}>
              {filtered.map(item => <li key={item.id}><button type="button" className={!creating && item.id === selectedId ? 'generation-selection-card is-selected' : 'generation-selection-card'} aria-pressed={!creating && item.id === selectedId} onClick={() => requestSelection(item.id)}><span className="generation-selection-card__title"><strong>{localizedName(locale, item)}</strong><StatusBadge label={g(`content.status.${item.status}`)} kind={statusKind(item.status)} /></span><span>{categoryLabel(g, item.category)}</span><time dateTime={item.updatedAt}>{formatDateTime(item.updatedAt)}</time></button></li>)}
            </ul>
          )}
        </section>
        <section className="panel generation-form generation-editor" aria-label={g('content.editorRegion')}>
          <div className="section-header generation-editor__heading"><Button className="generation-editor-back" variant="quiet" onClick={() => setMobileEditor(false)}>{g('common.backToList')}</Button><h2>{g(creating ? 'content.createTitle' : 'content.editor')}</h2></div>
          <div className="generation-form__grid">
            <Field label={g('content.status')} htmlFor="content-status"><select id="content-status" value={draft.status} onChange={event => setDraft(current => ({ ...current, status: event.target.value as ContentStatus }))}>{contentStatuses.map(value => <option key={value} value={value}>{g(`content.status.${value}`)}</option>)}</select></Field>
            <Field label={g('content.category')} htmlFor="content-category" required><select id="content-category" value={draft.category} disabled={!creating} aria-describedby={!creating ? 'content-category-immutable' : undefined} onChange={event => changeCategory(event.target.value as Category)}>{categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}</select>{!creating ? <span id="content-category-immutable" className="field__hint">{g('content.categoryImmutable')}</span> : null}</Field>
            <Field label={g('content.direction')} htmlFor="content-direction" required={directions.length > 0}><select id="content-direction" value={draft.conflictDirection ?? ''} disabled={directions.length === 0} onChange={event => setDraft(current => ({ ...current, conflictDirection: (event.target.value || null) as ConflictDirection | null }))}>{directions.length === 0 ? <option value="">{g('common.none')}</option> : null}{directions.map(value => <option key={value} value={value}>{directionLabel(g, value)}</option>)}</select></Field>
            <Field label={g('content.mode')} htmlFor="content-mode" required><select id="content-mode" value={draft.mode} onChange={event => setDraft(current => ({ ...current, mode: event.target.value as ContentMode }))}>{contentModes.map(value => <option key={value} value={value}>{g(`content.mode.${value}`)}</option>)}</select></Field>
            <Field label={g('content.trueEmotion')} htmlFor="content-true-emotion" required><input id="content-true-emotion" value={draft.trueEmotion} onChange={event => setDraft(current => ({ ...current, trueEmotion: event.target.value }))} /></Field>
            <Field label={g('content.apparentEmotion')} htmlFor="content-apparent-emotion" required><input id="content-apparent-emotion" value={draft.apparentEmotion} onChange={event => setDraft(current => ({ ...current, apparentEmotion: event.target.value }))} /></Field>
          </div>
          <div className="generation-bilingual-editor">
            <fieldset className="generation-language-panel" lang="zh-CN">
              <legend>{g('common.chinese')}</legend>
              <Field label={g('content.name')} htmlFor="content-name-zh" required><input id="content-name-zh" value={draft.nameZh} onChange={event => setDraft(current => ({ ...current, nameZh: event.target.value }))} /></Field>
              <Field label={g('content.scene')} htmlFor="content-scene-zh" required><textarea id="content-scene-zh" value={draft.sceneZh} onChange={event => setDraft(current => ({ ...current, sceneZh: event.target.value }))} /></Field>
              <Field label={g('content.triggerEvent')} htmlFor="content-trigger-zh" required><textarea id="content-trigger-zh" value={draft.triggerEventZh} onChange={event => setDraft(current => ({ ...current, triggerEventZh: event.target.value }))} /></Field>
              <Field label={g('content.psychologicalBackground')} htmlFor="content-psychological-zh" required><textarea id="content-psychological-zh" value={draft.psychologicalBackgroundZh} onChange={event => setDraft(current => ({ ...current, psychologicalBackgroundZh: event.target.value }))} /></Field>
              {draft.category.endsWith('-VA') ? <Field label={g('content.dialogue')} htmlFor="content-dialogue" required={draft.mode === 'Fixed'}><textarea id="content-dialogue" value={draft.dialogue ?? ''} onChange={event => setDraft(current => ({ ...current, dialogue: event.target.value }))} /></Field> : <Field label={g('content.displayText')} htmlFor="content-display-text" required={draft.mode === 'Fixed'}><textarea id="content-display-text" value={draft.displayText ?? ''} onChange={event => setDraft(current => ({ ...current, displayText: event.target.value }))} /></Field>}
              <Field label={g('content.trueEmotionDescription')} htmlFor="content-true-description" required={draft.mode === 'Fixed'}><textarea id="content-true-description" value={draft.trueEmotionDescription} onChange={event => setDraft(current => ({ ...current, trueEmotionDescription: event.target.value }))} /></Field>
              <Field label={g('content.contentRequirements')} htmlFor="content-requirements-zh" required={draft.mode === 'Generative'}><textarea id="content-requirements-zh" value={draft.contentRequirementsZh} onChange={event => setDraft(current => ({ ...current, contentRequirementsZh: event.target.value }))} /></Field>
              <Field label={g('content.sceneSupplement')} htmlFor="content-scene-supplement-zh"><textarea id="content-scene-supplement-zh" value={draft.sceneSupplementZh} onChange={event => setDraft(current => ({ ...current, sceneSupplementZh: event.target.value }))} /></Field>
            </fieldset>
            <fieldset className="generation-language-panel" lang="en">
              <legend>{g('common.english')}</legend>
              <Field label={g('content.name')} htmlFor="content-name-en" required><input id="content-name-en" value={draft.nameEn} onChange={event => setDraft(current => ({ ...current, nameEn: event.target.value }))} /></Field>
              <Field label={g('content.scene')} htmlFor="content-scene-en" required><textarea id="content-scene-en" value={draft.sceneEn} onChange={event => setDraft(current => ({ ...current, sceneEn: event.target.value }))} /></Field>
              <Field label={g('content.triggerEvent')} htmlFor="content-trigger-en" required><textarea id="content-trigger-en" value={draft.triggerEventEn} onChange={event => setDraft(current => ({ ...current, triggerEventEn: event.target.value }))} /></Field>
              <Field label={g('content.psychologicalBackground')} htmlFor="content-psychological-en" required><textarea id="content-psychological-en" value={draft.psychologicalBackgroundEn} onChange={event => setDraft(current => ({ ...current, psychologicalBackgroundEn: event.target.value }))} /></Field>
              <Field label={g('content.baseVideoPrompt')} htmlFor="content-base-prompt" required={draft.mode === 'Fixed'}><textarea id="content-base-prompt" value={draft.baseVideoPrompt} onChange={event => setDraft(current => ({ ...current, baseVideoPrompt: event.target.value }))} /></Field>
              <Field label={g('content.contentRequirements')} htmlFor="content-requirements-en" required={draft.mode === 'Generative'}><textarea id="content-requirements-en" value={draft.contentRequirementsEn} onChange={event => setDraft(current => ({ ...current, contentRequirementsEn: event.target.value }))} /></Field>
              <Field label={g('content.sceneSupplement')} htmlFor="content-scene-supplement-en"><textarea id="content-scene-supplement-en" value={draft.sceneSupplementEn} onChange={event => setDraft(current => ({ ...current, sceneSupplementEn: event.target.value }))} /></Field>
            </fieldset>
          </div>
          {validation ? <p className="field__error" role="alert">{g('content.validation')}</p> : null}
          <div className="generation-form__actions">
            {!creating ? <Button className="button--danger" onClick={() => setDeleteOpen(true)}>{g('content.delete')}</Button> : null}
            <Button variant="primary" disabled={createMutation.isPending || updateMutation.isPending} onClick={() => void save()}>{g('common.save')}</Button>
          </div>
          <p className="generation-shortcut-hint">{g('content.saveShortcut')}</p>
        </section>
      </div>
      {unsavedDialog}
      <ConfirmDialog open={deleteOpen} title={g('content.deleteTitle')} body={selected ? g('content.deleteBody', { name: localizedName(locale, selected) }) : g('content.deleteUnavailable')} confirmLabel={g('content.delete')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => void remove()} onClose={() => setDeleteOpen(false)} />
      <ConfirmDialog open={pendingSelection !== null} title={g('content.discardTitle')} body={g('content.discardBody')} confirmLabel={g('content.discard')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={() => { if (pendingSelection !== null) applySelection(pendingSelection); setPendingSelection(null); }} onClose={() => setPendingSelection(null)} />
    </GenerationScaffold>
  );
}
