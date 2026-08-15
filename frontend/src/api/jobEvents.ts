import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { jobEventsWebSocketUrl } from './client';
import { invalidateJobAuthority, queryKeys } from './queries';
import type { JobDetail, JobEvent, JobItem, JobItemStage, JobStatus, JobSummary, Page } from './contracts';

function eventStatus(event: JobEvent): JobStatus | null {
  if (event.eventType === 'JobStarted') return 'Running';
  if (event.eventType === 'JobCompleted') return 'Completed';
  if (event.eventType === 'JobFailed') return 'Failed';
  if (event.eventType === 'JobCancelled') return 'Cancelled';
  return null;
}

function updateJob<T extends JobSummary>(job: T, event: JobEvent): T {
  return {
    ...job,
    status: eventStatus(event) ?? job.status,
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

function updateItems(items: readonly JobItem[], event: JobEvent): JobItem[] {
  const state = event.itemId === null ? null : itemState(event);
  if (!state) return [...items];
  return items.map(item => {
    if (item.id !== event.itemId) return item;
    const renderProgress = event.eventType === 'ItemRenderProgress'
      && event.payload.progressValue !== null
      && event.payload.progressMaximum !== null
      ? { value: event.payload.progressValue, maximum: event.payload.progressMaximum }
      : item.renderProgress;
    return {
      ...item,
      ...state,
      renderProgress,
      failureCode: event.payload.failureCode ?? item.failureCode,
      failureReason: event.payload.failureReason ?? item.failureReason,
      updatedAt: event.createdAt,
    };
  });
}

function latestEventId(events: readonly JobEvent[]): number {
  return events.reduce((latest, event) => Math.max(latest, event.id), 0);
}

export function latestCachedJobEventId(client: QueryClient, jobId: number): number {
  const pages = client.getQueriesData<Page<JobEvent>>({ queryKey: [...queryKeys.jobs, 'detail', jobId, 'events'] });
  return pages.reduce((latest, [, page]) => Math.max(latest, latestEventId(page?.items ?? [])), 0);
}

export function eventRequiresAuthorityRefresh(event: JobEvent): boolean {
  return [
    'JobStarted', 'CancelRequested', 'ItemPromptReady', 'ItemRenderStarted',
    'ItemMediaProcessing', 'ItemCompleted', 'ItemFailed', 'ItemCancelled',
    'JobInterrupted', 'JobCompleted', 'JobFailed', 'JobCancelled',
  ].includes(event.eventType);
}

export async function invalidateAuthorityForJobEvent(client: QueryClient, event: JobEvent): Promise<void> {
  await invalidateJobAuthority(client, event.jobId, true);
}

export function applyJobEventToCache(client: QueryClient, event: JobEvent): void {
  client.setQueriesData<Page<JobSummary>>(
    { predicate: query => query.queryKey[0] === 'jobs' && query.queryKey[1] === 'page' },
    current => current ? { ...current, items: current.items.map(job => job.id === event.jobId ? updateJob(job, event) : job) } : current,
  );
  client.setQueryData<JobDetail>(queryKeys.job(event.jobId), current => current ? updateJob(current, event) : current);
  client.setQueriesData<Page<JobItem>>(
    { queryKey: [...queryKeys.jobs, 'detail', event.jobId, 'items'] },
    current => current ? { ...current, items: updateItems(current.items, event) } : current,
  );
  void client.invalidateQueries({ queryKey: [...queryKeys.jobs, 'detail', event.jobId, 'events'] });
  if (eventRequiresAuthorityRefresh(event)) void invalidateAuthorityForJobEvent(client, event);
}

export function reconnectDelay(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
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
  const [newEventCount, setNewEventCount] = useState(0);
  const afterEventId = useMemo(() => latestEventId(initialEvents), [initialEvents]);
  const cursor = useRef(afterEventId);
  const retryAttempt = useRef(0);
  const cursorJobId = useRef(jobId);

  useEffect(() => {
    if (cursorJobId.current !== jobId) {
      cursorJobId.current = jobId;
      cursor.current = afterEventId;
      retryAttempt.current = 0;
      setNewEventCount(0);
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
    const scheduleReconnect = () => {
      if (intentional) return;
      setDisconnected(true);
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
        if (value.id > cursor.current) {
          cursor.current = value.id;
          setNewEventCount(count => count + 1);
          applyJobEventToCache(client, value);
        }
      } catch {
        socket.close(4000, 'Invalid job event');
      }
    };
    socket.onerror = () => setDisconnected(true);
    socket.onclose = scheduleReconnect;
    return () => {
      intentional = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      socket.close();
    };
  }, [client, generation, jobId, terminal]);

  return {
    disconnected,
    newEventCount,
    clearNewEvents: () => setNewEventCount(0),
    reconnect: () => setGeneration(value => value + 1),
  };
}
