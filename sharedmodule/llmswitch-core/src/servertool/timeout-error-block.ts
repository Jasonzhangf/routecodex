import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import {
  ProviderProtocolError,
  type ProviderErrorCategory,
  type ProviderProtocolErrorCode
} from '../conversion/provider-protocol-error.js';
import {
  isAdapterClientDisconnectedWithNative,
  planServertoolClientDisconnectedErrorWithNative,
  planServertoolRequiredResponseHookEmptyErrorWithNative,
  planServertoolTimeoutErrorWithNative,
  planServertoolTimeoutWatcherWithNative,
  type ServertoolErrorPlan
} from '../native/router-hotpath/native-servertool-core-semantics.js';

// feature_id: hub.servertool_orchestration_policy
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
