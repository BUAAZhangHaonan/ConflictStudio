import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiRequest } from './client';
import type {
  Archive, ArchivePreview, ArchivePreviewRequest, ArchiveSyncRequest,
  BatchDraft, BatchDraftCreate, BatchDraftUpdate, BatchPreview,
  ContentScript, ContentScriptCreate, ContentScriptScenes, ContentScriptUpdate,
  Dataset, DatasetCreate, DatasetUpdate,
  GenerationAttempt, GpuSlot, Health, JobDetail, JobEvent, JobItem, JobSource,
  JobStatus, JobSummary, Page, PromptTemplate, PromptTemplateVersion,
  PromptTemplateVersionCreate, PromptTemplateVersionVerify,
  PromptTestCreate, Reviewer, ReviewerCreate,
  ResourceAssistantApplyRequest, ResourceAssistantApplyResult,
  ResourceAssistantProposal, ResourceAssistantProposeRequest,
  ReviewerRename, ReviewerStatistics, ReviewerStatisticsFilter,
  ReviewBatchSubmissionCreate, ReviewDecision,
  ReviewNoteDraftRead, ReviewNoteDraftUpdate, ReviewQueue, ReviewResultRead, ReviewSampleDetailRead,
  ReviewSampleListRead, ReviewSubmissionCreate, ReviewSubmissionRead,
  SampleClassificationConversionUpdate,
  Scene, SceneCreate, SceneUpdate, VideoTestCreate,
} from './contracts';

export interface DatasetQueryFilter {
  search?: string;
  status?: Dataset['status'];
}

export interface ContentScriptQueryFilter {
  search?: string;
  status?: ContentScript['status'];
  category?: ContentScript['category'];
  direction?: NonNullable<ContentScript['conflictDirection']>;
}

export interface ResultQueryFilter {
  statuses?: JobStatus[];
  source?: Exclude<JobSource, 'Production'>;
}

export interface SampleQueryFilter {
  decision?: ReviewDecision;
  datasetId?: number;
  protocol?: 'VA' | 'VT';
  search?: string;
}

export interface ReviewSampleListParams extends ReviewQueue {
  page: number;
}

const roots = {
  datasets: ['datasets'] as const,
  contentScripts: ['contentScripts'] as const,
  promptTemplates: ['promptTemplates'] as const,
  scenes: ['scenes'] as const,
  testResults: ['testResults'] as const,
  productionResults: ['productionResults'] as const,
  jobs: ['jobs'] as const,
  reviewers: ['reviewers'] as const,
  archives: ['archives'] as const,
  samples: ['samples'] as const,
  reviewSamples: ['reviewSamples'] as const,
  reviewNoteDrafts: ['reviewNoteDrafts'] as const,
  reviewHistory: ['reviewHistory'] as const,
};

export const queryKeys = {
  ...roots,
  datasetsPage: (filter: DatasetQueryFilter, page: number) => [...roots.datasets, filter, page] as const,
  dataset: (id: number) => [...roots.datasets, 'detail', id] as const,
  contentScriptsPage: (filter: ContentScriptQueryFilter, page: number) => [...roots.contentScripts, filter, page] as const,
  contentScript: (id: number) => [...roots.contentScripts, 'detail', id] as const,
  contentScenes: (id: number) => [...roots.contentScripts, id, 'scenes'] as const,
  promptTemplatesPage: (page: number) => [...roots.promptTemplates, page] as const,
  promptTemplateVersionsPage: (templateId: number, page: number) => [...roots.promptTemplates, templateId, 'versions', page] as const,
  promptTemplateVersion: (id: number) => [...roots.promptTemplates, 'version', id] as const,
  scenesPage: (page: number) => [...roots.scenes, page] as const,
  scene: (id: number) => [...roots.scenes, 'detail', id] as const,
  testResultsPage: (filter: ResultQueryFilter, page: number) => [...roots.testResults, filter, page] as const,
  productionResultsPage: (filter: ResultQueryFilter, page: number) => [...roots.productionResults, filter, page] as const,
  job: (id: number) => [...roots.jobs, 'detail', id] as const,
  jobItems: (id: number, page: number) => [...roots.jobs, 'detail', id, 'items', page] as const,
  jobAttempts: (itemId: number, page: number) => ['jobItems', itemId, 'attempts', page] as const,
  jobEvents: (id: number, page: number) => [...roots.jobs, 'detail', id, 'events', page] as const,
  gpuSlots: ['gpuSlots'] as const,
  health: ['health'] as const,
  reviewersPage: (page: number) => [...roots.reviewers, 'page', page] as const,
  reviewer: (id: number) => [...roots.reviewers, 'detail', id] as const,
  reviewerStatistics: (reviewerId: number, filter: ReviewerStatisticsFilter) => ['reviewerStatistics', reviewerId, filter] as const,
  archivesPage: (page: number) => [...roots.archives, page] as const,
  samplesPage: (filter: SampleQueryFilter, page: number) => [...roots.samples, filter, page] as const,
  reviewSamplesPage: (params: ReviewSampleListParams) => [...roots.reviewSamples, 'list', params] as const,
  reviewSampleDetail: (id: number) => [...roots.reviewSamples, 'detail', id] as const,
  reviewNoteDraft: (sampleId: number, reviewerId: number, sampleRevision: number) => [...roots.reviewNoteDrafts, sampleId, reviewerId, sampleRevision] as const,
  reviewHistoryPage: (sampleId: number, page: number) => [...roots.reviewHistory, sampleId, page] as const,
};

