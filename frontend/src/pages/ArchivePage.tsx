import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useDatasetsQuery, useSamplesQuery } from '../api/queries';
import { apiErrorMessage } from '../api/client';
import { Button, Metric, PageHeader } from '../components';
import {
  ARCHIVE_PAGE_SIZE,
  clampPage,
  pageCount,
  pageItems,
  reviewLocation,
} from '../reviewArchive';
import { formatDateTime } from '../time';
import type { Category } from '../types';
import './ArchivePage.css';

type ArchiveSortKey = 'id' | 'category' | 'updatedAt';
type SortDirection = 'ascending' | 'descending';

interface ArchiveStateViewProps {
  title: ReactNode;
  body: ReactNode;
  loading?: boolean;
  urgent?: boolean;
  action?: { label: ReactNode; onClick: () => void };
}

const categories: readonly Category[] = ['A-VA', 'C-VA', 'A-VT', 'C-VT'];

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function ArchiveStateView({ title, body, loading = false, urgent = false, action }: ArchiveStateViewProps) {
  return (
    <section
      className="archive-state"
      role={urgent ? 'alert' : 'status'}
      aria-live={urgent ? 'assertive' : 'polite'}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="archive-state__progress" aria-hidden="true" /> : null}
      <h2>{title}</h2>
      <p>{body}</p>
      {action ? <Button onClick={action.onClick}>{action.label}</Button> : null}
    </section>
  );
}

