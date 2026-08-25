import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, apiErrorMessage, shouldReloadAfterApiError } from '../api/client';
import type { ReviewDecision, ReviewQueue, ReviewSampleDetailRead } from '../api/contracts';
import {
  reviewSampleQueries,
  useConvertSampleClassificationMutation,
  usePutReviewNoteDraftMutation,
  useReviewHistoryQuery,
  useReviewNoteDraftQuery,
  useReviewSampleDetailQuery,
  useReviewSampleListQuery,
  useSubmitReviewMutation,
} from '../api/queries';
import { useReviewGateReviewer } from '../app/ReviewGate';
import { Button, ConfirmDialog, Field, MediaPanel, PageHeader, Pagination, StatusBadge } from '../components';
import { reviewArchiveEnUS } from '../locales/features/reviewArchive';
import {
  buildReviewListLocation,
  readReviewListLocation,
  readSavedReviewListState,
  reviewDetailLocation,
  safeReviewListReturnTarget,
  safeReviewReturnTarget,
} from '../reviewArchive';
import type { Category, ConflictDirection, Locale } from '../types';
import './ReviewDetailPage.css';

type NoteState = 'loading' | 'dirty' | 'saving' | 'saved' | 'failed';

const EMOTION_OPTIONS = Object.keys(reviewArchiveEnUS.emotion);