function pagePath(path: string, page: number, params = new URLSearchParams()): string {
  params.set('page', String(page));
  return path + '?' + params.toString();
}

function resultParams(filter: ResultQueryFilter): URLSearchParams {
  const params = new URLSearchParams();
  filter.statuses?.forEach(status => params.append('status', status));
  if (filter.source !== undefined) params.set('source', filter.source);
  return params;
}

export function reviewSampleListPath(input: ReviewSampleListParams): string {
  const params = new URLSearchParams();
  if (input.search?.trim()) params.set('search', input.search.trim());
  if (input.datasetId !== null) params.set('datasetId', String(input.datasetId));
  params.set('decision', input.decision);
  if (input.protocol !== null) params.set('protocol', input.protocol);
  if (input.relation !== null) params.set('relation', input.relation);
  if (input.direction !== null) params.set('direction', input.direction);
  params.set('page', String(input.page));
  return `/api/samples?${params.toString()}`;
}

export const reviewSampleQueries = {
  list: (params: ReviewSampleListParams) => queryOptions({
    queryKey: queryKeys.reviewSamplesPage(params),
    queryFn: () => apiRequest<Page<ReviewSampleListRead>>(reviewSampleListPath(params)),
  }),
  detail: (id: number) => queryOptions({
    queryKey: queryKeys.reviewSampleDetail(id),
    queryFn: () => apiRequest<ReviewSampleDetailRead>(`/api/samples/${id}`),
  }),
  note: (sampleId: number, reviewerId: number, sampleRevision: number) => queryOptions({
    queryKey: queryKeys.reviewNoteDraft(sampleId, reviewerId, sampleRevision),
    queryFn: () => apiRequest<ReviewNoteDraftRead>(`/api/samples/${sampleId}/review-note-draft?${new URLSearchParams({ reviewerId: String(reviewerId) }).toString()}`),
  }),
  history: (sampleId: number, page: number) => queryOptions({
    queryKey: queryKeys.reviewHistoryPage(sampleId, page),
    queryFn: () => apiRequest<Page<ReviewResultRead>>(`/api/reviews?${new URLSearchParams({ sampleId: String(sampleId), page: String(page) }).toString()}`),
  }),
};

