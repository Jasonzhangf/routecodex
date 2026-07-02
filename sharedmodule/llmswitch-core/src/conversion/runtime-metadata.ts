import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from './hub/types/json.js';
import {
  cloneRuntimeMetadataWithNative,
  ensureRuntimeMetadataCarrierWithNative,
  readRuntimeMetadataWithNative
} from '../native/router-hotpath/native-shared-conversion-semantics.js';

export type RuntimeMetadataCarrier = Record<string, unknown> & { __rt?: JsonObject };

import { METADATA_CENTER_SYMBOL } from './hub/metadata-center-runtime-control-writer.js';

// re-export for consumers that need it
export { METADATA_CENTER_SYMBOL };

function preserveMetadataCenterBinding(
  source: Record<string, unknown>,
  target: Record<string, unknown>
): void {
  const sourceCenter = Reflect.get(source, METADATA_CENTER_SYMBOL);
  if (sourceCenter !== undefined) {
    Reflect.set(target, METADATA_CENTER_SYMBOL, sourceCenter);
  }
  const sourceMetadata = source.metadata;
  const targetMetadata = target.metadata;
  if (
    sourceMetadata
    && typeof sourceMetadata === 'object'
    && !Array.isArray(sourceMetadata)
    && targetMetadata
    && typeof targetMetadata === 'object'
    && !Array.isArray(targetMetadata)
  ) {
    const metadataCenter = Reflect.get(sourceMetadata as Record<string, unknown>, METADATA_CENTER_SYMBOL);
    if (metadataCenter !== undefined) {
      Reflect.set(targetMetadata as Record<string, unknown>, METADATA_CENTER_SYMBOL, metadataCenter);
    }
  }
}

export function readRuntimeMetadata(carrier?: Record<string, unknown> | null): JsonObject | undefined {
  if (!carrier || typeof carrier !== 'object') {
    return undefined;
  }
  const candidate = readRuntimeMetadataWithNative(carrier);
  return candidate && isJsonObject(candidate as JsonValue) ? (candidate as JsonObject) : undefined;
}

export function ensureRuntimeMetadata(carrier: Record<string, unknown>): JsonObject {
  if (!carrier || typeof carrier !== 'object') {
    throw new Error('ensureRuntimeMetadata requires object carrier');
  }
  const nextCarrier = ensureRuntimeMetadataCarrierWithNative(carrier);
  preserveMetadataCenterBinding(carrier, nextCarrier as Record<string, unknown>);
  for (const key of Object.keys(carrier)) {
    if (!Object.prototype.hasOwnProperty.call(nextCarrier, key)) {
      delete (carrier as Record<string, unknown>)[key];
    }
  }
  Object.assign(carrier, nextCarrier);
  const existing = (carrier as RuntimeMetadataCarrier).__rt;
  if (existing && isJsonObject(existing as JsonValue)) {
    return existing as JsonObject;
  }
  (carrier as RuntimeMetadataCarrier).__rt = {};
  return (carrier as RuntimeMetadataCarrier).__rt as JsonObject;
}

export function cloneRuntimeMetadata(carrier?: Record<string, unknown> | null): JsonObject | undefined {
  const rt = cloneRuntimeMetadataWithNative(carrier);
  return rt && isJsonObject(rt as JsonValue) ? (jsonClone(rt as JsonValue) as JsonObject) : undefined;
}
