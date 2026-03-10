import type { ChatEnvelope } from './hub/types/chat-envelope.js';
import { isJsonObject, type JsonObject, type JsonValue } from './hub/types/json.js';
import {
  ensureProtocolStateWithNative,
  getProtocolStateWithNative
} from '../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

const PROTOCOL_STATE_KEY = 'protocolState';

export function ensureProtocolState(metadata: ChatEnvelope['metadata'], protocol: string): JsonObject {
  const native = ensureProtocolStateWithNative(metadata as unknown as Record<string, unknown>, protocol);
  for (const key of Object.keys(metadata)) {
    if (!Object.prototype.hasOwnProperty.call(native.metadata, key)) {
      delete (metadata as Record<string, unknown>)[key];
    }
  }
  Object.assign(metadata as Record<string, unknown>, native.metadata);
  if (!metadata[PROTOCOL_STATE_KEY] || !isJsonObject(metadata[PROTOCOL_STATE_KEY])) {
    metadata[PROTOCOL_STATE_KEY] = {};
  }
  const container = metadata[PROTOCOL_STATE_KEY] as JsonObject;
  if (!isJsonObject(container[protocol])) {
    container[protocol] = native.node as JsonObject;
  }
  return container[protocol] as JsonObject;
}

export function getProtocolState(metadata: ChatEnvelope['metadata'] | undefined, protocol: string): JsonObject | undefined {
  if (!metadata) {
    return undefined;
  }
  const node = getProtocolStateWithNative(metadata as unknown as Record<string, unknown>, protocol);
  return node && isJsonObject(node as JsonValue) ? (node as JsonObject) : undefined;
}
