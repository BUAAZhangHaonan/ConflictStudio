import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, apiErrorMessage } from '../api/client';
import type { ReviewDecision, ReviewQueue, ReviewSampleDetailRead } from '../api/contracts';
import {
  useConvertSampleClassificationMutation,
  usePutReviewNoteDraftMutation,
  useReviewNoteDraftQuery,
  useReviewSampleDetailQuery,
  useSubmitReviewMutation,
} from '../api/queries';
import { Button, ConfirmDialog, Field, MediaPanel, PageHeader, StatusBadge } from '../components';
import { usePreferences } from '../preferences';
import {
  buildReviewListLocation,
  readReviewListLocation,
  readSavedReviewListState,
  reviewDetailLocation,
  safeReviewReturnTarget,
  saveReviewListState,
} from '../reviewArchive';
import type { Category, ConflictDirection, Locale } from '../types';
import './ReviewDetailPage.css';

type NoteState = 'loading' | 'saving' | 'saved' | 'failed';

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
  const [searchParams] = useSearchParams();
  const { t, i18n } = useTranslation();
  const preferences = usePreferences();
  const reviewerId = preferences.currentReviewerId;
  const locale: Locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';
  const detailQuery = useReviewSampleDetailQuery(sampleId);
  const noteQuery = useReviewNoteDraftQuery(sampleId, reviewerId);
  const noteMutation = usePutReviewNoteDraftMutation();
  const reviewMutation = useSubmitReviewMutation();
  const conversionMutation = useConvertSampleClassificationMutation();
  const [useSourceAudio, setUseSourceAudio] = useState(false);
  const [note, setNote] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [noteRevision, setNoteRevision] = useState(0);
  const [noteState, setNoteState] = useState<NoteState>('loading');
  const [noteError, setNoteError] = useState<unknown>(null);
  const [retryNumber, setRetryNumber] = useState(0);
  const [reviewDecision, setReviewDecision] = useState<Exclude<ReviewDecision, 'Pending'> | null>(null);
  const [conversionOpen, setConversionOpen] = useState(false);
  const [conversionDirection, setConversionDirection] = useState<ConflictDirection | null>(null);
  const [conversionSaved, setConversionSaved] = useState(false);
  const initializedDraftRef = useRef<string | null>(null);
  const noteRef = useRef(note);
  noteRef.current = note;

  const savedListState = useMemo(() => readSavedReviewListState(), []);
  const returnTo = safeReviewReturnTarget(searchParams.get('returnTo')) ?? savedListState?.returnTo ?? '/review';
  const sample = detailQuery.data;
  const canReview = reviewerId !== null;

  useEffect(() => {
    setUseSourceAudio(false);
    setReviewDecision(null);
    setConversionOpen(false);
    setConversionDirection(null);
    setConversionSaved(false);
    initializedDraftRef.current = null;
    setNote('');
    setSavedNote('');
    setNoteRevision(0);
    setNoteState('loading');
    setNoteError(null);
  }, [sampleId]);

  useEffect(() => {
    if (!sample) return;
    if (!canReview) {
      const currentNote = sample.currentReview?.note ?? '';
      setNote(currentNote);
      setSavedNote(currentNote);
      setNoteState('saved');
      return;
    }
    if (!noteQuery.data) return;
    const key = `${sample.id}:${reviewerId}`;
    if (initializedDraftRef.current === key) return;
    initializedDraftRef.current = key;
    setNote(noteQuery.data.note);
    setSavedNote(noteQuery.data.note);
    setNoteRevision(noteQuery.data.revision);
    setNoteState('saved');
    setNoteError(null);
  }, [canReview, noteQuery.data, reviewerId, sample]);

  useEffect(() => {
    if (!sample || reviewerId === null || !noteQuery.isSuccess || note === savedNote || noteState === 'failed') return;
    setNoteState('saving');
    const value = note;
    const expectedRevision = noteRevision;
    const timer = window.setTimeout(() => {
      noteMutation.mutate({
        sampleId: sample.id,
        input: {
          reviewerId,
          note: value,
          expectedRevision,
          expectedSampleRevision: sample.revision,
        },
      }, {
        onSuccess: saved => {
          setNoteRevision(saved.revision);
          setSavedNote(value);
          setNoteError(null);
          setNoteState(noteRef.current === value ? 'saved' : 'saving');
        },
        onError: error => {
          setNoteError(error);
          setNoteState('failed');
        },
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [note, noteQuery.isSuccess, noteRevision, noteState, retryNumber, reviewerId, sample, savedNote]);

  const retryNoteSave = () => {
    setNoteError(null);
    setNoteState('saving');
    setRetryNumber(value => value + 1);
  };

  const followReviewResult = (nextReference: { id: number; page: number } | null) => {
    if (nextReference === null) {
      navigate(returnTo, { replace: true });
      return;
    }
    const nextListLocation = buildReviewListLocation({
      ...readReviewListLocation(returnTo),
      page: nextReference.page,
    });
    saveReviewListState({ returnTo: nextListLocation, page: nextReference.page, scrollY: 0 });
    navigate(reviewDetailLocation(nextReference.id), { replace: true });
  };

  const submitReview = () => {
    if (!sample || reviewerId === null || reviewDecision === null || noteState !== 'saved') return;
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
    if (!sample || reviewerId === null) return;
    setConversionSaved(false);
    setConversionDirection(null);
    setConversionOpen(true);
  };

  const submitConversion = () => {
    if (!sample || reviewerId === null) return;
    const targetCategory = targetCategoryFor(sample);
    const needsDirection = targetCategory.startsWith('C-');
    if (needsDirection && conversionDirection === null) return;
    conversionMutation.mutate({
      sampleId: sample.id,
      input: {
        reviewerId,
        expectedRevision: sample.revision,
        targetCategory,
        conflictDirection: needsDirection ? conversionDirection : null,
        ...(needsDirection ? { apparentEmotion: sample.apparentEmotion } : {}),
        trueEmotionDescription: sample.trueEmotionDescription,
      },
    }, {
      onSuccess: async () => {
        setConversionOpen(false);
        setConversionSaved(true);
        await detailQuery.refetch();
      },
    });
  };

  if (sampleId === null) {
    return (
      <section className="page-stack review-detail-page">
        <PageHeader title={t('review.detail.emptyTitle')} />
        <section className="generation-feedback" role="status">
          <p>{t('review.detail.emptyBody')}</p>
          <Button variant="secondary" onClick={() => navigate(returnTo)}>{t('review.detail.backToList')}</Button>
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
          <Button variant="quiet" onClick={() => navigate(returnTo)}>{t('review.detail.backToList')}</Button>
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
  const directionText = sample.conflictDirection === null
    ? t('review.detail.notNeeded')
    : t(`review.detail.direction.${sample.conflictDirection}`);
  const noteMessage = noteState === 'failed'
    ? noteError instanceof ApiError && noteError.code === 'note_draft_revision_conflict'
      ? t('review.detail.note.conflict')
      : apiErrorMessage(noteError, locale)
    : t(`review.detail.note.${noteState}`);
  const noteReady = !canReview || (noteQuery.isSuccess && noteState === 'saved');
  const writeBusy = reviewMutation.isPending || conversionMutation.isPending;

  return (
    <section className="page-stack review-detail-page" aria-label={t('review.detail.aria.page')}>
      <PageHeader
        title={sample.displayId}
        actions={<Button variant="secondary" onClick={() => navigate(returnTo)}>{t('review.detail.backToList')}</Button>}
      />

      {!canReview ? <section className="generation-feedback" role="status"><p>{t('review.detail.readOnly')}</p></section> : null}

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

            <details className="review-detail__disclosure">
              <summary>{t('review.detail.details')}</summary>
              <dl className="review-detail__facts">
                <div><dt>{t('review.demographics')}</dt><dd>{sample.age}, {t(`review.gender.${sample.gender}`)}, {t(`review.ethnicity.${sample.ethnicity}`)}</dd></div>
                <div><dt>{t('review.model')}</dt><dd>{sample.model}</dd></div>
                <div><dt>{t('review.precision')}</dt><dd>{sample.precision ?? t('review.notApplicable')}</dd></div>
                <div><dt>{t('review.detail.beijingTime')}</dt><dd>{beijingTimestamp(sample.updatedAt, locale)}</dd></div>
              </dl>
            </details>
          </section>

          {sample.compatibleSceneCount === 0 ? (
            <section className="generation-feedback generation-feedback--problem" role="status">
              <p>{t('review.detail.noCompatibleScene')}</p>
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
                readOnly={!canReview}
                disabled={canReview && !noteQuery.isSuccess}
                onChange={event => {
                  setNote(event.target.value);
                  setNoteError(null);
                  setNoteState('saving');
                }}
              />
            </Field>
            {noteState === 'failed' && canReview ? <Button variant="secondary" onClick={retryNoteSave}>{t('review.detail.note.retry')}</Button> : null}

            <div className="review-detail__actions">
              <Button disabled={!canReview || !noteReady || writeBusy} onClick={() => setReviewDecision('Accepted')}>{t('status.review.Accepted')}</Button>
              <Button variant="secondary" disabled={!canReview || !noteReady || writeBusy} onClick={() => setReviewDecision('Rejected')}>{t('status.review.Rejected')}</Button>
              <Button variant="secondary" disabled={!canReview || writeBusy} onClick={openConversion}>{t('review.detail.conversion.action')}</Button>
            </div>

            {conversionSaved ? <p className="review-detail__success" role="status">{t('review.detail.conversion.saved')} {t('status.review.Pending')}</p> : null}
            {reviewMutation.isError ? <p className="field-error" role="alert">{apiErrorMessage(reviewMutation.error, locale)}</p> : null}
            {conversionMutation.isError ? <p className="field-error" role="alert">{apiErrorMessage(conversionMutation.error, locale)}</p> : null}
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={reviewDecision !== null}
        title={t('review.detail.reviewConfirmTitle')}
        body={reviewDecision === null ? '' : t('review.detail.reviewConfirmBody', { decision: t(`status.review.${reviewDecision}`) })}
        confirmLabel={t('review.detail.reviewConfirmAction')}
        cancelLabel={t('actions.cancel')}
        closeLabel={t('actions.close')}
        busy={reviewMutation.isPending}
        confirmDisabled={!noteReady}
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
          </div>
        )}
        confirmLabel={t('review.detail.conversion.confirm')}
        cancelLabel={t('actions.cancel')}
        closeLabel={t('actions.close')}
        busy={conversionMutation.isPending}
        confirmDisabled={needsConversionDirection && conversionDirection === null}
        onConfirm={submitConversion}
        onClose={() => setConversionOpen(false)}
      />
    </section>
  );
}
