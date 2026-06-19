import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import {
  resolveStopMessageSessionScopeWithNative,
  resolveServertoolStickyKeyWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { readRuntimeControlFromBoundMetadataCenter } from './stopless-metadata-carrier.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function buildServertoolScopeMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const runtime = readRuntimeMetadata(record) as Record<string, unknown> | undefined;
  const runtimeControl = readRuntimeControlFromBoundMetadataCenter(record);
  const stopMessageClientInject = asRecord(runtimeControl?.stopMessageClientInject);
  const runtimeControlScope = typeof stopMessageClientInject?.sessionScope === 'string'
    ? stopMessageClientInject.sessionScope.trim()
    : '';
  const metadata = asRecord(record.metadata);
  const merged = {
    ...(metadata ?? {}),
    ...(runtime ?? {}),
    ...record
  };
  delete merged.stopMessageClientInjectSessionScope;
  delete merged.stopMessageClientInjectScope;
  if (runtimeControlScope) {
    merged.stopMessageClientInjectSessionScope = runtimeControlScope;
  }
  return merged;
}

export function resolveServertoolPersistentScopeKey(adapterContext: unknown): string | undefined {
  const record = asRecord(adapterContext);
  if (!record) {
    return undefined;
  }
  return resolveStopMessageSessionScopeWithNative(buildServertoolScopeMetadata(record)) || undefined;
}

export function resolveServertoolLoopScopeKey(adapterContext: unknown): string | undefined {
  const record = asRecord(adapterContext);
  if (!record) {
    return undefined;
  }
  return resolveServertoolStickyKeyWithNative(buildServertoolScopeMetadata(record)) || undefined;
}
