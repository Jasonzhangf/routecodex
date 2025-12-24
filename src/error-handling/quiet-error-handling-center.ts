import { ErrorHandlingCenter, type ErrorContext, type ErrorResponse } from 'rcc-errorhandling';
import { truncateForConsole } from '../utils/log-helpers.js';

type InternalStateKeys = '_isInitialized' | 'errorCount' | 'startTime';

function ensureBaseState(instance: ErrorHandlingCenter): Record<string, unknown> & {
  _isInitialized: boolean;
  errorCount: number;
  startTime: number;
} {
  const bag = instance as unknown as Record<string, unknown> & Partial<Record<InternalStateKeys, unknown>>;
  if (typeof bag._isInitialized !== 'boolean') {
    bag._isInitialized = false;
  }
  if (typeof bag.errorCount !== 'number') {
    bag.errorCount = 0;
  }
  if (typeof bag.startTime !== 'number') {
    bag.startTime = Date.now();
  }
  return bag as Record<string, unknown> & { _isInitialized: boolean; errorCount: number; startTime: number };
}

function extractRequestId(payload?: Record<string, unknown>): string | undefined {
  if (!payload) {
    return undefined;
  }
  const candidates = [
    payload.requestId,
    payload.clientRequestId,
    payload.providerRequestId,
    payload.internalRequestId
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function extractDetails(context: ErrorContext): {
  requestId?: string;
  endpoint?: string;
  status?: number;
  code?: string;
  rawError?: string;
  rawErrorSnippet?: string;
} {
  const errorObject = asRecord(context.error);
  const payload = asRecord(context.context);
  const details = asRecord(payload?.details);
  const status = typeof details?.status === 'number'
    ? details.status
    : typeof (errorObject?.statusCode) === 'number'
      ? (errorObject!.statusCode as number)
      : typeof (errorObject?.status) === 'number'
        ? (errorObject!.status as number)
        : undefined;
  const code = typeof details?.code === 'string'
    ? details.code
    : typeof errorObject?.code === 'string'
      ? errorObject.code
      : undefined;
  const endpoint = typeof payload?.endpoint === 'string'
    ? payload.endpoint
    : typeof errorObject?.endpoint === 'string'
      ? errorObject.endpoint
      : undefined;
  const requestId =
    extractRequestId(payload) ??
    (typeof errorObject?.requestId === 'string' ? errorObject.requestId : undefined) ??
    (typeof details?.requestId === 'string' ? details.requestId : undefined);
  const rawError = typeof errorObject?.rawError === 'string' ? errorObject.rawError : undefined;
  const rawErrorSnippet = typeof errorObject?.rawErrorSnippet === 'string' ? errorObject.rawErrorSnippet : undefined;
  return {
    requestId,
    endpoint,
    status,
    code,
    rawError,
    rawErrorSnippet
  };
}

export class QuietErrorHandlingCenter extends ErrorHandlingCenter {
  public override async initialize(): Promise<void> {
    const state = ensureBaseState(this);
    if (state._isInitialized) {
      return;
    }
    state._isInitialized = true;
    state.startTime = Date.now();
  }

  public override async handleError(errorContext: ErrorContext): Promise<ErrorResponse> {
    const state = ensureBaseState(this);
    if (!state._isInitialized) {
      await this.initialize();
    }
    state.errorCount += 1;
    const errorId = `error_${state.errorCount}_${Date.now()}`;
    const details = extractDetails(errorContext);
    const message =
      typeof errorContext.error === 'string'
        ? errorContext.error
        : errorContext.error instanceof Error
          ? errorContext.error.message
          : typeof (errorContext.error as Record<string, unknown>)?.message === 'string'
            ? String((errorContext.error as Record<string, unknown>).message)
            : 'Unknown error';
    const snippet = truncateForConsole(message, 500);
    const payload = {
      errorId,
      status: details.status,
      code: details.code,
      message: snippet,
      requestId: details.requestId,
      endpoint: details.endpoint,
      rawErrorSnippet: details.rawErrorSnippet,
      source: errorContext.source,
      severity: errorContext.severity
    };
    console.error('[route-error]', JSON.stringify(payload));
    const response: ErrorResponse = {
      success: true,
      message: `Error processed: ${message}`,
      actionTaken: 'logged',
      timestamp: Date.now(),
      errorId
    };
    return response;
  }

  public override handleErrorAsync(error: ErrorContext): void {
    void this.handleError(error);
  }

  public override async handleBatchErrors(errors: ErrorContext[]): Promise<ErrorResponse[]> {
    const results: ErrorResponse[] = [];
    for (const error of errors) {
      // eslint-disable-next-line no-await-in-loop
      const response = await this.handleError(error);
      results.push(response);
    }
    return results;
  }

  public override resetErrorCount(): void {
    const state = ensureBaseState(this);
    state.errorCount = 0;
  }

  public override async destroy(): Promise<void> {
    const state = ensureBaseState(this);
    state._isInitialized = false;
  }
}
