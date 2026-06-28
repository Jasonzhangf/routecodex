/**
 * Shared pure functions extracted from provider-response-converter.ts.
 *
 * Zero side effects. No external state. No env reads. No logging.
 * Only deterministic input → output transforms.
 *
 * NOTE: Most functions now delegate to Rust NAPI (batch #3, #2). TS fallback
 * is preserved for backward compatibility when native binding is unavailable.
 */

import { validateCanonicalClientToolCall } from './provider-response-tool-validation-blocks.js';
import { normalizeKnownProviderError } from '../../../../providers/core/runtime/provider-error-catalog.js';
import { getRouterHotpathJsonBindingSync } from '../../../../modules/llmswitch/bridge/native-exports.js';

function getBinding() {
  try {
    return getRouterHotpathJsonBindingSync();
  } catch {
    return undefined;
  }
}

function withNativeBinding<T>(fn: (binding: NonNullable<ReturnType<typeof getBinding>>) => T, fallback: () => T): T {
  const binding = getBinding();
  if (binding) {
    try {
      return fn(binding);
    } catch {
      // fall through
    }
  }
  return fallback();
}

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

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  return withNativeBinding(
    (binding) => {
      if (typeof binding.asFlatRecordJson === 'function') {
        const raw = binding.asFlatRecordJson(JSON.stringify(value));
        return raw !== null ? JSON.parse(raw) as Record<string, unknown> : undefined;
      }
      return undefined;
    },
    () => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      return value as Record<string, unknown>;
    }
  );
}

export function readSessionLikeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

// ---------------------------------------------------------------------------
// JSON parsing helpers
// ---------------------------------------------------------------------------

