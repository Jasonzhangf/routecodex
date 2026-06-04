import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';

export function isAdapterClientDisconnected(adapterContext: AdapterContext): boolean {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return false;
  }
  const state = (adapterContext as { clientConnectionState?: unknown }).clientConnectionState;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const disconnected = (state as { disconnected?: unknown }).disconnected;
    if (disconnected === true) {
      return true;
    }
    if (typeof disconnected === 'string' && disconnected.trim().toLowerCase() === 'true') {
      return true;
    }
  }
  const raw = (adapterContext as { clientDisconnected?: unknown }).clientDisconnected;
  if (raw === true) {
    return true;
  }
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'true') {
    return true;
  }
  return false;
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  buildError: () => Error
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timer: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(buildError()), timeoutMs);
    promise.then(resolve, reject).finally(() => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    });
  });
}

class ServerToolClientDisconnectedError extends Error {
  code = 'SERVERTOOL_CLIENT_DISCONNECTED';
}

export function createServerToolClientDisconnectedError(options: {
  requestId: string;
  flowId?: string;
}): Error {
  const error = new ServerToolClientDisconnectedError(
    `[servertool] client disconnected during followup` + (options.flowId ? ` flow=${options.flowId}` : '')
  );
  (error as unknown as { details?: Record<string, unknown> }).details = {
    requestId: options.requestId,
    flowId: options.flowId
  };
  return error;
}

export function isServerToolClientDisconnectedError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      typeof (error as { code?: unknown }).code === 'string' &&
      (error as { code: string }).code === 'SERVERTOOL_CLIENT_DISCONNECTED'
  );
}

export function createClientDisconnectWatcher(options: {
  adapterContext: AdapterContext;
  requestId: string;
  flowId?: string;
  pollIntervalMs?: number;
}): { promise: Promise<never>; cancel: () => void } {
  const interval =
    typeof options.pollIntervalMs === 'number' && Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs > 0
      ? Math.max(20, Math.floor(options.pollIntervalMs))
      : 80;
  let timer: NodeJS.Timeout | undefined;
  let active = true;
  const cancel = () => {
    active = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const promise = new Promise<never>((_resolve, reject) => {
    const check = () => {
      if (!active) {
        return;
      }
      if (isAdapterClientDisconnected(options.adapterContext)) {
        cancel();
        reject(
          createServerToolClientDisconnectedError({
            requestId: options.requestId,
            flowId: options.flowId
          })
        );
        return;
      }
      timer = setTimeout(check, interval);
    };
    timer = setTimeout(check, interval);
  });
  return { promise, cancel };
}

export function isServerToolTimeoutError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      typeof (error as { code?: unknown }).code === 'string' &&
      (error as { code: string }).code === 'SERVERTOOL_TIMEOUT'
  );
}

export function createServerToolTimeoutError(options: {
  requestId: string;
  phase: 'engine' | 'followup';
  timeoutMs: number;
  flowId?: string;
  attempt?: number;
  maxAttempts?: number;
}): ProviderProtocolError & { status?: number } {
  const err = new ProviderProtocolError(
    `[servertool] ${options.phase} timeout after ${options.timeoutMs}ms` +
      (options.flowId ? ` flow=${options.flowId}` : ''),
    {
      code: 'SERVERTOOL_TIMEOUT',
      category: 'INTERNAL_ERROR',
      details: {
        requestId: options.requestId,
        phase: options.phase,
        flowId: options.flowId,
        timeoutMs: options.timeoutMs,
        attempt: options.attempt,
        maxAttempts: options.maxAttempts
      }
    }
  ) as ProviderProtocolError & { status?: number };
  err.status = 504;
  return err;
}

export function createStopMessageFetchFailedError(options: {
  requestId: string;
  reason: 'loop_limit';
  elapsedMs?: number;
  repeatCount?: number;
  attempt?: number;
  maxAttempts?: number;
}): ProviderProtocolError & { status?: number } {
  const err = new ProviderProtocolError('fetch failed: network error (stopMessage loop detected)', {
    code: 'SERVERTOOL_TIMEOUT',
    category: 'EXTERNAL_ERROR',
    details: {
      requestId: options.requestId,
      reason: options.reason,
      ...(typeof options.elapsedMs === 'number' && Number.isFinite(options.elapsedMs)
        ? { elapsedMs: Math.max(0, Math.floor(options.elapsedMs)) }
        : {}),
      ...(typeof options.repeatCount === 'number' && Number.isFinite(options.repeatCount)
        ? { repeatCount: Math.max(0, Math.floor(options.repeatCount)) }
        : {}),
      ...(typeof options.attempt === 'number' && Number.isFinite(options.attempt)
        ? { attempt: Math.max(1, Math.floor(options.attempt)) }
        : {}),
      ...(typeof options.maxAttempts === 'number' && Number.isFinite(options.maxAttempts)
        ? { maxAttempts: Math.max(1, Math.floor(options.maxAttempts)) }
        : {})
    }
  }) as ProviderProtocolError & { status?: number };
  err.status = 502;
  return err;
}
