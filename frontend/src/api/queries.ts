import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { apiRequest } from './client';
import type {
  Archive,
  ArchivePreview,
  ArchivePreviewRequest,
  ArchiveSyncRequest,
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
  Health,
  JobDetail,
  JobEvent,
  JobItem,
  JobSummary,
  KeepTestResultRequest,
  PromptPreset,
  PromptPresetCreate,
  PromptPresetUpdate,
  PromptPreview,
  PromptPreviewRequest,
  Review,
  ReviewBatchCreate,
  ReviewCreate,
  ReviewDecision,
  Reviewer,
  ReviewerCreate,
  ReviewerRename,
  ReviewerStatistics,
  ReviewerStatisticsFilter,
  Sample,
  SampleClassificationUpdate,
  TestRunCreate,
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
  health: ['health'] as const,
  reviewers: ['reviewers'] as const,
  reviews: (sampleId: number) => ['reviews', sampleId] as const,
  reviewerStatistics: (reviewerId: number, filter: ReviewerStatisticsFilter) => ['reviewerStatistics', reviewerId, filter] as const,
  archives: ['archives'] as const,
  samples: (decision?: ReviewDecision) => ['samples', decision ?? 'All'] as const,
};

export const generationQueries = {
  datasets: () => queryOptions({ queryKey: queryKeys.datasets, queryFn: () => apiRequest<Dataset[]>('/api/datasets') }),
  contentPlans: () => queryOptions({ queryKey: queryKeys.contentPlans, queryFn: () => apiRequest<ContentPlan[]>('/api/content-plans') }),
  promptPresets: () => queryOptions({ queryKey: queryKeys.promptPresets, queryFn: () => apiRequest<PromptPreset[]>('/api/prompt-presets') }),
  backgroundPresets: () => queryOptions({ queryKey: queryKeys.backgroundPresets, queryFn: () => apiRequest<BackgroundPreset[]>('/api/video-background-presets') }),
  batchDrafts: () => queryOptions({ queryKey: queryKeys.batchDrafts, queryFn: () => apiRequest<BatchDraft[]>('/api/batch-drafts') }),
  jobs: () => queryOptions({ queryKey: queryKeys.jobs, queryFn: () => apiRequest<JobSummary[]>('/api/jobs') }),
  job: (id: number) => queryOptions({ queryKey: queryKeys.job(id), queryFn: () => apiRequest<JobDetail>(`/api/jobs/${id}`) }),
  jobItems: (id: number) => queryOptions({ queryKey: queryKeys.jobItems(id), queryFn: () => fetchAllJobItems(id) }),
  jobEvents: (id: number) => queryOptions({ queryKey: queryKeys.jobEvents(id), queryFn: () => fetchAllJobEvents(id) }),
  gpuSlots: () => queryOptions({
    queryKey: queryKeys.gpuSlots,
    queryFn: () => apiRequest<GpuSlot[]>('/api/gpu-slots'),
    refetchOnWindowFocus: true,
  }),
  health: () => queryOptions({ queryKey: queryKeys.health, queryFn: () => apiRequest<Health>('/api/health') }),
  reviewers: () => queryOptions({ queryKey: queryKeys.reviewers, queryFn: () => apiRequest<Reviewer[]>('/api/reviewers') }),
  reviews: (sampleId: number) => queryOptions({
    queryKey: queryKeys.reviews(sampleId),
    queryFn: () => apiRequest<Review[]>(`/api/reviews?${new URLSearchParams({ sampleId: String(sampleId) }).toString()}`),
  }),
  reviewerStatistics: (reviewerId: number, filter: ReviewerStatisticsFilter) => {
    const params = new URLSearchParams();
    if (filter.datasetId !== undefined) params.set('datasetId', String(filter.datasetId));
    if (filter.startDate !== undefined) params.set('startDate', filter.startDate);
    if (filter.endDate !== undefined) params.set('endDate', filter.endDate);
    return queryOptions({
      queryKey: queryKeys.reviewerStatistics(reviewerId, filter),
      queryFn: () => apiRequest<ReviewerStatistics>(`/api/reviewers/${reviewerId}/statistics${params.size ? `?${params.toString()}` : ''}`),
    });
  },
  archives: () => queryOptions({ queryKey: queryKeys.archives, queryFn: () => apiRequest<Archive[]>('/api/archives') }),
  samples: (decision?: ReviewDecision) => queryOptions({
    queryKey: queryKeys.samples(decision),
    queryFn: () => apiRequest<Sample[]>(decision
      ? `/api/samples?${new URLSearchParams({ decision }).toString()}`
      : '/api/samples'),
  }),
};

