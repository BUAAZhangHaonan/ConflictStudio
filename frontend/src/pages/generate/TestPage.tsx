import { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, Dialog, Field, StatusBadge, useToast } from '../../components';
import { canKeepTestResult, useMockRepository, useRepositorySnapshot } from '../../store';
import {
  allowedDirections,
  type Category,
  type ConflictDirection,
  type GpuSlot,
  type ModelName,
  type PreparedTest,
  type TestExecutionMode,
} from '../../types';
import { silentVideoDataUrl, voicedVideoDataUrl } from '../../mockMedia';
import {
  ages,
  categories,
  categoryLabel,
  directionLabel,
  ethnicities,
  genders,
  GpuPanel,
  GenerationScaffold,
  modelSpecLabel,
  models,
  OperationFeedback,
  parseSeed,
  useCommandEnter,
  useGenerationCopy,
} from './shared';

type Assignment = { model: ModelName; gpu: GpuSlot; order: number };
type Age = (typeof ages)[number];
type Gender = (typeof genders)[number];
type Ethnicity = (typeof ethnicities)[number];

interface TestResultCard {
  jobId: string;
  assignmentOrder: number;
  attemptGroupId: string;
  attemptNumber: number;
  prepared: PreparedTest;
}

function exampleTestResults(snapshot: ReturnType<typeof useRepositorySnapshot>): TestResultCard[] {
  return snapshot.data.jobs
    .filter(job => job.testInput !== undefined)
    .map(job => {
      const prepared = job.testInput!;
      let attemptNumber = 1;
      let parentId = job.parentJobId;
      while (parentId) {
        const parent = snapshot.data.jobs.find(item => item.id === parentId);
        if (!parent) break;
        attemptNumber += 1;
        parentId = parent.parentJobId;
      }
      return {
        jobId: job.id,
        assignmentOrder: Math.max(0, prepared.assignments.findIndex(item => item.order === job.testAssignmentOrder)),
        attemptGroupId: `${prepared.id}-${job.testAssignmentOrder ?? 1}`,
        attemptNumber,
        prepared,
      };
    });
}

function signatureFromDraft(
  category: Category,
  direction: ConflictDirection | null,
  contentId: string,
  presetId: string,
  age: Age,
  gender: Gender,
  ethnicity: Ethnicity,
  seed: string,
  assignments: Assignment[],
  executionMode: TestExecutionMode,
) {
  return JSON.stringify({
    category,
    direction,
    contentId,
    presetId,
    age,
    gender,
    ethnicity,
    seed: parseSeed(seed),
    assignments,
    executionMode,
  });
}

function signatureFromPrepared(prepared: PreparedTest) {
  return JSON.stringify({
    category: prepared.category,
    direction: prepared.conflictDirection,
    contentId: prepared.contentItemId,
    presetId: prepared.presetId,
    age: prepared.age,
    gender: prepared.gender,
    ethnicity: prepared.ethnicity,
    seed: prepared.seed,
    assignments: prepared.assignments.map(item => ({ ...item })),
    executionMode: prepared.executionMode,
  });
}

