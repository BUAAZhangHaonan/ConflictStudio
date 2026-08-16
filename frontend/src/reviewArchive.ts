import type { Category } from './types';

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
  '/generate/batches',
  '/generate/test',
  '/generate/content',
  '/generate/scenes',
  '/generate/template-versions',
  '/generate/jobs',
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