const pageSize = 500;

export async function fetchAllJobItems(id: number): Promise<JobItem[]> {
  const items: JobItem[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await apiRequest<JobItem[]>(`/api/jobs/${id}/items?offset=${offset}&limit=${pageSize}`);
    items.push(...page);
    if (page.length < pageSize) return items;
  }
}

export async function fetchJobEventsAfter(id: number, afterEventId: number): Promise<JobEvent[]> {
  const events: JobEvent[] = [];
  let cursor = afterEventId;
  for (;;) {
    const page = await apiRequest<JobEvent[]>(`/api/jobs/${id}/events?afterEventId=${cursor}&limit=${pageSize}`);
    for (const event of page) {
      if (event.id > cursor) events.push(event);
      cursor = Math.max(cursor, event.id);
    }
    if (page.length < pageSize) return events;
  }
}

export function fetchAllJobEvents(id: number): Promise<JobEvent[]> {
  return fetchJobEventsAfter(id, 0);
}

export function setJobDetailData(queryClient: QueryClient, value: JobDetail): void {
  queryClient.setQueryData(queryKeys.job(value.id), value);
  queryClient.setQueryData(queryKeys.jobItems(value.id), value.items);
  queryClient.setQueryData(queryKeys.jobEvents(value.id), value.events);
}

export async function invalidateJobAuthority(
  queryClient: QueryClient,
  id: number,
  includeEvents = true,
): Promise<void> {
  const invalidations = [
    queryClient.invalidateQueries({ queryKey: queryKeys.jobs, exact: true }),
    queryClient.invalidateQueries({ queryKey: queryKeys.job(id), exact: true }),
    queryClient.invalidateQueries({ queryKey: queryKeys.jobItems(id), exact: true }),
    queryClient.invalidateQueries({ queryKey: queryKeys.gpuSlots, exact: true }),
  ];
  if (includeEvents) {
    invalidations.push(queryClient.invalidateQueries({ queryKey: queryKeys.jobEvents(id), exact: true }));
  }
  await Promise.all(invalidations);
}

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
export function useHealthQuery() { return useQuery(generationQueries.health()); }
export function useReviewersQuery() { return useQuery(generationQueries.reviewers()); }
export function useArchivesQuery() { return useQuery(generationQueries.archives()); }
export function useSamplesQuery(decision?: ReviewDecision) { return useQuery(generationQueries.samples(decision)); }

export function useReviewsQuery(sampleId: number | null) {
  return useQuery({ ...generationQueries.reviews(sampleId ?? 0), enabled: sampleId !== null });
}

export function useReviewerStatisticsQuery(reviewerId: number | null, filter: ReviewerStatisticsFilter) {
  return useQuery({
    ...generationQueries.reviewerStatistics(reviewerId ?? 0, filter),
    enabled: reviewerId !== null && filter.startDate !== undefined && filter.endDate !== undefined,
  });
}

export function useReleaseGpuMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ slot, expectedRevision }: { slot: GpuSlot['slot']; expectedRevision: number }) => apiRequest<GpuSlot>(`/api/gpu-slots/${slot}/release`, {
      method: 'POST',
      ...json({ expectedRevision }),
    }),
    onSuccess: async value => {
      client.setQueryData<GpuSlot[]>(queryKeys.gpuSlots, current =>
        current?.map(item => item.slot === value.slot ? value : item) ?? [value],
      );
      await client.invalidateQueries({ queryKey: queryKeys.gpuSlots, exact: true });
    },
  });
}

