import type { JsonObject } from '../../../../types/json.js';
import type { BridgeToolDefinition } from '../../../../../types/bridge-message-types.js';
import {
  resolveAliasMapFromRespSemanticsWithNative,
  resolveClientToolsRawFromRespSemanticsWithNative,
  normalizeAliasMapWithNative,
  resolveClientToolsRawWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';
import { buildAnthropicToolAliasMapWithNative } from '../../../../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';

// Three-stage contract:
// inbound -> chat_process -> outbound
// This module is the outbound-side bridge that consumes chat_process semantics
// and remaps client-facing tool semantics without mutating chat_process internals.
export function resolveAliasMapFromSemantics(semantics?: JsonObject): Record<string, string> | undefined {
  const nativeResolved = resolveAliasMapFromRespSemanticsWithNative(semantics);
  if (nativeResolved && Object.keys(nativeResolved).length > 0) {
    return finalizeAliasMap(nativeResolved);
  }

  const toolsNode = asJsonRecord(semantics?.tools);
  const anthropicNode = asJsonRecord(semantics?.anthropic);
  const directCandidates = [
    toolsNode?.toolNameAliasMap,
    toolsNode?.toolAliasMap,
    anthropicNode?.toolNameAliasMap,
    anthropicNode?.toolAliasMap
  ];
  for (const candidate of directCandidates) {
    const normalized = normalizeAliasMap(candidate);
    if (normalized && Object.keys(normalized).length > 0) {
      return finalizeAliasMap(normalized);
    }
  }

  const rawCandidates = [
    anthropicNode?.clientToolsRaw,
    toolsNode?.clientToolsRaw,
    resolveClientToolsRawFromSemantics(semantics)
  ];
  for (const candidate of rawCandidates) {
    const built = buildAnthropicToolAliasMapWithNative(candidate);
    const normalized = normalizeAliasMap(built);
    if (normalized && Object.keys(normalized).length > 0) {
      return finalizeAliasMap(normalized);
    }
  }

  return undefined;
}

export function normalizeAliasMap(candidate: unknown): Record<string, string> | undefined {
  return normalizeAliasMapWithNative(candidate);
}

export function resolveClientToolsRawFromSemantics(semantics?: JsonObject): BridgeToolDefinition[] | undefined {
  const nativeResolved = resolveClientToolsRawFromRespSemanticsWithNative(semantics) as
    | BridgeToolDefinition[]
    | undefined;
  if (nativeResolved && nativeResolved.length > 0) {
    return nativeResolved;
  }
  const toolsNode = asJsonRecord(semantics?.tools);
  const anthropicNode = asJsonRecord(semantics?.anthropic);
  return (
    resolveClientToolsRaw(toolsNode?.clientToolsRaw) ??
    resolveClientToolsRaw(anthropicNode?.clientToolsRaw)
  );
}

export function resolveClientToolsRaw(candidate: unknown): BridgeToolDefinition[] | undefined {
  return resolveClientToolsRawWithNative(candidate) as
    | BridgeToolDefinition[]
    | undefined;
}

function asJsonRecord(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function finalizeAliasMap(aliasMap: Record<string, string>): Record<string, string> {
  const next = { ...aliasMap };
  const shellAlias =
    next.shell_command ??
    next.exec_command ??
    next.shell ??
    next.bash;
  if (typeof shellAlias === 'string' && shellAlias.trim().length > 0) {
    next.shell_command = next.shell_command ?? shellAlias;
    next.exec_command = next.exec_command ?? shellAlias;
    next.shell = next.shell ?? shellAlias;
    next.bash = next.bash ?? shellAlias;
  }
  return next;
}
