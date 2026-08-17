import { Button, MediaPanel, Pagination, StatusBadge } from '../../components';
import type { JobItem, JobStatus } from '../../api/contracts';
import { formatDateTime } from '../../time';
import type { Locale } from '../../types';
import {
  categoryLabel,
  jobFailureMessage,
  jobStatusKind,
  profileLabel,
  type useGenerationCopy,
} from './shared';
import { mediaForItem } from './resultsModel';
import type { GenerationKey } from '../../locales/features/generation';

type GenerationCopy = ReturnType<typeof useGenerationCopy>;

interface ResultsOutputListProps {
  items: readonly JobItem[];
  jobStatus: JobStatus;
  page: number;
  totalPages: number;
  total: number;
  locale: Locale;
  selectedFailures: readonly number[];
  onToggleFailure: (id: number) => void;
  onPageChange: (page: number) => void;
  g: GenerationCopy;
}

function localizedSnapshotName(
  item: JobItem,
  locale: Locale,
  field: 'contentScript' | 'shootingScene',
): string {
  if (field === 'contentScript') {
    return locale === 'zh-CN'
      ? item.input.contentScriptNameZh
      : item.input.contentScriptNameEn;
  }
  return locale === 'zh-CN'
    ? item.input.shootingSceneNameZh
    : item.input.shootingSceneNameEn;
}

function mediaTitle(role: ReturnType<typeof mediaForItem>[number]['role']): GenerationKey {
  if (role === 'vaAudiovisual') return 'results.media.va';
  if (role === 'vtSourceAudio') return 'results.media.vtSource';
  return 'results.media.vtPrimary';
}

