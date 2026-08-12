import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { jobEventsWebSocketUrl } from './client';
import { queryKeys } from './queries';
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

function updateItems(items: readonly JobItem[] | undefined, event: JobEvent): JobItem[] | undefined {
  if (event.itemId === null) return items ? [...items] : undefined;
  const state = itemState(event);
  if (!state) return items ? [...items] : undefined;
  return items?.map(item => item.id === event.itemId
    ? {
        ...item,
        ...state,
        failureCode: event.payload.failureCode ?? item.failureCode,
        failureReason: event.payload.failureReason ?? item.failureReason,
        updatedAt: event.createdAt,
      }
    : item);
}

export function applyJobEventToCache(client: QueryClient, event: JobEvent): void {
  client.setQueryData<JobEvent[]>(queryKeys.jobEvents(event.jobId), current => appendEvent(current, event));
  client.setQueryData<JobSummary[]>(queryKeys.jobs, current => current?.map(job => job.id === event.jobId ? updateJob(job, event) : job));
  client.setQueryData<JobDetail>(queryKeys.job(event.jobId), current => current
    ? { ...updateJob(current, event), items: updateItems(current.items, event) ?? current.items, events: appendEvent(current.events, event) }
    : current);
  client.setQueryData<JobItem[]>(queryKeys.jobItems(event.jobId), current => updateItems(current, event));
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

  useEffect(() => {
    cursor.current = afterEventId;
  }, [afterEventId, jobId]);

  useEffect(() => {
    if (jobId === null || terminal) {
      setDisconnected(false);
      return;
    }
    const socket = new WebSocket(jobEventsWebSocketUrl(jobId, cursor.current));
    let intentional = false;
    socket.onopen = () => setDisconnected(false);
    socket.onmessage = message => {
      try {
        const value: unknown = JSON.parse(String(message.data));
        if (isJobEvent(value)) {
          cursor.current = Math.max(cursor.current, value.id);
          applyJobEventToCache(client, value);
        }
      } catch {
        setDisconnected(true);
      }
    };
    socket.onerror = () => setDisconnected(true);
    socket.onclose = event => {
      if (!intentional && event.code !== 1000) setDisconnected(true);
    };
    return () => {
      intentional = true;
      socket.close();
    };
  }, [client, generation, jobId, terminal]);

  return {
    disconnected,
    reconnect: () => setGeneration(value => value + 1),
  };
}
