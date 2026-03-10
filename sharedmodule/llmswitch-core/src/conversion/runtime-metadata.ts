import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from './hub/types/json.js';
import {
  cloneRuntimeMetadataWithNative,
  ensureRuntimeMetadataCarrierWithNative,
  readRuntimeMetadataWithNative
} from '../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export type RuntimeMetadataCarrier = Record<string, unknown> & { __rt?: JsonObject };

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
