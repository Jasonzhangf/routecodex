/**
 * Shared pure functions extracted from provider-response-converter.ts.
 *
 * Zero side effects. No external state. No env reads. No logging.
 * Only deterministic input → output transforms.
 */

import {
  asFlatRecord,
  extractBridgeProviderResponsePayload,
  extractContentTextForStoplessScan,
  extractFirstBalancedJsonObject,
  extractLatestUserTextForStoplessScan,
  findNestedErrorMarker,
  findNestedRawString,
  hasStoplessDirectiveInRequestPayload,
  isContextLengthExceededError,
  isGenericBridgeResponseContractError,
  isRetryableNetworkSseWrapperError,
  tryParseJsonLikeString,
  validateCanonicalClientToolCall,
} from '../../../../modules/llmswitch/bridge/provider-response-converter-host.js';

export {
  asFlatRecord,
  extractBridgeProviderResponsePayload,
  extractContentTextForStoplessScan,
  extractFirstBalancedJsonObject,
  extractLatestUserTextForStoplessScan,
  findNestedErrorMarker,
  findNestedRawString,
  hasStoplessDirectiveInRequestPayload,
  isContextLengthExceededError,
  isGenericBridgeResponseContractError,
  isRetryableNetworkSseWrapperError,
  tryParseJsonLikeString,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONTEXT_LENGTH_MESSAGE_HINTS = [
  'context_length_exceeded',
  'context_window_exceeded',
  'model_context_window_exceeded',
  'context length exceeded',
  'context window exceeded',
  "model's maximum context length",
  'maximum context length',
  'max context length',
  'input_exceeds_limit',
  'input exceeds limit',
  'input tokens exceeds',
  'input tokens exceed',
  '内容超长',
  '请删减后再试',
  '对话长度上限',
  '达到对话长度上限'
];

export const RETRYABLE_NETWORK_MESSAGE_HINTS = [
  'internal network failure',
  'network failure',
  'network error',
  'api connection error',
  'service unavailable',
  'temporarily unavailable',
  'temporarily unreachable',
  'connection reset',
  'connection closed',
  'timed out',
  'timeout'
];

export const RETRYABLE_NETWORK_CODE_HINTS = [
  'internal_network_failure',
  'network_error',
  'api_connection_error',
  'service_unavailable',
  'request_timeout',
  'timeout'
];

export const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);

export const FATAL_CONVERSION_ERROR_CODES = new Set([
  'CLIENT_TOOL_ARGS_INVALID',
]);

export const STOPLESS_DIRECTIVE_PATTERN = /<\*\*stopless:[^*]+\*\*>/i;

export function readSessionLikeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function shouldAllowDirectResponsesPrebuiltSsePassthrough(args: {
  entryEndpoint?: string;
  providerProtocol?: string;
  hasSseStream: boolean;
  continuationOwner?: 'direct' | 'relay';
}): boolean {
  if (!args.hasSseStream) {
    return false;
  }
  const entry = String(args.entryEndpoint || '').toLowerCase();
  if (!entry.includes('/v1/responses')) {
    return false;
  }
  if (args.providerProtocol !== 'openai-responses') {
    return false;
  }
  return args.continuationOwner === 'direct';
}

// ---------------------------------------------------------------------------
// Tool name / argument helpers
// ---------------------------------------------------------------------------

export function collectDeclaredToolNames(baseContext: Record<string, unknown>): Set<string> {
  const capturedRequest = asFlatRecord(baseContext.capturedEntryRequest) ?? asFlatRecord(baseContext.capturedChatRequest);
  const tools = Array.isArray(capturedRequest?.tools) ? capturedRequest.tools : [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      continue;
    }
    const row = tool as Record<string, unknown>;
    const fn = row.function && typeof row.function === 'object' && !Array.isArray(row.function)
      ? (row.function as Record<string, unknown>)
      : row;
    const name = typeof fn.name === 'string' ? fn.name.trim().toLowerCase() : '';
    if (name) {
      names.add(name);
    }
  }
  return names;
}

export function stringifyToolCallArgumentsForValidation(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

// ---------------------------------------------------------------------------
// Tool call recovery / validation
// ---------------------------------------------------------------------------

export function normalizeRecoveredToolCalls(
  value: unknown,
  declaredToolNames: Set<string>
): {
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  invalidCall?: {
    name: string;
    reason: string;
    message?: string;
    missingFields?: string[];
  };
} {
  const rows = Array.isArray(value) ? value : [];
  const normalized: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const row of rows) {
    const item = asFlatRecord(row);
    const functionRecord = asFlatRecord(item?.function);
    const nameRaw =
      (typeof item?.name === 'string' ? item.name : '') ||
      (typeof functionRecord?.name === 'string' ? functionRecord.name : '');
    const name = nameRaw.trim();
    if (!name) {
      continue;
    }
    if (declaredToolNames.size > 0 && !declaredToolNames.has(name.toLowerCase())) {
      continue;
    }
    const inputRecord =
      asFlatRecord(item?.input)
      ?? asFlatRecord(item?.arguments)
      ?? asFlatRecord(functionRecord?.arguments)
      ?? {};
    const validation = validateCanonicalClientToolCall(name, JSON.stringify(inputRecord ?? {}), declaredToolNames);
    if (!validation.ok) {
      return {
        toolCalls: normalized,
        invalidCall: {
          name,
          reason: validation.reason || 'invalid_tool_arguments',
          message: validation.message,
          ...(validation.missingFields?.length ? { missingFields: validation.missingFields } : {})
        }
      };
    }
    let normalizedInput = inputRecord;
    if (typeof validation.normalizedArgs === 'string') {
      try {
        const parsed = JSON.parse(validation.normalizedArgs);
        if (asFlatRecord(parsed)) {
          normalizedInput = parsed;
        }
      } catch {
        // keep validated original
      }
    }
    normalized.push({ name, input: normalizedInput });
  }
  return { toolCalls: normalized };
}
