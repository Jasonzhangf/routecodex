import type { JsonObject } from '../conversion/hub/types/json.js';
import { loadRoutingInstructionStateSync } from '../native/router-hotpath/native-virtual-router-routing-state.js';
import {
  planRuntimePreCommandStateRuntimeActionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { resolveServertoolPersistentScopeKey } from './state-scope.js';
import { createServertoolProviderProtocolErrorFromPlan } from './timeout-error-block.js';

export function resolveServertoolRuntimePreCommandState(args: {
  adapterContext: unknown;
  runtimeMetadata: unknown;
  requestId: string;
  entryEndpoint?: string;
  providerProtocol?: string;
}): JsonObject | undefined {
  const persistentScopeKey = resolveServertoolPersistentScopeKey(args.adapterContext);
  const directRuntime = asObject((args.adapterContext as Record<string, unknown> | undefined)?.__rt);
  const runtimeActionBase = {
    directRuntimePreCommandState: directRuntime?.preCommandState,
    runtimeMetadataPreCommandState: asObject(args.runtimeMetadata)?.preCommandState,
    hasPersistentScopeKey: Boolean(persistentScopeKey)
  };

  const initialAction = planRuntimePreCommandStateRuntimeActionWithNative({
    ...runtimeActionBase,
    persistedLoadAttempted: false
  });
  if (initialAction.action === 'use_selected') {
    return initialAction.state as JsonObject | undefined;
  }

  try {
    const persistedState = loadRoutingInstructionStateSync(persistentScopeKey);
    const persistedAction = planRuntimePreCommandStateRuntimeActionWithNative({
      ...runtimeActionBase,
      hasPersistentScopeKey: true,
      persistedState: persistedState ? structuredClone(persistedState as unknown as JsonObject) : undefined,
      persistedLoadAttempted: true
    });
    if (persistedAction.action !== 'use_selected') {
      throw new Error(
        `[servertool] invalid native pre-command runtime action after persisted load: ${String(persistedAction.action)}`
      );
    }
    return persistedAction.state as JsonObject | undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    const failedAction = planRuntimePreCommandStateRuntimeActionWithNative({
      ...runtimeActionBase,
      hasPersistentScopeKey: true,
      persistedLoadAttempted: true,
      persistedLoadError: message,
      requestId: args.requestId,
      stickyKey: persistentScopeKey ?? '',
      entryEndpoint: args.entryEndpoint,
      providerProtocol: args.providerProtocol
    });
    if (failedAction.action !== 'throw_state_load_failed' || !failedAction.errorPlan) {
      throw new Error(
        `[servertool] invalid native pre-command runtime action for persisted load error: ${String(failedAction.action)}`
      );
    }
    const wrapped = createServertoolProviderProtocolErrorFromPlan(
      failedAction.errorPlan
    ) as ReturnType<typeof createServertoolProviderProtocolErrorFromPlan> & { cause?: unknown };
    wrapped.status = 500;
    wrapped.cause = error;
    throw wrapped;
  }
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}
