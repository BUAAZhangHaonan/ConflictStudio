import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ApiError, apiErrorMessage } from '../api/client';
import { useDatasetQuery, useDatasetsQuery, useReviewerStatisticsQuery } from '../api/queries';
import { Button, Field, Metric, PageHeader, Pagination, StateView, TableShell } from '../components';
import { setCurrentReviewer, useReviewerState } from '../preferences';
import { formatDate } from '../time';
import './StatisticsPage.css';

function dateDaysAgo(referenceDate: Date, days: number): string {
  return formatDate(new Date(referenceDate.getTime() - days * 24 * 60 * 60 * 1000));
}

export function StatisticsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const reviewerState = useReviewerState();
  const { preferences, currentReviewerId } = reviewerState;
  const [datasetPage, setDatasetPage] = useState(1);
  const [datasetSearch, setDatasetSearch] = useState('');
  const [defaultRange] = useState(() => ({
    startDate: dateDaysAgo(new Date(), 29),
    endDate: dateDaysAgo(new Date(), 0),
  }));
  const [datasetId, setDatasetId] = useState<number | undefined>(undefined);
  const datasetsQuery = useDatasetsQuery(datasetPage, datasetSearch.trim() ? { search: datasetSearch } : {});
  const selectedDatasetQuery = useDatasetQuery(datasetId ?? null);
  const datasets = datasetsQuery.data?.items ?? [];
  const selectedDataset = selectedDatasetQuery.data ?? null;
  const datasetOptions = selectedDataset && !datasets.some(dataset => dataset.id === selectedDataset.id)
    ? [selectedDataset, ...datasets]
    : datasets;
  const [startDate, setStartDate] = useState(defaultRange.startDate);
  const [endDate, setEndDate] = useState(defaultRange.endDate);
  const validRange = startDate !== '' && endDate !== '' && startDate <= endDate;
  const filter = useMemo(() => ({
    datasetId,
    startDate: validRange ? startDate : undefined,
    endDate: validRange ? endDate : undefined,
  }), [datasetId, endDate, startDate, validRange]);
  const statisticsQuery = useReviewerStatisticsQuery(currentReviewerId, filter);
  const statistics = statisticsQuery.data ?? null;
  const maximumDailyCount = Math.max(1, ...(statistics?.activity.map(item => item.reviewedCount) ?? []));
  const locale = preferences.locale;
  const filtersChanged = datasetId !== undefined || startDate !== defaultRange.startDate || endDate !== defaultRange.endDate;
  const statisticsMissing = statisticsQuery.error instanceof ApiError && statisticsQuery.error.status === 404;

  useEffect(() => {
    if (statisticsMissing) setCurrentReviewer(null);
  }, [statisticsMissing]);

  const resetFilters = () => {
    setDatasetId(undefined);
    setDatasetSearch('');
    setDatasetPage(1);
    setStartDate(defaultRange.startDate);
    setEndDate(defaultRange.endDate);
  };

  if (reviewerState.isPending) {
    return <div className="page-stack statistics-page"><PageHeader title={t('statistics.title')} /><StateView state="loading" /></div>;
  }
  if (reviewerState.error) {
    return <div className="page-stack statistics-page"><PageHeader title={t('statistics.title')} /><section className="state-view" role="alert"><h2>{t('statistics.title')}</h2><p>{apiErrorMessage(reviewerState.error, locale)}</p><Button variant="secondary" onClick={() => void reviewerState.retry()}>{t('actions.retry')}</Button></section></div>;
  }
  if (currentReviewerId === null || statisticsMissing) {
    return (
      <div className="page-stack statistics-page">
        <PageHeader title={t('statistics.title')} />
        <StateView
          state="empty"
          title={t('workspaceSettingsStatistics.statistics.unavailableTitle')}
          body={t('workspaceSettingsStatistics.statistics.unavailableBody')}
          action={{ label: t('nav.settings'), onClick: () => navigate('/settings') }}
        />
      </div>
    );
  }
  if (datasetsQuery.isPending || (datasetId !== undefined && selectedDatasetQuery.isPending) || (statisticsQuery.isPending && validRange)) {
    return <div className="page-stack statistics-page"><PageHeader title={t('statistics.title')} /><StateView state="loading" /></div>;
  }
  const error = datasetsQuery.error ?? selectedDatasetQuery.error ?? statisticsQuery.error;
  if (error) {
    return <div className="page-stack statistics-page"><PageHeader title={t('statistics.title')} /><section className="state-view" role="alert"><h2>{t('statistics.title')}</h2><p>{apiErrorMessage(error, locale)}</p><Button variant="secondary" onClick={() => void Promise.all([datasetsQuery.refetch(), selectedDatasetQuery.refetch(), statisticsQuery.refetch()])}>{t('actions.retry')}</Button></section></div>;
  }

  return (
    <div className="page-stack statistics-page">
      <PageHeader title={t('statistics.title')} />
      <section className="panel statistics-filters" aria-labelledby="statistics-filters-title">
        <div className="section-header"><h2 id="statistics-filters-title">{t('workspaceSettingsStatistics.statistics.filtersTitle')}</h2>{filtersChanged ? <Button variant="quiet" onClick={resetFilters}>{t('workspaceSettingsStatistics.statistics.resetFilters')}</Button> : null}</div>
        <p>{t('workspaceSettingsStatistics.statistics.currentReviewer', { name: preferences.currentReviewerName ?? '' })}</p>
        <div className="statistics-filters__grid">
          <div className="statistics-dataset-picker">
            <Field label={t('workspaceSettingsStatistics.statistics.datasetSearchLabel')} htmlFor="statistics-dataset-search"><input id="statistics-dataset-search" type="search" value={datasetSearch} onChange={event => { setDatasetSearch(event.target.value); setDatasetPage(1); }} /></Field>
            <Field label={t('workspaceSettingsStatistics.statistics.datasetLabel')} htmlFor="statistics-dataset"><select id="statistics-dataset" value={datasetId ?? ''} onChange={event => setDatasetId(event.target.value ? Number(event.target.value) : undefined)}><option value="">{t('workspaceSettingsStatistics.statistics.allDatasets')}</option>{datasetOptions.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></Field>
            <Pagination page={datasetsQuery.data?.page ?? 1} totalPages={datasetsQuery.data?.totalPages ?? 0} total={datasetsQuery.data?.total ?? 0} onPageChange={setDatasetPage} />
          </div>
          <Field label={t('workspaceSettingsStatistics.statistics.startDateLabel')} htmlFor="statistics-start" error={!validRange ? t('workspaceSettingsStatistics.statistics.invalidDateRange') : undefined}><input id="statistics-start" type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></Field>
          <Field label={t('workspaceSettingsStatistics.statistics.endDateLabel')} htmlFor="statistics-end"><input id="statistics-end" type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></Field>
        </div>
      </section>
      {!statistics || statistics.uniqueReviewedCount === 0 ? (
        <StateView state={filtersChanged ? 'filtered' : 'empty'} action={filtersChanged ? { label: t('actions.clearFilters'), onClick: resetFilters } : undefined} />
      ) : (
        <>
          <section className="metric-grid statistics-metrics" aria-label={t('statistics.title')}>
            <Metric label={t('workspaceSettingsStatistics.statistics.metrics.uniqueReviewed')} value={statistics.uniqueReviewedCount} />
            <Metric label={t('workspaceSettingsStatistics.statistics.metrics.accepted')} value={statistics.acceptedCount} />
            <Metric label={t('workspaceSettingsStatistics.statistics.metrics.rejected')} value={statistics.rejectedCount} />
            <Metric label={t('workspaceSettingsStatistics.statistics.metrics.va')} value={statistics.vaCount} />
            <Metric label={t('workspaceSettingsStatistics.statistics.metrics.vt')} value={statistics.vtCount} />
            <Metric label={t('workspaceSettingsStatistics.statistics.metrics.revisedSamples')} value={statistics.revisedSampleCount} />
            <Metric label={t('workspaceSettingsStatistics.statistics.metrics.archivedCurrent')} value={statistics.archivedCurrentCount} />
            <Metric label={t('workspaceSettingsStatistics.statistics.metrics.needsUpdate')} value={statistics.needsUpdateCount} />
          </section>
          <section className="panel statistics-activity" aria-labelledby="statistics-activity-title">
            <div className="section-header"><h2 id="statistics-activity-title">{t('statistics.activity')}</h2></div>
            <div className="statistics-chart" role="img" aria-label={t('workspaceSettingsStatistics.statistics.activityChartLabel', { startDate: statistics.startDate, endDate: statistics.endDate })}>
              <div className="statistics-chart__plot">{statistics.activity.map(item => <div className="statistics-chart__column" key={item.date} title={t('workspaceSettingsStatistics.statistics.activityPoint', { date: item.date, count: item.reviewedCount })}><span className="statistics-chart__bar" style={{ '--activity-height': `${Math.max(2, (item.reviewedCount / maximumDailyCount) * 100)}%` } as CSSProperties} /><span>{item.date.slice(5)}</span></div>)}</div>
            </div>
            <TableShell caption={t('workspaceSettingsStatistics.statistics.activityTableCaption')} columns={[{ key: 'date', label: t('workspaceSettingsStatistics.statistics.startDateLabel') }, { key: 'count', label: t('workspaceSettingsStatistics.statistics.activityCountLabel') }]}>{statistics.activity.map(item => <tr key={item.date}><th scope="row">{item.date}</th><td>{item.reviewedCount}</td></tr>)}</TableShell>
          </section>
        </>
      )}
    </div>
  );
}