export function ResultsOutputList({
  items,
  jobStatus,
  page,
  totalPages,
  total,
  locale,
  selectedFailures,
  onToggleFailure,
  onPageChange,
  g,
}: ResultsOutputListProps) {
  if (items.length === 0) {
    return <p className="generation-empty-note">{g('results.noOutput')}</p>;
  }

  return (
    <>
      <div className="generation-output-list">
        {items.map(item => {
          const media = mediaForItem(item);
          const attempt = item.latestAttempt;
          const person = [
            g(('demographic.age.' + item.input.age) as GenerationKey),
            g(('demographic.gender.' + item.input.gender) as GenerationKey),
            g(('demographic.ethnicity.' + item.input.ethnicity) as GenerationKey),
          ].join(', ');
          const outputTitleId = 'result-output-' + item.id;
          return (
            <article className="generation-output-card" key={item.id} aria-labelledby={outputTitleId}>
              <div className="generation-output-card__header">
                <div>
                  <h4 id={outputTitleId}>{g('results.outputNumber', { number: item.sequence })}</h4>
                  <p>{g(('stage.' + item.stage) as GenerationKey)}</p>
                </div>
                <StatusBadge
                  label={g(('job.' + item.status) as GenerationKey)}
                  kind={jobStatusKind(item.status)}
                />
              </div>
              {item.failureCode || item.status === 'Failed' ? (
                <p className="generation-failure" role="alert">
                  {jobFailureMessage(item.failureCode, g)}
                </p>
              ) : null}
              {item.status === 'Failed' && jobStatus === 'Failed' ? (
                <label className="generation-output-retry">
                  <input
                    type="checkbox"
                    checked={selectedFailures.includes(item.id)}
                    onChange={() => onToggleFailure(item.id)}
                  />
                  <span>{g('results.selectRetry')}</span>
                </label>
              ) : null}

              <section className="generation-attempt" aria-labelledby={'result-attempt-' + item.id}>
                <h5 id={'result-attempt-' + item.id}>{g('results.currentAttempt')}</h5>
                {attempt ? (
                  <dl>
                    <div>
                      <dt>{g('results.attempt')}</dt>
                      <dd>{attempt.attemptNumber}/{item.attemptCount}</dd>
                    </div>
                    <div>
                      <dt>{g('results.model')}</dt>
                      <dd>{profileLabel(attempt.model, attempt.precision)}</dd>
                    </div>
                    <div>
                      <dt>{g('results.actualGpu')}</dt>
                      <dd>{g(('gpu.' + attempt.gpuSlot) as GenerationKey)}</dd>
                    </div>
                    <div>
                      <dt>{g('results.status')}</dt>
                      <dd>{g(('job.' + attempt.status) as GenerationKey)}</dd>
                    </div>
                    <div>
                      <dt>{g('results.started')}</dt>
                      <dd><time dateTime={attempt.startedAt}>{formatDateTime(attempt.startedAt)}</time></dd>
                    </div>
                    {attempt.finishedAt ? (
                      <div>
                        <dt>{g('results.finished')}</dt>
                        <dd><time dateTime={attempt.finishedAt}>{formatDateTime(attempt.finishedAt)}</time></dd>
                      </div>
                    ) : null}
                  </dl>
                ) : (
                  <p>{g(item.status === 'Completed' ? 'results.promptOnlyAttempt' : 'results.attemptPending')}</p>
                )}
              </section>
              <section className="generation-output-facts" aria-labelledby={'result-facts-' + item.id}>
                <h5 id={'result-facts-' + item.id}>{g('results.attributes')}</h5>
                <dl>
                  <div><dt>{g('results.taskType')}</dt><dd>{categoryLabel(g, item.input.category)}</dd></div>
                  <div><dt>{g('results.content')}</dt><dd>{localizedSnapshotName(item, locale, 'contentScript')}</dd></div>
                  <div><dt>{g('results.scene')}</dt><dd>{localizedSnapshotName(item, locale, 'shootingScene')}</dd></div>
                  <div><dt>{g('results.model')}</dt><dd>{profileLabel(item.input.model, item.input.precision)}</dd></div>
                  <div>
                    <dt>{g('results.actualGpu')}</dt>
                    <dd>{item.gpuSlot ? g(('gpu.' + item.gpuSlot) as GenerationKey) : g('results.noGpu')}</dd>
                  </div>
                  <div><dt>{g('results.seed')}</dt><dd>{item.input.seed}</dd></div>
                  <div><dt>{g('results.person')}</dt><dd>{person}</dd></div>
                  <div>
                    <dt>{g('results.videoFormat')}</dt>
                    <dd>{g('results.videoFormatValue', {
                      width: item.input.width,
                      height: item.input.height,
                      fps: item.input.fps,
                      frames: item.input.frameCount,
                    })}</dd>
                  </div>
                </dl>
              </section>

              <section className="generation-output-media" aria-labelledby={'result-media-' + item.id}>
                <h5 id={'result-media-' + item.id}>{g('results.media')}</h5>
                {media.length === 0 ? (
                  <p>{g('results.mediaPending')}</p>
                ) : (
                  <div className="generation-output-media__grid">
                    {media.map(value => (
                      <MediaPanel
                        key={value.role}
                        title={g(mediaTitle(value.role))}
                        mediaLabel={g('results.mediaLabel', {
                          number: item.sequence,
                          role: g(mediaTitle(value.role)),
                        })}
                        src={value.src}
                        muted={value.muted}
                      />
                    ))}
                  </div>
                )}
                {item.input.category.endsWith('-VA') && item.promptResult?.dialogue ? (
                  <div className="generation-output-text">
                    <h6>{g('results.dialogue')}</h6>
                    <p>{item.promptResult.dialogue}</p>
                  </div>
                ) : null}
                {item.input.category.endsWith('-VT') && item.promptResult?.vtText ? (
                  <div className="generation-output-text">
                    <h6>{g('results.displayText')}</h6>
                    <p>{item.promptResult.vtText}</p>
                  </div>
                ) : null}
              </section>

              <section className="generation-output-prompts" aria-labelledby={'result-prompts-' + item.id}>
                <h5 id={'result-prompts-' + item.id}>{g('results.prompts')}</h5>
                {item.promptResult ? (
                  <div className="generation-prompt-blocks">
                    <section>
                      <h6>{g('results.positivePrompt')}</h6>
                      <pre>{item.promptResult.finalPositivePrompt}</pre>
                    </section>
                    <section>
                      <h6>{g('results.negativePrompt')}</h6>
                      <pre>{item.promptResult.negativePrompt}</pre>
                    </section>
                  </div>
                ) : (
                  <p>{g('results.promptPending')}</p>
                )}
              </section>
            </article>
          );
        })}
      </div>
      <Pagination page={page} totalPages={totalPages} total={total} onPageChange={onPageChange} />
    </>
  );
}
