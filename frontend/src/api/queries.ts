import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { apiRequest } from './client';
import type {
  BackgroundPreset,
  BackgroundPresetCreate,
  BackgroundPresetUpdate,
  BatchDraft,
  BatchDraftCreate,
  BatchDraftUpdate,
  BatchPreview,
  ContentPlan,
  ContentPlanCreate,
  ContentPlanUpdate,
  Dataset,
  DatasetCreate,
  DatasetUpdate,
  GpuSlot,
  JobDetail,
  JobEvent,
  JobItem,
  JobSummary,
  PromptPreset,
  PromptPresetCreate,
  PromptPresetUpdate,
  PromptPreview,
  PromptPreviewRequest,
} from './contracts';

export const queryKeys = {
  datasets: ['datasets'] as const,
  contentPlans: ['contentPlans'] as const,
  promptPresets: ['promptPresets'] as const,
  backgroundPresets: ['backgroundPresets'] as const,
  batchDrafts: ['batchDrafts'] as const,
  batchDraft: (id: number) => ['batchDrafts', id] as const,
  jobs: ['jobs'] as const,
  job: (id: number) => ['jobs', id] as const,
  jobItems: (id: number) => ['jobs', id, 'items'] as const,
  jobEvents: (id: number) => ['jobs', id, 'events'] as const,
  gpuSlots: ['gpuSlots'] as const,
};

export const generationQueries = {
  datasets: () => queryOptions({ queryKey: queryKeys.datasets, queryFn: () => apiRequest<Dataset[]>('/api/datasets') }),
  contentPlans: () => queryOptions({ queryKey: queryKeys.contentPlans, queryFn: () => apiRequest<ContentPlan[]>('/api/content-plans') }),
  promptPresets: () => queryOptions({ queryKey: queryKeys.promptPresets, queryFn: () => apiRequest<PromptPreset[]>('/api/prompt-presets') }),
  backgroundPresets: () => queryOptions({ queryKey: queryKeys.backgroundPresets, queryFn: () => apiRequest<BackgroundPreset[]>('/api/video-background-presets') }),
  batchDrafts: () => queryOptions({ queryKey: queryKeys.batchDrafts, queryFn: () => apiRequest<BatchDraft[]>('/api/batch-drafts') }),
  jobs: () => queryOptions({ queryKey: queryKeys.jobs, queryFn: () => apiRequest<JobSummary[]>('/api/jobs') }),
  job: (id: number) => queryOptions({ queryKey: queryKeys.job(id), queryFn: () => apiRequest<JobDetail>(`/api/jobs/${id}`) }),
  jobItems: (id: number) => queryOptions({ queryKey: queryKeys.jobItems(id), queryFn: () => apiRequest<JobItem[]>(`/api/jobs/${id}/items?offset=0&limit=500`) }),
  jobEvents: (id: number) => queryOptions({ queryKey: queryKeys.jobEvents(id), queryFn: () => apiRequest<JobEvent[]>(`/api/jobs/${id}/events?afterEventId=0&limit=500`) }),
  gpuSlots: () => queryOptions({ queryKey: queryKeys.gpuSlots, queryFn: () => apiRequest<GpuSlot[]>('/api/gpu-slots') }),
};

function json(value: unknown): RequestInit {
  return { body: JSON.stringify(value) };
}

async function invalidateCatalog(queryClient: QueryClient, key: readonly unknown[]): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: key });
}

export function useDatasetsQuery() { return useQuery(generationQueries.datasets()); }
export function useContentPlansQuery() { return useQuery(generationQueries.contentPlans()); }
export function usePromptPresetsQuery() { return useQuery(generationQueries.promptPresets()); }
export function useBackgroundPresetsQuery() { return useQuery(generationQueries.backgroundPresets()); }
export function useBatchDraftsQuery() { return useQuery(generationQueries.batchDrafts()); }
export function useJobsQuery() { return useQuery(generationQueries.jobs()); }
export function useGpuSlotsQuery() { return useQuery(generationQueries.gpuSlots()); }

export function useJobQuery(id: number | null) {
  return useQuery({ ...generationQueries.job(id ?? 0), enabled: id !== null });
}

export function useJobItemsQuery(id: number | null) {
  return useQuery({ ...generationQueries.jobItems(id ?? 0), enabled: id !== null });
}

export function useJobEventsQuery(id: number | null) {
  return useQuery({ ...generationQueries.jobEvents(id ?? 0), enabled: id !== null });
}

export function useCreateDatasetMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: DatasetCreate) => apiRequest<Dataset>('/api/datasets', { method: 'POST', ...json(input) }),
    onSuccess: () => invalidateCatalog(client, queryKeys.datasets),
  });
}