function emotionKey(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function positiveSampleId(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function beijingTimestamp(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function queueFromReturnTarget(returnTo: string): ReviewQueue {
  const location = readReviewListLocation(returnTo);
  return {
    search: location.search,
    datasetId: location.datasetId,
    decision: location.decision,
    protocol: location.protocol,
    relation: location.relation,
    direction: location.direction,
  };
}

function targetCategoryFor(sample: ReviewSampleDetailRead): Category {
  return `${sample.relation === 'Aligned' ? 'C' : 'A'}-${sample.protocol}` as Category;
}

export function ReviewDetailPage() {
  const { sampleId: sampleIdParam } = useParams<{ sampleId: string }>();
  const sampleId = positiveSampleId(sampleIdParam);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const { t, i18n } = useTranslation();
  const reviewer = useReviewGateReviewer();
  const reviewerId = reviewer?.id ?? null;
  const locale: Locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';
  const detailQuery = useReviewSampleDetailQuery(sampleId);
  const sampleRevision = detailQuery.data?.revision ?? null;
  const noteQuery = useReviewNoteDraftQuery(sampleId, reviewerId, sampleRevision);
  const noteMutation = usePutReviewNoteDraftMutation();
  const reviewMutation = useSubmitReviewMutation();
  const conversionMutation = useConvertSampleClassificationMutation();
  const [useSourceAudio, setUseSourceAudio] = useState(false);
  const [note, setNote] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [noteRevision, setNoteRevision] = useState(0);
  const [noteState, setNoteState] = useState<NoteState>('loading');
  const [noteError, setNoteError] = useState<unknown>(null);
  const [reviewDecision, setReviewDecision] = useState<ReviewDecision | null>(null);
  const [conversionOpen, setConversionOpen] = useState(false);
  const [conversionDirection, setConversionDirection] = useState<ConflictDirection | null>(null);
  const [conversionApparentEmotion, setConversionApparentEmotion] = useState('');
  const [conversionDescription, setConversionDescription] = useState('');
  const [conversionSaved, setConversionSaved] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [navigationPending, setNavigationPending] = useState(false);
  const initializedDraftRef = useRef<string | null>(null);
  const noteRef = useRef(note);
  const savedNoteRef = useRef(savedNote);
  const noteRevisionRef = useRef(noteRevision);
  const noteSavePromiseRef = useRef<Promise<boolean> | null>(null);
  noteRef.current = note;
  savedNoteRef.current = savedNote;
  noteRevisionRef.current = noteRevision;

  const savedListState = useMemo(() => readSavedReviewListState(), []);
  const explicitReturnTo = safeReviewListReturnTarget(searchParams.get('returnTo'))
    ?? safeReviewReturnTarget(searchParams.get('returnTo'));
  const returnTo = explicitReturnTo ?? savedListState?.returnTo ?? '/review';
  const backLabel = t(returnTo.startsWith('/generate/results')
    ? 'review.detail.backToResults'
    : 'review.detail.backToList');
  const listReturnTo = safeReviewListReturnTarget(returnTo);
  const listLocation = useMemo(() => readReviewListLocation(listReturnTo ?? '/review'), [listReturnTo]);
  const navigationQueue = useMemo(() => queueFromReturnTarget(listReturnTo ?? '/review'), [listReturnTo]);
  const navigationListQuery = useReviewSampleListQuery({
    ...navigationQueue,
    page: listLocation.page,
  }, listReturnTo !== null);
  const historyQuery = useReviewHistoryQuery(sampleId, historyPage, historyOpen);
  const sample = detailQuery.data;
  const queueItems = navigationListQuery.data?.items ?? [];
  const queueIndex = sampleId === null ? -1 : queueItems.findIndex(item => item.id === sampleId);
  const canGoPrevious = listReturnTo !== null && queueIndex >= 0 && (queueIndex > 0 || listLocation.page > 1);
  const canGoNext = listReturnTo !== null && queueIndex >= 0 && (
    queueIndex < queueItems.length - 1
    || listLocation.page < (navigationListQuery.data?.totalPages ?? 0)
  );

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [sampleId]);

  useEffect(() => {
    setUseSourceAudio(false);
    setReviewDecision(null);
    setConversionOpen(false);
    setConversionDirection(null);
    setConversionApparentEmotion('');
    setConversionDescription('');
    setConversionSaved(false);
    setHistoryOpen(false);
    setHistoryPage(1);
    setNavigationPending(false);
    initializedDraftRef.current = null;
    noteRef.current = '';
    savedNoteRef.current = '';
    noteRevisionRef.current = 0;
    noteSavePromiseRef.current = null;
    setNote('');
    setSavedNote('');
    setNoteRevision(0);
    setNoteState('loading');
    setNoteError(null);
  }, [sampleId, reviewerId]);

  useEffect(() => {
    if (!sample || !noteQuery.data) return;
    const key = `${sample.id}:${reviewerId}:${sample.revision}`;
    if (initializedDraftRef.current === key) return;
    initializedDraftRef.current = key;
    noteRef.current = noteQuery.data.note;
    savedNoteRef.current = noteQuery.data.note;
    noteRevisionRef.current = noteQuery.data.revision;
    setNote(noteQuery.data.note);
    setSavedNote(noteQuery.data.note);
    setNoteRevision(noteQuery.data.revision);
    setNoteState('saved');
    setNoteError(null);
  }, [noteQuery.data, reviewerId, sample]);

  const flushNote = useCallback(async (): Promise<boolean> => {
    while (true) {
      if (noteSavePromiseRef.current !== null) {
        if (!await noteSavePromiseRef.current) return false;
        continue;
      }
      if (noteRef.current === savedNoteRef.current) {
        setNoteState('saved');
        return true;
      }
      if (reviewerId === null || !sample || !noteQuery.isSuccess) return false;

      const value = noteRef.current;
      const request = noteMutation.mutateAsync({
        sampleId: sample.id,
        input: {
          reviewerId,
          note: value,
          expectedRevision: noteRevisionRef.current,
          expectedSampleRevision: sample.revision,
        },
      }).then(saved => {
        noteRevisionRef.current = saved.revision;
        savedNoteRef.current = value;
        setNoteRevision(saved.revision);
        setSavedNote(value);
        setNoteError(null);
        setNoteState(noteRef.current === value ? 'saved' : 'dirty');
        return true;
      }).catch(error => {
        if (shouldReloadAfterApiError(error)) initializedDraftRef.current = null;
        setNoteError(error);
        setNoteState('failed');
        return false;
      });
      noteSavePromiseRef.current = request;
      setNoteError(null);
      setNoteState('saving');
      const saved = await request;
      if (noteSavePromiseRef.current === request) noteSavePromiseRef.current = null;
      if (!saved) return false;
    }
  }, [noteMutation, noteQuery.isSuccess, reviewerId, sample]);

  useEffect(() => {
    if (reviewerId === null || note === savedNote || noteState === 'failed' || noteState === 'saving') return;
    const timer = window.setTimeout(() => { void flushNote(); }, 400);
    return () => window.clearTimeout(timer);
  }, [flushNote, note, noteState, reviewerId, savedNote]);

  const retryNoteSave = () => { void flushNote(); };

  const navigateAdjacent = async (direction: 'previous' | 'next') => {
    if (listReturnTo === null || queueIndex < 0) return;
    setNavigationPending(true);
    try {
      if (!await flushNote()) return;
      let targetPage = listLocation.page;
      let target = queueItems[queueIndex + (direction === 'previous' ? -1 : 1)] ?? null;
      if (target === null) {
        targetPage += direction === 'previous' ? -1 : 1;
        if (targetPage < 1 || targetPage > (navigationListQuery.data?.totalPages ?? 0)) return;
        const adjacent = await queryClient.fetchQuery(reviewSampleQueries.list({
          ...navigationQueue,
          page: targetPage,
        }));
        target = direction === 'previous'
          ? adjacent.items[adjacent.items.length - 1] ?? null
          : adjacent.items[0] ?? null;
      }
      if (target === null) return;
      const nextReturnTo = buildReviewListLocation({ ...listLocation, page: targetPage });
      navigate(reviewDetailLocation(target.id, nextReturnTo));
    } finally {
      setNavigationPending(false);
    }
  };

  const followReviewResult = (nextReference: { id: number; page: number } | null) => {
    if (nextReference === null) {
      navigate(returnTo, { replace: true });
      return;
    }
    if (listReturnTo === null) {
      navigate(reviewDetailLocation(nextReference.id, returnTo), { replace: true });
      return;
    }
    const nextListLocation = buildReviewListLocation({
      ...readReviewListLocation(listReturnTo),
      page: nextReference.page,
    });
    navigate(reviewDetailLocation(nextReference.id, nextListLocation), { replace: true });
  };

  const navigateBack = async () => {
    setNavigationPending(true);
    try {
      if (await flushNote()) navigate(returnTo);
    } finally {
      setNavigationPending(false);
    }
  };

  const chooseReviewDecision = async (decision: ReviewDecision) => {
    setNavigationPending(true);
    try {
      if (await flushNote()) setReviewDecision(decision);
    } finally {
      setNavigationPending(false);
    }
  };

  const submitReview = () => {
    if (
      reviewerId === null
      || !sample
      || reviewDecision === null
      || noteState !== 'saved'
      || (reviewDecision === 'Accepted' && sample.generationCompatibility === 'NeedsRegeneration')
    ) return;
    reviewMutation.mutate({
      sampleId: sample.id,
      reviewerId,
      decision: reviewDecision,
      expectedRevision: sample.revision,
      expectedReviewRevision: sample.reviewRevision,
      expectedNoteDraftRevision: noteRevision,
      queue: queueFromReturnTarget(returnTo),
    }, {
      onSuccess: value => followReviewResult(value.nextReference),
    });
  };

  const openConversion = () => {
    if (!sample) return;
    setConversionSaved(false);
    setConversionDirection(null);
    setConversionApparentEmotion('');
    setConversionDescription(sample.trueEmotionDescription);
    setConversionOpen(true);
  };

  const submitConversion = () => {
    if (reviewerId === null || !sample) return;
    const targetCategory = targetCategoryFor(sample);
    const needsDirection = targetCategory.startsWith('C-');
    if (
      !conversionDescription.trim()
      || (needsDirection && (conversionDirection === null || !conversionApparentEmotion))
    ) return;
    conversionMutation.mutate({
      sampleId: sample.id,
      input: {
        reviewerId,
        expectedRevision: sample.revision,
        targetCategory,
        conflictDirection: needsDirection ? conversionDirection : null,
        ...(needsDirection ? { apparentEmotion: conversionApparentEmotion } : {}),
        trueEmotionDescription: conversionDescription.trim(),
      },
    }, {
      onSuccess: () => {
        setConversionOpen(false);
        setConversionSaved(true);
        noteRef.current = '';
        savedNoteRef.current = '';
        noteRevisionRef.current = 0;
        setNote('');
        setSavedNote('');
        setNoteRevision(0);
        setNoteState('loading');
        setNoteError(null);
        initializedDraftRef.current = null;
      },
    });
  };

  if (sampleId === null) {
    return (
      <section className="page-stack review-detail-page">
        <PageHeader title={t('review.detail.emptyTitle')} />
        <section className="generation-feedback" role="status">
          <p>{t('review.detail.emptyBody')}</p>
          <Button variant="secondary" onClick={() => navigate(returnTo)}>{backLabel}</Button>
        </section>
      </section>
    );
  }

  if (detailQuery.isLoading) {
    return (
      <section className="page-stack review-detail-page" aria-label={t('review.detail.aria.page')}>
        <PageHeader title={t('review.detail.loadingTitle')} />
        <section className="generation-feedback" role="status"><p>{t('review.detail.loadingBody')}</p></section>
      </section>
    );
  }

  if (detailQuery.isError || !sample) {
    return (
      <section className="page-stack review-detail-page" aria-label={t('review.detail.aria.page')}>
        <PageHeader title={t('review.detail.errorTitle')} />
        <section className="generation-feedback generation-feedback--problem" role="alert">
          <p>{t('review.detail.errorBody')}</p>
          <Button variant="secondary" onClick={() => detailQuery.refetch()}>{t('actions.retry')}</Button>
          <Button variant="quiet" onClick={() => navigate(returnTo)}>{backLabel}</Button>
        </section>
      </section>
    );
  }

  const showSourceToggle = sample.protocol === 'VT' && sample.sourceMedia !== null;
  const displayedMedia = showSourceToggle && useSourceAudio && sample.sourceMedia ? sample.sourceMedia : sample.primaryMedia;
  const targetCategory = targetCategoryFor(sample);
  const targetRelation = targetCategory.startsWith('C-') ? 'C' : 'A';
  const needsConversionDirection = targetRelation === 'C';
  const directionOptions: ConflictDirection[] = sample.protocol === 'VA' ? ['Vision', 'Audio'] : ['Vision', 'Text'];
  const apparentEmotionOptions = EMOTION_OPTIONS.filter(option => option !== emotionKey(sample.trueEmotion));
  const conversionComplete = Boolean(conversionDescription.trim())
    && (!needsConversionDirection || (
      conversionDirection !== null
      && Boolean(conversionApparentEmotion)
      && conversionApparentEmotion !== emotionKey(sample.trueEmotion)
    ));
  const directionText = sample.conflictDirection === null
    ? t('review.detail.notNeeded')
    : t(`review.detail.direction.${sample.conflictDirection}`);
  const noteMessage = noteState === 'failed'
    ? noteError instanceof ApiError && noteError.code === 'note_draft_revision_conflict'
      ? t('review.detail.note.conflict')
      : apiErrorMessage(noteError, locale)
    : t(`review.detail.note.${noteState}`);
  const noteReady = noteQuery.isSuccess && noteState === 'saved' && note === savedNote;
  const noteSaving = noteState === 'saving';
  const writeBusy = reviewMutation.isPending || conversionMutation.isPending || noteSaving || navigationPending;
  const acceptanceBlocked = sample.generationCompatibility === 'NeedsRegeneration';

  return (
    <section className="page-stack review-detail-page" aria-label={t('review.detail.aria.page')}>
      <PageHeader
        title={sample.displayId}
        actions={(
          <div className="review-detail__navigation">
            <Button variant="quiet" disabled={!canGoPrevious || navigationPending || noteSaving} onClick={() => void navigateAdjacent('previous')}>{t('review.detail.previous')}</Button>
            <Button variant="quiet" disabled={!canGoNext || navigationPending || noteSaving} onClick={() => void navigateAdjacent('next')}>{t('review.detail.next')}</Button>
            <Button variant="secondary" disabled={navigationPending || noteSaving} onClick={() => void navigateBack()}>{backLabel}</Button>
          </div>
        )}
      />

      <div className="review-detail__layout">
        <section className="panel review-detail__media" aria-label={t('review.detail.aria.media')}>
          <MediaPanel
            key={displayedMedia.url}
            title={useSourceAudio ? t('review.detail.sourceVideo') : t('review.detail.primaryVideo')}
            mediaLabel={t('review.mediaLabel', { id: sample.displayId, protocol: sample.protocol })}
            src={displayedMedia.url}
            muted={sample.protocol === 'VT' && !useSourceAudio}
            detail={showSourceToggle ? (
              <Button variant="secondary" onClick={() => setUseSourceAudio(value => !value)}>
                {useSourceAudio ? t('review.detail.showSilentPrimary') : t('review.detail.playSourceAudio')}
              </Button>
            ) : undefined}
          />
        </section>

        <div className="review-detail__right">
          <section className="panel review-detail__context" aria-label={t('review.detail.aria.context')}>
            <div className="section-header">
              <h2>{t('review.detail.contextTitle')}</h2>
              <StatusBadge label={t(`status.review.${sample.reviewDecision}`)} kind={sample.reviewDecision === 'Accepted' ? 'complete' : sample.reviewDecision === 'Rejected' ? 'problem' : 'neutral'} />
            </div>
            <dl className="review-detail__facts">
              <div><dt>{t('review.trueEmotionDescription')}</dt><dd>{sample.trueEmotionDescription}</dd></div>
              <div>
                <dt>{sample.protocol === 'VA' ? t('review.dialogue') : t('review.displayText')}</dt>
                <dd>{sample.protocol === 'VA' ? sample.dialogue ?? t('review.detail.notAvailable') : sample.displayText ?? t('review.detail.notAvailable')}</dd>
              </div>
              <div><dt>{t('review.detail.relation')}</dt><dd>{sample.relation === 'Aligned' ? 'A' : 'C'}</dd></div>
              <div><dt>{t('review.protocolFilter')}</dt><dd>{sample.protocol}</dd></div>
              <div><dt>{t('review.detail.directionLabel')}</dt><dd>{directionText}</dd></div>
            </dl>

            <details key={sample.id} className="review-detail__disclosure">
              <summary>{t('review.detail.details')}</summary>
              <dl className="review-detail__facts">
                <div><dt>{t('review.demographics')}</dt><dd>{sample.age}, {t(`review.gender.${sample.gender}`)}, {t(`review.ethnicity.${sample.ethnicity}`)}</dd></div>
                <div><dt>{t('review.model')}</dt><dd>{sample.model}</dd></div>
                <div><dt>{t('review.precision')}</dt><dd>{sample.precision ?? t('review.notApplicable')}</dd></div>
                <div><dt>{t('review.detail.beijingTime')}</dt><dd>{beijingTimestamp(sample.updatedAt, locale)}</dd></div>
              </dl>
            </details>
          </section>

          <details
            key={sample.id}
            className="panel review-detail__history"
            onToggle={event => setHistoryOpen(event.currentTarget.open)}
          >
            <summary>{t('review.detail.history.title', { count: sample.reviewRevision })}</summary>
            {historyOpen ? historyQuery.isPending ? (
              <p role="status">{t('review.detail.history.loading')}</p>
            ) : historyQuery.isError ? (
              <div role="alert">
                <p>{apiErrorMessage(historyQuery.error, locale)}</p>
                <Button variant="secondary" onClick={() => void historyQuery.refetch()}>{t('actions.retry')}</Button>
              </div>
            ) : historyQuery.data && historyQuery.data.items.length > 0 ? (
              <>
                <ol className="review-detail__history-list">
                  {historyQuery.data.items.map(item => (
                    <li key={item.id}>
                      <div>
                        <StatusBadge label={t(`status.review.${item.decision}`)} kind={item.decision === 'Accepted' ? 'complete' : item.decision === 'Rejected' ? 'problem' : 'neutral'} />
                        <span>{item.reviewerName}</span>
                        <time dateTime={item.createdAt}>{beijingTimestamp(item.createdAt, locale)}</time>
                      </div>
                      {item.note ? <p>{item.note}</p> : null}
                    </li>
                  ))}
                </ol>
                <Pagination page={historyQuery.data.page} totalPages={historyQuery.data.totalPages} total={historyQuery.data.total} onPageChange={setHistoryPage} />
              </>
            ) : <p>{t('review.detail.history.empty')}</p> : null}
          </details>

          {acceptanceBlocked ? (
            <section className="generation-feedback generation-feedback--problem" role="status">
              <p>{t('review.detail.compatibilityBlocked')}</p>
              <Link to="/generate/production">{t('review.detail.openGeneration')}</Link>
            </section>
          ) : null}

          <section className="panel review-detail__decision" aria-label={t('review.detail.aria.decision')}>
            <h2>{t('review.detail.decisionTitle')}</h2>
            <Field label={t('fields.note')} htmlFor="review-detail-note" hint={noteMessage} error={noteState === 'failed' ? noteMessage : undefined}>
              <textarea
                id="review-detail-note"
                value={note}
                maxLength={2000}
                disabled={!noteQuery.isSuccess}
                readOnly={reviewerId === null}
                onChange={event => {
                  noteRef.current = event.target.value;
                  setNote(event.target.value);
                  setNoteError(null);
                  setNoteState('dirty');
                }}
              />
            </Field>
            {noteQuery.isError ? <Button variant="secondary" onClick={() => void noteQuery.refetch()}>{t('actions.retry')}</Button> : null}
            {noteState === 'failed' ? <Button variant="secondary" onClick={retryNoteSave}>{t('review.detail.note.retry')}</Button> : null}

            <div className="review-detail__actions">
              <Button disabled={reviewerId === null || writeBusy || acceptanceBlocked} onClick={() => void chooseReviewDecision('Accepted')}>{t('status.review.Accepted')}</Button>
              <Button variant="secondary" disabled={reviewerId === null || writeBusy} onClick={() => void chooseReviewDecision('Rejected')}>{t('status.review.Rejected')}</Button>
              {sample.reviewDecision !== 'Pending' ? (
                <Button variant="quiet" disabled={reviewerId === null || writeBusy} onClick={() => void chooseReviewDecision('Pending')}>{t('review.detail.withdraw')}</Button>
              ) : null}
            </div>
            {reviewerId === null ? <p className="field-error" role="status">{t('review.detail.guestHint')}</p> : null}

            <details className="review-detail__secondary">
              <summary>{t('review.detail.secondaryActions')}</summary>
              <p>{t('review.detail.conversion.help')}</p>
              <Button variant="quiet" disabled={reviewerId === null || writeBusy} onClick={openConversion}>{t('review.detail.conversion.action')}</Button>
            </details>

            {conversionSaved ? <p className="review-detail__success" role="status">{t('review.detail.conversion.saved')} {t('status.review.Pending')}</p> : null}
            {reviewMutation.isError ? <p className="field-error" role="alert">{apiErrorMessage(reviewMutation.error, locale)}</p> : null}
            {conversionMutation.isError ? <p className="field-error" role="alert">{apiErrorMessage(conversionMutation.error, locale)}</p> : null}
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={reviewDecision !== null}
        title={reviewDecision === 'Pending' ? t('review.detail.withdrawConfirmTitle') : t('review.detail.reviewConfirmTitle')}
        body={reviewDecision === null ? '' : reviewDecision === 'Pending'
          ? t('review.detail.withdrawConfirmBody')
          : t('review.detail.reviewConfirmBody', { decision: t(`status.review.${reviewDecision}`) })}
        confirmLabel={reviewDecision === 'Pending' ? t('review.detail.withdrawConfirmAction') : t('review.detail.reviewConfirmAction')}
        cancelLabel={t('actions.cancel')}
        closeLabel={t('actions.close')}
        busy={reviewMutation.isPending}
        confirmDisabled={!noteReady || (reviewDecision === 'Accepted' && acceptanceBlocked)}
        onConfirm={submitReview}
        onClose={() => setReviewDecision(null)}
      />

      <ConfirmDialog
        open={conversionOpen}
        title={t('review.detail.conversion.title')}
        body={(
          <div className="review-detail__conversion">
            <p>{t('review.detail.conversion.target', { category: targetRelation })}</p>
            {needsConversionDirection ? (
              <Field label={t('review.apparentEmotion')} htmlFor="review-detail-apparent-emotion" required>
                <select
                  id="review-detail-apparent-emotion"
                  value={conversionApparentEmotion}
                  onChange={event => setConversionApparentEmotion(event.target.value)}
                >
                  <option value="">{t('review.detail.conversion.chooseEmotion')}</option>
                  {apparentEmotionOptions.map(emotion => (
                    <option key={emotion} value={emotion}>{t(`emotion.${emotion}`)}</option>
                  ))}
                </select>
              </Field>
            ) : null}
            {needsConversionDirection ? (
              <Field label={t('review.detail.directionLabel')} htmlFor="review-detail-direction" required>
                <select
                  id="review-detail-direction"
                  value={conversionDirection ?? ''}
                  onChange={event => setConversionDirection(event.target.value ? event.target.value as ConflictDirection : null)}
                >
                  <option value="">{t('review.detail.conversion.chooseDirection')}</option>
                  {directionOptions.map(direction => <option key={direction} value={direction}>{t(`review.detail.direction.${direction}`)}</option>)}
                </select>
              </Field>
            ) : null}
            <Field
              label={t('review.trueEmotionDescription')}
              htmlFor="review-detail-conversion-description"
              hint={t('review.detail.conversion.descriptionHint')}
              required
            >
              <textarea
                id="review-detail-conversion-description"
                value={conversionDescription}
                maxLength={1000}
                onChange={event => setConversionDescription(event.target.value)}
              />
            </Field>
            {!conversionComplete ? <p className="field-error" role="status">{t('review.detail.conversion.incomplete')}</p> : null}
          </div>
        )}
        confirmLabel={t('review.detail.conversion.confirm')}
        cancelLabel={t('actions.cancel')}
        closeLabel={t('actions.close')}
        busy={conversionMutation.isPending}
        confirmDisabled={!conversionComplete}
        onConfirm={submitConversion}
        onClose={() => setConversionOpen(false)}
      />
    </section>
  );
}
