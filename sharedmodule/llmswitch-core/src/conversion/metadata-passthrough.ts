import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from './hub/types/json.js';
import {
  encodeMetadataPassthroughWithNative,
  extractMetadataPassthroughWithNative
} from '../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

interface PassthroughOptions {
  prefix: string;
  keys: readonly string[];
}

export function encodeMetadataPassthrough(
  parameters: JsonObject | undefined,
  options: PassthroughOptions
): Record<string, string> | undefined {
  return encodeMetadataPassthroughWithNative(parameters, options.prefix, options.keys);
}

export function extractMetadataPassthrough(
  metadataField: JsonValue | undefined,
  options: PassthroughOptions
): {
  metadata?: JsonObject;
  passthrough?: JsonObject;
} {
  if (!metadataField || !isJsonObject(metadataField)) {
    return {};
  }
  const cloned = jsonClone(metadataField) as JsonObject;
  const native = extractMetadataPassthroughWithNative(cloned, options.prefix, options.keys);
  const metadata =
    native.metadata && isJsonObject(native.metadata as JsonValue) ? (native.metadata as JsonObject) : undefined;
  const passthrough =
    native.passthrough && isJsonObject(native.passthrough as JsonValue)
      ? (native.passthrough as JsonObject)
      : undefined;
  return {
    metadata,
    passthrough
  };
}
