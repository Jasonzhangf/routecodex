import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  planRuntimePreCommandStateRuntimeActionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { readRuntimeControlFromAnyBoundMetadataCenter } from './metadata-center-carrier.js';

export function resolveServertoolRuntimePreCommandState(args: {
  adapterContext: unknown;
  requestId: string;
  entryEndpoint?: string;
  providerProtocol?: string;
}): JsonObject | undefined {
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(
    args.adapterContext as Record<string, unknown> | undefined
  );
  const runtimeAction = planRuntimePreCommandStateRuntimeActionWithNative({
    runtimeControlPreCommandState: asObject(runtimeControl?.preCommandState) ?? undefined
  });
  if (runtimeAction.action !== 'use_selected') {
    throw new Error(
      `[servertool] invalid native pre-command runtime action: ${String(runtimeAction.action)}`
    );
  }
  return runtimeAction.state as JsonObject | undefined;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}
