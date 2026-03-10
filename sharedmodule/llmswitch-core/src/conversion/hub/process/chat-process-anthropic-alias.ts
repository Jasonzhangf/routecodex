import { isJsonObject } from '../types/json.js';
import type { StandardizedRequest } from '../types/standardized.js';
import { buildAnthropicToolAliasMapWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';

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
    const aliasMap = buildAnthropicToolAliasMapWithNative(sourceTools);
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
