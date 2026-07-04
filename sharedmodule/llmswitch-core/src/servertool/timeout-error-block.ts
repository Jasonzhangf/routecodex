import {
  ProviderProtocolError,
  type ProviderErrorCategory,
  type ProviderProtocolErrorCode
} from '../conversion/provider-protocol-error.js';
import {
  createServertoolProviderProtocolErrorFromPlanWithNative,
  planServertoolTimeoutWatcherWithNative,
  type ServertoolErrorPlan
} from 'rcc-llmswitch-core/native/servertool-wrapper';

// feature_id: hub.servertool_orchestration_policy
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  buildError: () => Error
): Promise<T> {
  const plan = planServertoolTimeoutWatcherWithNative({ timeoutMs });
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

export function createServertoolProviderProtocolErrorFromPlan(
  plan: ServertoolErrorPlan
): ProviderProtocolError & { status?: number } {
  return createServertoolProviderProtocolErrorFromPlanWithNative(plan);
}