export const generationQueries = {
  datasets: (page: number, filter: DatasetQueryFilter = {}) => {
    const params = new URLSearchParams();
    if (filter.search?.trim()) params.set('search', filter.search.trim());
    if (filter.status !== undefined) params.set('status', filter.status);
    return queryOptions({ queryKey: queryKeys.datasetsPage(filter, page), queryFn: () => apiRequest<Page<Dataset>>(pagePath('/api/datasets', page, params)) });
  },
  dataset: (id: number) => queryOptions({ queryKey: queryKeys.dataset(id), queryFn: () => apiRequest<Dataset>('/api/datasets/' + id) }),
  contentScripts: (page: number, filter: ContentScriptQueryFilter = {}) => {
    const params = new URLSearchParams();
    if (filter.search?.trim()) params.set('search', filter.search.trim());
    if (filter.status !== undefined) params.set('status', filter.status);
    if (filter.category !== undefined) params.set('category', filter.category);
    if (filter.direction !== undefined) params.set('direction', filter.direction);
    return queryOptions({ queryKey: queryKeys.contentScriptsPage(filter, page), queryFn: () => apiRequest<Page<ContentScript>>(pagePath('/api/content-scripts', page, params)) });
  },
  contentScript: (id: number) => queryOptions({ queryKey: queryKeys.contentScript(id), queryFn: () => apiRequest<ContentScript>('/api/content-scripts/' + id) }),
  contentScenes: (id: number) => queryOptions({ queryKey: queryKeys.contentScenes(id), queryFn: () => apiRequest<ContentScriptScenes>('/api/content-scripts/' + id + '/scenes') }),
  promptTemplates: (page: number) => queryOptions({ queryKey: queryKeys.promptTemplatesPage(page), queryFn: () => apiRequest<Page<PromptTemplate>>(pagePath('/api/prompt-templates', page)) }),
  promptTemplateVersions: (templateId: number, page: number) => queryOptions({ queryKey: queryKeys.promptTemplateVersionsPage(templateId, page), queryFn: () => apiRequest<Page<PromptTemplateVersion>>(pagePath('/api/prompt-templates/' + templateId + '/versions', page)) }),
  promptTemplateVersion: (id: number) => queryOptions({ queryKey: queryKeys.promptTemplateVersion(id), queryFn: () => apiRequest<PromptTemplateVersion>('/api/prompt-template-versions/' + id) }),
  scenes: (page: number) => queryOptions({ queryKey: queryKeys.scenesPage(page), queryFn: () => apiRequest<Page<Scene>>(pagePath('/api/scenes', page)) }),
  scene: (id: number) => queryOptions({ queryKey: queryKeys.scene(id), queryFn: () => apiRequest<Scene>('/api/scenes/' + id) }),
  testResults: (page: number, filter: ResultQueryFilter = {}) => queryOptions({ queryKey: queryKeys.testResultsPage(filter, page), queryFn: () => apiRequest<Page<JobSummary>>(pagePath('/api/test-results', page, resultParams(filter))) }),
  productionResults: (page: number, filter: ResultQueryFilter = {}) => queryOptions({ queryKey: queryKeys.productionResultsPage(filter, page), queryFn: () => apiRequest<Page<JobSummary>>(pagePath('/api/generation-results', page, resultParams(filter))) }),
  testResult: (id: number) => queryOptions({ queryKey: queryKeys.job(id), queryFn: () => apiRequest<JobDetail>('/api/test-results/' + id) }),
  productionResult: (id: number) => queryOptions({ queryKey: queryKeys.job(id), queryFn: () => apiRequest<JobDetail>('/api/generation-results/' + id) }),
  resultItems: (kind: 'test' | 'production', id: number, page: number) => queryOptions({ queryKey: queryKeys.jobItems(id, page), queryFn: () => apiRequest<Page<JobItem>>(pagePath((kind === 'test' ? '/api/test-results/' : '/api/generation-results/') + id + '/items', page)) }),
  jobAttempts: (itemId: number, page: number) => queryOptions({ queryKey: queryKeys.jobAttempts(itemId, page), queryFn: () => apiRequest<Page<GenerationAttempt>>(pagePath('/api/job-items/' + itemId + '/attempts', page)) }),
  jobEvents: (id: number, page: number) => queryOptions({ queryKey: queryKeys.jobEvents(id, page), queryFn: () => apiRequest<Page<JobEvent>>(pagePath('/api/jobs/' + id + '/events', page)) }),
  gpuSlots: () => queryOptions({ queryKey: queryKeys.gpuSlots, queryFn: () => apiRequest<GpuSlot[]>('/api/gpu-slots'), refetchOnWindowFocus: true }),
  health: () => queryOptions({ queryKey: queryKeys.health, queryFn: () => apiRequest<Health>('/api/health') }),
  reviewers: (page: number) => queryOptions({ queryKey: queryKeys.reviewersPage(page), queryFn: () => apiRequest<Page<Reviewer>>(pagePath('/api/reviewers', page)) }),
  reviewer: (id: number) => queryOptions({ queryKey: queryKeys.reviewer(id), queryFn: () => apiRequest<Reviewer>('/api/reviewers/' + id) }),
  reviewerStatistics: (reviewerId: number, filter: ReviewerStatisticsFilter) => {
    const params = new URLSearchParams();
    if (filter.datasetId !== undefined) params.set('datasetId', String(filter.datasetId));
    if (filter.startDate !== undefined) params.set('startDate', filter.startDate);
    if (filter.endDate !== undefined) params.set('endDate', filter.endDate);
    return queryOptions({ queryKey: queryKeys.reviewerStatistics(reviewerId, filter), queryFn: () => apiRequest<ReviewerStatistics>('/api/reviewers/' + reviewerId + '/statistics' + (params.size ? '?' + params.toString() : '')) });
  },
  archives: (page: number) => queryOptions({ queryKey: queryKeys.archivesPage(page), queryFn: () => apiRequest<Page<Archive>>(pagePath('/api/archives', page)) }),
  samples: (filter: SampleQueryFilter, page: number) => {
    const params = new URLSearchParams();
    if (filter.decision !== undefined) params.set('decision', filter.decision);
    if (filter.datasetId !== undefined) params.set('datasetId', String(filter.datasetId));
    if (filter.protocol !== undefined) params.set('protocol', filter.protocol);
    if (filter.search?.trim()) params.set('search', filter.search.trim());
    return queryOptions({ queryKey: queryKeys.samplesPage(filter, page), queryFn: () => apiRequest<Page<ReviewSampleListRead>>(pagePath('/api/samples', page, params)) });
  },
};