export function ArchivePage() {
  const { t, i18n } = useTranslation();
  const datasetsQuery = useDatasetsQuery();
  const samplesQuery = useSamplesQuery('Accepted');
  const location = useLocation();
  const navigate = useNavigate();
  const initialParams = new URLSearchParams(location.search);
  const requestedDatasetId = Number(initialParams.get('dataset'));
  const initialPage = Number(initialParams.get('page'));
  const initialCategory = initialParams.get('category');
  const [datasetId, setDatasetId] = useState<number | null>(
    Number.isInteger(requestedDatasetId) && requestedDatasetId > 0 ? requestedDatasetId : null,
  );
  const [search, setSearch] = useState(initialParams.get('search') ?? '');
  const [categoryFilter, setCategoryFilter] = useState<Category | 'All'>(() =>
    categories.includes(initialCategory as Category) ? initialCategory as Category : 'All',
  );
  const [page, setPage] = useState(Number.isInteger(initialPage) && initialPage > 0 ? initialPage : 1);
  const [sortKey, setSortKey] = useState<ArchiveSortKey>('id');
  const [sortDirection, setSortDirection] = useState<SortDirection>('ascending');
  const datasets = datasetsQuery.data ?? [];
  const acceptedSamples = samplesQuery.data ?? [];
  const locale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';
  const dataset = datasets.find(item => item.id === datasetId) ?? datasets[0] ?? null;

  useEffect(() => {
    if (!datasetsQuery.isSuccess) return;
    if (dataset && dataset.id !== datasetId) setDatasetId(dataset.id);
    if (!dataset && datasetId !== null) setDatasetId(null);
  }, [dataset, datasetId, datasetsQuery.isSuccess]);

  const rows = useMemo(
    () => dataset ? acceptedSamples.filter(sample => sample.datasetId === dataset.id) : [],
    [acceptedSamples, dataset],
  );
  const filteredRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase(locale);
    const matching = rows.filter(sample => {
      const searchText = [sample.displayId, dataset?.name, sample.category, sample.model]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase(locale);
      return (!query || searchText.includes(query))
        && (categoryFilter === 'All' || sample.category === categoryFilter);
    });
    const direction = sortDirection === 'ascending' ? 1 : -1;
    return [...matching].sort((left, right) => {
      let result = 0;
      if (sortKey === 'id') result = compareText(left.displayId, right.displayId);
      if (sortKey === 'category') result = compareText(left.category, right.category);
      if (sortKey === 'updatedAt') result = compareText(left.updatedAt, right.updatedAt);
      return direction * (result || left.id - right.id);
    });
  }, [categoryFilter, dataset?.name, locale, rows, search, sortDirection, sortKey]);
  const totalPages = pageCount(filteredRows.length);
  const currentPage = samplesQuery.isSuccess ? clampPage(page, filteredRows.length) : page;
  const visibleRows = pageItems(filteredRows, currentPage);
  const hasFilters = search.trim() !== '' || categoryFilter !== 'All';
  const reviewReturnTo = `${location.pathname}${location.search}`;

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [currentPage, page]);

  useEffect(() => {
    if (!datasetsQuery.isSuccess) return;
    const params = new URLSearchParams();
    if (dataset) params.set('dataset', String(dataset.id));
    if (search.trim()) params.set('search', search.trim());
    if (categoryFilter !== 'All') params.set('category', categoryFilter);
    if (currentPage > 1) params.set('page', String(currentPage));
    const nextSearch = params.toString();
    if (nextSearch !== location.search.slice(1)) {
      navigate({ pathname: '/archive', search: nextSearch ? `?${nextSearch}` : '' }, { replace: true });
    }
  }, [categoryFilter, currentPage, dataset, datasetsQuery.isSuccess, location.search, navigate, search]);

  const requestSort = (nextKey: ArchiveSortKey) => {
    if (nextKey === sortKey) {
      setSortDirection(current => current === 'ascending' ? 'descending' : 'ascending');
      return;
    }
    setSortKey(nextKey);
    setSortDirection(nextKey === 'updatedAt' ? 'descending' : 'ascending');
  };

  const clearFilters = () => {
    setSearch('');
    setCategoryFilter('All');
    setPage(1);
  };

  const pageHeader = <PageHeader title={t('archive.title')} />;

  if (datasetsQuery.isPending || samplesQuery.isPending) {
    return (
      <div className="page-stack archive-page" role="region" aria-label={t('archive.aria.page')}>
        {pageHeader}
        <section className="panel"><ArchiveStateView loading title={t('archive.loadingTitle')} body={t('archive.loadingBody')} /></section>
      </div>
    );
  }

  const error = datasetsQuery.error ?? samplesQuery.error;
  if (error) {
    return (
      <div className="page-stack archive-page" role="region" aria-label={t('archive.aria.page')}>
        {pageHeader}
        <section className="panel"><ArchiveStateView urgent title={t('archive.errorTitle')} body={apiErrorMessage(error, locale)} /></section>
      </div>
    );
  }

  return (
    <div className="page-stack archive-page" role="region" aria-label={t('archive.aria.page')}>
      {pageHeader}
      {datasets.length === 0 ? (
        <section className="panel"><ArchiveStateView title={t('archive.emptyTitle')} body={t('workspaceSettingsStatistics.workspace.datasets.emptyBody')} /></section>
      ) : (
        <>
          <section className="panel archive-toolbar" aria-label={t('archive.aria.toolbar')}>
            <label className="archive-dataset-select">
              <span>{t('archive.datasetLabel')}</span>
              <select value={dataset?.id ?? ''} onChange={event => { setDatasetId(Number(event.target.value)); clearFilters(); }} aria-label={t('archive.aria.dataset')}>
                {datasets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          </section>

          <section className="panel archive-overview" aria-label={t('archive.aria.overview')}>
            <div className="archive-overview__header"><h2>{t('workspaceSettingsStatistics.workspace.attention.pendingArchive')}</h2></div>
            <div className="metric-grid archive-metrics">
              <Metric label={t('workspaceSettingsStatistics.workspace.attention.pendingArchive')} value={rows.length} />
            </div>
          </section>

          {rows.length === 0 ? (
            <section className="panel"><ArchiveStateView title={t('archive.emptyTitle')} body={t('archive.emptyBody')} /></section>
          ) : (
            <>
              <section className="panel archive-filters" aria-label={t('archive.aria.page')}>
                <label className="archive-filter archive-filter--search">
                  <span>{t('fields.search')}</span>
                  <input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder={t('fields.searchPlaceholder')} aria-label={t('fields.search')} />
                </label>
                <label className="archive-filter">
                  <span>{t('archive.category')}</span>
                  <select value={categoryFilter} onChange={event => { setCategoryFilter(event.target.value as Category | 'All'); setPage(1); }} aria-label={t('archive.category')}>
                    <option value="All">{t('review.allCategories')}</option>
                    {categories.map(category => <option key={category} value={category}>{t(`category.${category}`)}</option>)}
                  </select>
                </label>
                {hasFilters ? <Button variant="quiet" onClick={clearFilters}>{t('actions.clearFilters')}</Button> : null}
              </section>

              <section className="panel archive-list-panel">
                <div className="section-header"><h2>{t('workspaceSettingsStatistics.workspace.attention.pendingArchive')}</h2><span>{t('archive.pageSize', { count: ARCHIVE_PAGE_SIZE })}</span></div>
                {filteredRows.length === 0 ? (
                  <ArchiveStateView title={t('archive.filteredTitle')} body={t('archive.filteredBody')} action={{ label: t('actions.clearFilters'), onClick: clearFilters }} />
                ) : (
                  <>
                    <div className="table-shell archive-table-shell">
                      <table aria-label={t('archive.aria.currentTable')} data-page-size={ARCHIVE_PAGE_SIZE}>
                        <caption>{t('table.archiveCaption')}</caption>
                        <thead><tr>
                          <th scope="col">{t('archive.thumbnail')}</th>
                          <th scope="col" aria-sort={sortKey === 'id' ? sortDirection : 'none'}><button type="button" onClick={() => requestSort('id')}>{t('archive.sampleId')}</button></th>
                          <th scope="col" aria-sort={sortKey === 'category' ? sortDirection : 'none'}><button type="button" onClick={() => requestSort('category')}>{t('archive.category')}</button></th>
                          <th scope="col">{t('review.model')}</th>
                          <th scope="col" aria-sort={sortKey === 'updatedAt' ? sortDirection : 'none'}><button type="button" onClick={() => requestSort('updatedAt')}>{t('fields.updatedAt')}</button></th>
                        </tr></thead>
                        <tbody>{visibleRows.map(sample => (
                          <tr key={sample.id} data-sample-id={sample.displayId}>
                            <td><video className="archive-thumbnail" src={sample.primaryAssetUrl} muted preload="metadata" aria-label={t('archive.thumbnailAlt', { id: sample.displayId })} /></td>
                            <th scope="row"><Link to={reviewLocation(sample.displayId, reviewReturnTo)} state={{ reviewReturnTo }}><strong>{sample.displayId}</strong></Link><span className="archive-sample-meta">{t(`category.${sample.category}`)}<br />{formatDateTime(sample.updatedAt)}</span></th>
                            <td>{t(`category.${sample.category}`)}</td>
                            <td>{sample.model}</td>
                            <td>{formatDateTime(sample.updatedAt)}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                    <nav className="archive-pagination" aria-label={t('archive.aria.pagination')}>
                      <Button variant="secondary" onClick={() => setPage(current => Math.max(1, current - 1))} disabled={currentPage === 1}>{t('archive.previousPage')}</Button>
                      <label><span>{t('archive.page')}</span><select value={currentPage} onChange={event => setPage(Number(event.target.value))}>{Array.from({ length: totalPages }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select><span>{t('archive.pageTotal', { count: totalPages })}</span></label>
                      <Button variant="secondary" onClick={() => setPage(current => Math.min(totalPages, current + 1))} disabled={currentPage === totalPages}>{t('archive.nextPage')}</Button>
                    </nav>
                  </>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
