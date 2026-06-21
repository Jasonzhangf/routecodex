import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import {
  ProviderProtocolError,
  type ProviderErrorCategory,
  type ProviderProtocolErrorCode
} from '../conversion/provider-protocol-error.js';
import {
  isAdapterClientDisconnectedWithNative,
  planClientDisconnectWatcherWithNative,
  planServertoolClientDisconnectedErrorWithNative,
  planServertoolRequiredResponseHookEmptyErrorWithNative,
  planServertoolStateLoadFailedErrorWithNative,
  planServertoolTimeoutErrorWithNative,
  planServertoolTimeoutWatcherWithNative,
  planStopMessageFetchFailedErrorWithNative,
  type ServertoolErrorPlan
} from '../native/router-hotpath/native-servertool-core-semantics.js';

export const SERVERTOOL_TIMEOUT_ERROR_FEATURE_ID = 'feature_id: hub.servertool_orchestration_policy';

export function isAdapterClientDisconnected(adapterContext: AdapterContext): boolean {
  return isAdapterClientDisconnectedWithNative(adapterContext);
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  buildError: () => Error
): Promise<T> {
  const plan = planServertoolTimeoutWatcherWithNative(timeoutMs);
  if (!plan.armed) {
    return promise;
  }
  let timer: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(buildError()), plan.timeoutMs);
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
  const plan = planServertoolClientDisconnectedErrorWithNative(options);
  const error = new ServerToolClientDisconnectedError(plan.message);
  (error as unknown as { details?: Record<string, unknown> }).details = plan.details;
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
  const plan = planClientDisconnectWatcherWithNative(options.pollIntervalMs);
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
      timer = setTimeout(check, plan.intervalMs);
    };
    timer = setTimeout(check, plan.intervalMs);
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
  return buildProviderProtocolError(planServertoolTimeoutErrorWithNative(options));
}

export function createStopMessageFetchFailedError(options: {
  requestId: string;
  reason: 'loop_limit';
  elapsedMs?: number;
  repeatCount?: number;
  attempt?: number;
  maxAttempts?: number;
}): ProviderProtocolError & { status?: number } {
  return buildProviderProtocolError(planStopMessageFetchFailedErrorWithNative(options));
}

export function createServertoolStateLoadFailedError(options: {
  requestId: string;
  stickyKey: string;
  entryEndpoint: string;
  providerProtocol: string;
  error: string;
}): ProviderProtocolError & { status?: number } {
  return buildProviderProtocolError(planServertoolStateLoadFailedErrorWithNative(options));
}

export function createServertoolRequiredResponseHookEmptyError(options: {
  requestId: string;
  responseHookName: string;
}): ProviderProtocolError & { status?: number } {
  return buildProviderProtocolError(
    planServertoolRequiredResponseHookEmptyErrorWithNative(options)
  );
}

export function createServertoolProviderProtocolErrorFromPlan(
  plan: ServertoolErrorPlan
): ProviderProtocolError & { status?: number } {
  return buildProviderProtocolError(plan);
}

function buildProviderProtocolError(plan: ServertoolErrorPlan): ProviderProtocolError & { status?: number } {
  const err = new ProviderProtocolError(plan.message, {
    code: plan.code as ProviderProtocolErrorCode,
    category: plan.category as ProviderErrorCategory,
    details: plan.details
  }) as ProviderProtocolError & { status?: number };
  err.status = plan.status;
  return err;
}
