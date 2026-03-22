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

export function parseOutput(raw: string): NativeBridgeToolCallIdsOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.messages)) {
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
  } catch {
    return null;
  }
}

export function parseEnsureMessagesArrayOutput(raw: string): NativeEnsureMessagesArrayOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const messages = Array.isArray(row.messages) ? (row.messages as Array<Record<string, unknown>>) : [];
    return { messages };
  } catch {
    return null;
  }
}

export function parseBridgeHistoryOutput(raw: string): NativeBridgeHistoryOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.input) || !Array.isArray(row.originalSystemMessages)) {
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
  } catch {
    return null;
  }
}

export function parseNormalizeBridgeHistorySeedOutput(raw: string): NativeNormalizeBridgeHistorySeedOutput | null {
  return parseBridgeHistoryOutput(raw);
}

export function parseResolveResponsesBridgeToolsOutput(
  raw: string
): NativeResolveResponsesBridgeToolsOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
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
  } catch {
    return null;
  }
}

export function parseResolveResponsesRequestBridgeDecisionsOutput(
  raw: string
): NativeResolveResponsesRequestBridgeDecisionsOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (typeof row.forceWebSearch !== 'boolean') {
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
    return output;
  } catch {
    return null;
  }
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
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.messages)) {
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
  } catch {
    return null;
  }
}

export function parseApplyBridgeNormalizeHistoryOutput(
  raw: string
): NativeApplyBridgeNormalizeHistoryOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.messages)) {
      return null;
    }
    const output: NativeApplyBridgeNormalizeHistoryOutput = {
      messages: row.messages
    };
    if (row.bridgeHistory && typeof row.bridgeHistory === 'object' && !Array.isArray(row.bridgeHistory)) {
      output.bridgeHistory = row.bridgeHistory as Record<string, unknown>;
    }
    return output;
  } catch {
    return null;
  }
}

export function parseApplyBridgeCaptureToolResultsOutput(
  raw: string
): NativeApplyBridgeCaptureToolResultsOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
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
  } catch {
    return null;
  }
}

export function parseApplyBridgeEnsureToolPlaceholdersOutput(
  raw: string
): NativeApplyBridgeEnsureToolPlaceholdersOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.messages)) {
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
  } catch {
    return null;
  }
}

export function parseEnsureBridgeOutputFieldsOutput(
  raw: string
): NativeEnsureBridgeOutputFieldsOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.messages)) {
      return null;
    }
    return {
      messages: row.messages
    };
  } catch {
    return null;
  }
}

export function parseApplyBridgeMetadataActionOutput(
  raw: string
): NativeApplyBridgeMetadataActionOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
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
  } catch {
    return null;
  }
}

export function parseApplyBridgeReasoningExtractOutput(
  raw: string
): NativeApplyBridgeReasoningExtractOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.messages)) {
      return null;
    }
    return {
      messages: row.messages
    };
  } catch {
    return null;
  }
}

export function parseApplyBridgeResponsesOutputReasoningOutput(
  raw: string
): NativeApplyBridgeResponsesOutputReasoningOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.messages)) {
      return null;
    }
    return {
      messages: row.messages
    };
  } catch {
    return null;
  }
}

export function parseApplyBridgeInjectSystemInstructionOutput(
  raw: string
): NativeApplyBridgeInjectSystemInstructionOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.messages)) {
      return null;
    }
    return {
      messages: row.messages
    };
  } catch {
    return null;
  }
}

export function parseApplyBridgeEnsureSystemInstructionOutput(
  raw: string
): NativeApplyBridgeEnsureSystemInstructionOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.messages)) {
      return null;
    }
    const output: NativeApplyBridgeEnsureSystemInstructionOutput = {
      messages: row.messages
    };
    if (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)) {
      output.metadata = row.metadata as Record<string, unknown>;
    }
    return output;
  } catch {
    return null;
  }
}

export function parseNormalizeMessageReasoningToolsOutput(
  raw: string
): NativeNormalizeMessageReasoningToolsOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (!row.message || typeof row.message !== 'object' || Array.isArray(row.message)) {
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
  } catch {
    return null;
  }
}

export function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
