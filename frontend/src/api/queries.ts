import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiRequest } from './client';
import type {
  Archive, ArchivePreview, ArchivePreviewRequest, ArchiveSyncRequest,
  BackgroundPreset, BackgroundPresetCreate, BackgroundPresetUpdate,
  BatchDraft, BatchDraftCreate, BatchDraftUpdate, BatchPreview,
  ContentPlan, ContentPlanBackgrounds, ContentPlanCreate, ContentPlanUpdate,
  Dataset, DatasetCreate, DatasetUpdate, GenerationAttempt, GpuSlot, Health,
  JobDetail, JobEvent, JobItem, JobSummary, KeepTestResultRequest, Page,
  PromptPreset, PromptPresetCreate, PromptPresetUpdate, PromptPreview, PromptPreviewRequest,
  Review, ReviewBatchCreate, ReviewCreate, ReviewDecision, Reviewer, ReviewerCreate,
  ReviewerRename, ReviewerStatistics, ReviewerStatisticsFilter, Sample,
  SampleClassificationUpdate, TestRunCreate,
} from './contracts';
import type { Category } from '../types';

export interface DatasetQueryFilter {
  search?: string;
  status?: Dataset['status'];
}

export interface JobQueryFilter {
  statuses?: JobSummary['status'][];
}

export interface SampleQueryFilter {
  decision?: ReviewDecision;
  datasetId?: number;
  protocol?: 'VA' | 'VT';
  category?: Category;
  search?: string;
}

const roots = {
  datasets: ['datasets'] as const,
  contentPlans: ['contentPlans'] as const,
  promptPresets: ['promptPresets'] as const,
  backgroundPresets: ['backgroundPresets'] as const,
  batchDrafts: ['batchDrafts'] as const,
  jobs: ['jobs'] as const,
  reviewers: ['reviewers'] as const,
  reviews: ['reviews'] as const,
  archives: ['archives'] as const,
  samples: ['samples'] as const,
};

export const queryKeys = {
  ...roots,
  datasetsPage: (filter: DatasetQueryFilter, page: number) => [...roots.datasets, filter, page] as const,
  dataset: (id: number) => [...roots.datasets, 'detail', id] as const,
  contentPlansPage: (page: number) => [...roots.contentPlans, page] as const,
  contentBackgrounds: (id: number) => [...roots.contentPlans, id, 'backgrounds'] as const,
  promptPresetsPage: (page: number) => [...roots.promptPresets, page] as const,
  backgroundPresetsPage: (page: number) => [...roots.backgroundPresets, page] as const,
  batchDraftsPage: (page: number) => [...roots.batchDrafts, page] as const,
  batchDraft: (id: number) => [...roots.batchDrafts, id] as const,
  jobsPage: (filter: JobQueryFilter, page: number) => [...roots.jobs, 'page', filter, page] as const,
  job: (id: number) => [...roots.jobs, 'detail', id] as const,
  jobItems: (id: number, page: number) => [...roots.jobs, 'detail', id, 'items', page] as const,
  jobAttempts: (itemId: number, page: number) => ['jobItems', itemId, 'attempts', page] as const,
  jobEvents: (id: number, page: number) => [...roots.jobs, 'detail', id, 'events', page] as const,
  gpuSlots: ['gpuSlots'] as const,
  health: ['health'] as const,
  reviewersPage: (page: number) => [...roots.reviewers, 'page', page] as const,
  reviewer: (id: number) => [...roots.reviewers, 'detail', id] as const,
  reviewsPage: (sampleId: number, page: number) => [...roots.reviews, sampleId, page] as const,
  reviewerStatistics: (reviewerId: number, filter: ReviewerStatisticsFilter) => ['reviewerStatistics', reviewerId, filter] as const,
  archivesPage: (page: number) => [...roots.archives, page] as const,
  sample: (id: number) => [...roots.samples, 'detail', id] as const,
  samplesPage: (filter: SampleQueryFilter, page: number) => [...roots.samples, filter, page] as const,
};

function pagePath(path: string, page: number, params = new URLSearchParams()): string {
  params.set('page', String(page));
  return `${path}?${params.toString()}`;
}

