import { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, Field, StatusBadge, useToast } from '../../components';
import { useMockRepository, useRepositorySnapshot } from '../../store';
import { formatDateTime } from '../../time';
import { contentIsReferenced } from '../../generation';
import { allowedDirections, type Category, type ConflictDirection, type ContentItem, type ContentItemInput, type ContentMode, type ContentStatus } from '../../types';
import {
  categories,
  categoryLabel,
  directionLabel,
  emotions,
  GenerationScaffold,
  OperationFeedback,
  readGenerationDraft,
  useCommandEnter,
  useGenerationCopy,
  useGenerationDraft,
  useUnsavedChanges,
  VideoPromptPreview,
} from './shared';

const contentStatuses: ContentStatus[] = ['Draft', 'Active', 'Disabled'];
const contentModes: ContentMode[] = ['Fixed', 'Generative'];

function emptyContent(): ContentItemInput {
  return {
    name: '', category: 'A-VA', conflictDirection: null, mode: 'Fixed', status: 'Draft', emotion: '', scene: '',
    dialogue: '', displayText: null, explanation: '', videoPrompt: '', contentInstruction: '', sceneSupplement: '',
  };
}

function contentInput(item: ContentItem): ContentItemInput {
  const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = item;
  return input;
}

function contentStatusKind(status: ContentStatus) {
  if (status === 'Active') return 'complete' as const;
  if (status === 'Disabled') return 'problem' as const;
  return 'neutral' as const;
}

interface StoredContentDraft {
  creating: boolean;
  selectedId: string;
  draft: ContentItemInput;
}

interface ContentFilters {
  search: string;
  category: Category | 'All';
  status: ContentStatus | 'All';
}

type PendingContentChange =
  | { kind: 'new' }
  | { kind: 'select'; id: string }
  | { kind: 'filters'; filters: ContentFilters };

function matchesContentFilters(item: ContentItem, filters: ContentFilters, locale: string): boolean {
  const query = filters.search.trim().toLocaleLowerCase(locale);
  return (filters.category === 'All' || item.category === filters.category)
    && (filters.status === 'All' || item.status === filters.status)
    && (query === '' || `${item.name} ${item.scene}`.toLocaleLowerCase(locale).includes(query));
}

