import type { Locale } from '../types';

export type ApiErrorTransport = 'http' | 'network' | 'malformed';
export type ApiErrorRecovery = 'none' | 'reload' | 'retry' | 'confirmModelSwitch';
type ApiErrorKind = 'notFound' | 'revision' | 'reference' | 'gpu' | 'database' | 'renderer' | 'promptEnvelope' | 'promptEmpty' | 'promptJson' | 'promptDuplicateKey' | 'promptSchema' | 'displayName' | 'http' | 'network' | 'invalidInput' | 'modelSwitchConfirmationRequired' | 'unavailable';

const reloadCodes = new Set(['revision_conflict', 'referenced_resource_changed', 'gpu_state_changed']);
const referenceCodes = new Set(['referenced_resource_changed']);
const gpuCodes = new Set(['gpu_state_changed', 'gpu_unavailable', 'gpu_not_available']);
const rendererCodes = new Set(['renderer_not_configured', 'renderer_unavailable', 'renderer_execution_failed', 'renderer_output_invalid', 'model_service_unavailable', 'model_service_readiness_timeout']);

function recoveryFor(status: number, code: string): ApiErrorRecovery {
  if (code === 'model_switch_confirmation_required') return 'confirmModelSwitch';
  if (reloadCodes.has(code)) return 'reload';
  if (code === 'database_busy' || status === 0 || status >= 500) return 'retry';
  return 'none';
}

function kindFor(status: number, code: string): ApiErrorKind {
  if (code === 'model_switch_confirmation_required') return 'modelSwitchConfirmationRequired';
  if (code === 'invalid_prompt_envelope') return 'promptEnvelope';
  if (code === 'empty_prompt_content') return 'promptEmpty';
  if (code === 'invalid_prompt_json') return 'promptJson';
  if (code === 'duplicate_prompt_key') return 'promptDuplicateKey';
  if (code === 'invalid_prompt_schema') return 'promptSchema';
  if (code === 'invalid_display_name') return 'displayName';
  if (code === 'revision_conflict') return 'revision';
  if (referenceCodes.has(code)) return 'reference';
  if (gpuCodes.has(code)) return 'gpu';
  if (code === 'database_busy') return 'database';
  if (rendererCodes.has(code)) return 'renderer';
  if (status === 404) return 'notFound';
  if (status === 422) return 'invalidInput';
  if (status === 502 || status === 503) return 'http';
  if (status === 0) return 'network';
  return 'unavailable';
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly transport: ApiErrorTransport;
  readonly recovery: ApiErrorRecovery;
  readonly kind: ApiErrorKind;
  constructor(options: { status: number; code: string; message: string; details?: unknown; transport: ApiErrorTransport }) {
    super(options.message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details ?? null;
    this.transport = options.transport;
    this.recovery = recoveryFor(options.status, options.code);
    this.kind = kindFor(options.status, options.code);
  }
}

function responseJson(response: Response): Promise<{ parsed: true; value: unknown } | { parsed: false }> {
  return response.json().then(value => ({ parsed: true as const, value })).catch(() => ({ parsed: false as const }));
}

function canonicalError(value: unknown): { code: string; message: string; details: unknown } | null {
  if (typeof value !== 'object' || value === null) return null;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  return typeof candidate.code === 'string' && typeof candidate.message === 'string'
    ? { code: candidate.code, message: candidate.message, details: candidate.details ?? null }
    : null;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers } });
  } catch {
    throw new ApiError({ status: 0, code: 'network_error', message: 'The service could not be reached.', transport: 'network' });
  }
  if (!response.ok) {
    const parsed = await responseJson(response);
    const error = parsed.parsed ? canonicalError(parsed.value) : null;
    throw new ApiError(error ? { status: response.status, ...error, transport: 'http' } : { status: response.status, code: 'malformed_error_response', message: 'The service returned an invalid error response.', transport: 'malformed' });
  }
  if (response.status === 204) return undefined as T;
  const parsed = await responseJson(response);
  if (parsed.parsed) return parsed.value as T;
  throw new ApiError({ status: response.status, code: 'malformed_response', message: 'The service returned an invalid response.', transport: 'malformed' });
}

const messages: Record<Locale, Record<ApiErrorKind, string>> = {
  'en-US': {
    notFound: 'The requested record no longer exists.', revision: 'This record changed elsewhere. Reload it, then try again.', reference: 'A referenced record changed. Reload the form, then try again.', gpu: 'The selected GPU is no longer available. Reload GPU status and choose again.', database: 'The data store is busy. Try again shortly.', renderer: 'The renderer or model service is unavailable. Try again after it is ready.', promptEnvelope: 'The generation service returned an invalid response. Try again.', promptEmpty: 'The generation service returned no content. Try again.', promptJson: 'The generation service returned content that could not be read. Try again.', promptDuplicateKey: 'The generation service returned repeated fields. Try again.', promptSchema: 'The generation service returned missing or invalid fields. Try again.', displayName: 'Use a clear English name of 1 to 60 characters. Do not use import labels, slugs, statuses, or version tags.', http: 'The generation service is unavailable. Try again shortly.', network: 'The service could not be reached. Check the connection and try again.', invalidInput: 'Some fields need attention. Check the form and try again.', modelSwitchConfirmationRequired: 'The selected GPU has another model loaded. Confirm the model switch to submit.', unavailable: 'The service is unavailable. Try again shortly.',
  },
  'zh-CN': {
    notFound: '请求的记录已不存在。', revision: '记录已被其他操作修改。请重新加载后再试。', reference: '引用的记录已发生变化。请重新加载表单后再试。', gpu: '所选 GPU 已不可用。请刷新 GPU 状态后重新选择。', database: '数据存储正忙。请稍后再试。', renderer: '渲染器或模型服务不可用。请等待服务就绪后再试。', promptEnvelope: '生成服务返回了无效响应。请重试。', promptEmpty: '生成服务没有返回内容。请重试。', promptJson: '生成服务返回的内容无法读取。请重试。', promptDuplicateKey: '生成服务返回了重复字段。请重试。', promptSchema: '生成服务返回的字段缺失或有误。请重试。', displayName: '请输入 1 至 60 个字符的清晰英文名称。不要使用导入标记、短标识、状态值或版本号。', http: '生成服务暂时不可用。请稍后再试。', network: '无法连接服务。请检查网络后再试。', invalidInput: '部分字段需要修改。请检查表单后再试。', modelSwitchConfirmationRequired: '所选 GPU 已加载其他模型。请确认切换模型后再提交。', unavailable: '服务暂时不可用。请稍后再试。',
  },
};

export function apiErrorMessage(error: unknown, locale: Locale): string { return messages[locale][error instanceof ApiError ? error.kind : 'unavailable']; }
export function isModelSwitchConfirmationRequired(error: unknown): boolean { return error instanceof ApiError && error.code === 'model_switch_confirmation_required'; }
export function shouldReloadAfterApiError(error: unknown): boolean { return error instanceof ApiError && error.recovery === 'reload'; }
export function jobEventsWebSocketUrl(jobId: number, afterEventId: number): string { const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'; return `${scheme}//${window.location.host}/api/ws/jobs/${jobId}?${new URLSearchParams({ afterEventId: String(afterEventId) }).toString()}`; }