export function TestPage() {
  const g = useGenerationCopy();
  const repository = useMockRepository();
  const snapshot = useRepositorySnapshot();
  const { showToast } = useToast();
  const [category, setCategory] = useState<Category>('A-VA');
  const [direction, setDirection] = useState<ConflictDirection | null>(null);
  const [contentId, setContentId] = useState('');
  const [presetId, setPresetId] = useState('');
  const [age, setAge] = useState<Age>(25);
  const [gender, setGender] = useState<Gender>('Female');
  const [ethnicity, setEthnicity] = useState<Ethnicity>('EastAsian');
  const [seed, setSeed] = useState('');
  const [assignments, setAssignments] = useState<Assignment[]>([{ model: 'LTX-2.3', gpu: 'GPU0', order: 1 }]);
  const [executionMode, setExecutionMode] = useState<TestExecutionMode>('Serial');
  const [prepared, setPrepared] = useState<PreparedTest | null>(null);
  const [failure, setFailure] = useState<null | 'Conflict' | 'NotFound' | 'InvalidInput' | 'Unavailable'>(null);
  const [validation, setValidation] = useState<null | 'general' | 'parallel'>(null);
  const [showStartConfirm, setShowStartConfirm] = useState(false);
  const results = exampleTestResults(snapshot);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [retryOpen, setRetryOpen] = useState(false);
  const [keepOpen, setKeepOpen] = useState(false);
  const [retryJobId, setRetryJobId] = useState('');
  const [retryGpu, setRetryGpu] = useState<GpuSlot | ''>('');
  const [retrySeed, setRetrySeed] = useState('');
  const [keepJobId, setKeepJobId] = useState('');
  const [cancelJobId, setCancelJobId] = useState('');
  const [keepDatasetId, setKeepDatasetId] = useState('');
  const directions = allowedDirections(category);
  const matchingContent = useMemo(
    () => snapshot.data.contentItems.filter(
      item => item.status === 'Active' && item.category === category && item.conflictDirection === direction,
    ),
    [category, direction, snapshot.data.contentItems],
  );
  const matchingPresets = useMemo(
    () => snapshot.data.presets.filter(item => item.category === category),
    [category, snapshot.data.presets],
  );
  const activeDatasets = snapshot.data.datasets.filter(dataset => dataset.status === 'Active');
  const availableGpuSlots = snapshot.data.gpuStates
    .filter(gpu => gpu.availability === 'Available')
    .map(gpu => gpu.slot);
  const currentContent = useMemo(
    () => snapshot.data.contentItems.find(item => item.id === contentId),
    [contentId, snapshot.data.contentItems],
  );
  const currentPreset = useMemo(
    () => snapshot.data.presets.find(item => item.id === presetId),
    [presetId, snapshot.data.presets],
  );
  const activeRunCards = useMemo(
    () => results
      .map(card => {
        const job = snapshot.data.jobs.find(item => item.id === card.jobId);
        return job ? { ...card, job } : null;
      })
      .filter((card): card is TestResultCard & { job: NonNullable<ReturnType<typeof snapshot.data.jobs.find>> } => card !== null),
    [results, snapshot.data.jobs],
  );
  const latestAttemptByGroup = useMemo(() => {
    const latest = new Map<string, number>();
    activeRunCards.forEach(card => {
      latest.set(card.attemptGroupId, Math.max(latest.get(card.attemptGroupId) ?? 0, card.attemptNumber));
    });
    return latest;
  }, [activeRunCards]);
  const currentSignature = useMemo(
    () => signatureFromDraft(
      category,
      direction,
      contentId,
      presetId,
      age,
      gender,
      ethnicity,
      seed,
      assignments,
      executionMode,
    ),
    [age, assignments, category, direction, ethnicity, gender, presetId, seed, contentId, executionMode],
  );
  const isPreparedCurrent = prepared !== null && signatureFromPrepared(prepared) === currentSignature;

  useEffect(() => {
    setContentId(current => matchingContent.some(item => item.id === current) ? current : (matchingContent[0]?.id ?? ''));
    setPresetId(current => matchingPresets.some(item => item.id === current) ? current : (matchingPresets[0]?.id ?? ''));
  }, [matchingContent, matchingPresets]);

  useEffect(() => {
    if (prepared && !isPreparedCurrent) {
      setPrepared(null);
    }
  }, [isPreparedCurrent, prepared]);

  useEffect(() => {
    if (cancelJobId !== '' && !activeRunCards.some(card => card.job.id === cancelJobId)) {
      setCancelOpen(false);
      setCancelJobId('');
    }
  }, [activeRunCards, cancelJobId]);

  useEffect(() => {
    if (retryJobId !== '' && !activeRunCards.some(card => card.job.id === retryJobId)) {
      setRetryOpen(false);
      setRetryJobId('');
    }
  }, [activeRunCards, retryJobId]);

  useEffect(() => {
    if (keepJobId !== '' && !activeRunCards.some(card => card.job.id === keepJobId)) {
      setKeepOpen(false);
      setKeepJobId('');
    }
  }, [activeRunCards, keepJobId]);

  useEffect(() => {
    if (retryJobId === '') return;
    const selected = activeRunCards.find(card => card.job.id === retryJobId)?.job;
    if (!selected) return;
    setRetryGpu(availableGpuSlots.includes(selected.gpu) ? selected.gpu : (availableGpuSlots[0] ?? ''));
    setRetrySeed(selected.seed == null ? '' : String(selected.seed));
  }, [retryJobId, availableGpuSlots, activeRunCards]);

  useEffect(() => {
    if (keepDatasetId !== '' && activeDatasets.some(dataset => dataset.id === keepDatasetId)) return;
    setKeepDatasetId(activeDatasets[0]?.id ?? '');
  }, [activeDatasets, keepDatasetId]);

  useEffect(() => {
    if (!isPreparedCurrent) setValidation(null);
  }, [isPreparedCurrent]);

  const updateAssignment = (index: number, patch: Partial<Assignment>) => {
    setAssignments(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  };

  const changeCategory = (nextCategory: Category) => {
    const nextDirection = allowedDirections(nextCategory)[0] ?? null;
    setCategory(nextCategory);
    setDirection(nextDirection);
    setContentId(snapshot.data.contentItems.find(item =>
      item.status === 'Active' && item.category === nextCategory && item.conflictDirection === nextDirection,
    )?.id ?? '');
    setPresetId(snapshot.data.presets.find(item => item.category === nextCategory)?.id ?? '');
  };

  const addSecond = () => {
    setAssignments(current => [...current, { model: current[0].model === 'LTX-2.3' ? 'MiniMax H3' : 'LTX-2.3', gpu: executionMode === 'Parallel' ? 'GPU1' : current[0].gpu, order: 2 }]);
  };

  const prepare = () => {
    const duplicateModels = new Set(assignments.map(item => item.model)).size !== assignments.length;
    const duplicateParallelGpu = executionMode === 'Parallel' && new Set(assignments.map(item => item.gpu)).size !== assignments.length;
    const unavailableGpu = assignments.some(assignment =>
      snapshot.data.gpuStates.find(gpu => gpu.slot === assignment.gpu)?.availability !== 'Available',
    );
    if (duplicateModels || !contentId || !presetId) {
      setValidation('general');
      return;
    }
    if (duplicateParallelGpu) {
      setValidation('parallel');
      return;
    }
    if (unavailableGpu) {
      setValidation(null);
      setFailure('Unavailable');
      return;
    }
    const result = repository.prepareTest({
      category,
      conflictDirection: direction,
      contentItemId: contentId,
      presetId,
      age,
      gender,
      ethnicity,
      seed: parseSeed(seed),
      assignments,
      executionMode,
    });
    if (!result.ok) {
      setValidation(result.kind === 'InvalidInput' ? 'general' : null);
      setFailure(result.kind === 'InvalidInput' ? null : result.kind);
      return;
    }
    setValidation(null);
    setFailure(null);
    setPrepared(result.value);
    setShowStartConfirm(true);
  };

  const startTest = () => {
    if (!prepared || !isPreparedCurrent) {
      setShowStartConfirm(false);
      setPrepared(null);
      return;
    }
    const result = repository.submitTest(prepared);
    setShowStartConfirm(false);
    if (!result.ok) {
      setPrepared(null);
      setFailure(result.kind);
      return;
    }
    setPrepared(null);
    setFailure(null);
    showToast(result.value.length === 1 ? g('test.success') : g('test.successMany', { count: result.value.length }));
  };

  useCommandEnter(() => {
    if (prepared && isPreparedCurrent) {
      setShowStartConfirm(true);
    }
  }, prepared !== null && isPreparedCurrent);

  const openRetry = (jobId: string) => {
    const selected = activeRunCards.find(card => card.job.id === jobId);
    if (!selected || (selected.job.status !== 'Failed' && selected.job.status !== 'Cancelled')) return;
    setRetryJobId(jobId);
    setRetryGpu(availableGpuSlots.includes(selected.job.gpu) ? selected.job.gpu : (availableGpuSlots[0] ?? ''));
    setRetrySeed(selected.job.seed == null ? '' : String(selected.job.seed));
    setRetryOpen(true);
  };

  const openKeep = (jobId: string) => {
    const selected = activeRunCards.find(card => card.job.id === jobId);
    if (!selected || !canKeepTestResult(selected.job)) return;
    setKeepJobId(jobId);
    setKeepDatasetId(activeDatasets[0]?.id ?? '');
    setKeepOpen(true);
  };

  const openCancel = (jobId: string) => {
    const selected = activeRunCards.find(card => card.job.id === jobId);
    if (!selected || (selected.job.status !== 'Queued' && selected.job.status !== 'Running')) return;
    setCancelJobId(jobId);
    setCancelOpen(true);
  };

  const cancelResult = () => {
    if (!cancelJobId) return;
    const selected = snapshot.data.jobs.find(job => job.id === cancelJobId);
    if (!selected) return;
    const result = repository.cancelJob(selected.id, selected.revision);
    setCancelOpen(false);
    setCancelJobId('');
    if (!result.ok) {
      setFailure(result.kind);
      return;
    }
    setFailure(null);
    showToast(g('test.cancelled'));
  };

  const retryResult = () => {
    if (!retryJobId || retryGpu === '') return;
    const source = snapshot.data.jobs.find(job => job.id === retryJobId);
    if (!source || (source.status !== 'Failed' && source.status !== 'Cancelled')) return;
    const result = repository.retryJob(source.id, retryGpu, parseSeed(retrySeed), source.revision);
    setRetryOpen(false);
    setRetryJobId('');
    if (!result.ok) {
      setFailure(result.kind);
      return;
    }
    setFailure(null);
    showToast(g('jobs.retried'));
  };

  const keepResult = () => {
    if (!keepJobId || keepDatasetId === '') return;
    const selected = snapshot.data.jobs.find(job => job.id === keepJobId);
    if (!selected || !canKeepTestResult(selected)) return;
    const result = repository.keepTestResult(selected.id, keepDatasetId, selected.revision);
    setKeepOpen(false);
    setKeepJobId('');
    if (!result.ok) {
      setFailure(result.kind);
      return;
    }
    setFailure(null);
    showToast(g('jobs.kept'));
  };

  const serialSwitchMessage = executionMode === 'Serial'
    && assignments.length === 2
    && assignments[0].gpu === assignments[1].gpu
    && assignments[0].model !== assignments[1].model
    ? g('test.serialModelSwitch', {
        gpu: g(`gpu.${assignments[0].gpu}`),
        currentModel: g(`model.${assignments[0].model}`),
        nextModel: g(`model.${assignments[1].model}`),
      })
    : null;
  const retrySource = snapshot.data.jobs.find(job => job.id === retryJobId) ?? null;
  const retryGpuState = snapshot.data.gpuStates.find(gpu => gpu.slot === retryGpu) ?? null;

  return (
    <GenerationScaffold title={'test.title'} subtitle={'test.subtitle'}>
      {failure ? <OperationFeedback kind={failure} onDismiss={() => setFailure(null)} /> : null}
      <div className="generation-layout">
        <section className="panel generation-form" aria-label={g('test.formRegion')}>
          <div className="section-header"><h2>{g('test.setup')}</h2></div>
          <div className="generation-form__grid">
            <Field label={g('test.category')} htmlFor="test-category" required>
              <select id="test-category" value={category} onChange={event => changeCategory(event.target.value as Category)}>
                {categories.map(value => <option key={value} value={value}>{categoryLabel(g, value)}</option>)}
              </select>
            </Field>
            <Field label={g('test.direction')} htmlFor="test-direction" required={directions.length > 0}>
              <select id="test-direction" value={direction ?? ''} disabled={directions.length === 0} onChange={event => setDirection((event.target.value || null) as ConflictDirection | null)}>
                {directions.length === 0 ? <option value="">{g('common.none')}</option> : null}
                {directions.map(value => <option key={value} value={value}>{directionLabel(g, value)}</option>)}
              </select>
            </Field>
            <Field label={g('test.content')} htmlFor="test-content" required>
              <select id="test-content" value={contentId} onChange={event => setContentId(event.target.value)}>
                {matchingContent.length === 0 ? <option value="">{g('batches.noContent')}</option> : null}
                {matchingContent.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </Field>
            <Field label={g('test.preset')} htmlFor="test-preset" required>
              <select id="test-preset" value={presetId} onChange={event => setPresetId(event.target.value)}>
                {matchingPresets.length === 0 ? <option value="">{g('batches.noPreset')}</option> : null}
                {matchingPresets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </Field>
            <Field label={g('test.age')} htmlFor="test-age">
              <select id="test-age" value={age} onChange={event => setAge(Number(event.target.value) as (typeof ages)[number])}>
                {ages.map(value => <option key={value} value={value}>{g(`demographic.age.${value}`)}</option>)}
              </select>
            </Field>
            <Field label={g('test.gender')} htmlFor="test-gender">
              <select id="test-gender" value={gender} onChange={event => setGender(event.target.value as Gender)}>
                {genders.map(value => <option key={value} value={value}>{g(`demographic.gender.${value}`)}</option>)}
              </select>
            </Field>
            <Field label={g('test.ethnicity')} htmlFor="test-ethnicity">
              <select id="test-ethnicity" value={ethnicity} onChange={event => setEthnicity(event.target.value as (typeof ethnicities)[number])}>
                {ethnicities.map(value => <option key={value} value={value}>{g(`demographic.ethnicity.${value}`)}</option>)}
              </select>
            </Field>
            <Field label={g('test.seed')} htmlFor="test-seed">
              <input id="test-seed" inputMode="numeric" value={seed} onChange={event => setSeed(event.target.value)} placeholder={g('test.seedPlaceholder')} />
            </Field>
            <Field label={g('test.outputProfile')} htmlFor="test-output-profile">
              <input id="test-output-profile" value={g('test.outputProfileValue')} readOnly />
            </Field>
          </div>
          <fieldset>
            <legend>{g('test.execution')}</legend>
            <div className="generation-choice-grid">
              {(['Serial', 'Parallel'] as TestExecutionMode[]).map(value => (
                <label key={value}>
                  <input type="radio" name="execution" value={value} checked={executionMode === value} onChange={() => setExecutionMode(value)} />
                  <span>{g(value === 'Serial' ? 'test.serial' : 'test.parallel')}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <section aria-labelledby="test-models-title">
            <div className="section-header">
              <h2 id="test-models-title">{g('test.models')}</h2>
              <Button variant="quiet" onClick={assignments.length === 1 ? addSecond : () => setAssignments(current => current.slice(0, 1))}>
                {g(assignments.length === 1 ? 'test.addSecond' : 'test.removeSecond')}
              </Button>
            </div>
            <div className="generation-form">
              {assignments.map((assignment, index) => (
                <div key={assignment.order} className="generation-assignment">
                  <h3>{g('test.assignment', { number: index + 1 })}</h3>
                  <Field label={g('test.model')} htmlFor={`test-model-${index}`}>
                    <select id={`test-model-${index}`} value={assignment.model} onChange={event => updateAssignment(index, { model: event.target.value as ModelName })}>
                      {models.map(value => <option key={value} value={value}>{g(`model.${value}`)}</option>)}
                    </select>
                  </Field>
                  <Field label={g('test.gpu')} htmlFor={`test-gpu-${index}`}>
                    <select id={`test-gpu-${index}`} value={assignment.gpu} onChange={event => updateAssignment(index, { gpu: event.target.value as GpuSlot })}>
                      {snapshot.data.gpuStates.map(item => (
                        <option key={item.slot} value={item.slot} disabled={item.availability !== 'Available'}>
                          {g(`gpu.${item.slot}`)} / {g(`gpu.${item.availability}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              ))}
            </div>
          </section>
          {validation ? <p className="field__error" role="alert">{g(validation === 'parallel' ? 'test.parallelValidation' : 'test.validation')}</p> : null}
          <div className="generation-form__actions"><Button variant="primary" onClick={prepare}>{g('test.prepare')}</Button></div>
          <p className="generation-shortcut-hint">{g('test.runShortcut')}</p>
        </section>
        <GpuPanel />
      </div>

      <section className="panel generation-result-panel generation-form" aria-label={g('test.resultsTitle')}>
        <div className="section-header">
          <h2>{g('test.resultsTitle')}</h2>
        </div>
        {activeRunCards.length === 0 ? (
          <p className="generation-empty-note">{g('jobs.noResults')}</p>
        ) : (
          <div className="generation-result-cards">
            {activeRunCards.map(card => {
              const assignment = card.prepared.assignments[card.assignmentOrder];
              if (!assignment) return null;
              const hasAudio = card.prepared.category.endsWith('VA');
              const isCurrentAttempt = latestAttemptByGroup.get(card.attemptGroupId) === card.attemptNumber;
              return (
                <article className="generation-result-card" key={card.job.id}>
                  <div className="generation-result-card__header">
                    <div>
                      <h3>{g('test.attempt', { number: card.attemptNumber })}</h3>
                      <p>{g('test.cardModel', { model: g(`model.${assignment.model}`) })}</p>
                    </div>
                    <div className="generation-result-card__badges">
                      {isCurrentAttempt ? <StatusBadge label={g('jobs.currentAttempt')} kind="active" /> : null}
                      <StatusBadge label={g(`jobs.status.${card.job.status}`)} kind={card.job.status === 'Failed' || card.job.status === 'Cancelled' ? 'problem' : card.job.status === 'Completed' ? 'complete' : card.job.status === 'Running' ? 'active' : 'neutral'} />
                    </div>
                  </div>
                  <div className="generation-result-card__meta">
                    <dl>
                      <div>
                        <dt>{g('test.seed')}</dt>
                        <dd>{card.prepared.seed == null ? g('test.randomSeed') : String(card.prepared.seed)}</dd>
                      </div>
                      <div>
                        <dt>{g('jobs.audio')}</dt>
                        <dd>{hasAudio ? g('test.audioIncluded') : g('test.audioMissing')}</dd>
                      </div>
                      <div>
                        <dt>{g('jobs.progress')}</dt>
                        <dd>{card.job.progress}%</dd>
                      </div>
                      <div>
                        <dt>{g('jobs.source')}</dt>
                        <dd>{g(`jobs.source.${card.job.source}`)}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="generation-result-card__asset">
                    {card.job.status === 'Completed' ? (
                      <video
                        controls
                        preload="metadata"
                        muted={!hasAudio}
                        aria-label={g('test.mediaLabel', { model: g(`model.${assignment.model}`) })}
                      >
                        <source src={hasAudio ? voicedVideoDataUrl : silentVideoDataUrl} />
                        {g('test.videoUnsupported')}
                      </video>
                    ) : <span role="status">{g('test.mediaPlaceholder')}</span>}
                  </div>
                  <div className="generation-result-card__details">
                    <h4>{g('test.outputProfile')}</h4>
                    <p>{modelSpecLabel(g, assignment.model)}</p>
                    <dl>
                      <div>
                        <dt>{g('test.dialogue')}</dt>
                        <dd>{card.prepared.dialogue ?? g('common.none')}</dd>
                      </div>
                      <div>
                        <dt>{g('test.displayText')}</dt>
                        <dd>{card.prepared.displayText ?? g('common.none')}</dd>
                      </div>
                      <div>
                        <dt>{g('test.explanation')}</dt>
                        <dd>{card.prepared.explanation}</dd>
                      </div>
                      <div>
                        <dt>{g('test.videoPrompt')}</dt>
                        <dd>{card.prepared.videoPrompt}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="generation-detail-actions generation-result-card__actions">
                    {isCurrentAttempt && (card.job.status === 'Queued' || card.job.status === 'Running') ? (
                      <Button variant="secondary" onClick={() => openCancel(card.job.id)}>{g('jobs.cancel')}</Button>
                    ) : null}
                    {isCurrentAttempt && (card.job.status === 'Failed' || card.job.status === 'Cancelled') ? (
                      <Button variant="secondary" onClick={() => openRetry(card.job.id)}>{g('jobs.retry')}</Button>
                    ) : null}
                    {isCurrentAttempt && canKeepTestResult(card.job) ? (
                      <Button variant="primary" onClick={() => openKeep(card.job.id)}>{g('jobs.keep')}</Button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <Dialog
        open={showStartConfirm}
        title={g('test.previewTitle')}
        closeLabel={g('common.close')}
        onClose={() => setShowStartConfirm(false)}
        footer={<><Button onClick={() => setShowStartConfirm(false)}>{g('common.cancel')}</Button><Button variant="primary" onClick={startTest}>{g('test.run')}</Button></>}
      >
        <div className="generation-dialog-form">
          <dl className="generation-job-summary">
            <div><dt>{g('test.content')}</dt><dd>{currentContent?.name ?? currentContent?.id ?? g('common.none')}</dd></div>
            <div>
              <dt>{g('test.category')} / {g('test.direction')}</dt>
              <dd>{categoryLabel(g, category)} / {direction ? directionLabel(g, direction) : g('common.none')}</dd>
            </div>
            <div><dt>{g('test.execution')}</dt><dd>{g(executionMode === 'Serial' ? 'test.serial' : 'test.parallel')}</dd></div>
            {assignments.map((assignment, index) => (
              <div key={assignment.order}>
                <dt>{g('test.assignment', { number: index + 1 })}</dt>
                <dd>{g(`model.${assignment.model}`)} / {g(`gpu.${assignment.gpu}`)}</dd>
              </div>
            ))}
            <div><dt>{g('test.seed')}</dt><dd>{parseSeed(seed) == null ? g('test.randomSeed') : String(parseSeed(seed))}</dd></div>
          </dl>
          {serialSwitchMessage ? <p>{serialSwitchMessage}</p> : null}
        </div>
      </Dialog>

      <ConfirmDialog
        open={cancelOpen}
        title={g('jobs.cancelTitle')}
        body={g('jobs.cancelBody')}
        confirmLabel={g('jobs.cancel')}
        cancelLabel={g('common.cancel')}
        closeLabel={g('common.close')}
        onConfirm={cancelResult}
        onClose={() => {
          setCancelOpen(false);
          setCancelJobId('');
        }}
      />

      <Dialog
        open={retryOpen}
        title={g('jobs.retryTitle')}
        closeLabel={g('common.close')}
        onClose={() => {
          setRetryOpen(false);
          setRetryJobId('');
        }}
        footer={
          <>
            <Button onClick={() => {
              setRetryOpen(false);
              setRetryJobId('');
            }}>{g('common.cancel')}</Button>
            <Button variant="primary" onClick={retryResult} disabled={retryGpu === '' || availableGpuSlots.length === 0}>
              {g('jobs.retry')}
            </Button>
          </>
        }
      >
        <div className="generation-dialog-form">
          <p>{g('test.retryBody')}</p>
          {retrySource && retryGpuState?.loadedModel && retryGpuState.loadedModel !== retrySource.model ? (
            <p>{g('test.initialModelSwitch', {
              gpu: g(`gpu.${retryGpuState.slot}`),
              currentModel: g(`model.${retryGpuState.loadedModel}`),
              nextModel: g(`model.${retrySource.model}`),
            })}</p>
          ) : null}
          <Field label={g('jobs.retryGpu')} htmlFor="test-retry-gpu" required>
            <select id="test-retry-gpu" value={retryGpu} onChange={event => setRetryGpu(event.target.value as GpuSlot | '')}>
              {availableGpuSlots.length === 0 ? <option value="">{g('feedback.errorTitle')}</option> : null}
              {availableGpuSlots.map(slot => <option key={slot} value={slot}>{g(`gpu.${slot}`)}</option>)}
            </select>
          </Field>
          <Field label={g('jobs.retrySeed')} htmlFor="test-retry-seed">
            <input id="test-retry-seed" inputMode="numeric" value={retrySeed} onChange={event => setRetrySeed(event.target.value)} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={keepOpen}
        title={g('jobs.keepTitle')}
        closeLabel={g('common.close')}
        onClose={() => {
          setKeepOpen(false);
          setKeepJobId('');
        }}
        footer={
          <>
            <Button onClick={() => {
              setKeepOpen(false);
              setKeepJobId('');
            }}>{g('common.cancel')}</Button>
            <Button variant="primary" onClick={keepResult} disabled={keepDatasetId === ''}>
              {g('jobs.keep')}
            </Button>
          </>
        }
      >
        <div className="generation-dialog-form">
          <p>{g('jobs.keepBody')}</p>
          <Field label={g('jobs.keepDataset')} htmlFor="test-keep-dataset" required>
            <select id="test-keep-dataset" value={keepDatasetId} onChange={event => setKeepDatasetId(event.target.value)}>
              {activeDatasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
            </select>
          </Field>
        </div>
      </Dialog>
    </GenerationScaffold>
  );
}
