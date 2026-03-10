import type { JsonObject } from '../../../../types/json.js';
import type { BridgeToolDefinition } from '../../../../../types/bridge-message-types.js';
import {
  resolveAliasMapFromRespSemanticsWithNative,
  resolveClientToolsRawFromRespSemanticsWithNative,
  normalizeAliasMapWithNative,
  resolveClientToolsRawWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';

// Three-stage contract:
// inbound -> chat_process -> outbound
// This module is the outbound-side bridge that consumes chat_process semantics
// and remaps client-facing tool semantics without mutating chat_process internals.
export function resolveAliasMapFromSemantics(semantics?: JsonObject): Record<string, string> | undefined {
  return resolveAliasMapFromRespSemanticsWithNative(semantics);
}

export function normalizeAliasMap(candidate: unknown): Record<string, string> | undefined {
  return normalizeAliasMapWithNative(candidate);
}

export function resolveClientToolsRawFromSemantics(semantics?: JsonObject): BridgeToolDefinition[] | undefined {
  return resolveClientToolsRawFromRespSemanticsWithNative(semantics) as
    | BridgeToolDefinition[]
    | undefined;
}

export function resolveClientToolsRaw(candidate: unknown): BridgeToolDefinition[] | undefined {
  return resolveClientToolsRawWithNative(candidate) as
    | BridgeToolDefinition[]
    | undefined;
}