export function ContentPage() {
  const g = useGenerationCopy();
  const repository = useMockRepository();
  const snapshot = useRepositorySnapshot();
  const { showToast } = useToast();
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<Category | 'All'>('All');
  const [statusFilter, setStatusFilter] = useState<ContentStatus | 'All'>('All');
  const [storedDraft] = useState(() => {
    return readGenerationDraft<StoredContentDraft>('content-editor');
  });
  const [selectedId, setSelectedId] = useState(storedDraft?.selectedId ?? snapshot.data.contentItems[0]?.id ?? '');
  const [creating, setCreating] = useState(storedDraft?.creating ?? false);
  const selected = snapshot.data.contentItems.find(item => item.id === selectedId) ?? null;
  const [draft, setDraft] = useState<ContentItemInput>(() => storedDraft?.draft ?? (selected ? contentInput(selected) : emptyContent()));
  const [confirming, setConfirming] = useState(false);
  const [pendingChange, setPendingChange] = useState<PendingContentChange | null>(null);
  const [pendingStatus, setPendingStatus] = useState<ContentStatus | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [previewPresetId, setPreviewPresetId] = useState('');
  const [failure, setFailure] = useState<null | 'Conflict' | 'NotFound' | 'InvalidInput' | 'Unavailable'>(null);
  const [validation, setValidation] = useState(false);
  const locale = snapshot.preferences.locale;
  const previewPresets = snapshot.data.presets.filter(item => item.status === 'Active' && item.category === draft.category);
  const previewPreset = previewPresets.find(item => item.id === previewPresetId) ?? previewPresets[0] ?? null;
  const referenced = selected
    ? contentIsReferenced(selected.id, snapshot.data.jobs, snapshot.data.samples)
    : false;
  const canDelete = Boolean(selected && !creating && selected.status === 'Draft' && !referenced);

  const filtered = useMemo(() => {
    const filters = { search, category: categoryFilter, status: statusFilter };
    return snapshot.data.contentItems.filter(item => matchesContentFilters(item, filters, locale));
  }, [categoryFilter, locale, search, snapshot.data.contentItems, statusFilter]);

  useEffect(() => {
    if (creating) return;
    if (selected) setDraft(contentInput(selected));
  }, [creating, selected?.id, selected?.revision]);

  useEffect(() => {
    if (previewPresets.some(item => item.id === previewPresetId)) return;
    setPreviewPresetId(previewPresets[0]?.id ?? '');
  }, [previewPresetId, previewPresets]);

  const applyChange = (change: PendingContentChange) => {
    if (change.kind === 'new') {
      setCreating(true);
      setSelectedId('');
      setDraft(emptyContent());
    } else if (change.kind === 'select') {
      const item = snapshot.data.contentItems.find(candidate => candidate.id === change.id);
      if (!item) return;
      setCreating(false);
      setSelectedId(item.id);
      setDraft(contentInput(item));
    } else {
      setSearch(change.filters.search);
      setCategoryFilter(change.filters.category);
      setStatusFilter(change.filters.status);
      const nextFiltered = snapshot.data.contentItems.filter(item => matchesContentFilters(item, change.filters, locale));
      if (!creating && selected && !nextFiltered.some(item => item.id === selected.id)) {
        const next = nextFiltered[0];
        setSelectedId(next?.id ?? '');
        setCreating(!next);
        setDraft(next ? contentInput(next) : emptyContent());
      }
    }
    setFailure(null);
    setValidation(false);
  };

  const dirty = creating
    ? JSON.stringify(draft) !== JSON.stringify(emptyContent())
    : selected !== null && JSON.stringify(draft) !== JSON.stringify(contentInput(selected));

  const requestChange = (change: PendingContentChange) => {
    const wouldLeaveEditor = change.kind !== 'filters'
      || (!creating && selected !== null && !matchesContentFilters(selected, change.filters, locale));
    if (dirty && wouldLeaveEditor) {
      setPendingChange(change);
      return;
    }
    applyChange(change);
  };

  const startNew = () => requestChange({ kind: 'new' });
  const choose = (item: ContentItem) => requestChange({ kind: 'select', id: item.id });

  const requestFilters = (filters: ContentFilters) => requestChange({ kind: 'filters', filters });

  const requestStatus = (status: ContentStatus) => {
    if (status === draft.status) return;
    if (status === 'Active' || status === 'Disabled') {
      setPendingStatus(status);
      return;
    }
    setDraft(current => ({ ...current, status }));
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

  const isValid = Boolean(
    draft.name.trim() && draft.emotion.trim() && draft.scene.trim() && draft.explanation.trim() && draft.videoPrompt.trim() &&
    (draft.mode === 'Generative' ? draft.contentInstruction.trim() : (draft.category.endsWith('-VA') ? draft.dialogue?.trim() : draft.displayText?.trim())),
  );

  const requestSave = () => {
    if (!isValid) {
      setValidation(true);
      return;
    }
    setValidation(false);
    setConfirming(true);
  };

  const save = () => {
    const result = creating || !selected
      ? repository.createContentItem(draft)
      : repository.updateContentItem(selected.id, draft, selected.revision);
    setConfirming(false);
    if (!result.ok) {
      setFailure(result.kind);
      return;
    }
    setCreating(false);
    setSelectedId(result.value.id);
    setDraft(contentInput(result.value));
    setFailure(null);
    showToast(g('content.saved'));
  };

  const deleteContent = () => {
    if (!selected || !canDelete) return;
    const result = repository.deleteContentItem(selected.id, selected.revision);
    setDeleteOpen(false);
    if (!result.ok) {
      setFailure(result.kind);
      return;
    }
    const next = snapshot.data.contentItems.find(item => item.id !== selected.id) ?? null;
    setSelectedId(next?.id ?? '');
    setCreating(next === null);
    setDraft(next ? contentInput(next) : emptyContent());
    setFailure(null);
    showToast(g('content.deleted'));
  };

  useGenerationDraft('content-editor', { creating, selectedId, draft }, dirty);
  const unsavedChangesDialog = useUnsavedChanges(dirty);
  useCommandEnter(requestSave, !confirming && pendingChange === null && pendingStatus === null);

  const hasFilters = search !== '' || categoryFilter !== 'All' || statusFilter !== 'All';
  const clearFilters = () => requestFilters({ search: '', category: 'All', status: 'All' });
  const directions = allowedDirections(draft.category);

  return (
    <GenerationScaffold
      title={'content.title'}
      subtitle={'content.subtitle'}
      action={<Button variant="primary" onClick={startNew}>{g('content.new')}</Button>}
    >
      {failure ? <OperationFeedback kind={failure} onDismiss={() => setFailure(null)} /> : null}
      <div className="generation-layout generation-layout--editor">
        <section className="panel generation-list" aria-labelledby="content-list-title">
          <div className="section-header"><h2 id="content-list-title">{g('content.list')}</h2>{hasFilters ? <Button variant="quiet" onClick={clearFilters}>{g('common.clearFilters')}</Button> : null}</div>
          <div className="generation-filters">
            <Field label={g('common.search')} htmlFor="content-search">
              <input id="content-search" type="search" value={search} onChange={event => requestFilters({ search: event.target.value, category: categoryFilter, status: statusFilter })} placeholder={g('content.searchPlaceholder')} />
            </Field>
            <Field label={g('content.categoryFilter')} htmlFor="content-category-filter">
              <select id="content-category-filter" value={categoryFilter} onChange={event => requestFilters({ search, category: event.target.value as Category | 'All', status: statusFilter })}>
                <option value="All">{g('common.all')}</option>{categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}
              </select>
            </Field>
            <Field label={g('content.statusFilter')} htmlFor="content-status-filter">
              <select id="content-status-filter" value={statusFilter} onChange={event => requestFilters({ search, category: categoryFilter, status: event.target.value as ContentStatus | 'All' })}>
                <option value="All">{g('common.all')}</option>{contentStatuses.map(value => <option key={value} value={value}>{g(`content.status.${value}`)}</option>)}
              </select>
            </Field>
          </div>
          {snapshot.data.contentItems.length === 0 || filtered.length === 0 ? (
            <div className="generation-list__empty"><p>{g(snapshot.data.contentItems.length === 0 ? 'content.empty' : 'content.filtered')}</p></div>
          ) : (
            <ul className="generation-selection-list" aria-label={g('content.tableCaption')}>
              {filtered.map(item => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={!creating && item.id === selectedId ? 'generation-selection-card is-selected' : 'generation-selection-card'}
                    aria-pressed={!creating && item.id === selectedId}
                    onClick={() => choose(item)}
                  >
                    <span className="generation-selection-card__title">
                      <strong>{item.name}</strong>
                      <StatusBadge label={g(`content.status.${item.status}`)} kind={contentStatusKind(item.status)} />
                    </span>
                    <span>{categoryLabel(g, item.category)}</span>
                    <time dateTime={item.updatedAt}>{formatDateTime(item.updatedAt)}</time>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel generation-form generation-editor" aria-label={g('content.editorRegion')}>
          <div className="section-header"><h2>{g(creating ? 'content.createTitle' : 'content.editor')}</h2></div>
          <div className="generation-form__grid">
            <Field label={g('content.name')} htmlFor="content-name" required>
              <input id="content-name" value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} placeholder={g('content.namePlaceholder')} />
            </Field>
            <Field label={g('content.status')} htmlFor="content-status">
              <select id="content-status" value={draft.status} onChange={event => requestStatus(event.target.value as ContentStatus)}>
                {contentStatuses.map(value => <option key={value} value={value}>{g(`content.status.${value}`)}</option>)}
              </select>
            </Field>
            <Field label={g('content.category')} htmlFor="content-category" required>
              <select id="content-category" value={draft.category} onChange={event => changeCategory(event.target.value as Category)}>
                {categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}
              </select>
            </Field>
            <Field label={g('content.direction')} htmlFor="content-direction" required={directions.length > 0}>
              <select id="content-direction" value={draft.conflictDirection ?? ''} disabled={directions.length === 0} onChange={event => setDraft(current => ({ ...current, conflictDirection: (event.target.value || null) as ConflictDirection | null }))}>
                {directions.length === 0 ? <option value="">{g('common.none')}</option> : null}
                {directions.map(value => <option key={value} value={value}>{directionLabel(g, value)}</option>)}
              </select>
            </Field>
            <Field label={g('content.mode')} htmlFor="content-mode" required>
              <select id="content-mode" value={draft.mode} onChange={event => setDraft(current => ({ ...current, mode: event.target.value as ContentMode }))}>
                {contentModes.map(value => <option key={value} value={value}>{g(`content.mode.${value}`)}</option>)}
              </select>
            </Field>
            <Field label={g('content.emotion')} htmlFor="content-emotion" required>
              <select id="content-emotion" value={draft.emotion} onChange={event => setDraft(current => ({ ...current, emotion: event.target.value }))}>
                {draft.emotion === '' ? <option value="">{g('content.emotionPlaceholder')}</option> : null}
                {emotions.map(value => <option key={value} value={value}>{g(`emotion.${value}`)}</option>)}
              </select>
            </Field>
            <Field className="generation-form__wide" label={g('content.scene')} htmlFor="content-scene" required>
              <textarea id="content-scene" value={draft.scene} onChange={event => setDraft(current => ({ ...current, scene: event.target.value }))} placeholder={g('content.scenePlaceholder')} />
            </Field>
            {draft.category.endsWith('-VA') ? (
              <Field className="generation-form__wide" label={g('content.dialogue')} htmlFor="content-dialogue" required={draft.mode === 'Fixed'}>
                <textarea id="content-dialogue" value={draft.dialogue ?? ''} onChange={event => setDraft(current => ({ ...current, dialogue: event.target.value }))} placeholder={g('content.dialoguePlaceholder')} />
              </Field>
            ) : (
              <Field className="generation-form__wide" label={g('content.displayText')} htmlFor="content-display-text" required={draft.mode === 'Fixed'}>
                <textarea id="content-display-text" value={draft.displayText ?? ''} onChange={event => setDraft(current => ({ ...current, displayText: event.target.value }))} placeholder={g('content.displayTextPlaceholder')} />
              </Field>
            )}
            <Field className="generation-form__wide" label={g('content.explanation')} htmlFor="content-explanation" required>
              <textarea id="content-explanation" value={draft.explanation} onChange={event => setDraft(current => ({ ...current, explanation: event.target.value }))} placeholder={g('content.explanationPlaceholder')} />
            </Field>
            <Field className="generation-form__wide" label={g('content.videoPrompt')} htmlFor="content-video-prompt" required>
              <textarea id="content-video-prompt" value={draft.videoPrompt} onChange={event => setDraft(current => ({ ...current, videoPrompt: event.target.value }))} placeholder={g('content.videoPromptPlaceholder')} />
            </Field>
            <Field className="generation-form__wide" label={g('content.instruction')} htmlFor="content-instruction" required={draft.mode === 'Generative'}>
              <textarea id="content-instruction" value={draft.contentInstruction} onChange={event => setDraft(current => ({ ...current, contentInstruction: event.target.value }))} placeholder={g('content.instructionPlaceholder')} />
            </Field>
            <Field className="generation-form__wide" label={g('content.sceneSupplement')} htmlFor="content-scene-supplement">
              <textarea id="content-scene-supplement" value={draft.sceneSupplement} onChange={event => setDraft(current => ({ ...current, sceneSupplement: event.target.value }))} placeholder={g('content.sceneSupplementPlaceholder')} />
            </Field>
            <Field className="generation-form__wide" label={g('promptPreview.preset')} htmlFor="content-preview-preset">
              <select id="content-preview-preset" value={previewPreset?.id ?? ''} onChange={event => setPreviewPresetId(event.target.value)}>
                {previewPresets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </Field>
            {previewPreset ? (
              <div className="generation-form__wide">
                <VideoPromptPreview content={draft} preset={previewPreset} />
              </div>
            ) : null}
          </div>
          {validation ? <p className="field__error" role="alert">{g('content.validation')}</p> : null}
          {!creating && selected ? (
            <p className="generation-delete-note">
              {g(referenced ? 'content.deleteReferenced' : selected.status !== 'Draft' ? 'content.deleteDraftOnly' : 'content.deleteAvailable')}
            </p>
          ) : null}
          <div className="generation-form__actions">
            {!creating ? <Button className="button--danger" onClick={() => setDeleteOpen(true)} disabled={!canDelete}>{g('content.delete')}</Button> : null}
            <Button variant="primary" onClick={requestSave}>{g('common.save')}</Button>
          </div>
          <p className="generation-shortcut-hint">{g('content.saveShortcut')}</p>
        </section>
      </div>
      {unsavedChangesDialog}
      <ConfirmDialog open={confirming} title={g('content.saveConfirmTitle')} body={g('content.saveConfirmBody')} confirmLabel={g('common.save')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={save} onClose={() => setConfirming(false)} />
      <ConfirmDialog
        open={deleteOpen}
        title={g('content.deleteTitle')}
        body={selected ? g('content.deleteBody', { name: selected.name }) : g('content.deleteUnavailable')}
        confirmLabel={g('content.delete')}
        cancelLabel={g('common.cancel')}
        closeLabel={g('common.close')}
        onConfirm={deleteContent}
        onClose={() => setDeleteOpen(false)}
      />
      <ConfirmDialog
        open={pendingChange !== null}
        title={g('content.discardTitle')}
        body={g('content.discardBody')}
        confirmLabel={g('content.discard')}
        cancelLabel={g('common.cancel')}
        closeLabel={g('common.close')}
        onConfirm={() => {
          if (pendingChange) applyChange(pendingChange);
          setPendingChange(null);
        }}
        onClose={() => setPendingChange(null)}
      />
      <ConfirmDialog
        open={pendingStatus === 'Active'}
        title={g('content.activateTitle')}
        body={g('content.activateBody')}
        confirmLabel={g('content.activate')}
        cancelLabel={g('common.cancel')}
        closeLabel={g('common.close')}
        onConfirm={() => {
          setDraft(current => ({ ...current, status: 'Active' }));
          setPendingStatus(null);
        }}
        onClose={() => setPendingStatus(null)}
      />
      <ConfirmDialog
        open={pendingStatus === 'Disabled'}
        title={g('content.disableTitle')}
        body={g('content.disableBody')}
        confirmLabel={g('content.disable')}
        cancelLabel={g('common.cancel')}
        closeLabel={g('common.close')}
        onConfirm={() => {
          setDraft(current => ({ ...current, status: 'Disabled' }));
          setPendingStatus(null);
        }}
        onClose={() => setPendingStatus(null)}
      />
    </GenerationScaffold>
  );
}
