import type {
  NativeAppendLocalImageBlockOnLatestUserInputOutput,
  NativeApplyBridgeCaptureToolResultsOutput,
  NativeApplyBridgeEnsureSystemInstructionOutput,
  NativeApplyBridgeEnsureToolPlaceholdersOutput,
  NativeApplyBridgeInjectSystemInstructionOutput,
  NativeApplyBridgeMetadataActionOutput,
  NativeApplyBridgeNormalizeHistoryOutput,
  NativeApplyBridgeReasoningExtractOutput,
  NativeApplyBridgeResponsesOutputReasoningOutput,
  NativeBridgeActionState,
  NativeBridgeHistoryOutput,
  NativeBridgeInputToChatOutput,
  NativeBridgeToolCallIdsOutput,
  NativeEnsureBridgeOutputFieldsOutput,
  NativeEnsureMessagesArrayOutput,
  NativeFilterBridgeInputForUpstreamOutput,
  NativeNormalizeBridgeHistorySeedOutput,
  NativeNormalizeMessageReasoningToolsOutput,
  NativePrepareResponsesRequestEnvelopeOutput,
  NativeResolveResponsesBridgeToolsOutput,
  NativeResolveResponsesRequestBridgeDecisionsOutput
} from './native-hub-bridge-action-semantics-types.js';

const NON_BLOCKING_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingParseLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-bridge-action-semantics.parse-failed');

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? 'unknown');
  }
}

function logNativeBridgeActionParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingParseLogState.set(stage, now);
  console.warn(
    `[native-hub-bridge-action-semantics-parsers] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeBridgeActionParserNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

export function parseOutput(raw: string): NativeBridgeToolCallIdsOutput | null {
  const row = parseRecord(raw, 'parseOutput');
  if (!row || !Array.isArray(row.messages)) {
    return null;
  }
  const output: NativeBridgeToolCallIdsOutput = {
    messages: row.messages
  };
  if (row.rawRequest && typeof row.rawRequest === 'object' && !Array.isArray(row.rawRequest)) {
    output.rawRequest = row.rawRequest as Record<string, unknown>;
  }
  if (Array.isArray(row.capturedToolResults)) {
    output.capturedToolResults = row.capturedToolResults.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
    );
  }
  return output;
}

export function parseEnsureMessagesArrayOutput(raw: string): NativeEnsureMessagesArrayOutput | null {
  const row = parseRecord(raw, 'parseEnsureMessagesArrayOutput');
  if (!row) {
    return null;
  }
  const messages = Array.isArray(row.messages) ? (row.messages as Array<Record<string, unknown>>) : [];
  return { messages };
}

export function parseBridgeHistoryOutput(raw: string): NativeBridgeHistoryOutput | null {
  const row = parseRecord(raw, 'parseBridgeHistoryOutput');
  if (!row || !Array.isArray(row.input) || !Array.isArray(row.originalSystemMessages)) {
    return null;
  }
  const originalSystemMessages = row.originalSystemMessages.filter(
    (entry): entry is string => typeof entry === 'string'
  );
  if (originalSystemMessages.length !== row.originalSystemMessages.length) {
    return null;
  }
  const output: NativeBridgeHistoryOutput = {
    input: row.input,
    originalSystemMessages
  };
  if (typeof row.combinedSystemInstruction === 'string' && row.combinedSystemInstruction.trim().length) {
    output.combinedSystemInstruction = row.combinedSystemInstruction;
  }
  if (typeof row.latestUserInstruction === 'string' && row.latestUserInstruction.trim().length) {
    output.latestUserInstruction = row.latestUserInstruction;
  }
  return output;
}

export function parseNormalizeBridgeHistorySeedOutput(raw: string): NativeNormalizeBridgeHistorySeedOutput | null {
  return parseBridgeHistoryOutput(raw);
}

export function parseResolveResponsesBridgeToolsOutput(
  raw: string
): NativeResolveResponsesBridgeToolsOutput | null {
  const row = parseRecord(raw, 'parseResolveResponsesBridgeToolsOutput');
  if (!row) {
    return null;
  }
  const output: NativeResolveResponsesBridgeToolsOutput = {};
  if (Array.isArray(row.mergedTools)) {
    output.mergedTools = row.mergedTools.filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
    );
  }
  if (row.request && typeof row.request === 'object' && !Array.isArray(row.request)) {
    output.request = row.request as Record<string, unknown>;
  }
  return output;
}

export function parseResolveResponsesRequestBridgeDecisionsOutput(
  raw: string
): NativeResolveResponsesRequestBridgeDecisionsOutput | null {
  const row = parseRecord(raw, 'parseResolveResponsesRequestBridgeDecisionsOutput');
  if (!row || typeof row.forceWebSearch !== 'boolean') {
    return null;
  }
  const output: NativeResolveResponsesRequestBridgeDecisionsOutput = {
    forceWebSearch: row.forceWebSearch
  };
  if (row.toolCallIdStyle === 'fc' || row.toolCallIdStyle === 'preserve') {
    output.toolCallIdStyle = row.toolCallIdStyle;
  }
  if (row.historySeed && typeof row.historySeed === 'object' && !Array.isArray(row.historySeed)) {
    const serialized = JSON.stringify(row.historySeed);
    const parsedHistory = parseBridgeHistoryOutput(serialized);
    if (!parsedHistory) {
      return null;
    }
    output.historySeed = parsedHistory;
  }
  if (typeof row.previousResponseId === 'string' && row.previousResponseId.trim().length > 0) {
    output.previousResponseId = row.previousResponseId.trim();
  }
  return output;
}

export function parseFilterBridgeInputForUpstreamOutput(
  raw: string
): NativeFilterBridgeInputForUpstreamOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.input)) {
      return null;
    }
    const input = row.input.filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
    );
    return { input };
  } catch {
    return null;
  }
}

export function parsePrepareResponsesRequestEnvelopeOutput(
  raw: string
): NativePrepareResponsesRequestEnvelopeOutput | null {
  const parsed = parseRecord(raw);
  if (!parsed || !parsed.request || typeof parsed.request !== 'object' || Array.isArray(parsed.request)) {
    return null;
  }
  return { request: parsed.request as Record<string, unknown> };
}

export function parseAppendLocalImageBlockOnLatestUserInputOutput(
  raw: string
): NativeAppendLocalImageBlockOnLatestUserInputOutput | null {
  const parsed = parseRecord(raw);
  if (!parsed || !Array.isArray(parsed.messages)) {
    return null;
  }
  const messages = parsed.messages.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
  );
  return { messages };
}

export function parseBridgeInputToChatOutput(raw: string): NativeBridgeInputToChatOutput | null {
  const parsed = parseRecord(raw);
  if (!parsed || !Array.isArray(parsed.messages)) {
    return null;
  }
  const messages = parsed.messages.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
  );
  return { messages };
}

export function parseBridgeActionState(raw: string): NativeBridgeActionState | null {
  const row = parseRecord(raw, 'parseBridgeActionState');
  if (!row || !Array.isArray(row.messages)) {
    return null;
  }
  const output: NativeBridgeActionState = {
    messages: row.messages
  };
  if (Array.isArray(row.input)) {
    output.input = row.input;
  }
  if (row.requiredAction && typeof row.requiredAction === 'object' && !Array.isArray(row.requiredAction)) {
    output.requiredAction = row.requiredAction as Record<string, unknown>;
  }
  if (Array.isArray(row.capturedToolResults)) {
    output.capturedToolResults = row.capturedToolResults.filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
    );
  }
  if (row.rawRequest && typeof row.rawRequest === 'object' && !Array.isArray(row.rawRequest)) {
    output.rawRequest = row.rawRequest as Record<string, unknown>;
  }
  if (row.rawResponse && typeof row.rawResponse === 'object' && !Array.isArray(row.rawResponse)) {
    output.rawResponse = row.rawResponse as Record<string, unknown>;
  }
  if (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)) {
    output.metadata = row.metadata as Record<string, unknown>;
  }
  return output;
}

export function parseApplyBridgeNormalizeHistoryOutput(
  raw: string
): NativeApplyBridgeNormalizeHistoryOutput | null {
  const row = parseRecord(raw, 'parseApplyBridgeNormalizeHistoryOutput');
  if (!row || !Array.isArray(row.messages)) {
    return null;
  }
  const output: NativeApplyBridgeNormalizeHistoryOutput = {
    messages: row.messages
  };
  if (row.bridgeHistory && typeof row.bridgeHistory === 'object' && !Array.isArray(row.bridgeHistory)) {
    output.bridgeHistory = row.bridgeHistory as Record<string, unknown>;
  }
  return output;
}

export function parseApplyBridgeCaptureToolResultsOutput(
  raw: string
): NativeApplyBridgeCaptureToolResultsOutput | null {
  const row = parseRecord(raw, 'parseApplyBridgeCaptureToolResultsOutput');
  if (!row) {
    return null;
  }
  const output: NativeApplyBridgeCaptureToolResultsOutput = {};
  if (Array.isArray(row.capturedToolResults)) {
    output.capturedToolResults = row.capturedToolResults.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
    );
  }
  if (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)) {
    output.metadata = row.metadata as Record<string, unknown>;
  }
  return output;
}

export function parseApplyBridgeEnsureToolPlaceholdersOutput(
  raw: string
): NativeApplyBridgeEnsureToolPlaceholdersOutput | null {
  const row = parseRecord(raw, 'parseApplyBridgeEnsureToolPlaceholdersOutput');
  if (!row || !Array.isArray(row.messages)) {
    return null;
  }
  const output: NativeApplyBridgeEnsureToolPlaceholdersOutput = {
    messages: row.messages
  };
  if (Array.isArray(row.toolOutputs)) {
    output.toolOutputs = row.toolOutputs.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
    );
  }
  return output;
}

export function parseEnsureBridgeOutputFieldsOutput(
  raw: string
): NativeEnsureBridgeOutputFieldsOutput | null {
  const row = parseRecord(raw, 'parseEnsureBridgeOutputFieldsOutput');
  if (!row || !Array.isArray(row.messages)) {
    return null;
  }
  return {
    messages: row.messages
  };
}

export function parseApplyBridgeMetadataActionOutput(
  raw: string
): NativeApplyBridgeMetadataActionOutput | null {
  const row = parseRecord(raw, 'parseApplyBridgeMetadataActionOutput');
  if (!row) {
    return null;
  }
  const output: NativeApplyBridgeMetadataActionOutput = {};
  if (row.rawRequest && typeof row.rawRequest === 'object' && !Array.isArray(row.rawRequest)) {
    output.rawRequest = row.rawRequest as Record<string, unknown>;
  }
  if (row.rawResponse && typeof row.rawResponse === 'object' && !Array.isArray(row.rawResponse)) {
    output.rawResponse = row.rawResponse as Record<string, unknown>;
  }
  if (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)) {
    output.metadata = row.metadata as Record<string, unknown>;
  }
  return output;
}

export function parseApplyBridgeReasoningExtractOutput(
  raw: string
): NativeApplyBridgeReasoningExtractOutput | null {
  const row = parseRecord(raw, 'parseApplyBridgeReasoningExtractOutput');
  if (!row || !Array.isArray(row.messages)) {
    return null;
  }
  return {
    messages: row.messages
  };
}

export function parseApplyBridgeResponsesOutputReasoningOutput(
  raw: string
): NativeApplyBridgeResponsesOutputReasoningOutput | null {
  const row = parseRecord(raw, 'parseApplyBridgeResponsesOutputReasoningOutput');
  if (!row || !Array.isArray(row.messages)) {
    return null;
  }
  return {
    messages: row.messages
  };
}

export function parseApplyBridgeInjectSystemInstructionOutput(
  raw: string
): NativeApplyBridgeInjectSystemInstructionOutput | null {
  const row = parseRecord(raw, 'parseApplyBridgeInjectSystemInstructionOutput');
  if (!row || !Array.isArray(row.messages)) {
    return null;
  }
  return {
    messages: row.messages
  };
}

export function parseApplyBridgeEnsureSystemInstructionOutput(
  raw: string
): NativeApplyBridgeEnsureSystemInstructionOutput | null {
  const row = parseRecord(raw, 'parseApplyBridgeEnsureSystemInstructionOutput');
  if (!row || !Array.isArray(row.messages)) {
    return null;
  }
  const output: NativeApplyBridgeEnsureSystemInstructionOutput = {
    messages: row.messages
  };
  if (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)) {
    output.metadata = row.metadata as Record<string, unknown>;
  }
  return output;
}

export function parseNormalizeMessageReasoningToolsOutput(
  raw: string
): NativeNormalizeMessageReasoningToolsOutput | null {
  const row = parseRecord(raw, 'parseNormalizeMessageReasoningToolsOutput');
  if (!row || !row.message || typeof row.message !== 'object' || Array.isArray(row.message)) {
    return null;
  }
  const toolCallsAdded = typeof row.toolCallsAdded === 'number' && Number.isFinite(row.toolCallsAdded)
    ? Math.max(0, Math.floor(row.toolCallsAdded))
    : null;
  if (toolCallsAdded === null) {
    return null;
  }
  const output: NativeNormalizeMessageReasoningToolsOutput = {
    message: row.message as Record<string, unknown>,
    toolCallsAdded
  };
  if (typeof row.cleanedReasoning === 'string') {
    output.cleanedReasoning = row.cleanedReasoning;
  }
  return output;
}

export function parseRecord(raw: string, stage = 'parseRecord'): Record<string, unknown> | null {
  const parsed = parseJson(stage, raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}
