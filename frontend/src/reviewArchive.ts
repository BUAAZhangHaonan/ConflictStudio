import type { ConflictDirection, Sample } from './types';

export const ARCHIVE_PAGE_SIZE = 20;

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

export function reviewLocation(sampleId: string, returnTo: string): string {
  const params = new URLSearchParams({ sample: sampleId, returnTo });
  return `/review?${params.toString()}`;
}

export function archiveReturnTarget(value: string | null): string | null {
  if (!value) return null;
  const target = new URL(value, 'https://conflictstudio.local');
  return target.origin === 'https://conflictstudio.local' && target.pathname === '/archive'
    ? `${target.pathname}${target.search}`
    : null;
}

export function applyConflictDirectionChange(
  sample: Sample,
  conflictDirection: ConflictDirection,
  updatedAt: string,
): Sample {
  return {
    ...sample,
    conflictDirection,
    reviewDecision: 'Pending',
    reviewRevision: sample.reviewRevision + 1,
    archiveStatus: 'NeedsUpdate',
    revision: sample.revision + 1,
    updatedAt,
  };
}
