import type { Protocol, Relation, ReviewDecision } from './api/contracts';
import type { Category, ConflictDirection } from './types';

export interface ReviewListLocationState {
  search: string | null;
  datasetId: number | null;
  decision: 'All' | ReviewDecision;
  protocol: Protocol | null;
  relation: Relation | null;
  direction: ConflictDirection | null;
  page: number;
}

export interface ReviewListSavedState {
  returnTo: string;
  page: number;
  scrollY: number;
}

interface ReviewListStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const REVIEW_LIST_STATE_STORAGE_KEY = 'conflictstudio.review.listState';
const REVIEW_LIST_ORIGIN = 'https://conflictstudio.local';
const decisions = new Set(['All', 'Pending', 'Accepted', 'Rejected']);
const protocols = new Set(['VA', 'VT']);
const relations = new Set(['Aligned', 'Conflict']);
const directions = new Set(['Vision', 'Audio', 'Text']);

function positiveInteger(value: string | null, fallback: number | null): number | null {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function reviewListSearchParams(value: string): URLSearchParams {
  const queryStart = value.indexOf('?');
  const query = queryStart >= 0 ? value.slice(queryStart + 1) : value.startsWith('?') ? value.slice(1) : value;
  return new URLSearchParams(query);
}

export function readReviewListLocation(value: string): ReviewListLocationState {
  const params = reviewListSearchParams(value);
  const rawSearch = params.get('search');
  const search = rawSearch?.trim() ?? '';
  const decision = params.get('decision');
  const protocol = params.get('protocol');
  const relation = params.get('relation');
  const direction = params.get('direction');
  return {
    search: search.length > 0 && search.length <= 160 ? search : null,
    datasetId: positiveInteger(params.get('datasetId'), null),
    decision: decisions.has(decision ?? '') ? decision as ReviewListLocationState['decision'] : 'All',
    protocol: protocols.has(protocol ?? '') ? protocol as Protocol : null,
    relation: relations.has(relation ?? '') ? relation as Relation : null,
    direction: directions.has(direction ?? '') ? direction as ConflictDirection : null,
    page: positiveInteger(params.get('page'), 1) ?? 1,
  };
}

export function buildReviewListLocation(state: ReviewListLocationState): string {
  const params = new URLSearchParams();
  if (state.search?.trim()) params.set('search', state.search.trim());
  if (state.datasetId !== null) params.set('datasetId', String(state.datasetId));
  if (state.decision !== 'All') params.set('decision', state.decision);
  if (state.protocol !== null) params.set('protocol', state.protocol);
  if (state.relation !== null) params.set('relation', state.relation);
  if (state.direction !== null) params.set('direction', state.direction);
  if (state.page > 1) params.set('page', String(state.page));
  const query = params.toString();
  return query ? `/review?${query}` : '/review';
}

export function reviewDetailLocation(sampleId: number): string {
  if (!Number.isInteger(sampleId) || sampleId <= 0) throw new RangeError('sampleId must be a positive integer');
  return `/review/${sampleId}`;
}

export function safeReviewListReturnTarget(value: string | null): string | null {
  if (!value || !value.startsWith('/review') || value.startsWith('//')) return null;
  try {
    const target = new URL(value, REVIEW_LIST_ORIGIN);
    if (target.origin !== REVIEW_LIST_ORIGIN || target.pathname !== '/review' || target.hash) return null;
    return `${target.pathname}${target.search}`;
  } catch {
    return null;
  }
}

export function saveReviewListState(
  state: ReviewListSavedState,
  storage: ReviewListStateStorage = window.sessionStorage,
): boolean {
  const returnTo = safeReviewListReturnTarget(state.returnTo);
  if (
    returnTo === null
    || !Number.isInteger(state.page)
    || state.page < 1
    || !Number.isFinite(state.scrollY)
    || state.scrollY < 0
    || readReviewListLocation(returnTo).page !== state.page
  ) return false;
  storage.setItem(REVIEW_LIST_STATE_STORAGE_KEY, JSON.stringify({
    returnTo,
    page: state.page,
    scrollY: state.scrollY,
  } satisfies ReviewListSavedState));
  return true;
}

export function restoreReviewListState(
  returnTo: string,
  storage: ReviewListStateStorage = window.sessionStorage,
): ReviewListSavedState | null {
  const safeReturnTo = safeReviewListReturnTarget(returnTo);
  if (safeReturnTo === null) return null;
  try {
    const value = JSON.parse(storage.getItem(REVIEW_LIST_STATE_STORAGE_KEY) ?? 'null') as Partial<ReviewListSavedState> | null;
    if (
      value === null
      || value.returnTo !== safeReturnTo
      || !Number.isInteger(value.page)
      || (value.page ?? 0) < 1
      || !Number.isFinite(value.scrollY)
      || (value.scrollY ?? -1) < 0
      || readReviewListLocation(safeReturnTo).page !== value.page
    ) return null;
    return { returnTo: safeReturnTo, page: value.page, scrollY: value.scrollY } as ReviewListSavedState;
  } catch {
    return null;
  }
}

export function currentPageSelection(
  selectedIds: ReadonlySet<number>,
  currentPageIds: readonly number[],
): Set<number> {
  const currentIds = new Set(currentPageIds);
  return new Set([...selectedIds].filter(id => currentIds.has(id)));
}

export const ARCHIVE_PAGE_SIZE = 20;

export interface ArchiveLocationState {
  datasetId: number | null;
  search: string;
  category: Category | 'All';
  page: number;
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / ARCHIVE_PAGE_SIZE));
}

export function clampPage(page: number, total: number): number {
  return Math.min(Math.max(1, page), pageCount(total));
}

export function pageItems<T>(items: readonly T[], page: number): T[] {
  const safePage = clampPage(page, items.length);
  const start = (safePage - 1) * ARCHIVE_PAGE_SIZE;
  return items.slice(start, start + ARCHIVE_PAGE_SIZE);
}

export function buildArchiveLocation(state: ArchiveLocationState): string {
  const params = new URLSearchParams();
  if (state.datasetId !== null) params.set('dataset', String(state.datasetId));
  if (state.search.trim()) params.set('search', state.search.trim());
  if (state.category !== 'All') params.set('category', state.category);
  if (state.page > 1) params.set('page', String(state.page));
  const query = params.toString();
  return query ? `/archive?${query}` : '/archive';
}

export function reviewLocation(sampleId: number, returnTo: string): string {
  const params = new URLSearchParams({ sampleId: String(sampleId) });
  const safeReturnTo = safeReviewReturnTarget(returnTo);
  if (safeReturnTo) params.set('returnTo', safeReturnTo);
  return `/review?${params.toString()}`;
}

const reviewReturnPaths = new Set([
  '/workspace',
  '/generate/test',
  '/generate/production',
  '/generate/results',
  '/archive',
  '/settings',
  '/me/statistics',
]);

export function safeReviewReturnTarget(value: string | null): string | null {
  if (!value) return null;
  try {
    const target = new URL(value, 'https://conflictstudio.local');
    if (target.origin !== 'https://conflictstudio.local' || !reviewReturnPaths.has(target.pathname)) return null;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}