export const generationQueries = {
  datasets: (page: number, filter: DatasetQueryFilter = {}) => {
    const params = new URLSearchParams();
    if (filter.search?.trim()) params.set('search', filter.search.trim());
    if (filter.status !== undefined) params.set('status', filter.status);
    return queryOptions({ queryKey: queryKeys.datasetsPage(filter, page), queryFn: () => apiRequest<Page<Dataset>>(pagePath('/api/datasets', page, params)) });
  },
  dataset: (id: number) => queryOptions({ queryKey: queryKeys.dataset(id), queryFn: () => apiRequest<Dataset>(`/api/datasets/${id}`) }),
  contentPlans: (page: number) => queryOptions({ queryKey: queryKeys.contentPlansPage(page), queryFn: () => apiRequest<Page<ContentPlan>>(pagePath('/api/content-plans', page)) }),
  contentBackgrounds: (id: number) => queryOptions({ queryKey: queryKeys.contentBackgrounds(id), queryFn: () => apiRequest<ContentPlanBackgrounds>(`/api/content-plans/${id}/backgrounds`) }),
  promptPresets: (page: number) => queryOptions({ queryKey: queryKeys.promptPresetsPage(page), queryFn: () => apiRequest<Page<PromptPreset>>(pagePath('/api/prompt-presets', page)) }),
  backgroundPresets: (page: number) => queryOptions({ queryKey: queryKeys.backgroundPresetsPage(page), queryFn: () => apiRequest<Page<BackgroundPreset>>(pagePath('/api/video-background-presets', page)) }),
  batchDrafts: (page: number) => queryOptions({ queryKey: queryKeys.batchDraftsPage(page), queryFn: () => apiRequest<Page<BatchDraft>>(pagePath('/api/batch-drafts', page)) }),
  jobs: (page: number, filter: JobQueryFilter = {}) => {
    const params = new URLSearchParams();
    filter.statuses?.forEach(status => params.append('status', status));
    return queryOptions({ queryKey: queryKeys.jobsPage(filter, page), queryFn: () => apiRequest<Page<JobSummary>>(pagePath('/api/jobs', page, params)) });
  },
  job: (id: number) => queryOptions({ queryKey: queryKeys.job(id), queryFn: () => apiRequest<JobDetail>(`/api/jobs/${id}`) }),
  jobItems: (id: number, page: number) => queryOptions({ queryKey: queryKeys.jobItems(id, page), queryFn: () => apiRequest<Page<JobItem>>(pagePath(`/api/jobs/${id}/items`, page)) }),
  jobAttempts: (itemId: number, page: number) => queryOptions({ queryKey: queryKeys.jobAttempts(itemId, page), queryFn: () => apiRequest<Page<GenerationAttempt>>(pagePath(`/api/job-items/${itemId}/attempts`, page)) }),
  jobEvents: (id: number, page: number) => queryOptions({ queryKey: queryKeys.jobEvents(id, page), queryFn: () => apiRequest<Page<JobEvent>>(pagePath(`/api/jobs/${id}/events`, page)) }),
  gpuSlots: () => queryOptions({ queryKey: queryKeys.gpuSlots, queryFn: () => apiRequest<GpuSlot[]>('/api/gpu-slots'), refetchOnWindowFocus: true }),
  health: () => queryOptions({ queryKey: queryKeys.health, queryFn: () => apiRequest<Health>('/api/health') }),
  reviewers: (page: number) => queryOptions({ queryKey: queryKeys.reviewersPage(page), queryFn: () => apiRequest<Page<Reviewer>>(pagePath('/api/reviewers', page)) }),
  reviewer: (id: number) => queryOptions({ queryKey: queryKeys.reviewer(id), queryFn: () => apiRequest<Reviewer>(`/api/reviewers/${id}`) }),
  reviews: (sampleId: number, page: number) => queryOptions({ queryKey: queryKeys.reviewsPage(sampleId, page), queryFn: () => apiRequest<Page<Review>>(pagePath('/api/reviews', page, new URLSearchParams({ sampleId: String(sampleId) }))) }),
  reviewerStatistics: (reviewerId: number, filter: ReviewerStatisticsFilter) => {
    const params = new URLSearchParams();
    if (filter.datasetId !== undefined) params.set('datasetId', String(filter.datasetId));
    if (filter.startDate !== undefined) params.set('startDate', filter.startDate);
    if (filter.endDate !== undefined) params.set('endDate', filter.endDate);
    return queryOptions({ queryKey: queryKeys.reviewerStatistics(reviewerId, filter), queryFn: () => apiRequest<ReviewerStatistics>(`/api/reviewers/${reviewerId}/statistics${params.size ? `?${params.toString()}` : ''}`) });
  },
  archives: (page: number) => queryOptions({ queryKey: queryKeys.archivesPage(page), queryFn: () => apiRequest<Page<Archive>>(pagePath('/api/archives', page)) }),
  samples: (filter: SampleQueryFilter, page: number) => {
    const params = new URLSearchParams();
    if (filter.decision !== undefined) params.set('decision', filter.decision);
    if (filter.datasetId !== undefined) params.set('datasetId', String(filter.datasetId));
    if (filter.protocol !== undefined) params.set('protocol', filter.protocol);
    if (filter.category !== undefined) params.set('category', filter.category);
    if (filter.search?.trim()) params.set('search', filter.search.trim());
    return queryOptions({ queryKey: queryKeys.samplesPage(filter, page), queryFn: () => apiRequest<Page<Sample>>(pagePath('/api/samples', page, params)) });
  },
  sample: (id: number) => queryOptions({ queryKey: queryKeys.sample(id), queryFn: () => apiRequest<Sample>(`/api/samples/${id}`) }),
};

