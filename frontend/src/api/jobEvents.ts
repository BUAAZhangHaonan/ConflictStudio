import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { jobEventsWebSocketUrl } from './client';
import {
  fetchJobEventsAfter,
  invalidateJobAuthority,
  queryKeys,
} from './queries';
import type { JobDetail, JobEvent, JobItem, JobItemStage, JobStatus, JobSummary } from './contracts';

function appendEvent(events: readonly JobEvent[] | undefined, event: JobEvent): JobEvent[] {
  const byId = new Map((events ?? []).map(value => [value.id, value]));
  byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

function eventStatus(event: JobEvent): JobStatus | null {
  if (event.eventType === 'JobStarted') return 'Running';
  if (event.eventType === 'JobCompleted') return 'Completed';
  if (event.eventType === 'JobFailed') return 'Failed';
  if (event.eventType === 'JobCancelled') return 'Cancelled';
  return null;
}

function updateJob<T extends JobSummary>(job: T, event: JobEvent): T {
  const status = eventStatus(event) ?? job.status;
  return {
    ...job,
    status,
    preparedCount: event.payload.preparedCount ?? job.preparedCount,
    completedCount: event.payload.completedCount ?? job.completedCount,
    failedCount: event.payload.failedCount ?? job.failedCount,
    totalCount: event.payload.totalCount ?? job.totalCount,
    failureCode: event.payload.failureCode ?? job.failureCode,
    failureReason: event.payload.failureReason ?? job.failureReason,
    updatedAt: event.createdAt,
  };
}

function itemState(event: JobEvent): { stage: JobItemStage; status: JobStatus } | null {
  if (event.eventType === 'ItemPromptStarted') return { stage: 'PromptGenerating', status: 'Running' };
  if (event.eventType === 'ItemPromptReady') return { stage: 'PromptReady', status: 'Running' };
  if (event.eventType === 'ItemRenderStarted' || event.eventType === 'ItemRenderProgress') return { stage: 'Rendering', status: 'Running' };
  if (event.eventType === 'ItemMediaProcessing') return { stage: 'MediaProcessing', status: 'Running' };
  if (event.eventType === 'ItemCompleted') return { stage: 'Completed', status: 'Completed' };
  if (event.eventType === 'ItemFailed') return { stage: 'Completed', status: 'Failed' };
  if (event.eventType === 'ItemCancelled') return { stage: 'Completed', status: 'Cancelled' };
  return null;
}

function eventProgress(event: JobEvent): JobItem['renderProgress'] | undefined {
  const { progressValue, progressMaximum } = event.payload;
  if (event.eventType !== 'ItemRenderProgress') return undefined;
  if (progressValue === null || progressMaximum === null) return undefined;
  return { value: progressValue, maximum: progressMaximum };
}

function updateItems(items: readonly JobItem[] | undefined, event: JobEvent): JobItem[] | undefined {
  if (event.itemId === null) return items ? [...items] : undefined;
  const state = itemState(event);
  if (!state) return items ? [...items] : undefined;
  const progress = eventProgress(event);
  return items?.map(item => item.id === event.itemId
    ? {
        ...item,
        ...state,
        ...(progress === undefined ? {} : { renderProgress: progress }),
        failureCode: event.payload.failureCode ?? item.failureCode,
        failureReason: event.payload.failureReason ?? item.failureReason,
        updatedAt: event.createdAt,
      }
    : item);
}

function latestEventId(events: readonly JobEvent[] | undefined): number {
  return (events ?? []).reduce((latest, event) => Math.max(latest, event.id), 0);
}

export function latestCachedJobEventId(client: QueryClient, jobId: number): number {
  const events = client.getQueryData<JobEvent[]>(queryKeys.jobEvents(jobId));
  const detail = client.getQueryData<JobDetail>(queryKeys.job(jobId));
  return Math.max(latestEventId(events), latestEventId(detail?.events));
}

export function eventRequiresAuthorityRefresh(event: JobEvent): boolean {
  return [
    'JobStarted',
    'CancelRequested',
    'ItemPromptReady',
    'ItemRenderStarted',
    'ItemMediaProcessing',
    'ItemCompleted',
    'ItemFailed',
    'ItemCancelled',
    'JobInterrupted',
    'JobCompleted',
    'JobFailed',
    'JobCancelled',
  ].includes(event.eventType);
}

export async function invalidateAuthorityForJobEvent(client: QueryClient, event: JobEvent): Promise<void> {
  const invalidations = [
    client.invalidateQueries({ queryKey: queryKeys.jobs, exact: true }),
    client.invalidateQueries({ queryKey: queryKeys.job(event.jobId), exact: true }),
    client.invalidateQueries({ queryKey: queryKeys.jobItems(event.jobId), exact: true }),
  ];
  if (['CancelRequested', 'JobInterrupted', 'JobCompleted', 'JobFailed', 'JobCancelled'].includes(event.eventType)) {
    invalidations.push(client.invalidateQueries({ queryKey: queryKeys.jobEvents(event.jobId), exact: true }));
  }
  if (['JobStarted', 'CancelRequested', 'JobInterrupted', 'JobCompleted', 'JobFailed', 'JobCancelled'].includes(event.eventType)) {
    invalidations.push(client.invalidateQueries({ queryKey: queryKeys.gpuSlots, exact: true }));
  }
  await Promise.all(invalidations);
}

export function applyJobEventToCache(
  client: QueryClient,
  event: JobEvent,
  refreshAuthority = true,
): void {
  const latestBefore = latestCachedJobEventId(client, event.jobId);
  client.setQueryData<JobEvent[]>(queryKeys.jobEvents(event.jobId), current => appendEvent(current, event));
  client.setQueryData<JobDetail>(queryKeys.job(event.jobId), current => current
    ? { ...current, events: appendEvent(current.events, event) }
    : current);

  // A replayed or out-of-order event belongs in the log, but it must not roll
  // authoritative counters, status, failure, progress, or item stage backward.
  if (event.id <= latestBefore) return;

  client.setQueryData<JobSummary[]>(queryKeys.jobs, current => current?.map(job => job.id === event.jobId ? updateJob(job, event) : job));
  client.setQueryData<JobDetail>(queryKeys.job(event.jobId), current => current
    ? { ...updateJob(current, event), items: updateItems(current.items, event) ?? current.items }
    : current);
  client.setQueryData<JobItem[]>(queryKeys.jobItems(event.jobId), current => updateItems(current, event));

  if (refreshAuthority && eventRequiresAuthorityRefresh(event)) {
    void invalidateAuthorityForJobEvent(client, event);
  }
}

export function reconnectDelay(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}

export async function catchUpJobEvents(
  client: QueryClient,
  jobId: number,
  afterEventId: number,
): Promise<number> {
  const events = await fetchJobEventsAfter(jobId, afterEventId);
  let cursor = afterEventId;
  for (const event of events) {
    applyJobEventToCache(client, event, false);
    cursor = Math.max(cursor, event.id);
  }
  await invalidateJobAuthority(client, jobId, false);
  return cursor;
}

function isJobEvent(value: unknown): value is JobEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<JobEvent>;
  return typeof candidate.id === 'number'
    && typeof candidate.jobId === 'number'
    && typeof candidate.eventType === 'string'
    && typeof candidate.createdAt === 'string'
    && typeof candidate.payload === 'object'
    && candidate.payload !== null;
}

