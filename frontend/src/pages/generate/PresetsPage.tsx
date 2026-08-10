import { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, Field, TableShell, useToast } from '../../components';
import { useMockRepository, useRepositorySnapshot } from '../../store';
import type { Category, Preset, PresetInput, PresetRuleKey } from '../../types';
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

function presetInput(item: Preset): PresetInput {
  const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = item;
  return input;
}

interface StoredPresetDraft {
  creating: boolean;
  selectedId: string;
  draft: PresetInput;
  positiveText: string;
  negativeText: string;
}

interface PresetFilters {
  search: string;
  category: Category | 'All';
}

type PendingPresetChange =
  | { kind: 'new' }
  | { kind: 'select'; id: string }
  | { kind: 'filters'; filters: PresetFilters };

const fixedStructureRules = [
  'presets.rule.subject',
  'presets.rule.signal',
  'presets.rule.camera',
] as const satisfies readonly PresetRuleKey[];

function matchesPresetFilters(item: Preset, filters: PresetFilters, locale: string): boolean {
  const query = filters.search.trim().toLocaleLowerCase(locale);
  return (filters.category === 'All' || item.category === filters.category)
    && (query === '' || item.name.toLocaleLowerCase(locale).includes(query));
}

export function PresetsPage() {
  const g = useGenerationCopy();
  const repository = useMockRepository();
  const snapshot = useRepositorySnapshot();
  const { showToast } = useToast();
  const makeEmpty = (): PresetInput => ({
    name: '', category: 'A-VA', fixedStructureRules,
    styleInstruction: '', sceneSupplement: '', positiveExamples: [], negativeExamples: [], renderNegativeConstraints: '',
  });
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<Category | 'All'>('All');
  const [storedDraft] = useState(() => {
    return readGenerationDraft<StoredPresetDraft>('preset-editor');
  });
  const [selectedId, setSelectedId] = useState(storedDraft?.selectedId ?? snapshot.data.presets[0]?.id ?? '');
  const [creating, setCreating] = useState(storedDraft?.creating ?? false);
  const selected = snapshot.data.presets.find(item => item.id === selectedId) ?? null;
  const [draft, setDraft] = useState<PresetInput>(() => storedDraft?.draft ?? (selected ? presetInput(selected) : makeEmpty()));
  const [positiveText, setPositiveText] = useState(() => storedDraft?.positiveText ?? draft.positiveExamples.join('\n'));
  const [negativeText, setNegativeText] = useState(() => storedDraft?.negativeText ?? draft.negativeExamples.join('\n'));
  const [confirming, setConfirming] = useState(false);
  const [pendingChange, setPendingChange] = useState<PendingPresetChange | null>(null);
  const [validation, setValidation] = useState(false);
  const [failure, setFailure] = useState<null | 'Conflict' | 'NotFound' | 'InvalidInput' | 'Unavailable'>(null);
  const locale = snapshot.preferences.locale;

  const filtered = useMemo(() => {
    const filters = { search, category: categoryFilter };
    return snapshot.data.presets.filter(item => matchesPresetFilters(item, filters, locale));
  }, [categoryFilter, locale, search, snapshot.data.presets]);

  const load = (input: PresetInput) => {
    setDraft(input);
    setPositiveText(input.positiveExamples.join('\n'));
    setNegativeText(input.negativeExamples.join('\n'));
  };

  useEffect(() => {
    if (!creating && selected) load(presetInput(selected));
  }, [creating, selected?.id, selected?.revision]);

  const storedValue = { creating, selectedId, draft, positiveText, negativeText };
  const savedValue = selected ? presetInput(selected) : null;
  const emptyValue = makeEmpty();
  const dirty = creating
    ? JSON.stringify(draft) !== JSON.stringify(emptyValue) || positiveText !== '' || negativeText !== ''
    : savedValue !== null && (
      JSON.stringify(draft) !== JSON.stringify(savedValue)
      || positiveText !== savedValue.positiveExamples.join('\n')
      || negativeText !== savedValue.negativeExamples.join('\n')
    );

  const applyChange = (change: PendingPresetChange) => {
    if (change.kind === 'new') {
      setCreating(true);
      setSelectedId('');
      load(makeEmpty());
    } else if (change.kind === 'select') {
      const item = snapshot.data.presets.find(candidate => candidate.id === change.id);
      if (!item) return;
      setCreating(false);
      setSelectedId(item.id);
      load(presetInput(item));
    } else {
      setSearch(change.filters.search);
      setCategoryFilter(change.filters.category);
      const nextFiltered = snapshot.data.presets.filter(item => matchesPresetFilters(item, change.filters, locale));
      if (!creating && selected && !nextFiltered.some(item => item.id === selected.id)) {
        const next = nextFiltered[0];
        setSelectedId(next?.id ?? '');
        setCreating(!next);
        load(next ? presetInput(next) : makeEmpty());
      }
    }
    setFailure(null);
    setValidation(false);
  };

  const requestChange = (change: PendingPresetChange) => {
    const wouldLeaveEditor = change.kind !== 'filters'
      || (!creating && selected !== null && !matchesPresetFilters(selected, change.filters, locale));
    if (dirty && wouldLeaveEditor) {
      setPendingChange(change);
      return;
    }
    applyChange(change);
  };

  const startNew = () => requestChange({ kind: 'new' });
  const choose = (item: Preset) => requestChange({ kind: 'select', id: item.id });
  const requestFilters = (filters: PresetFilters) => requestChange({ kind: 'filters', filters });

  const requestSave = () => {
    if (!draft.name.trim() || !draft.styleInstruction.trim() || !draft.renderNegativeConstraints.trim()) {
      setValidation(true);
      return;
    }
    setValidation(false);
    setConfirming(true);
  };

  const save = () => {
    const complete: PresetInput = { ...draft, positiveExamples: lines(positiveText), negativeExamples: lines(negativeText) };
    const result = creating || !selected
      ? repository.createPreset(complete)
      : repository.updatePreset(selected.id, {
          name: complete.name,
          styleInstruction: complete.styleInstruction,
          sceneSupplement: complete.sceneSupplement,
          positiveExamples: complete.positiveExamples,
          negativeExamples: complete.negativeExamples,
          renderNegativeConstraints: complete.renderNegativeConstraints,
        }, selected.revision);
    setConfirming(false);
    if (!result.ok) {
      setFailure(result.kind);
      return;
    }
    setCreating(false);
    setSelectedId(result.value.id);
    load(presetInput(result.value));
    setFailure(null);
    showToast(g('presets.saved'));
  };

  useGenerationDraft('preset-editor', storedValue, dirty);
  useUnsavedChanges(dirty);
  useCommandEnter(requestSave, !confirming && pendingChange === null);

  const hasFilters = search !== '' || categoryFilter !== 'All';

  return (
    <GenerationScaffold title={'presets.title'} subtitle={'presets.subtitle'} action={<Button variant="primary" onClick={startNew}>{g('presets.new')}</Button>}>
      {failure ? <OperationFeedback kind={failure} onDismiss={() => setFailure(null)} /> : null}
      <div className="generation-layout generation-layout--editor">
        <section className="panel generation-list" aria-labelledby="preset-list-title">
          <div className="section-header">
            <h2 id="preset-list-title">{g('presets.list')}</h2>
            {hasFilters ? <Button variant="quiet" onClick={() => requestFilters({ search: '', category: 'All' })}>{g('common.clearFilters')}</Button> : null}
          </div>
          <div className="generation-filters">
            <Field label={g('common.search')} htmlFor="preset-search">
              <input id="preset-search" type="search" value={search} onChange={event => requestFilters({ search: event.target.value, category: categoryFilter })} placeholder={g('presets.searchPlaceholder')} />
            </Field>
            <Field label={g('presets.categoryFilter')} htmlFor="preset-category-filter">
              <select id="preset-category-filter" value={categoryFilter} onChange={event => requestFilters({ search, category: event.target.value as Category | 'All' })}>
                <option value="All">{g('common.all')}</option>{categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}
              </select>
            </Field>
          </div>
          {snapshot.data.presets.length === 0 || filtered.length === 0 ? (
            <div className="generation-list__empty"><p>{g(snapshot.data.presets.length === 0 ? 'presets.empty' : 'presets.filtered')}</p></div>
          ) : (
            <TableShell caption={g('presets.tableCaption')} columns={[
              { key: 'name', label: g('presets.name') }, { key: 'category', label: g('presets.category') }, { key: 'updated', label: g('common.updated') },
            ]}>
              {filtered.map(item => (
                <tr key={item.id} className={!creating && item.id === selectedId ? 'is-selected' : undefined}>
                  <th scope="row"><button type="button" className="table-link" aria-pressed={!creating && item.id === selectedId} onClick={() => choose(item)}>{item.name}</button></th>
                  <td>{categoryLabel(g, item.category)}</td><td>{new Date(item.updatedAt).toLocaleDateString(locale)}</td>
                </tr>
              ))}
            </TableShell>
          )}
        </section>
        <section className="panel generation-form generation-editor" aria-label={g('presets.editorRegion')}>
          <div className="section-header"><h2>{g(creating ? 'presets.createTitle' : 'presets.editor')}</h2></div>
          <div className="generation-form__grid">
            <Field label={g('presets.name')} htmlFor="preset-name" required>
              <input id="preset-name" value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} placeholder={g('presets.namePlaceholder')} />
            </Field>
            <Field label={g('presets.category')} htmlFor="preset-category" required>
              <select id="preset-category" value={draft.category} disabled={!creating} onChange={event => setDraft(current => ({ ...current, category: event.target.value as Category }))}>
                {categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}
              </select>
            </Field>
            <div className="generation-form__wide">
              <strong>{g('presets.fixedRules')}</strong>
              <ol className="generation-editor__rules">{fixedStructureRules.map(rule => <li key={rule}>{g(rule)}</li>)}</ol>
            </div>
            <Field className="generation-form__wide" label={g('presets.style')} htmlFor="preset-style" required>
              <textarea id="preset-style" value={draft.styleInstruction} onChange={event => setDraft(current => ({ ...current, styleInstruction: event.target.value }))} placeholder={g('presets.stylePlaceholder')} />
            </Field>
            <Field className="generation-form__wide" label={g('presets.sceneSupplement')} htmlFor="preset-scene">
              <textarea id="preset-scene" value={draft.sceneSupplement} onChange={event => setDraft(current => ({ ...current, sceneSupplement: event.target.value }))} placeholder={g('presets.sceneSupplementPlaceholder')} />
            </Field>
            <Field className="generation-form__wide" label={g('presets.positive')} htmlFor="preset-positive">
              <textarea id="preset-positive" value={positiveText} onChange={event => setPositiveText(event.target.value)} placeholder={g('presets.positivePlaceholder')} />
            </Field>
            <Field className="generation-form__wide" label={g('presets.negative')} htmlFor="preset-negative">
              <textarea id="preset-negative" value={negativeText} onChange={event => setNegativeText(event.target.value)} placeholder={g('presets.negativePlaceholder')} />
            </Field>
            <Field className="generation-form__wide" label={g('presets.constraints')} htmlFor="preset-constraints" required>
              <textarea id="preset-constraints" value={draft.renderNegativeConstraints} onChange={event => setDraft(current => ({ ...current, renderNegativeConstraints: event.target.value }))} placeholder={g('presets.constraintsPlaceholder')} />
            </Field>
          </div>
          {validation ? <p className="field__error" role="alert">{g('presets.validation')}</p> : null}
          <div className="generation-form__actions"><Button variant="primary" onClick={requestSave}>{g('common.save')}</Button></div>
          <p className="generation-shortcut-hint">{g('presets.saveShortcut')}</p>
        </section>
      </div>
      <ConfirmDialog open={confirming} title={g('presets.saveConfirmTitle')} body={g('presets.saveConfirmBody')} confirmLabel={g('common.save')} cancelLabel={g('common.cancel')} closeLabel={g('common.close')} onConfirm={save} onClose={() => setConfirming(false)} />
      <ConfirmDialog
        open={pendingChange !== null}
        title={g('presets.discardTitle')}
        body={g('presets.discardBody')}
        confirmLabel={g('presets.discard')}
        cancelLabel={g('common.cancel')}
        closeLabel={g('common.close')}
        onConfirm={() => {
          if (pendingChange) applyChange(pendingChange);
          setPendingChange(null);
        }}
        onClose={() => setPendingChange(null)}
      />
    </GenerationScaffold>
  );
}
