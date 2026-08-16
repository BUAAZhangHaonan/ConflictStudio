import { useState } from 'react';
import { Button, Field, Pagination, StatusBadge, useToast } from '../../components';
import {
  useCreatePromptTemplateVersionMutation,
  usePromptTemplateVersionsQuery,
  useVerifyPromptTemplateVersionMutation,
} from '../../api/queries';
import type { PromptTemplateVersionCreate } from '../../api/contracts';
import type { Category } from '../../types';
import {
  categories,
  categoryLabel,
  GenerationScaffold,
  lines,
  OperationFeedback,
  useGenerationCopy,
} from './shared';

function emptyVersion(): PromptTemplateVersionCreate {
  return {
    name: '',
    category: 'A-VA',
    version: 1,
    styleGuidance: '',
    positiveExamples: [],
    negativeExamples: [],
    ltxNegativePrompt: '',
    h3NegativePrompt: '',
    verificationStatus: 'Draft',
  };
}

export function PromptTemplateVersionsPage() {
  const g = useGenerationCopy();
  const { showToast } = useToast();
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<PromptTemplateVersionCreate>(emptyVersion());
  const [validation, setValidation] = useState(false);
  const query = usePromptTemplateVersionsQuery(page);
  const createMutation = useCreatePromptTemplateVersionMutation();
  const verifyMutation = useVerifyPromptTemplateVersionMutation();
  const items = query.data?.items ?? [];
  const error = query.error ?? createMutation.error ?? verifyMutation.error ?? null;

  const create = async () => {
    if (
      !draft.name.trim()
      || draft.version < 1
      || !draft.ltxNegativePrompt.trim()
      || !draft.h3NegativePrompt.trim()
    ) {
      setValidation(true);
      return;
    }
    setValidation(false);
    try {
      const created = await createMutation.mutateAsync(draft);
      setDraft({ ...emptyVersion(), name: created.name, category: created.category, version: created.version + 1 });
      showToast(g('templateVersions.saved'));
    } catch {
      // The shared safe error panel renders mutation errors.
    }
  };

  if (query.isPending) {
    return <GenerationScaffold title="templateVersions.title" subtitle="templateVersions.subtitle"><p role="status">{g('state.loadingBody')}</p></GenerationScaffold>;
  }

  return (
    <GenerationScaffold title="templateVersions.title" subtitle="templateVersions.subtitle">
      {error ? <OperationFeedback error={error} onDismiss={() => { createMutation.reset(); verifyMutation.reset(); }} /> : null}
      <div className="generation-layout generation-layout--editor">
        <section className="panel generation-list" aria-labelledby="template-version-list">
          <div className="section-header"><h2 id="template-version-list">{g('templateVersions.list')}</h2></div>
          <ul className="generation-selection-list">
            {items.map(item => (
              <li key={item.id} className="generation-selection-card">
                <span className="generation-selection-card__title">
                  <strong>{item.name} {g('templateVersions.versionLabel', { version: item.version })}</strong>
                  <StatusBadge
                    label={g(item.verificationStatus === 'Verified' ? 'templateVersions.status.Verified' : 'templateVersions.status.Draft')}
                    kind={item.verificationStatus === 'Verified' ? 'complete' : 'neutral'}
                  />
                </span>
                <span>{categoryLabel(g, item.category)}</span>
                {item.verificationStatus === 'Draft' ? (
                  <Button
                    variant="quiet"
                    disabled={verifyMutation.isPending}
                    onClick={() => verifyMutation.mutate({
                      id: item.id,
                      input: { expectedRevision: item.revision },
                    })}
                  >
                    {g('templateVersions.verify')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <Pagination page={query.data?.page ?? page} totalPages={query.data?.totalPages ?? 0} total={query.data?.total ?? 0} onPageChange={setPage} />
        </section>
        <section className="panel generation-form generation-editor" aria-label={g('templateVersions.editorRegion')}>
          <div className="section-header"><h2>{g('templateVersions.createTitle')}</h2></div>
          <div className="generation-form__grid">
            <Field label={g('templateVersions.name')} htmlFor="template-name" required>
              <input id="template-name" value={draft.name} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} />
            </Field>
            <Field label={g('templateVersions.version')} htmlFor="template-version" required>
              <input id="template-version" type="number" min={1} value={draft.version} onChange={event => setDraft(value => ({ ...value, version: Number(event.target.value) }))} />
            </Field>
            <Field label={g('templateVersions.category')} htmlFor="template-category" required>
              <select id="template-category" value={draft.category} onChange={event => setDraft(value => ({ ...value, category: event.target.value as Category }))}>
                {categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}
              </select>
            </Field>
            <Field className="generation-form__wide" label={g('templateVersions.style')} htmlFor="template-style">
              <textarea id="template-style" value={draft.styleGuidance} onChange={event => setDraft(value => ({ ...value, styleGuidance: event.target.value }))} />
            </Field>
            <Field className="generation-form__wide" label={g('templateVersions.positive')} htmlFor="template-positive">
              <textarea id="template-positive" value={draft.positiveExamples.join('\n')} onChange={event => setDraft(value => ({ ...value, positiveExamples: lines(event.target.value) }))} />
            </Field>
            <Field className="generation-form__wide" label={g('templateVersions.negative')} htmlFor="template-negative">
              <textarea id="template-negative" value={draft.negativeExamples.join('\n')} onChange={event => setDraft(value => ({ ...value, negativeExamples: lines(event.target.value) }))} />
            </Field>
            <Field className="generation-form__wide" label={g('templateVersions.ltxNegativePrompt')} htmlFor="template-ltx-negative" required>
              <textarea id="template-ltx-negative" value={draft.ltxNegativePrompt} onChange={event => setDraft(value => ({ ...value, ltxNegativePrompt: event.target.value }))} />
            </Field>
            <Field className="generation-form__wide" label={g('templateVersions.h3NegativePrompt')} htmlFor="template-h3-negative" required>
              <textarea id="template-h3-negative" value={draft.h3NegativePrompt} onChange={event => setDraft(value => ({ ...value, h3NegativePrompt: event.target.value }))} />
            </Field>
          </div>
          {validation ? <p className="field__error" role="alert">{g('templateVersions.validation')}</p> : null}
          <Button variant="primary" disabled={createMutation.isPending} onClick={() => void create()}>{g('common.save')}</Button>
        </section>
      </div>
    </GenerationScaffold>
  );
}
