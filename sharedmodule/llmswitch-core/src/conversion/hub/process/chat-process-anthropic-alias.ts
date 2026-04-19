import { isJsonObject } from '../types/json.js';
import type { StandardizedRequest } from '../types/standardized.js';
import { buildAnthropicToolAliasMapWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';

export function normalizeAnthropicToolAliasMap(
  aliasMap?: Record<string, unknown>
): Record<string, string> | undefined {
  if (!aliasMap || typeof aliasMap !== 'object') {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(aliasMap)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      continue;
    }
    const normalizedKey = key.trim().toLowerCase();
    const normalizedValue = value.trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    next[normalizedKey] = normalizedValue;
  }
  const shellAlias =
    next.shell_command ??
    next.bash ??
    next.shell ??
    next.exec_command;
  if (shellAlias) {
    next.shell_command = shellAlias;
    next.bash = shellAlias;
    next.shell = shellAlias;
    next.exec_command = shellAlias;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function applyAnthropicToolAliasSemantics(
  request: StandardizedRequest,
  entryEndpoint: string
): StandardizedRequest {
  try {
    const endpoint = typeof entryEndpoint === 'string' ? entryEndpoint.trim().toLowerCase() : '';
    if (!endpoint.includes('/v1/messages')) {
      return request;
    }

    request.semantics = asObjectRecord(request.semantics) as any;
    const semantics = request.semantics as Record<string, unknown>;
    const semanticsTools = asObjectRecord((semantics as any).tools);
    (semantics as any).tools = semanticsTools;

    const hasAlias =
      isJsonObject((semanticsTools as any).toolNameAliasMap) ||
      isJsonObject((semanticsTools as any).toolAliasMap);
    if (hasAlias) {
      return request;
    }

    const sourceTools =
      Array.isArray((semanticsTools as any).clientToolsRaw) && (semanticsTools as any).clientToolsRaw.length
        ? (semanticsTools as any).clientToolsRaw
        : request.tools;
    const aliasMap = normalizeAnthropicToolAliasMap(
      buildAnthropicToolAliasMapWithNative(sourceTools)
    );
    if (aliasMap) {
      (semanticsTools as any).toolNameAliasMap = aliasMap;
    }
  } catch {
    // best-effort: alias-map propagation must never block request handling
  }
  return request;
}

function asObjectRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