function json(value: unknown): RequestInit { return { body: JSON.stringify(value) }; }
async function invalidateCatalog(client: QueryClient, key: readonly unknown[]): Promise<void> { await client.invalidateQueries({ queryKey: key }); }
export function setJobDetailData(client: QueryClient, value: JobDetail): void { client.setQueryData(queryKeys.job(value.id), value); }

export async function invalidateJobAuthority(client: QueryClient, id: number, includeEvents = true): Promise<void> {
  const invalidations = [
    client.invalidateQueries({ queryKey: roots.jobs }),
    client.invalidateQueries({ queryKey: queryKeys.job(id), exact: true }),
    client.invalidateQueries({ queryKey: [...roots.jobs, 'detail', id, 'items'] }),
    client.invalidateQueries({ queryKey: queryKeys.gpuSlots, exact: true }),
  ];
  if (includeEvents) invalidations.push(client.invalidateQueries({ queryKey: [...roots.jobs, 'detail', id, 'events'] }));
  await Promise.all(invalidations);
}

export function useDatasetsQuery(page = 1, filter: DatasetQueryFilter = {}) { return useQuery(generationQueries.datasets(page, filter)); }
export function useDatasetQuery(id: number | null) { return useQuery({ ...generationQueries.dataset(id ?? 0), enabled: id !== null }); }
export function useContentPlansQuery(page = 1) { return useQuery(generationQueries.contentPlans(page)); }
export function useContentBackgroundsQuery(id: number | null) { return useQuery({ ...generationQueries.contentBackgrounds(id ?? 0), enabled: id !== null }); }
export function usePromptPresetsQuery(page = 1) { return useQuery(generationQueries.promptPresets(page)); }
export function useBackgroundPresetsQuery(page = 1) { return useQuery(generationQueries.backgroundPresets(page)); }
export function useBatchDraftsQuery(page = 1) { return useQuery(generationQueries.batchDrafts(page)); }
export function useJobsQuery(page = 1, filter: JobQueryFilter = {}) { return useQuery(generationQueries.jobs(page, filter)); }
export function useGpuSlotsQuery() { return useQuery(generationQueries.gpuSlots()); }
export function useHealthQuery() { return useQuery(generationQueries.health()); }
export function useReviewersQuery(page = 1) { return useQuery(generationQueries.reviewers(page)); }
export function useReviewerQuery(id: number | null) { return useQuery({ ...generationQueries.reviewer(id ?? 0), enabled: id !== null }); }
export function useArchivesQuery(page = 1) { return useQuery(generationQueries.archives(page)); }
export function useSamplesQuery(filter: SampleQueryFilter = {}, page = 1) { return useQuery(generationQueries.samples(filter, page)); }
export function useSampleQuery(id: number | null) { return useQuery({ ...generationQueries.sample(id ?? 0), enabled: id !== null }); }
export function useReviewsQuery(sampleId: number | null, page = 1) { return useQuery({ ...generationQueries.reviews(sampleId ?? 0, page), enabled: sampleId !== null }); }
export function useReviewerStatisticsQuery(reviewerId: number | null, filter: ReviewerStatisticsFilter) { return useQuery({ ...generationQueries.reviewerStatistics(reviewerId ?? 0, filter), enabled: reviewerId !== null && filter.startDate !== undefined && filter.endDate !== undefined }); }
export function useJobQuery(id: number | null) { return useQuery({ ...generationQueries.job(id ?? 0), enabled: id !== null }); }
export function useJobItemsQuery(id: number | null, page = 1) { return useQuery({ ...generationQueries.jobItems(id ?? 0, page), enabled: id !== null }); }
export function useJobAttemptsQuery(itemId: number | null, page = 1) { return useQuery({ ...generationQueries.jobAttempts(itemId ?? 0, page), enabled: itemId !== null }); }
export function useJobEventsQuery(id: number | null, page = 1) { return useQuery({ ...generationQueries.jobEvents(id ?? 0, page), enabled: id !== null }); }