export function extractFirstBalancedJsonObject(raw: string): string | undefined {
  return withNativeBinding(
    (binding) => {
      if (typeof binding.extractFirstBalancedJsonObjectJson === 'function') {
        const raw2 = binding.extractFirstBalancedJsonObjectJson(raw);
        return raw2 !== null ? String(raw2) : undefined;
      }
      return undefined;
    },
    () => {
      const start = raw.indexOf('{');
      if (start < 0) return undefined;
      let depth = 0;
      let inString = false;
      let escaping = false;
      for (let i = start; i < raw.length; i += 1) {
        const ch = raw[i];
        if (inString) {
          if (escaping) { escaping = false; continue; }
          if (ch === '\\') { escaping = true; continue; }
          if (ch === '"') { inString = false; }
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') { depth += 1; continue; }
        if (ch === '}') {
          depth -= 1;
          if (depth === 0) return raw.slice(start, i + 1);
        }
      }
      return undefined;
    }
  );
}

export function tryParseJsonLikeString(raw: string): unknown {
  return withNativeBinding(
    (binding) => {
      if (typeof binding.tryParseJsonLikeStringJson === 'function') {
        const raw2 = binding.tryParseJsonLikeStringJson(raw);
        return raw2 !== null ? JSON.parse(raw2) : undefined;
      }
      return undefined;
    },
    () => {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;
      if (!(trimmed.startsWith('{') || trimmed.startsWith('[')) && !trimmed.includes('{"') && !trimmed.includes("{'")) return undefined;
      try { return JSON.parse(trimmed); }
      catch {
        const balanced = extractFirstBalancedJsonObject(trimmed);
        if (!balanced) return undefined;
        try { return JSON.parse(balanced); } catch { return undefined; }
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Stopless / request scanning
// ---------------------------------------------------------------------------

export function extractContentTextForStoplessScan(content: unknown): string {
  return withNativeBinding(
    (binding) => {
      if (typeof binding.extractContentTextForStoplessScanJson === 'function') {
        return binding.extractContentTextForStoplessScanJson(JSON.stringify(content));
      }
      return '';
    },
    () => {
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      const parts: string[] = [];
      for (const item of content) {
        if (typeof item === 'string') { parts.push(item); continue; }
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const text = typeof (item as Record<string, unknown>).text === 'string' ? String((item as Record<string, unknown>).text) : '';
        if (text) parts.push(text);
      }
      return parts.join('\n');
    }
  );
}

export function extractLatestUserTextForStoplessScan(source: unknown): string {
  return withNativeBinding(
    (binding) => {
      if (typeof binding.extractLatestUserTextForStoplessScanJson === 'function') {
        return binding.extractLatestUserTextForStoplessScanJson(JSON.stringify(source));
      }
      return '';
    },
    () => {
      const record = asFlatRecord(source);
      if (!record) return '';
      const rows = Array.isArray(record.messages) ? record.messages : Array.isArray(record.input) ? record.input : [];
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = asFlatRecord(rows[i]);
        if (!row) continue;
        const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
        if (role !== 'user') continue;
        const text = extractContentTextForStoplessScan(row.content).trim();
        if (text) return text;
      }
      return '';
    }
  );
}

export function hasStoplessDirectiveInRequestPayload(source: unknown): boolean {
  return withNativeBinding(
    (binding) => {
      if (typeof binding.hasStoplessDirectiveInRequestPayloadJson === 'function') {
        return binding.hasStoplessDirectiveInRequestPayloadJson(JSON.stringify(source)) === true;
      }
      return false;
    },
    () => STOPLESS_DIRECTIVE_PATTERN.test(extractLatestUserTextForStoplessScan(source))
  );
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
// Nested payload traversal
// ---------------------------------------------------------------------------

export function findNestedRawString(payload: unknown, depth = 3): string {
  void depth;
  return withNativeBinding(
    (binding) => {
      if (typeof binding.findNestedRawStringJson === 'function') {
        return binding.findNestedRawStringJson(JSON.stringify(payload));
      }
      return '';
    },
    () => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || depth < 0) return '';
      const record = payload as Record<string, unknown>;
      const directRaw = typeof record.raw === 'string' ? record.raw : '';
      if (directRaw) return directRaw;
      for (const key of ['body', 'data', 'payload', 'response', 'error']) {
        const nested = findNestedRawString(record[key], depth - 1);
        if (nested) return nested;
      }
      return '';
    }
  );
}

export function findNestedErrorMarker(payload: unknown, depth = 3): string {
  void depth;
  return withNativeBinding(
    (binding) => {
      if (typeof binding.findNestedErrorMarkerJson === 'function') {
        return binding.findNestedErrorMarkerJson(JSON.stringify(payload));
      }
      return '';
    },
    () => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || depth < 0) return '';
      const record = payload as Record<string, unknown>;
      const directError = typeof record.error === 'string' ? record.error.trim() : '';
      if (directError) return directError;
      for (const key of ['body', 'data', 'payload', 'response']) {
        const nested = findNestedErrorMarker(record[key], depth - 1);
        if (nested) return nested;
      }
      return '';
    }
  );
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

// ---------------------------------------------------------------------------
// Error classification (pure predicates)
// ---------------------------------------------------------------------------

export function isGenericBridgeResponseContractError(args: {
  error: Record<string, unknown>;
  message: string;
}): boolean {
  return withNativeBinding(
    (binding) => {
      if (typeof binding.isGenericBridgeResponseContractErrorJson === 'function') {
        const raw = binding.isGenericBridgeResponseContractErrorJson(JSON.stringify({
          errorCode: String(args.error.code ?? ''),
          errorName: String(args.error.name ?? ''),
          message: args.message,
        }));
        return (JSON.parse(raw) as { result: boolean }).result === true;
      }
      return false;
    },
    () => {
      const code = typeof args.error.code === 'string' ? args.error.code.trim() : '';
      const name = typeof args.error.name === 'string' ? args.error.name.trim() : '';
      const normalizedMessage = args.message.trim().toLowerCase();
      if (name !== 'ProviderProtocolError') return false;
      if (code !== 'MALFORMED_RESPONSE') return false;
      return normalizedMessage.includes('[hub_response] non-canonical response payload') || normalizedMessage.includes('[hub_response] failed to canonicalize response payload');
    }
  );
}

export function isContextLengthExceededError(
  message: string,
  upstreamCode?: string,
  detailReason?: string
): boolean {
  return withNativeBinding(
    (binding) => {
      if (typeof binding.isContextLengthExceededErrorJson === 'function') {
        const raw = binding.isContextLengthExceededErrorJson(JSON.stringify({
          message,
          upstreamCode: upstreamCode ?? null,
          detailReason: detailReason ?? null,
        }));
        return (JSON.parse(raw) as { result: boolean }).result === true;
      }
      return false;
    },
    () => {
      const normalizedMessage = message.toLowerCase();
      const normalizedUpstream = typeof upstreamCode === 'string' ? upstreamCode.trim().toLowerCase() : '';
      const normalizedReason = typeof detailReason === 'string' ? detailReason.trim().toLowerCase() : '';
      if (normalizedUpstream.includes('context_length_exceeded') || normalizedUpstream.includes('context_window_exceeded') || normalizedUpstream.includes('model_context_window_exceeded') || normalizedUpstream.includes('input_exceeds_limit')) return true;
      if (normalizedReason === 'context_length_exceeded' || normalizedReason === 'context_window_exceeded' || normalizedReason === 'model_context_window_exceeded' || normalizedReason === 'input_exceeds_limit') return true;
      return CONTEXT_LENGTH_MESSAGE_HINTS.some((hint) => normalizedMessage.includes(hint));
    }
  );
}

export function isRetryableNetworkSseWrapperError(message: string, upstreamCode?: string, statusCode?: number): boolean {
  return withNativeBinding(
    (binding) => {
      if (typeof binding.isRetryableNetworkSseWrapperErrorJson === 'function') {
        const raw = binding.isRetryableNetworkSseWrapperErrorJson(JSON.stringify({
          message,
          upstreamCode: upstreamCode ?? null,
          statusCode: statusCode ?? null,
        }));
        return (JSON.parse(raw) as { result: boolean }).result === true;
      }
      return false;
    },
    () => {
      const known = normalizeKnownProviderError({ statusCode, code: upstreamCode, upstreamCode, message });
      if (known?.code === '429.2000') return false;
      if (known?.class === 'recoverable') return true;
      if (known?.class === 'unrecoverable') return false;
      if (typeof statusCode === 'number' && Number.isFinite(statusCode)) {
        if (statusCode === 408 || statusCode === 425 || statusCode === 502 || statusCode === 503 || statusCode === 504) return true;
      }
      const normalizedMessage = String(message || '').trim().toLowerCase();
      const normalizedUpstream = typeof upstreamCode === 'string' ? upstreamCode.trim().toLowerCase() : '';
      if (normalizedUpstream && RETRYABLE_NETWORK_CODE_HINTS.some((hint) => normalizedUpstream.includes(hint))) return true;
      return RETRYABLE_NETWORK_MESSAGE_HINTS.some((hint) => normalizedMessage.includes(hint));
    }
  );
}

// ---------------------------------------------------------------------------
// Payload extraction
// ---------------------------------------------------------------------------

export function extractBridgeProviderResponsePayload(
  body: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  return withNativeBinding(
    (binding) => {
      if (typeof binding.extractBridgeProviderResponsePayloadJson === 'function') {
        const raw = binding.extractBridgeProviderResponsePayloadJson(JSON.stringify(body ?? {}));
        return raw !== null ? JSON.parse(raw) as Record<string, unknown> : undefined;
      }
      return undefined;
    },
    () => {
      if (!body || typeof body !== 'object') return undefined;
      if (body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)) return body.payload as Record<string, unknown>;
      const nestedBody = body.body && typeof body.body === 'object' && !Array.isArray(body.body) ? body.body as Record<string, unknown> : undefined;
      if (nestedBody?.data && typeof nestedBody.data === 'object' && !Array.isArray(nestedBody.data)) return nestedBody.data as Record<string, unknown>;
      if (nestedBody) return nestedBody;
      if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) return body.data as Record<string, unknown>;
      return undefined;
    }
  );
}
