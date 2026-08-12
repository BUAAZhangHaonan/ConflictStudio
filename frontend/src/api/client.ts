import type { Locale } from '../types';

type ApiErrorKind =
  | 'notFound'
  | 'conflict'
  | 'invalidInput'
  | 'modelSwitchConfirmationRequired'
  | 'unavailable';

interface ErrorEnvelope {
  error?: {
    code?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly kind: ApiErrorKind;

  constructor(status: number, kind: ApiErrorKind) {
    super(kind);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
  }
}

function errorKind(status: number, body: unknown): ApiErrorKind {
  const code = typeof body === 'object' && body !== null
    ? (body as ErrorEnvelope).error?.code
    : undefined;
  if (status === 409 && code === 'model_switch_confirmation_required') {
    return 'modelSwitchConfirmationRequired';
  }
  if (status === 404) return 'notFound';
  if (status === 409) return 'conflict';
  if (status === 422) return 'invalidInput';
  return 'unavailable';
}

async function errorBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'unavailable');
  }
  if (!response.ok) throw new ApiError(response.status, errorKind(response.status, await errorBody(response)));
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch {
    throw new ApiError(0, 'unavailable');
  }
}

const messages = {
  'en-US': {
    notFound: 'The requested record no longer exists.',
    conflict: 'This record changed. Reload it before trying again.',
    invalidInput: 'Some fields need attention. Check the form and try again.',
    modelSwitchConfirmationRequired: 'The selected GPU has another model loaded. Confirm the model switch to submit.',
    unavailable: 'The service is unavailable. Try again shortly.',
  },
  'zh-CN': {
    notFound: '请求的记录已不存在。',
    conflict: '这条记录已发生变化。请重新加载后再试。',
    invalidInput: '部分字段需要修改。请检查表单后再试。',
    modelSwitchConfirmationRequired: '所选 GPU 已加载其他模型。请确认切换模型后提交。',
    unavailable: '服务暂时不可用，请稍后再试。',
  },
} as const;

export function apiErrorMessage(error: unknown, locale: Locale): string {
  const kind = error instanceof ApiError ? error.kind : 'unavailable';
  return messages[locale][kind];
}

export function isModelSwitchConfirmationRequired(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'modelSwitchConfirmationRequired';
}

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && [404, 409, 422].includes(error.status)) return false;
  return failureCount < 1;
}

export function jobEventsWebSocketUrl(jobId: number, afterEventId: number): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = new URLSearchParams({ afterEventId: String(afterEventId) });
  return `${scheme}//${window.location.host}/api/ws/jobs/${jobId}?${query.toString()}`;
}
