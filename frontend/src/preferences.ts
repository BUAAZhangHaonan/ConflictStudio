import { useEffect, useSyncExternalStore } from 'react';
import { ApiError } from './api/client';
import type { Reviewer } from './api/contracts';
import { useReviewerQuery, useReviewersQuery } from './api/queries';
import type { Locale } from './types';

export const LOCALE_STORAGE_KEY = 'conflictstudio.locale';
const REVIEWER_ID_STORAGE_KEY = 'conflictstudio.reviewer.id';
const REVIEWER_NAME_STORAGE_KEY = 'conflictstudio.reviewer.name';
export const REVIEWER_PROMPT_DISMISSED_STORAGE_KEY = 'conflictstudio.reviewer.readOnly';

export interface BrowserPreferences {
  locale: Locale;
  currentReviewerId: number | null;
  currentReviewerName: string | null;
}

const listeners = new Set<() => void>();
let snapshot = readPreferences();

function readPositiveInteger(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readPreferences(): BrowserPreferences {
  const storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  const currentReviewerId = readPositiveInteger(window.localStorage.getItem(REVIEWER_ID_STORAGE_KEY));
  const currentReviewerName = window.localStorage.getItem(REVIEWER_NAME_STORAGE_KEY)?.trim() || null;
  return {
    locale: storedLocale === 'en-US' ? 'en-US' : 'zh-CN',
    currentReviewerId,
    currentReviewerName: currentReviewerId === null ? null : currentReviewerName,
  };
}

function publish(next: BrowserPreferences): void {
  snapshot = next;
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePreferences(): BrowserPreferences {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function setPreferredLocale(locale: Locale): void {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  publish({ ...snapshot, locale });
}

export function isReviewerPromptDismissed(): boolean {
  return window.localStorage.getItem(REVIEWER_PROMPT_DISMISSED_STORAGE_KEY) === 'true';
}

export function dismissReviewerPrompt(): void {
  window.localStorage.setItem(REVIEWER_PROMPT_DISMISSED_STORAGE_KEY, 'true');
}

export function setCurrentReviewer(reviewer: { id: number; name: string } | null): void {
  if (reviewer === null) {
    window.localStorage.removeItem(REVIEWER_ID_STORAGE_KEY);
    window.localStorage.removeItem(REVIEWER_NAME_STORAGE_KEY);
    publish({ ...snapshot, currentReviewerId: null, currentReviewerName: null });
    return;
  }
  window.localStorage.removeItem(REVIEWER_PROMPT_DISMISSED_STORAGE_KEY);
  window.localStorage.setItem(REVIEWER_ID_STORAGE_KEY, String(reviewer.id));
  window.localStorage.setItem(REVIEWER_NAME_STORAGE_KEY, reviewer.name);
  publish({ ...snapshot, currentReviewerId: reviewer.id, currentReviewerName: reviewer.name });
}

export function useReviewerState(page = 1) {
  const preferences = usePreferences();
  const reviewersQuery = useReviewersQuery(page);
  const listedReviewer = reviewersQuery.data?.items.find(reviewer => reviewer.id === preferences.currentReviewerId) ?? null;
  const currentReviewerQuery = useReviewerQuery(
    preferences.currentReviewerId,
    reviewersQuery.isSuccess && preferences.currentReviewerId !== null && listedReviewer === null,
  );
  const missingReviewer = currentReviewerQuery.error instanceof ApiError && currentReviewerQuery.error.status === 404;
  const currentReviewer: Reviewer | null = reviewersQuery.isSuccess
    ? listedReviewer ?? currentReviewerQuery.data ?? null
    : null;

  useEffect(() => {
    if (!reviewersQuery.isSuccess || preferences.currentReviewerId === null) return;
    if (currentReviewer !== null) {
      if (currentReviewer.name !== preferences.currentReviewerName) setCurrentReviewer(currentReviewer);
      return;
    }
    if (missingReviewer) setCurrentReviewer(null);
  }, [currentReviewer, missingReviewer, preferences.currentReviewerId, preferences.currentReviewerName, reviewersQuery.isSuccess]);

  const isPending = reviewersQuery.isPending || (
    preferences.currentReviewerId !== null
    && listedReviewer === null
    && currentReviewerQuery.isPending
  );
  const error = reviewersQuery.error ?? (missingReviewer ? null : currentReviewerQuery.error);
  const retry = () => Promise.all([
    reviewersQuery.refetch(),
    ...(preferences.currentReviewerId === null || listedReviewer !== null ? [] : [currentReviewerQuery.refetch()]),
  ]);

  return {
    preferences,
    reviewersQuery,
    currentReviewer,
    currentReviewerId: currentReviewer?.id ?? null,
    isPending,
    error,
    retry,
  };
}