function json(value: unknown): RequestInit { return { body: JSON.stringify(value) }; }
async function invalidateCatalog(client: QueryClient, key: readonly unknown[]): Promise<void> { await client.invalidateQueries({ queryKey: key }); }
export function setJobDetailData(client: QueryClient, value: JobDetail): void { client.setQueryData(queryKeys.job(value.id), value); }

export async function invalidateJobAuthority(client: QueryClient, id: number, includeEvents = true): Promise<void> {
  const invalidations = [
    client.invalidateQueries({ queryKey: roots.testResults }),
    client.invalidateQueries({ queryKey: roots.productionResults }),
    client.invalidateQueries({ queryKey: queryKeys.job(id), exact: true }),
    client.invalidateQueries({ queryKey: [...roots.jobs, 'detail', id, 'items'] }),
    client.invalidateQueries({ queryKey: queryKeys.gpuSlots, exact: true }),
  ];
  if (includeEvents) invalidations.push(client.invalidateQueries({ queryKey: [...roots.jobs, 'detail', id, 'events'] }));
  await Promise.all(invalidations);
}

export function useDatasetsQuery(page = 1, filter: DatasetQueryFilter = {}) { return useQuery(generationQueries.datasets(page, filter)); }
export function useDatasetQuery(id: number | null) { return useQuery({ ...generationQueries.dataset(id ?? 0), enabled: id !== null }); }
export function useContentScriptsQuery(page = 1, filter: ContentScriptQueryFilter = {}) { return useQuery(generationQueries.contentScripts(page, filter)); }
export function useContentScriptQuery(id: number | null) { return useQuery({ ...generationQueries.contentScript(id ?? 0), enabled: id !== null }); }
export function useContentScenesQuery(id: number | null) { return useQuery({ ...generationQueries.contentScenes(id ?? 0), enabled: id !== null }); }
export function usePromptTemplatesQuery(page = 1) { return useQuery(generationQueries.promptTemplates(page)); }
export function usePromptTemplateVersionsQuery(templateId: number | null, page = 1) { return useQuery({ ...generationQueries.promptTemplateVersions(templateId ?? 0, page), enabled: templateId !== null }); }
export function usePromptTemplateVersionQuery(id: number | null) { return useQuery({ ...generationQueries.promptTemplateVersion(id ?? 0), enabled: id !== null }); }
export function useScenesQuery(page = 1) { return useQuery(generationQueries.scenes(page)); }
export function useSceneQuery(id: number | null) { return useQuery({ ...generationQueries.scene(id ?? 0), enabled: id !== null }); }
export function useTestResultsQuery(page = 1, filter: ResultQueryFilter = {}) { return useQuery(generationQueries.testResults(page, filter)); }
export function useProductionResultsQuery(page = 1, filter: ResultQueryFilter = {}) { return useQuery(generationQueries.productionResults(page, filter)); }
export function useTestResultQuery(id: number | null) { return useQuery({ ...generationQueries.testResult(id ?? 0), enabled: id !== null }); }
export function useProductionResultQuery(id: number | null) { return useQuery({ ...generationQueries.productionResult(id ?? 0), enabled: id !== null }); }
export function useResultItemsQuery(kind: 'test' | 'production', id: number | null, page = 1) { return useQuery({ ...generationQueries.resultItems(kind, id ?? 0, page), enabled: id !== null }); }
export function useJobAttemptsQuery(itemId: number | null, page = 1) { return useQuery({ ...generationQueries.jobAttempts(itemId ?? 0, page), enabled: itemId !== null }); }
export function useJobEventsQuery(id: number | null, page = 1) { return useQuery({ ...generationQueries.jobEvents(id ?? 0, page), enabled: id !== null }); }
export function useGpuSlotsQuery() { return useQuery(generationQueries.gpuSlots()); }
export function useHealthQuery() { return useQuery(generationQueries.health()); }
export function useReviewersQuery(page = 1) { return useQuery(generationQueries.reviewers(page)); }
export function useReviewerQuery(id: number | null, enabled = true) { return useQuery({ ...generationQueries.reviewer(id ?? 0), enabled: enabled && id !== null }); }
export function useArchivesQuery(page = 1) { return useQuery(generationQueries.archives(page)); }
export function useSamplesQuery(filter: SampleQueryFilter = {}, page = 1) { return useQuery(generationQueries.samples(filter, page)); }
export function useReviewerStatisticsQuery(reviewerId: number | null, filter: ReviewerStatisticsFilter) { return useQuery({ ...generationQueries.reviewerStatistics(reviewerId ?? 0, filter), enabled: reviewerId !== null && filter.startDate !== undefined && filter.endDate !== undefined }); }
export function useReviewSampleListQuery(params: ReviewSampleListParams, enabled = true) { return useQuery({ ...reviewSampleQueries.list(params), enabled }); }
export function useReviewSampleDetailQuery(id: number | null) { return useQuery({ ...reviewSampleQueries.detail(id ?? 0), enabled: id !== null }); }
export function useReviewNoteDraftQuery(sampleId: number | null, reviewerId: number | null, sampleRevision: number | null) { return useQuery({ ...reviewSampleQueries.note(sampleId ?? 0, reviewerId ?? 0, sampleRevision ?? 0), enabled: sampleId !== null && reviewerId !== null && sampleRevision !== null }); }
export function useReviewHistoryQuery(sampleId: number | null, page: number, enabled = true) { return useQuery({ ...reviewSampleQueries.history(sampleId ?? 0, page), enabled: enabled && sampleId !== null }); }