export function useJobQuery(id: number | null) {
  const client = useQueryClient();
  const jobId = id ?? 0;
  return useQuery({
    ...generationQueries.job(jobId),
    queryFn: async () => {
      const value = await apiRequest<JobDetail>(`/api/jobs/${jobId}`);
      setJobDetailData(client, value);
      return value;
    },
    enabled: id !== null,
  });
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
      setJobDetailData(client, value);
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

export function useSubmitTestRunMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TestRunCreate) => apiRequest<JobDetail>('/api/test-runs', {
      method: 'POST',
      ...json(input),
    }),
    onSuccess: async value => {
      setJobDetailData(client, value);
      await Promise.all([
        invalidateCatalog(client, queryKeys.jobs),
        invalidateCatalog(client, queryKeys.gpuSlots),
      ]);
    },
  });
}

export function useKeepTestResultMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, input }: { itemId: number; input: KeepTestResultRequest }) => apiRequest<Sample>(`/api/job-items/${itemId}/keep`, {
      method: 'POST',
      ...json(input),
    }),
    onSuccess: async value => {
      await Promise.all([
        invalidateCatalog(client, queryKeys.jobs),
        invalidateCatalog(client, ['samples']),
        invalidateCatalog(client, queryKeys.jobItems(value.jobItemId)),
      ]);
    },
  });
}

async function invalidateReviewData(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: ['samples'] }),
    client.invalidateQueries({ queryKey: ['reviews'] }),
    client.invalidateQueries({ queryKey: ['reviewerStatistics'] }),
    client.invalidateQueries({ queryKey: queryKeys.archives }),
  ]);
}

export function useCreateReviewerMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewerCreate) => apiRequest<Reviewer>('/api/reviewers', { method: 'POST', ...json(input) }),
    onSuccess: value => {
      client.setQueryData<Reviewer[]>(queryKeys.reviewers, current => current ? [...current, value] : [value]);
      return invalidateCatalog(client, queryKeys.reviewers);
    },
  });
}

export function useRenameReviewerMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: ReviewerRename }) => apiRequest<Reviewer>(`/api/reviewers/${id}`, { method: 'PATCH', ...json(input) }),
    onSuccess: value => {
      client.setQueryData<Reviewer[]>(queryKeys.reviewers, current => current?.map(item => item.id === value.id ? value : item) ?? [value]);
      return invalidateCatalog(client, queryKeys.reviewers);
    },
  });
}

export function useCreateReviewMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewCreate) => apiRequest<Sample>('/api/reviews', { method: 'POST', ...json(input) }),
    onSuccess: () => invalidateReviewData(client),
  });
}

export function useCreateReviewsBatchMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewBatchCreate) => apiRequest<Sample[]>('/api/reviews/batch', { method: 'POST', ...json(input) }),
    onSuccess: () => invalidateReviewData(client),
  });
}

export function useUpdateSampleClassificationMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: SampleClassificationUpdate }) => apiRequest<Sample>(`/api/samples/${id}/classification`, { method: 'PATCH', ...json(input) }),
    onSuccess: () => invalidateReviewData(client),
  });
}

export function usePreviewArchiveMutation() {
  return useMutation({
    mutationFn: (input: ArchivePreviewRequest) => apiRequest<ArchivePreview>('/api/archives/preview', { method: 'POST', ...json(input) }),
  });
}

export function useSyncArchiveMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ArchiveSyncRequest) => apiRequest<Archive>('/api/archives/sync', { method: 'POST', ...json(input) }),
    onSuccess: () => invalidateReviewData(client),
  });
}

export function useCancelJobMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<JobDetail>(`/api/jobs/${id}/cancel`, { method: 'POST', ...json({ expectedRevision }) }),
    onSuccess: async value => {
      setJobDetailData(client, value);
      await invalidateJobAuthority(client, value.id);
    },
  });
}
