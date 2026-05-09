import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import {
  resolveStopMessageSessionScopeWithNative,
  resolveServertoolStickyKeyWithNative
} from '../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function buildServertoolScopeMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const runtime = readRuntimeMetadata(record) as Record<string, unknown> | undefined;
  const metadata = asRecord(record.metadata);
  return {
    ...(metadata ?? {}),
    ...(runtime ?? {}),
    ...record
  };
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