export function useReleaseGpuMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ slot, expectedRevision }: { slot: GpuSlot['slot']; expectedRevision: number }) => apiRequest<GpuSlot>(`/api/gpu-slots/${slot}/release`, { method: 'POST', ...json({ expectedRevision }) }), onSuccess: async () => { await client.invalidateQueries({ queryKey: queryKeys.gpuSlots }); } });
}
export function useCreateDatasetMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: DatasetCreate) => apiRequest<Dataset>('/api/datasets', { method: 'POST', ...json(input) }), onSuccess: () => invalidateCatalog(client, roots.datasets) });
}
export function useUpdateDatasetMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, input }: { id: number; input: DatasetUpdate }) => apiRequest<Dataset>(`/api/datasets/${id}`, { method: 'PATCH', ...json(input) }), onSuccess: () => invalidateCatalog(client, roots.datasets) });
}
export function useDeleteDatasetMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<void>(`/api/datasets/${id}?expectedRevision=${expectedRevision}`, { method: 'DELETE' }), onSuccess: () => invalidateCatalog(client, roots.datasets) });
}
export function useCreateContentPlanMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: ContentPlanCreate) => apiRequest<ContentPlan>('/api/content-plans', { method: 'POST', ...json(input) }), onSuccess: () => invalidateCatalog(client, roots.contentPlans) });
}
export function useUpdateContentPlanMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, input }: { id: number; input: ContentPlanUpdate }) => apiRequest<ContentPlan>(`/api/content-plans/${id}`, { method: 'PATCH', ...json(input) }), onSuccess: () => invalidateCatalog(client, roots.contentPlans) });
}
export function useDeleteContentPlanMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<void>(`/api/content-plans/${id}?expectedRevision=${expectedRevision}`, { method: 'DELETE' }), onSuccess: () => invalidateCatalog(client, roots.contentPlans) });
}
export function useCreatePromptPresetMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: PromptPresetCreate) => apiRequest<PromptPreset>('/api/prompt-presets', { method: 'POST', ...json(input) }), onSuccess: () => invalidateCatalog(client, roots.promptPresets) });
}
export function useUpdatePromptPresetMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, input }: { id: number; input: PromptPresetUpdate }) => apiRequest<PromptPreset>(`/api/prompt-presets/${id}`, { method: 'PATCH', ...json(input) }), onSuccess: () => invalidateCatalog(client, roots.promptPresets) });
}
export function useDeletePromptPresetMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<void>(`/api/prompt-presets/${id}?expectedRevision=${expectedRevision}`, { method: 'DELETE' }), onSuccess: () => invalidateCatalog(client, roots.promptPresets) });
}
export function useCreateBackgroundPresetMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: BackgroundPresetCreate) => apiRequest<BackgroundPreset>('/api/video-background-presets', { method: 'POST', ...json(input) }), onSuccess: () => invalidateCatalog(client, roots.backgroundPresets) });
}
export function useUpdateBackgroundPresetMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, input }: { id: number; input: BackgroundPresetUpdate }) => apiRequest<BackgroundPreset>(`/api/video-background-presets/${id}`, { method: 'PATCH', ...json(input) }), onSuccess: () => invalidateCatalog(client, roots.backgroundPresets) });
}
export function useDeleteBackgroundPresetMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<void>(`/api/video-background-presets/${id}?expectedRevision=${expectedRevision}`, { method: 'DELETE' }), onSuccess: () => invalidateCatalog(client, roots.backgroundPresets) });
}
export function useSaveBatchDraftMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, input }: { id: number | null; input: BatchDraftCreate | BatchDraftUpdate }) => id === null ? apiRequest<BatchDraft>('/api/batch-drafts', { method: 'POST', ...json(input) }) : apiRequest<BatchDraft>(`/api/batch-drafts/${id}`, { method: 'PUT', ...json(input) }), onSuccess: async value => { client.setQueryData(queryKeys.batchDraft(value.id), value); await invalidateCatalog(client, roots.batchDrafts); } });
}
export function usePreviewBatchMutation() { return useMutation({ mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<BatchPreview>(`/api/batch-drafts/${id}/preview`, { method: 'POST', ...json({ expectedRevision }) }) }); }
export function useSubmitBatchMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, expectedRevision, expectedGpuRevisions, confirmModelSwitch }: { id: number; expectedRevision: number; expectedGpuRevisions: Partial<Record<GpuSlot['slot'], number>>; confirmModelSwitch: boolean }) => apiRequest<JobDetail>(`/api/batch-drafts/${id}/submit`, { method: 'POST', ...json({ expectedRevision, expectedGpuRevisions, confirmModelSwitch }) }), onSuccess: async value => { setJobDetailData(client, value); await Promise.all([invalidateCatalog(client, roots.jobs), invalidateCatalog(client, roots.batchDrafts), invalidateCatalog(client, queryKeys.gpuSlots)]); } });
}
export function usePromptPreviewMutation() { return useMutation({ mutationFn: (input: PromptPreviewRequest) => apiRequest<PromptPreview>('/api/prompt-preview', { method: 'POST', ...json(input) }) }); }
export function useSubmitTestRunMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: TestRunCreate) => apiRequest<JobDetail>('/api/test-runs', { method: 'POST', ...json(input) }), onSuccess: async value => { setJobDetailData(client, value); await Promise.all([invalidateCatalog(client, roots.jobs), invalidateCatalog(client, queryKeys.gpuSlots)]); } });
}
export function useKeepTestResultMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ itemId, input }: { itemId: number; input: KeepTestResultRequest }) => apiRequest<Sample>(`/api/job-items/${itemId}/keep`, { method: 'POST', ...json(input) }), onSuccess: async () => { await Promise.all([invalidateCatalog(client, roots.jobs), invalidateCatalog(client, roots.samples)]); } });
}

