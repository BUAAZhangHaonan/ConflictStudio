import { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, Field, Pagination, StatusBadge } from '../../components';
import {
  useContentScriptQuery,
  useContentScriptsQuery,
  useCreateContentScriptMutation,
  useCreatePromptTemplateVersionMutation,
  useCreateSceneMutation,
  usePromptTemplatesQuery,
  usePromptTemplateVersionQuery,
  usePromptTemplateVersionsQuery,
  useSceneQuery,
  useScenesQuery,
  useUpdateContentScriptMutation,
  useUpdateSceneMutation,
  useVerifyPromptTemplateVersionMutation,
} from '../../api/queries';
import { allowedDirections, type Category, type ConflictDirection } from '../../types';
import type { GenerationKey } from '../../locales/features/generation';
import {
  categories,
  categoryLabel,
  directionLabel,
  localizedName,
  OperationFeedback,
  useGenerationCopy,
  useGenerationLocale,
} from './shared';
import {
  buildContentDraftRequest,
  buildSceneDraftRequest,
  buildVersionDraftRequest,
  contentDraftFromResource,
  emptyContentDraft,
  emptySceneDraft,
  emptyVersionDraft,
  sceneDraftFromResource,
  toggleCompatibility,
  type ContentDraftForm,
  type SceneDraftForm,
  type VersionDraftForm,
} from './testWorkflow';

type EditorMode = 'create' | 'edit';
type ConfirmAction = 'content' | 'scene' | 'version' | 'verify' | null;
type ResourceTab = 'content' | 'scenes' | 'prompts';