export function useJobEventReplay(jobId: number | null, terminal: boolean, initialEvents: readonly JobEvent[]) {
  const client = useQueryClient();
  const [generation, setGeneration] = useState(0);
  const [disconnected, setDisconnected] = useState(false);
  const afterEventId = useMemo(
    () => initialEvents.reduce((latest, event) => Math.max(latest, event.id), 0),
    [initialEvents],
  );
  const cursor = useRef(afterEventId);
  const retryAttempt = useRef(0);
  const cursorJobId = useRef(jobId);

  useEffect(() => {
    if (cursorJobId.current !== jobId) {
      cursorJobId.current = jobId;
      cursor.current = afterEventId;
      retryAttempt.current = 0;
    } else {
      cursor.current = Math.max(cursor.current, afterEventId);
    }
  }, [afterEventId, jobId]);

  useEffect(() => {
    if (jobId === null || terminal) {
      setDisconnected(false);
      return;
    }

    const socket = new WebSocket(jobEventsWebSocketUrl(jobId, cursor.current));
    let intentional = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let recovering = false;

    const recover = async () => {
      if (intentional || recovering) return;
      recovering = true;
      setDisconnected(true);
      try {
        cursor.current = await catchUpJobEvents(client, jobId, cursor.current);
      } catch {
        // The same bounded reconnect path handles a temporary REST failure.
      }
      if (intentional) return;
      const delay = reconnectDelay(retryAttempt.current);
      retryAttempt.current += 1;
      retryTimer = setTimeout(() => setGeneration(value => value + 1), delay);
    };

    socket.onopen = () => {
      retryAttempt.current = 0;
      setDisconnected(false);
    };
    socket.onmessage = message => {
      try {
        const value: unknown = JSON.parse(String(message.data));
        if (!isJobEvent(value) || value.jobId !== jobId) {
          socket.close(4000, 'Invalid job event');
          return;
        }
        cursor.current = Math.max(cursor.current, value.id);
        applyJobEventToCache(client, value);
      } catch {
        socket.close(4000, 'Invalid job event');
      }
    };
    socket.onerror = () => setDisconnected(true);
    socket.onclose = () => void recover();
    return () => {
      intentional = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      socket.close();
    };
  }, [client, generation, jobId, terminal]);

  return {
    disconnected,
    reconnect: () => setGeneration(value => value + 1),
  };
}