async function invalidateReviewData(client: QueryClient): Promise<void> {
  await Promise.all([client.invalidateQueries({ queryKey: roots.samples }), client.invalidateQueries({ queryKey: roots.reviews }), client.invalidateQueries({ queryKey: ['reviewerStatistics'] }), client.invalidateQueries({ queryKey: roots.archives })]);
}
export function useCreateReviewerMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: ReviewerCreate) => apiRequest<Reviewer>('/api/reviewers', { method: 'POST', ...json(input) }), onSuccess: () => invalidateCatalog(client, roots.reviewers) });
}
export function useRenameReviewerMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, input }: { id: number; input: ReviewerRename }) => apiRequest<Reviewer>(`/api/reviewers/${id}`, { method: 'PATCH', ...json(input) }), onSuccess: () => invalidateCatalog(client, roots.reviewers) });
}
export function useCreateReviewMutation() { const client = useQueryClient(); return useMutation({ mutationFn: (input: ReviewCreate) => apiRequest<Sample>('/api/reviews', { method: 'POST', ...json(input) }), onSuccess: () => invalidateReviewData(client) }); }
export function useCreateReviewsBatchMutation() { const client = useQueryClient(); return useMutation({ mutationFn: (input: ReviewBatchCreate) => apiRequest<Sample[]>('/api/reviews/batch', { method: 'POST', ...json(input) }), onSuccess: () => invalidateReviewData(client) }); }
export function useUpdateSampleClassificationMutation() { const client = useQueryClient(); return useMutation({ mutationFn: ({ id, input }: { id: number; input: SampleClassificationUpdate }) => apiRequest<Sample>(`/api/samples/${id}/classification`, { method: 'PATCH', ...json(input) }), onSuccess: () => invalidateReviewData(client) }); }
export function usePreviewArchiveMutation() { return useMutation({ mutationFn: (input: ArchivePreviewRequest) => apiRequest<ArchivePreview>('/api/archives/preview', { method: 'POST', ...json(input) }) }); }
export function useSyncArchiveMutation() { const client = useQueryClient(); return useMutation({ mutationFn: (input: ArchiveSyncRequest) => apiRequest<Archive>('/api/archives/sync', { method: 'POST', ...json(input) }), onSuccess: () => invalidateReviewData(client) }); }
export function useCancelJobMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<JobDetail>(`/api/jobs/${id}/cancel`, { method: 'POST', ...json({ expectedRevision }) }), onSuccess: async value => { setJobDetailData(client, value); await invalidateJobAuthority(client, value.id); } });
}