export function useReleaseGpuMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ slot, expectedRevision }: { slot: GpuSlot['slot']; expectedRevision: number }) => apiRequest<GpuSlot>('/api/gpu-slots/' + slot + '/release', { method: 'POST', ...json({ expectedRevision }) }), onSuccess: async () => { await client.invalidateQueries({ queryKey: queryKeys.gpuSlots }); } });
}
export function useCreateDatasetMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: DatasetCreate) => apiRequest<Dataset>('/api/datasets', { method: 'POST', ...json(input) }), onSuccess: () => invalidateCatalog(client, roots.datasets) });
}
export function useUpdateDatasetMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, input }: { id: number; input: DatasetUpdate }) => apiRequest<Dataset>('/api/datasets/' + id, { method: 'PATCH', ...json(input) }), onSuccess: () => invalidateCatalog(client, roots.datasets) });
}
export function useDeleteDatasetMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<void>('/api/datasets/' + id + '?expectedRevision=' + expectedRevision, { method: 'DELETE' }), onSuccess: () => invalidateCatalog(client, roots.datasets) });
}
export function useCreateContentScriptMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: ContentScriptCreate) => apiRequest<ContentScript>('/api/content-scripts', { method: 'POST', ...json(input) }), onSuccess: async value => { client.setQueryData(queryKeys.contentScript(value.id), value); await invalidateCatalog(client, roots.contentScripts); } });
}
export function useUpdateContentScriptMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, input }: { id: number; input: ContentScriptUpdate }) => apiRequest<ContentScript>('/api/content-scripts/' + id, { method: 'PATCH', ...json(input) }), onSuccess: async value => { client.setQueryData(queryKeys.contentScript(value.id), value); await invalidateCatalog(client, roots.contentScripts); } });
}
export function useCreateSceneMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: SceneCreate) => apiRequest<Scene>('/api/scenes', { method: 'POST', ...json(input) }), onSuccess: async value => { client.setQueryData(queryKeys.scene(value.id), value); await invalidateCatalog(client, roots.scenes); } });
}
export function useUpdateSceneMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, input }: { id: number; input: SceneUpdate }) => apiRequest<Scene>('/api/scenes/' + id, { method: 'PATCH', ...json(input) }), onSuccess: async value => { client.setQueryData(queryKeys.scene(value.id), value); await Promise.all([invalidateCatalog(client, roots.scenes), invalidateCatalog(client, roots.contentScripts)]); } });
}
export function useCreatePromptTemplateVersionMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ templateId, input }: { templateId: number; input: PromptTemplateVersionCreate }) => apiRequest<PromptTemplateVersion>('/api/prompt-templates/' + templateId + '/versions', { method: 'POST', ...json(input) }), onSuccess: async value => { client.setQueryData(queryKeys.promptTemplateVersion(value.id), value); await invalidateCatalog(client, roots.promptTemplates); } });
}
export function useVerifyPromptTemplateVersionMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, input }: { id: number; input: PromptTemplateVersionVerify }) => apiRequest<PromptTemplateVersion>('/api/prompt-template-versions/' + id + '/verify', { method: 'POST', ...json(input) }), onSuccess: async value => { client.setQueryData(queryKeys.promptTemplateVersion(value.id), value); await invalidateCatalog(client, roots.promptTemplates); } });
}
export function useSaveBatchDraftMutation() {
  return useMutation({ mutationFn: ({ id, input }: { id: number | null; input: BatchDraftCreate | BatchDraftUpdate }) => id === null ? apiRequest<BatchDraft>('/api/batch-drafts', { method: 'POST', ...json(input) }) : apiRequest<BatchDraft>('/api/batch-drafts/' + id, { method: 'PUT', ...json(input) }) });
}
export function usePreviewBatchMutation() { return useMutation({ mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<BatchPreview>('/api/batch-drafts/' + id + '/preview', { method: 'POST', ...json({ expectedRevision }) }) }); }
export function useSubmitBatchMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, expectedRevision, expectedGpuRevisions, confirmModelSwitch }: { id: number; expectedRevision: number; expectedGpuRevisions: Record<string, number>; confirmModelSwitch: boolean }) => apiRequest<JobDetail>('/api/batch-drafts/' + id + '/submit', { method: 'POST', ...json({ expectedRevision, expectedGpuRevisions, confirmModelSwitch }) }), onSuccess: async value => { setJobDetailData(client, value); await Promise.all([invalidateCatalog(client, roots.productionResults), invalidateCatalog(client, queryKeys.gpuSlots)]); } });
}
export function useSubmitPromptTestMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: PromptTestCreate) => apiRequest<JobDetail>('/api/test-runs/prompt', { method: 'POST', ...json(input) }), onSuccess: async value => { setJobDetailData(client, value); await invalidateCatalog(client, roots.testResults); } });
}
export function useSubmitVideoTestMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: VideoTestCreate) => apiRequest<JobDetail>('/api/test-runs/video', { method: 'POST', ...json(input) }), onSuccess: async value => { setJobDetailData(client, value); await Promise.all([invalidateCatalog(client, roots.testResults), invalidateCatalog(client, queryKeys.gpuSlots)]); } });
}
export function useProposeResourceAssistantMutation() {
  return useMutation({ mutationFn: (input: ResourceAssistantProposeRequest) => apiRequest<ResourceAssistantProposal>('/api/resource-assistant/propose', { method: 'POST', ...json(input) }) });
}
export function useApplyResourceAssistantMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: ResourceAssistantApplyRequest) => apiRequest<ResourceAssistantApplyResult>('/api/resource-assistant/apply', { method: 'POST', ...json(input) }), onSuccess: async value => { client.setQueryData(queryKeys.contentScript(value.contentScript.id), value.contentScript); for (const scene of value.scenes) client.setQueryData(queryKeys.scene(scene.id), scene); client.setQueryData(queryKeys.promptTemplateVersion(value.promptTemplateVersion.id), value.promptTemplateVersion); await Promise.all([invalidateCatalog(client, roots.contentScripts), invalidateCatalog(client, roots.scenes), invalidateCatalog(client, roots.promptTemplates)]); } });
}

