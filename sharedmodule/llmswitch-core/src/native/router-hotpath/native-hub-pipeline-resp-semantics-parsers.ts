import type {
  AnthropicChatCompletionOutcome,
  AnthropicStopReasonResolution,
  ContextLengthDiagnosticsOutput,
  ProviderResponseContextHelpersOutput,
  ProviderSseStreamReadErrorDescriptor,
  ProviderResponseToolCallSummary,
  RespInboundSseErrorDescriptor,
  ResponsesClientSseFrameProjection,
  ResponsesHostPolicyResult
} from './native-hub-pipeline-resp-semantics-types.js';
import { formatUnknownError } from '../../shared/common-utils.js';

const NON_BLOCKING_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingParseLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-resp-semantics.parse-failed');


function logNativeRespSemanticsParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingParseLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-resp-semantics-parsers] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeRespSemanticsParserNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

export function parseAliasMap(raw: string): Record<string, string> | undefined | null {
  const parsed = parseJson('parseAliasMap', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, string>;
}

export function parseClientToolsRaw(raw: string): unknown[] | undefined | null {
  const parsed = parseJson('parseClientToolsRaw', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

export function parseRecord(raw: string, stage = 'parseRecord'): Record<string, unknown> | null {
  const parsed = parseJson(stage, raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

export function parseBoolean(raw: string): boolean | null {
  const parsed = parseJson('parseBoolean', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return typeof parsed === 'boolean' ? parsed : null;
}

export function parseUnknown(raw: string): unknown | null {
  const parsed = parseJson('parseUnknown', raw);
  return parsed === JSON_PARSE_FAILED ? null : parsed;
}

export function parseStringOrUndefined(raw: string): string | undefined | null {
  const parsed = parseJson('parseStringOrUndefined', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  return typeof parsed === 'string' ? parsed : null;
}

export function parseContextLengthDiagnostics(raw: string): ContextLengthDiagnosticsOutput | null {
  const row = parseRecord(raw, 'parseContextLengthDiagnostics');
  return row as ContextLengthDiagnosticsOutput | null;
}

export function parseRespInboundSseErrorDescriptor(raw: string): RespInboundSseErrorDescriptor | null {
  const row = parseRecord(raw, 'parseRespInboundSseErrorDescriptor');
  return row as unknown as RespInboundSseErrorDescriptor | null;
}

export function parseProviderSseStreamReadErrorDescriptor(raw: string): ProviderSseStreamReadErrorDescriptor | null {
  const row = parseRecord(raw, 'parseProviderSseStreamReadErrorDescriptor');
  return row as unknown as ProviderSseStreamReadErrorDescriptor | null;
}

export function parseJsonObjectCandidate(raw: string): Record<string, unknown> | null | undefined {
  const parsed = parseJson('parseJsonObjectCandidate', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return undefined;
  }
  if (parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

export function parseResponsesHostPolicyResult(raw: string): ResponsesHostPolicyResult | null {
  const row = parseRecord(raw, 'parseResponsesHostPolicyResult');
  return row as unknown as ResponsesHostPolicyResult | null;
}

export function parseResponsesClientSseFrameProjection(raw: string): ResponsesClientSseFrameProjection | null {
  const row = parseRecord(raw, 'parseResponsesClientSseFrameProjection');
  return row as unknown as ResponsesClientSseFrameProjection | null;
}

export function parseRespFormatEnvelopeResult(raw: string): Record<string, unknown> | null {
  return parseRecord(raw, 'parseRespFormatEnvelopeResult');
}

export function parseAnthropicStopReasonResolution(raw: string): AnthropicStopReasonResolution | null {
  const row = parseRecord(raw, 'parseAnthropicStopReasonResolution');
  return row as unknown as AnthropicStopReasonResolution | null;
}

export function parseAnthropicChatCompletionOutcome(raw: string): AnthropicChatCompletionOutcome | null {
  const row = parseRecord(raw, 'parseAnthropicChatCompletionOutcome');
  return row as unknown as AnthropicChatCompletionOutcome | null;
}

export function parseProviderResponseToolCallSummary(raw: string): ProviderResponseToolCallSummary | null {
  const row = parseRecord(raw, 'parseProviderResponseToolCallSummary');
  return row as ProviderResponseToolCallSummary | null;
}

export function parseProviderResponseContextHelpers(raw: string): ProviderResponseContextHelpersOutput | null {
  const row = parseRecord(raw, 'parseProviderResponseContextHelpers');
  return row as unknown as ProviderResponseContextHelpersOutput | null;
}