export function ResourceEditors() {
  const g = useGenerationCopy();
  const locale = useGenerationLocale();
  const [tab, setTab] = useState<ResourceTab>('content');
  const [contentPage, setContentPage] = useState(1);
  const [scenePage, setScenePage] = useState(1);
  const [templatePage, setTemplatePage] = useState(1);
  const [versionPage, setVersionPage] = useState(1);
  const [contentMode, setContentMode] = useState<EditorMode>('create');
  const [sceneMode, setSceneMode] = useState<EditorMode>('create');
  const [selectedContentId, setSelectedContentId] = useState<number | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState<number | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null);
  const [contentForm, setContentForm] = useState<ContentDraftForm>(() => emptyContentDraft());
  const [sceneForm, setSceneForm] = useState<SceneDraftForm>(() => emptySceneDraft());
  const [versionForm, setVersionForm] = useState<VersionDraftForm>(() => emptyVersionDraft());
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  const contentQuery = useContentScriptsQuery(contentPage, { status: 'Draft' });
  const selectedContentQuery = useContentScriptQuery(selectedContentId);
  const scenesQuery = useScenesQuery(scenePage);
  const selectedSceneQuery = useSceneQuery(selectedSceneId);
  const templatesQuery = usePromptTemplatesQuery(templatePage);
  const versionsQuery = usePromptTemplateVersionsQuery(selectedTemplateId, versionPage);
  const selectedVersionQuery = usePromptTemplateVersionQuery(selectedVersionId);
  const createContent = useCreateContentScriptMutation();
  const updateContent = useUpdateContentScriptMutation();
  const createScene = useCreateSceneMutation();
  const updateScene = useUpdateSceneMutation();
  const createVersion = useCreatePromptTemplateVersionMutation();
  const verifyVersion = useVerifyPromptTemplateVersionMutation();

  const draftContents = contentQuery.data?.items ?? [];
  const draftScenes = (scenesQuery.data?.items ?? []).filter(item => item.status === 'Draft');
  const templates = templatesQuery.data?.items ?? [];
  const versions = versionsQuery.data?.items ?? [];
  const selectedContent = selectedContentQuery.data?.status === 'Draft' ? selectedContentQuery.data : null;
  const selectedScene = selectedSceneQuery.data?.status === 'Draft' ? selectedSceneQuery.data : null;
  const selectedTemplate = templates.find(item => item.id === selectedTemplateId) ?? null;
  const selectedVersion = selectedVersionQuery.data ?? null;
  const draftContentOptions = selectedContent && !draftContents.some(item => item.id === selectedContent.id)
    ? [selectedContent, ...draftContents]
    : draftContents;
  const draftSceneOptions = selectedScene && !draftScenes.some(item => item.id === selectedScene.id)
    ? [selectedScene, ...draftScenes]
    : draftScenes;
  const contentRequest = useMemo(() => buildContentDraftRequest(contentForm), [contentForm]);
  const sceneRequest = useMemo(() => buildSceneDraftRequest(sceneForm), [sceneForm]);
  const versionRequest = useMemo(
    () => buildVersionDraftRequest(versionForm, selectedTemplate?.revision ?? null),
    [selectedTemplate?.revision, versionForm],
  );

  useEffect(() => {
    if (contentMode === 'edit' && selectedContent) setContentForm(contentDraftFromResource(selectedContent));
  }, [contentMode, selectedContent?.id, selectedContent?.revision]);

  useEffect(() => {
    if (sceneMode === 'edit' && selectedScene) setSceneForm(sceneDraftFromResource(selectedScene));
  }, [sceneMode, selectedScene?.id, selectedScene?.revision]);

  useEffect(() => {
    if (templates.some(item => item.id === selectedTemplateId)) return;
    setSelectedTemplateId(templates[0]?.id ?? null);
    setSelectedVersionId(null);
  }, [selectedTemplateId, templates]);

  useEffect(() => {
    if (versions.some(item => item.id === selectedVersionId)) return;
    setSelectedVersionId(versions[0]?.id ?? null);
  }, [selectedVersionId, versions]);

  const changeContentCategory = (category: Category) => {
    setContentForm(current => ({
      ...current,
      category,
      conflictDirection: allowedDirections(category)[0] ?? null,
      dialogue: category.endsWith('-VA') ? current.dialogue : null,
      displayText: category.endsWith('-VT') ? current.displayText : null,
    }));
  };

  const saveContent = async () => {
    if (contentRequest === null) return;
    try {
      if (contentMode === 'create') {
        const saved = await createContent.mutateAsync(contentRequest);
        setSelectedContentId(saved.id);
        setContentMode('edit');
        setContentForm(contentDraftFromResource(saved));
      } else if (selectedContent) {
        const { category: _category, ...editable } = contentRequest;
        const saved = await updateContent.mutateAsync({
          id: selectedContent.id,
          input: { ...editable, expectedRevision: selectedContent.revision },
        });
        setContentForm(contentDraftFromResource(saved));
      }
      setConfirmAction(null);
    } catch {
      return;
    }
  };

  const saveScene = async () => {
    if (sceneRequest === null) return;
    try {
      if (sceneMode === 'create') {
        const saved = await createScene.mutateAsync(sceneRequest);
        setSelectedSceneId(saved.id);
        setSceneMode('edit');
        setSceneForm(sceneDraftFromResource(saved));
      } else if (selectedScene) {
        const { status: _status, ...editable } = sceneRequest;
        const saved = await updateScene.mutateAsync({
          id: selectedScene.id,
          input: { ...editable, status: 'Draft', expectedRevision: selectedScene.revision },
        });
        setSceneForm(sceneDraftFromResource(saved));
      }
      setConfirmAction(null);
    } catch {
      return;
    }
  };

  const saveVersion = async () => {
    if (selectedTemplateId === null || versionRequest === null) return;
    try {
      const saved = await createVersion.mutateAsync({ templateId: selectedTemplateId, input: versionRequest });
      setSelectedVersionId(saved.id);
      setVersionForm(emptyVersionDraft());
      setConfirmAction(null);
    } catch {
      return;
    }
  };

  const sealVersion = async () => {
    if (selectedVersion === null || selectedVersion.verificationStatus !== 'Draft') return;
    try {
      const saved = await verifyVersion.mutateAsync({
        id: selectedVersion.id,
        input: { expectedRevision: selectedVersion.revision },
      });
      setConfirmAction(null);
    } catch {
      return;
    }
  };

  const queryError = contentQuery.error ?? selectedContentQuery.error ?? scenesQuery.error
    ?? selectedSceneQuery.error ?? templatesQuery.error ?? versionsQuery.error ?? selectedVersionQuery.error;
  const mutationError = createContent.error ?? updateContent.error ?? createScene.error
    ?? updateScene.error ?? createVersion.error ?? verifyVersion.error;
  const contentBusy = createContent.isPending || updateContent.isPending;
  const sceneBusy = createScene.isPending || updateScene.isPending;
  const versionBusy = createVersion.isPending || verifyVersion.isPending;
  const confirmTitle = confirmAction === 'content'
    ? g(contentMode === 'create' ? 'test.resource.contentCreateTitle' : 'test.resource.contentSaveTitle')
    : confirmAction === 'scene'
      ? g(sceneMode === 'create' ? 'test.resource.sceneCreateTitle' : 'test.resource.sceneSaveTitle')
      : confirmAction === 'version'
        ? g('test.resource.versionCreateTitle')
        : g('test.resource.verifyTitle');
  const confirmBody = confirmAction === 'verify'
    ? g('test.resource.verifyBody')
    : g('test.resource.saveBody');

  return (
    <section className="generation-resources" aria-labelledby="resources-manual-title">
      <div className="section-header">
        <div><h2 id="resources-manual-title">{g('resources.manual.title')}</h2><p>{g('resources.manual.hint')}</p></div>
      </div>
      {queryError ? <OperationFeedback error={queryError} onDismiss={() => void Promise.all([
        contentQuery.refetch(), selectedContentQuery.refetch(), scenesQuery.refetch(), selectedSceneQuery.refetch(),
        templatesQuery.refetch(), versionsQuery.refetch(), selectedVersionQuery.refetch(),
      ])} /> : null}
      {mutationError ? <OperationFeedback error={mutationError} onDismiss={() => {
        createContent.reset(); updateContent.reset(); createScene.reset(); updateScene.reset();
        createVersion.reset(); verifyVersion.reset();
      }} /> : null}

      <div className="generation-resource-tabs" role="tablist" aria-label={g('resources.manual.title')}>
        {(['content', 'scenes', 'prompts'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{g(('resources.tab.' + value) as GenerationKey)}</button>)}
      </div>

      <div className="generation-resource-grid">
        {tab === 'content' ? <section className="panel generation-resource-editor" aria-labelledby="content-resource-title">
          <div className="section-header"><h3 id="content-resource-title">{g('test.resource.contentTitle')}</h3></div>
          <div className="generation-editor-modes">
            <Button variant={contentMode === 'create' ? 'primary' : 'secondary'} onClick={() => { setContentMode('create'); setSelectedContentId(null); setContentForm(emptyContentDraft(contentForm.category)); }}>{g('test.resource.newDraft')}</Button>
            <Button variant={contentMode === 'edit' ? 'primary' : 'secondary'} onClick={() => setContentMode('edit')}>{g('test.resource.editDraft')}</Button>
          </div>
          {contentMode === 'edit' ? <Field label={g('test.resource.chooseContent')} htmlFor="resource-content-select">
            <select id="resource-content-select" value={selectedContentId ?? ''} onChange={event => setSelectedContentId(event.target.value ? Number(event.target.value) : null)}>
              <option value="">{g('common.none')}</option>
              {draftContentOptions.map(item => <option key={item.id} value={item.id}>{localizedName(locale, item)}</option>)}
            </select>
          </Field> : null}
          <div className="generation-form__grid">
            <Field label={g('test.resource.nameZh')} htmlFor="content-name-zh"><input id="content-name-zh" value={contentForm.nameZh} onChange={event => setContentForm(current => ({ ...current, nameZh: event.target.value }))} /></Field>
            <Field label={g('test.resource.nameEn')} htmlFor="content-name-en"><input id="content-name-en" value={contentForm.nameEn} onChange={event => setContentForm(current => ({ ...current, nameEn: event.target.value }))} /></Field>
            <Field label={g('test.taskType')} htmlFor="content-category"><select id="content-category" value={contentForm.category} disabled={contentMode === 'edit'} onChange={event => changeContentCategory(event.target.value as Category)}>{categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}</select></Field>
            <Field label={g('test.direction')} htmlFor="content-direction"><select id="content-direction" value={contentForm.conflictDirection ?? ''} disabled={allowedDirections(contentForm.category).length === 0} onChange={event => setContentForm(current => ({ ...current, conflictDirection: (event.target.value || null) as ConflictDirection | null }))}>{allowedDirections(contentForm.category).length === 0 ? <option value="">{g('common.none')}</option> : null}{allowedDirections(contentForm.category).map(value => <option key={value} value={value}>{directionLabel(g, value)}</option>)}</select></Field>
            <Field label={g('test.resource.mode')} htmlFor="content-mode"><select id="content-mode" value={contentForm.mode} onChange={event => setContentForm(current => ({ ...current, mode: event.target.value as ContentDraftForm['mode'], sceneIds: [] }))}><option value="Fixed">{g('assistant.mode.Fixed')}</option><option value="Generative">{g('assistant.mode.Generative')}</option></select></Field>
            <Field label={g('test.resource.protocol')} htmlFor="content-protocol"><input id="content-protocol" value={contentForm.category.endsWith('-VA') ? 'VA' : 'VT'} readOnly /></Field>
            <Field label={g('test.resource.relation')} htmlFor="content-relation"><input id="content-relation" value={g(contentForm.category.startsWith('A-') ? 'test.resource.aligned' : 'test.resource.conflict')} readOnly /></Field>
            <Field label={g('test.resource.trueEmotion')} htmlFor="content-true-emotion"><input id="content-true-emotion" value={contentForm.trueEmotion} onChange={event => setContentForm(current => ({ ...current, trueEmotion: event.target.value }))} /></Field>
            <Field label={g('test.resource.apparentEmotion')} htmlFor="content-apparent-emotion"><input id="content-apparent-emotion" value={contentForm.apparentEmotion} onChange={event => setContentForm(current => ({ ...current, apparentEmotion: event.target.value }))} /></Field>
          </div>
          {([
            ['sceneZh', 'test.resource.settingZh'], ['sceneEn', 'test.resource.settingEn'],
            ['triggerEventZh', 'test.resource.eventZh'], ['triggerEventEn', 'test.resource.eventEn'],
            ['psychologicalBackgroundZh', 'test.resource.backgroundZh'], ['psychologicalBackgroundEn', 'test.resource.backgroundEn'],
          ] as const).map(([field, key]) => <Field key={field} label={g(key)} htmlFor={'content-' + field}><textarea id={'content-' + field} value={contentForm[field]} onChange={event => setContentForm(current => ({ ...current, [field]: event.target.value }))} /></Field>)}
          {contentForm.category.endsWith('-VA') ? <Field label={g('test.resource.dialogue')} htmlFor="content-dialogue"><textarea id="content-dialogue" value={contentForm.dialogue ?? ''} onChange={event => setContentForm(current => ({ ...current, dialogue: event.target.value || null }))} /></Field> : <Field label={g('test.resource.displayText')} htmlFor="content-display-text"><textarea id="content-display-text" value={contentForm.displayText ?? ''} onChange={event => setContentForm(current => ({ ...current, displayText: event.target.value || null }))} /></Field>}
          {contentForm.mode === 'Fixed' ? <>
            <Field label={g('test.resource.emotionDescription')} htmlFor="content-emotion-description"><textarea id="content-emotion-description" value={contentForm.trueEmotionDescription} onChange={event => setContentForm(current => ({ ...current, trueEmotionDescription: event.target.value }))} /></Field>
            <Field label={g('test.resource.basePrompt')} htmlFor="content-base-prompt"><textarea id="content-base-prompt" value={contentForm.baseVideoPrompt} onChange={event => setContentForm(current => ({ ...current, baseVideoPrompt: event.target.value }))} /></Field>
          </> : <>
            <Field label={g('test.resource.requirementsZh')} htmlFor="content-requirements-zh"><textarea id="content-requirements-zh" value={contentForm.contentRequirementsZh} onChange={event => setContentForm(current => ({ ...current, contentRequirementsZh: event.target.value }))} /></Field>
            <Field label={g('test.resource.requirementsEn')} htmlFor="content-requirements-en"><textarea id="content-requirements-en" value={contentForm.contentRequirementsEn} onChange={event => setContentForm(current => ({ ...current, contentRequirementsEn: event.target.value }))} /></Field>
          </>}
          <Field label={g('test.resource.supplementZh')} htmlFor="content-supplement-zh"><textarea id="content-supplement-zh" value={contentForm.sceneSupplementZh} onChange={event => setContentForm(current => ({ ...current, sceneSupplementZh: event.target.value }))} /></Field>
          <Field label={g('test.resource.supplementEn')} htmlFor="content-supplement-en"><textarea id="content-supplement-en" value={contentForm.sceneSupplementEn} onChange={event => setContentForm(current => ({ ...current, sceneSupplementEn: event.target.value }))} /></Field>
          <fieldset className="generation-compatibility">
            <legend>{g('test.resource.compatibility')}</legend>
            <p>{g('test.resource.compatibilityHint')}</p>
            {(scenesQuery.data?.items ?? []).length === 0 ? <p>{g('state.empty')}</p> : <div className="generation-check-grid">{(scenesQuery.data?.items ?? []).map(scene => <label key={scene.id}><input type={contentForm.mode === 'Fixed' ? 'radio' : 'checkbox'} name={contentForm.mode === 'Fixed' ? 'content-scene' : undefined} checked={contentForm.sceneIds.includes(scene.id)} onChange={() => setContentForm(current => ({ ...current, sceneIds: toggleCompatibility(current.mode, current.sceneIds, scene.id) }))} /><span>{localizedName(locale, scene)}</span></label>)}</div>}
            <Pagination page={scenesQuery.data?.page ?? scenePage} totalPages={scenesQuery.data?.totalPages ?? 0} total={scenesQuery.data?.total ?? 0} onPageChange={setScenePage} />
          </fieldset>
          {contentRequest === null ? <p className="field__error" role="alert">{g('test.resource.contentValidation')}</p> : null}
          <Button variant="primary" busy={contentBusy} disabled={contentRequest === null || (contentMode === 'edit' && selectedContent === null)} onClick={() => setConfirmAction('content')}>{g(contentMode === 'create' ? 'test.resource.createDraft' : 'test.resource.saveDraft')}</Button>
          <Pagination page={contentQuery.data?.page ?? contentPage} totalPages={contentQuery.data?.totalPages ?? 0} total={contentQuery.data?.total ?? 0} onPageChange={setContentPage} />
        </section> : null}

        {tab === 'scenes' ? <section className="panel generation-resource-editor" aria-labelledby="scene-resource-title">
          <div className="section-header"><h3 id="scene-resource-title">{g('test.resource.sceneTitle')}</h3></div>
          <div className="generation-editor-modes">
            <Button variant={sceneMode === 'create' ? 'primary' : 'secondary'} onClick={() => { setSceneMode('create'); setSelectedSceneId(null); setSceneForm(emptySceneDraft()); }}>{g('test.resource.newDraft')}</Button>
            <Button variant={sceneMode === 'edit' ? 'primary' : 'secondary'} onClick={() => setSceneMode('edit')}>{g('test.resource.editDraft')}</Button>
          </div>
          {sceneMode === 'edit' ? <Field label={g('test.resource.chooseScene')} htmlFor="resource-scene-select"><select id="resource-scene-select" value={selectedSceneId ?? ''} onChange={event => setSelectedSceneId(event.target.value ? Number(event.target.value) : null)}><option value="">{g('common.none')}</option>{draftSceneOptions.map(item => <option key={item.id} value={item.id}>{localizedName(locale, item)}</option>)}</select></Field> : null}
          <div className="generation-form__grid">
            <Field label={g('test.resource.nameZh')} htmlFor="scene-name-zh"><input id="scene-name-zh" value={sceneForm.nameZh} onChange={event => setSceneForm(current => ({ ...current, nameZh: event.target.value }))} /></Field>
            <Field label={g('test.resource.nameEn')} htmlFor="scene-name-en"><input id="scene-name-en" value={sceneForm.nameEn} onChange={event => setSceneForm(current => ({ ...current, nameEn: event.target.value }))} /></Field>
          </div>
          {([
            ['sceneZh', 'test.resource.sceneZh'], ['sceneEn', 'test.resource.sceneEn'],
            ['ambientSoundZh', 'test.resource.ambientZh'], ['ambientSoundEn', 'test.resource.ambientEn'],
            ['participantRelationshipZh', 'test.resource.relationshipZh'], ['participantRelationshipEn', 'test.resource.relationshipEn'],
            ['lightingZh', 'test.resource.lightingZh'], ['lightingEn', 'test.resource.lightingEn'],
            ['framingZh', 'test.resource.framingZh'], ['framingEn', 'test.resource.framingEn'],
          ] as const).map(([field, key]) => <Field key={field} label={g(key)} htmlFor={'scene-' + field}><textarea id={'scene-' + field} value={sceneForm[field]} onChange={event => setSceneForm(current => ({ ...current, [field]: event.target.value }))} /></Field>)}
          {sceneRequest === null ? <p className="field__error" role="alert">{g('test.resource.sceneValidation')}</p> : null}
          <Button variant="primary" busy={sceneBusy} disabled={sceneRequest === null || (sceneMode === 'edit' && selectedScene === null)} onClick={() => setConfirmAction('scene')}>{g(sceneMode === 'create' ? 'test.resource.createDraft' : 'test.resource.saveDraft')}</Button>
        </section> : null}

        {tab === 'prompts' ? <section className="panel generation-resource-editor" aria-labelledby="version-resource-title">
          <div className="section-header"><h3 id="version-resource-title">{g('test.resource.versionTitle')}</h3></div>
          <Field label={g('test.template')} htmlFor="resource-template-select"><select id="resource-template-select" value={selectedTemplateId ?? ''} onChange={event => { setSelectedTemplateId(event.target.value ? Number(event.target.value) : null); setSelectedVersionId(null); setVersionPage(1); }}><option value="">{g('common.none')}</option>{templates.map(item => <option key={item.id} value={item.id}>{categoryLabel(g, item.category)}</option>)}</select></Field>
          <Field label={g('test.resource.existingVersion')} htmlFor="resource-version-select"><select id="resource-version-select" value={selectedVersionId ?? ''} onChange={event => setSelectedVersionId(event.target.value ? Number(event.target.value) : null)}><option value="">{g('common.none')}</option>{versions.map(item => <option key={item.id} value={item.id}>{g('test.versionOption', { category: categoryLabel(g, item.category), version: item.version })}</option>)}</select></Field>
          {selectedVersion ? <div className="generation-version-summary"><StatusBadge label={g(selectedVersion.verificationStatus === 'Verified' ? 'test.resource.verified' : 'test.resource.draft')} kind={selectedVersion.verificationStatus === 'Verified' ? 'complete' : 'neutral'} /></div> : null}
          {selectedVersion ? <div className="generation-prompt-readonly">
            <Field label={g('test.resource.rules')} htmlFor="selected-version-rules"><textarea id="selected-version-rules" value={selectedVersion.organizationRules} readOnly /></Field>
            <Field label={g('test.resource.style')} htmlFor="selected-version-style"><textarea id="selected-version-style" value={selectedVersion.styleGuidance} readOnly /></Field>
            <Field label={g('test.resource.ltxNegative')} htmlFor="selected-version-ltx-negative"><textarea id="selected-version-ltx-negative" value={selectedVersion.ltxNegativePrompt} readOnly /></Field>
            <Field label={g('test.resource.h3Negative')} htmlFor="selected-version-h3-negative"><textarea id="selected-version-h3-negative" value={selectedVersion.h3NegativePrompt} readOnly /></Field>
          </div> : null}
          <Button variant="secondary" busy={verifyVersion.isPending} disabled={selectedVersion?.verificationStatus !== 'Draft'} onClick={() => setConfirmAction('verify')}>{g('test.resource.verify')}</Button>
          <Pagination page={versionsQuery.data?.page ?? versionPage} totalPages={versionsQuery.data?.totalPages ?? 0} total={versionsQuery.data?.total ?? 0} onPageChange={setVersionPage} />
          <div className="section-header"><h4>{g('test.resource.newVersion')}</h4></div>
          <Field label={g('test.resource.rules')} htmlFor="new-version-rules"><textarea id="new-version-rules" value={versionForm.organizationRules} onChange={event => setVersionForm(current => ({ ...current, organizationRules: event.target.value }))} /></Field>
          <Field label={g('test.resource.style')} htmlFor="new-version-style"><textarea id="new-version-style" value={versionForm.styleGuidance} onChange={event => setVersionForm(current => ({ ...current, styleGuidance: event.target.value }))} /></Field>
          <Field label={g('test.resource.ltxNegative')} htmlFor="new-version-ltx-negative"><textarea id="new-version-ltx-negative" value={versionForm.ltxNegativePrompt} onChange={event => setVersionForm(current => ({ ...current, ltxNegativePrompt: event.target.value }))} /></Field>
          <Field label={g('test.resource.h3Negative')} htmlFor="new-version-h3-negative"><textarea id="new-version-h3-negative" value={versionForm.h3NegativePrompt} onChange={event => setVersionForm(current => ({ ...current, h3NegativePrompt: event.target.value }))} /></Field>
          {versionRequest === null ? <p className="field__error" role="alert">{g('test.resource.versionValidation')}</p> : null}
          <Button variant="primary" busy={createVersion.isPending} disabled={selectedTemplateId === null || versionRequest === null} onClick={() => setConfirmAction('version')}>{g('test.resource.createVersion')}</Button>
          <Pagination page={templatesQuery.data?.page ?? templatePage} totalPages={templatesQuery.data?.totalPages ?? 0} total={templatesQuery.data?.total ?? 0} onPageChange={setTemplatePage} />
        </section> : null}
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmTitle}
        body={confirmBody}
        confirmLabel={g('common.confirm')}
        cancelLabel={g('common.cancel')}
        closeLabel={g('common.close')}
        onConfirm={() => {
          if (confirmAction === 'content') void saveContent();
          else if (confirmAction === 'scene') void saveScene();
          else if (confirmAction === 'version') void saveVersion();
          else if (confirmAction === 'verify') void sealVersion();
        }}
        onClose={() => setConfirmAction(null)}
        busy={(confirmAction === 'content' && contentBusy) || (confirmAction === 'scene' && sceneBusy) || ((confirmAction === 'version' || confirmAction === 'verify') && versionBusy)}
      />
    </section>
  );
}
