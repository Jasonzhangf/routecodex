import type { JsonObject } from '../../hub/types/json.js';
import { stripOrphanFunctionCallsTagWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';

export function stripOrphanFunctionCallsTag(payload: JsonObject): JsonObject {
  return stripOrphanFunctionCallsTagWithNative(payload as unknown as Record<string, unknown>) as unknown as JsonObject;
}