export function useUpdateDatasetMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: DatasetUpdate }) => apiRequest<Dataset>(`/api/datasets/${id}`, { method: 'PATCH', ...json(input) }),
    onSuccess: () => invalidateCatalog(client, queryKeys.datasets),
  });
}

export function useCreateContentPlanMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ContentPlanCreate) => apiRequest<ContentPlan>('/api/content-plans', { method: 'POST', ...json(input) }),
    onSuccess: () => invalidateCatalog(client, queryKeys.contentPlans),
  });
}

export function useUpdateContentPlanMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: ContentPlanUpdate }) => apiRequest<ContentPlan>(`/api/content-plans/${id}`, { method: 'PATCH', ...json(input) }),
    onSuccess: () => invalidateCatalog(client, queryKeys.contentPlans),
  });
}

export function useDeleteContentPlanMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<void>(`/api/content-plans/${id}?expectedRevision=${expectedRevision}`, { method: 'DELETE' }),
    onSuccess: () => invalidateCatalog(client, queryKeys.contentPlans),
  });
}

export function useCreatePromptPresetMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: PromptPresetCreate) => apiRequest<PromptPreset>('/api/prompt-presets', { method: 'POST', ...json(input) }),
    onSuccess: () => invalidateCatalog(client, queryKeys.promptPresets),
  });
}

export function useUpdatePromptPresetMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: PromptPresetUpdate }) => apiRequest<PromptPreset>(`/api/prompt-presets/${id}`, { method: 'PATCH', ...json(input) }),
    onSuccess: () => invalidateCatalog(client, queryKeys.promptPresets),
  });
}

export function useDeletePromptPresetMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<void>(`/api/prompt-presets/${id}?expectedRevision=${expectedRevision}`, { method: 'DELETE' }),
    onSuccess: () => invalidateCatalog(client, queryKeys.promptPresets),
  });
}

export function useCreateBackgroundPresetMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: BackgroundPresetCreate) => apiRequest<BackgroundPreset>('/api/video-background-presets', { method: 'POST', ...json(input) }),
    onSuccess: () => invalidateCatalog(client, queryKeys.backgroundPresets),
  });
}

export function useUpdateBackgroundPresetMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: BackgroundPresetUpdate }) => apiRequest<BackgroundPreset>(`/api/video-background-presets/${id}`, { method: 'PATCH', ...json(input) }),
    onSuccess: () => invalidateCatalog(client, queryKeys.backgroundPresets),
  });
}

export function useDeleteBackgroundPresetMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<void>(`/api/video-background-presets/${id}?expectedRevision=${expectedRevision}`, { method: 'DELETE' }),
    onSuccess: () => invalidateCatalog(client, queryKeys.backgroundPresets),
  });
}

export function useSaveBatchDraftMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: BatchDraftCreate | BatchDraftUpdate }) => id === null
      ? apiRequest<BatchDraft>('/api/batch-drafts', { method: 'POST', ...json(input) })
      : apiRequest<BatchDraft>(`/api/batch-drafts/${id}`, { method: 'PUT', ...json(input) }),
    onSuccess: async value => {
      client.setQueryData(queryKeys.batchDraft(value.id), value);
      await invalidateCatalog(client, queryKeys.batchDrafts);
    },
  });
}

export function usePreviewBatchMutation() {
  return useMutation({
    mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<BatchPreview>(`/api/batch-drafts/${id}/preview`, { method: 'POST', ...json({ expectedRevision }) }),
  });
}

export function useSubmitBatchMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision, expectedGpuRevisions, confirmModelSwitch }: { id: number; expectedRevision: number; expectedGpuRevisions: Partial<Record<GpuSlot['slot'], number>>; confirmModelSwitch: boolean }) => apiRequest<JobDetail>(`/api/batch-drafts/${id}/submit`, {
      method: 'POST',
      ...json({ expectedRevision, expectedGpuRevisions, confirmModelSwitch }),
    }),
    onSuccess: async value => {
      client.setQueryData(queryKeys.job(value.id), value);
      await Promise.all([
        invalidateCatalog(client, queryKeys.jobs),
        invalidateCatalog(client, queryKeys.batchDrafts),
        invalidateCatalog(client, queryKeys.gpuSlots),
      ]);
    },
  });
}

export function usePromptPreviewMutation() {
  return useMutation({
    mutationFn: (input: PromptPreviewRequest) => apiRequest<PromptPreview>('/api/prompt-preview', { method: 'POST', ...json(input) }),
  });
}

export function useCancelJobMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<JobDetail>(`/api/jobs/${id}/cancel`, { method: 'POST', ...json({ expectedRevision }) }),
    onSuccess: async value => {
      client.setQueryData(queryKeys.job(value.id), value);
      await Promise.all([
        invalidateCatalog(client, queryKeys.jobs),
        invalidateCatalog(client, queryKeys.gpuSlots),
      ]);
    },
  });
}