async function invalidateReviewData(client: QueryClient): Promise<void> {
  await Promise.all([client.invalidateQueries({ queryKey: roots.samples }), client.invalidateQueries({ queryKey: roots.reviewSamples }), client.invalidateQueries({ queryKey: roots.reviewNoteDrafts }), client.invalidateQueries({ queryKey: roots.reviewHistory }), client.invalidateQueries({ queryKey: ['reviewerStatistics'] }), client.invalidateQueries({ queryKey: roots.archives })]);
}
export function useCreateReviewerMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: ReviewerCreate) => apiRequest<Reviewer>('/api/reviewers', { method: 'POST', ...json(input) }), onSuccess: () => invalidateCatalog(client, roots.reviewers) });
}
export function useRenameReviewerMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, input }: { id: number; input: ReviewerRename }) => apiRequest<Reviewer>('/api/reviewers/' + id, { method: 'PATCH', ...json(input) }), onSuccess: () => invalidateCatalog(client, roots.reviewers) });
}
export function usePutReviewNoteDraftMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ sampleId, input }: { sampleId: number; input: ReviewNoteDraftUpdate }) => apiRequest<ReviewNoteDraftRead>(`/api/samples/${sampleId}/review-note-draft`, { method: 'PUT', ...json(input) }),
    onSuccess: value => { client.setQueryData(queryKeys.reviewNoteDraft(value.sampleId, value.reviewerId, value.sampleRevision), value); },
  });
}
export function useSubmitReviewMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewSubmissionCreate) => apiRequest<ReviewSubmissionRead>('/api/reviews', { method: 'POST', ...json(input) }),
    onSuccess: async value => { client.setQueryData(queryKeys.reviewSampleDetail(value.id), value); await invalidateReviewData(client); },
  });
}
export function useSubmitReviewBatchMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewBatchSubmissionCreate) => apiRequest<ReviewSampleDetailRead[]>('/api/reviews/batch', { method: 'POST', ...json(input) }),
    onSuccess: async values => { values.forEach(value => client.setQueryData(queryKeys.reviewSampleDetail(value.id), value)); await invalidateReviewData(client); },
  });
}
export function useConvertSampleClassificationMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ sampleId, input }: { sampleId: number; input: SampleClassificationConversionUpdate }) => apiRequest<ReviewSampleDetailRead>(`/api/samples/${sampleId}/classification`, { method: 'PATCH', ...json(input) }),
    onSuccess: async (value, variables) => {
      client.removeQueries({ queryKey: queryKeys.reviewNoteDraft(value.id, variables.input.reviewerId, variables.input.expectedRevision), exact: true });
      client.setQueryData(queryKeys.reviewSampleDetail(value.id), value);
      await invalidateReviewData(client);
    },
  });
}
export function usePreviewArchiveMutation() { return useMutation({ mutationFn: (input: ArchivePreviewRequest) => apiRequest<ArchivePreview>('/api/archives/preview', { method: 'POST', ...json(input) }) }); }
export function useSyncArchiveMutation() { const client = useQueryClient(); return useMutation({ mutationFn: (input: ArchiveSyncRequest) => apiRequest<Archive>('/api/archives/sync', { method: 'POST', ...json(input) }), onSuccess: () => invalidateReviewData(client) }); }
export function useCancelJobMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<JobDetail>('/api/jobs/' + id + '/cancel', { method: 'POST', ...json({ expectedRevision }) }), onSuccess: async value => { setJobDetailData(client, value); await invalidateJobAuthority(client, value.id); } });
}
export function useResumeJobMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, expectedRevision }: { id: number; expectedRevision: number }) => apiRequest<JobDetail>('/api/jobs/' + id + '/resume', { method: 'POST', ...json({ expectedRevision }) }), onSuccess: async value => { setJobDetailData(client, value); await invalidateJobAuthority(client, value.id); } });
}
export function useRetryFailedItemsMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, expectedRevision, itemRevisions }: { id: number; expectedRevision: number; itemRevisions: Record<string, number> }) => apiRequest<JobDetail>('/api/jobs/' + id + '/retry-failed', { method: 'POST', ...json({ expectedRevision, itemRevisions }) }), onSuccess: async value => { setJobDetailData(client, value); await invalidateJobAuthority(client, value.id); } });
}
