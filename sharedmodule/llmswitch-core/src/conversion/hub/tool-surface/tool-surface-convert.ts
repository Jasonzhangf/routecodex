import type { JsonValue } from '../types/json.js';
import { mapBridgeToolsToChat, mapChatToolsToBridge } from '../../shared/tool-mapping.js';
import { buildGeminiToolsFromBridge, prepareGeminiToolsForBridge } from '../../shared/gemini-tool-utils.js';
import { mapAnthropicToolsToChat, mapChatToolsToAnthropicTools } from '../../shared/anthropic-message-utils.js';
import { resolveHubProtocolSpec, type ToolDefinitionFormat, type ProviderOutboundHistoryCarrier } from '../policy/protocol-spec.js';

function looksLikeOpenAITools(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const obj = entry as Record<string, unknown>;
    return typeof obj.type === 'string' || (obj.function && typeof obj.function === 'object');
  });
}

function looksLikeGeminiTools(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const obj = entry as Record<string, unknown>;
    return Array.isArray(obj.functionDeclarations);
  });
}

function looksLikeAnthropicTools(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const obj = entry as Record<string, unknown>;
    return typeof obj.name === 'string' && Object.prototype.hasOwnProperty.call(obj, 'input_schema');
  });
}

type DetectedToolFormat = ToolDefinitionFormat | 'unknown';

function detectToolFormat(raw: unknown): DetectedToolFormat {
  if (!Array.isArray(raw)) return 'unknown';
  if (looksLikeGeminiTools(raw)) return 'gemini';
  if (looksLikeAnthropicTools(raw)) return 'anthropic';
  if (looksLikeOpenAITools(raw)) return 'openai';
  return 'unknown';
}

function convertToolDefinitions(args: {
  from: ToolDefinitionFormat;
  to: ToolDefinitionFormat;
  tools: unknown;
}): JsonValue | undefined {
  if (!Array.isArray(args.tools)) {
    return undefined;
  }
  const from = args.from;
  const to = args.to;
  const raw = args.tools;

  if (from === to) {
    return raw as unknown as JsonValue;
  }

  // All conversions pass through OpenAI-format as the canonical bridge.
  const toOpenAI = (sourceFormat: ToolDefinitionFormat, input: unknown): unknown | undefined => {
    if (!Array.isArray(input)) return undefined;
    if (sourceFormat === 'openai') {
      return input;
    }
    if (sourceFormat === 'gemini') {
      if (!looksLikeGeminiTools(input)) return undefined;
      const bridgeDefs = prepareGeminiToolsForBridge(input as JsonValue | undefined);
      return mapBridgeToolsToChat(bridgeDefs);
    }
    if (sourceFormat === 'anthropic') {
      if (!looksLikeAnthropicTools(input)) return undefined;
      return mapAnthropicToolsToChat(input);
    }
    return undefined;
  };

  const fromOpenAI = (targetFormat: ToolDefinitionFormat, input: unknown): unknown | undefined => {
    if (!Array.isArray(input)) return undefined;
    if (targetFormat === 'openai') {
      return input;
    }
    if (targetFormat === 'gemini') {
      if (!looksLikeOpenAITools(input)) return undefined;
      const bridgeDefs = mapChatToolsToBridge(input);
      return buildGeminiToolsFromBridge(bridgeDefs);
    }
    if (targetFormat === 'anthropic') {
      if (!looksLikeOpenAITools(input)) return undefined;
      return mapChatToolsToAnthropicTools(input);
    }
    return undefined;
  };

  const openaiTools = toOpenAI(from, raw);
  if (!openaiTools) {
    return undefined;
  }
  const converted = fromOpenAI(to, openaiTools);
  if (!converted) {
    return undefined;
  }
  return converted as unknown as JsonValue;
}

export function resolveExpectedHistoryCarrier(providerProtocol: string): ProviderOutboundHistoryCarrier | null {
  try {
    const spec = resolveHubProtocolSpec(providerProtocol);
    return spec.toolSurface.expectedHistoryCarrier ?? null;
  } catch {
    return null;
  }
}

export function buildCandidateTools(args: {
  providerProtocol: string;
  tools: unknown;
}): { candidateTools: JsonValue | undefined; reason?: string } | undefined {
  const rawTools = args.tools;
  if (!Array.isArray(rawTools)) {
    return undefined;
  }

  const spec = resolveHubProtocolSpec(args.providerProtocol);
  const expected = spec.toolSurface.expectedToolFormat;
  const detected = detectToolFormat(rawTools);
  if (detected === 'unknown' || detected === expected) {
    return undefined;
  }

  const candidateTools = convertToolDefinitions({
    from: detected,
    to: expected,
    tools: rawTools
  });
  if (candidateTools === undefined) {
    return undefined;
  }

  return {
    candidateTools,
    reason: `${detected}_tools_on_${expected}_protocol`
  };
}
