import {
  resolveStopMessageSessionScopeWithNative,
  resolveServertoolStickyKeyWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter } from './metadata-center-carrier.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function buildServertoolScopeMetadata(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(record);
}

export function resolveServertoolPersistentScopeKey(adapterContext: unknown): string | undefined {
  const record = asRecord(adapterContext);
  if (!record) {
    return undefined;
  }
  const metadata = buildServertoolScopeMetadata(record);
  return metadata ? resolveStopMessageSessionScopeWithNative(metadata) || undefined : undefined;
}

export function resolveServertoolLoopScopeKey(adapterContext: unknown): string | undefined {
  const record = asRecord(adapterContext);
  if (!record) {
    return undefined;
  }
  const metadata = buildServertoolScopeMetadata(record);
  return metadata ? resolveServertoolStickyKeyWithNative(metadata) || undefined : undefined;
}
