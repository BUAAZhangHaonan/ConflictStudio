import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, Field, Metric, PageHeader, StateView, TableShell } from '../components';
import { PageStateBoundary } from '../app/PageStateBoundary';
import { useMockRepository, useRepositorySnapshot } from '../store';
import './StatisticsPage.css';

const dateRangeErrorId = 'statistics-date-error';

function utcDateDaysAgo(referenceDate: Date, days: number): string {
  return new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate() - days,
  )).toISOString().slice(0, 10);
}

function formatUtcDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

export function StatisticsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const repository = useMockRepository();
  const snapshot = useRepositorySnapshot();
  const [defaultRange] = useState(() => {
    const referenceDate = new Date();
    return {
      startDate: utcDateDaysAgo(referenceDate, 29),
      endDate: utcDateDaysAgo(referenceDate, 0),
    };
  });
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(defaultRange.startDate);
  const [endDate, setEndDate] = useState(defaultRange.endDate);
  const currentReviewer = snapshot.data.reviewers.find(
    reviewer => reviewer.id === snapshot.preferences.currentReviewerId,
  );
  const dateRangeValid = Boolean(startDate && endDate && startDate <= endDate);
  const filtersChanged =
    datasetId !== null ||
    startDate !== defaultRange.startDate ||
    endDate !== defaultRange.endDate;
  const result = currentReviewer && dateRangeValid
    ? repository.getStatistics({ reviewerId: currentReviewer.id, datasetId, startDate, endDate })
    : null;
  const statistics = result?.ok ? result.value : null;
  const maximumDailyCount = Math.max(1, ...(statistics?.activity.map(item => item.reviewedCount) ?? []));

  const resetFilters = () => {
    setDatasetId(null);
    setStartDate(defaultRange.startDate);
    setEndDate(defaultRange.endDate);
  };

  return (
    <PageStateBoundary>
      <div className="page-stack statistics-page">
        <PageHeader title={t('statistics.title')} />

        <section className="panel statistics-filters" aria-labelledby="statistics-filters-title">
          <div className="section-header">
            <h2 id="statistics-filters-title">{t('workspaceSettingsStatistics.statistics.filtersTitle')}</h2>
            <Button type="button" variant="quiet" onClick={resetFilters} disabled={!filtersChanged}>
              {t('workspaceSettingsStatistics.statistics.resetFilters')}
            </Button>
          </div>
          <p className="statistics-current-reviewer">
            {currentReviewer
              ? t('workspaceSettingsStatistics.statistics.currentReviewer', { name: currentReviewer.name })
              : t('workspaceSettingsStatistics.statistics.unavailableTitle')}
          </p>
          <div className="statistics-filters__grid">
            <Field label={t('workspaceSettingsStatistics.statistics.datasetLabel')} htmlFor="statistics-dataset">
              <select
                id="statistics-dataset"
                value={datasetId ?? ''}
                onChange={event => setDatasetId(event.target.value || null)}
              >
                <option value="">{t('workspaceSettingsStatistics.statistics.allDatasets')}</option>
                {snapshot.data.datasets.map(dataset => (
                  <option key={dataset.id} value={dataset.id}>{dataset.name}</option>
                ))}
              </select>
            </Field>
            <Field label={t('workspaceSettingsStatistics.statistics.startDateLabel')} htmlFor="statistics-start-date">
              <input
                id="statistics-start-date"
                type="date"
                value={startDate}
                max={endDate || undefined}
                onChange={event => setStartDate(event.target.value)}
                aria-invalid={!dateRangeValid || undefined}
                aria-describedby={!dateRangeValid ? dateRangeErrorId : undefined}
              />
            </Field>
            <Field label={t('workspaceSettingsStatistics.statistics.endDateLabel')} htmlFor="statistics-end-date">
              <input
                id="statistics-end-date"
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={event => setEndDate(event.target.value)}
                aria-invalid={!dateRangeValid || undefined}
                aria-describedby={!dateRangeValid ? dateRangeErrorId : undefined}
              />
            </Field>
          </div>
          {!dateRangeValid ? (
            <p id={dateRangeErrorId} className="field__error" role="alert">
              {t('workspaceSettingsStatistics.statistics.invalidDateRange')}
            </p>
          ) : null}
        </section>

        {!currentReviewer ? (
          <section className="panel state-view" aria-live="polite">
            <h2>{t('workspaceSettingsStatistics.statistics.unavailableTitle')}</h2>
            <p>{t('workspaceSettingsStatistics.statistics.unavailableBody')}</p>
            <Button type="button" variant="secondary" onClick={() => navigate('/settings')}>
              {t('nav.settings')}
            </Button>
          </section>
        ) : !dateRangeValid ? null : !result || !result.ok ? (
          <StateView
            state="error"
            action={{
              label: t('actions.retry'),
              onClick: () => window.location.reload(),
            }}
          />
        ) : !statistics || statistics.uniqueReviewedCount === 0 ? (
          filtersChanged ? (
            <StateView
              state="filtered"
              action={{
                label: t('workspaceSettingsStatistics.statistics.resetFilters'),
                onClick: resetFilters,
              }}
            />
          ) : (
            <StateView
              state="empty"
              action={{
                label: t('actions.goWorkspace'),
                onClick: () => navigate('/workspace'),
              }}
            />
          )
        ) : (
          <>
            <div className="metric-grid statistics-metrics">
              <Metric label={t('statistics.uniqueReviewed')} value={statistics.uniqueReviewedCount} />
              <Metric label={t('statistics.revisedSamples')} value={statistics.revisedSampleCount} />
              <Metric label={t('statistics.archivedCurrent')} value={statistics.archivedCurrentCount} />
              <Metric label={t('statistics.needsUpdate')} value={statistics.needsUpdateCount} />
              <Metric label={t('statistics.accepted')} value={statistics.acceptedCount} />
              <Metric label={t('statistics.rejected')} value={statistics.rejectedCount} />
              <Metric label={t('statistics.va')} value={statistics.vaCount} />
              <Metric label={t('statistics.vt')} value={statistics.vtCount} />
            </div>
            <section className="panel statistics-activity" aria-labelledby="statistics-activity-title">
              <div className="section-header">
                <h2 id="statistics-activity-title">
                  {t('workspaceSettingsStatistics.statistics.activityChartCaption')}
                </h2>
              </div>
              <figure className="statistics-chart">
                <figcaption>
                  {t('workspaceSettingsStatistics.statistics.activityChartLabel', {
                    startDate: statistics.startDate,
                    endDate: statistics.endDate,
                  })}
                </figcaption>
                <div
                  className="statistics-chart__plot"
                  role="img"
                  aria-label={t('workspaceSettingsStatistics.statistics.activityChartLabel', {
                    startDate: statistics.startDate,
                    endDate: statistics.endDate,
                  })}
                  style={{
                    '--statistics-column-count': statistics.activity.length,
                  } as CSSProperties}
                >
                  {statistics.activity.map(item => (
                    <div
                      className="statistics-chart__column"
                      key={item.date}
                      tabIndex={0}
                      role="img"
                      aria-label={t('workspaceSettingsStatistics.statistics.activityPoint', {
                        date: formatUtcDate(item.date, snapshot.preferences.locale),
                        count: item.reviewedCount,
                      })}
                    >
                      <span
                        className="statistics-chart__bar"
                        aria-hidden="true"
                        style={{
                          '--statistics-bar-height': `${item.reviewedCount === 0 ? 0 : Math.max(12, (item.reviewedCount / maximumDailyCount) * 100)}%`,
                        } as CSSProperties}
                      />
                    </div>
                  ))}
                </div>
              </figure>
              <TableShell
                caption={t('workspaceSettingsStatistics.statistics.activityTableCaption')}
                columns={[
                  { key: 'date', label: t('workspaceSettingsStatistics.statistics.startDateLabel') },
                  {
                    key: 'count',
                    label: t('workspaceSettingsStatistics.statistics.activityChartCaption'),
                    align: 'right',
                  },
                ]}
              >
                {statistics.activity.map(item => (
                  <tr key={item.date}>
                    <th scope="row" data-label={t('workspaceSettingsStatistics.statistics.startDateLabel')}>
                      {item.date}
                    </th>
                    <td
                      className="is-numeric"
                      data-label={t('workspaceSettingsStatistics.statistics.activityCountLabel')}
                    >
                      {item.reviewedCount}
                    </td>
                  </tr>
                ))}
              </TableShell>
            </section>
          </>
        )}
      </div>
    </PageStateBoundary>
  );
}
