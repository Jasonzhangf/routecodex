import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export interface NativeBridgeToolCallIdsInput {
  messages: unknown[];
  rawRequest?: Record<string, unknown>;
  capturedToolResults?: Array<Record<string, unknown>>;
  idPrefix?: string;
}

export interface NativeBridgeToolCallIdsOutput {
  messages: unknown[];
  rawRequest?: Record<string, unknown>;
  capturedToolResults?: Array<Record<string, unknown>>;
}

export interface NativeApplyBridgeNormalizeToolIdentifiersInput {
  stage: 'request_inbound' | 'request_outbound' | 'response_inbound' | 'response_outbound';
  protocol?: string;
  moduleType?: string;
  messages: unknown[];
  rawRequest?: Record<string, unknown>;
  capturedToolResults?: Array<Record<string, unknown>>;
  idPrefix?: string;
}

export interface NativeBridgeHistoryInput {
  messages: unknown[];
  tools?: Array<Record<string, unknown>>;
}

export interface NativeBridgeHistoryOutput {
  input: unknown[];
  combinedSystemInstruction?: string;
  latestUserInstruction?: string;
  originalSystemMessages: string[];
}

export interface NativeNormalizeBridgeHistorySeedOutput {
  input: unknown[];
  combinedSystemInstruction?: string;
  latestUserInstruction?: string;
  originalSystemMessages: string[];
}

export interface NativeResolveResponsesBridgeToolsInput {
  originalTools?: Array<Record<string, unknown>>;
  chatTools?: Array<Record<string, unknown>>;
  hasServerSideWebSearch?: boolean;
  passthroughKeys?: string[];
  request?: Record<string, unknown>;
}

export interface NativeResolveResponsesBridgeToolsOutput {
  mergedTools?: Array<Record<string, unknown>>;
  request?: Record<string, unknown>;
}

export interface NativeResolveResponsesRequestBridgeDecisionsInput {
  context?: Record<string, unknown>;
  requestMetadata?: Record<string, unknown>;
  envelopeMetadata?: Record<string, unknown>;
  bridgeMetadata?: Record<string, unknown>;
  extraBridgeHistory?: Record<string, unknown>;
}

export interface NativeResolveResponsesRequestBridgeDecisionsOutput {
  forceWebSearch: boolean;
  toolCallIdStyle?: 'fc' | 'preserve';
  historySeed?: NativeBridgeHistoryOutput;
}

export interface NativeFilterBridgeInputForUpstreamInput {
  input: unknown[];
  allowToolCallId?: boolean;
}

export interface NativeFilterBridgeInputForUpstreamOutput {
  input: Array<Record<string, unknown>>;
}

export interface NativePrepareResponsesRequestEnvelopeInput {
  request: Record<string, unknown>;
  contextSystemInstruction?: unknown;
  extraSystemInstruction?: unknown;
  metadataSystemInstruction?: unknown;
  combinedSystemInstruction?: unknown;
  reasoningInstructionSegments?: unknown;
  contextParameters?: unknown;
  chatParameters?: unknown;
  metadataParameters?: unknown;
  contextStream?: unknown;
  metadataStream?: unknown;
  chatStream?: unknown;
  chatParametersStream?: unknown;
  contextInclude?: unknown;
  metadataInclude?: unknown;
  contextStore?: unknown;
  metadataStore?: unknown;
  stripHostFields?: boolean;
  contextToolChoice?: unknown;
  metadataToolChoice?: unknown;
  contextParallelToolCalls?: unknown;
  metadataParallelToolCalls?: unknown;
  contextResponseFormat?: unknown;
  metadataResponseFormat?: unknown;
  contextServiceTier?: unknown;
  metadataServiceTier?: unknown;
  contextTruncation?: unknown;
  metadataTruncation?: unknown;
  contextMetadata?: unknown;
  metadataMetadata?: unknown;
}

export interface NativePrepareResponsesRequestEnvelopeOutput {
  request: Record<string, unknown>;
}

export interface NativeAppendLocalImageBlockOnLatestUserInputInput {
  messages: unknown[];
}

export interface NativeAppendLocalImageBlockOnLatestUserInputOutput {
  messages: Array<Record<string, unknown>>;
}

export interface NativeApplyBridgeNormalizeHistoryInput {
  messages: unknown[];
  tools?: Array<Record<string, unknown>>;
}

export interface NativeApplyBridgeNormalizeHistoryOutput {
  messages: unknown[];
  bridgeHistory?: Record<string, unknown>;
}

export interface NativeApplyBridgeCaptureToolResultsInput {
  stage: 'request_inbound' | 'request_outbound' | 'response_inbound' | 'response_outbound';
  capturedToolResults?: Array<Record<string, unknown>>;
  rawRequest?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface NativeApplyBridgeCaptureToolResultsOutput {
  capturedToolResults?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

export interface NativeApplyBridgeEnsureToolPlaceholdersInput {
  stage: 'request_inbound' | 'request_outbound' | 'response_inbound' | 'response_outbound';
  messages: unknown[];
  capturedToolResults?: Array<Record<string, unknown>>;
  rawRequest?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
}

export interface NativeApplyBridgeEnsureToolPlaceholdersOutput {
  messages: unknown[];
  toolOutputs?: Array<Record<string, unknown>>;
}

export interface NativeBridgeInputToChatInput {
  input: unknown[];
  tools?: Array<Record<string, unknown>>;
  toolResultFallbackText?: string;
  normalizeFunctionName?: string;
}

export interface NativeBridgeInputToChatOutput {
  messages: Array<Record<string, unknown>>;
}

export interface NativeCoerceBridgeRoleInput {
  role: unknown;
}

export interface NativeSerializeToolArgumentsInput {
  args?: unknown;
}

export interface NativeSerializeToolOutputInput {
  output?: unknown;
}

export interface NativeEnsureMessagesArrayInput {
  state?: unknown;
}

export interface NativeEnsureMessagesArrayOutput {
  messages: Array<Record<string, unknown>>;
}

export interface NativeEnsureBridgeOutputFieldsInput {
  messages: unknown[];
  toolFallback?: string;
  assistantFallback?: string;
}

export interface NativeEnsureBridgeOutputFieldsOutput {
  messages: unknown[];
}

export interface NativeApplyBridgeMetadataActionInput {
  actionName: string;
  stage: 'request_inbound' | 'request_outbound' | 'response_inbound' | 'response_outbound';
  options?: Record<string, unknown>;
  rawRequest?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface NativeApplyBridgeMetadataActionOutput {
  rawRequest?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface NativeApplyBridgeReasoningExtractInput {
  messages: unknown[];
  dropFromContent?: boolean;
  idPrefixBase?: string;
}

export interface NativeApplyBridgeReasoningExtractOutput {
  messages: unknown[];
}

export interface NativeApplyBridgeResponsesOutputReasoningInput {
  messages: unknown[];
  rawResponse?: Record<string, unknown>;
  idPrefix?: string;
}

export interface NativeApplyBridgeResponsesOutputReasoningOutput {
  messages: unknown[];
}

export interface NativeApplyBridgeInjectSystemInstructionInput {
  stage: 'request_inbound' | 'request_outbound' | 'response_inbound' | 'response_outbound';
  options?: Record<string, unknown>;
  messages: unknown[];
  rawRequest?: Record<string, unknown>;
}

export interface NativeApplyBridgeInjectSystemInstructionOutput {
  messages: unknown[];
}

export interface NativeApplyBridgeEnsureSystemInstructionInput {
  stage: 'request_inbound' | 'request_outbound' | 'response_inbound' | 'response_outbound';
  messages: unknown[];
  metadata?: Record<string, unknown>;
}

export interface NativeApplyBridgeEnsureSystemInstructionOutput {
  messages: unknown[];
  metadata?: Record<string, unknown>;
}

export interface NativeBridgeActionPipelineInput {
  stage: 'request_inbound' | 'request_outbound' | 'response_inbound' | 'response_outbound';
  actions?: Array<{ name: string; options?: Record<string, unknown> }>;
  protocol?: string;
  moduleType?: string;
  requestId?: string;
  state: NativeBridgeActionState;
}

export interface NativeBridgeActionState {
  messages: unknown[];
  requiredAction?: Record<string, unknown>;
  capturedToolResults?: Array<Record<string, unknown>>;
  rawRequest?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface NativeNormalizeMessageReasoningToolsOutput {
  message: Record<string, unknown>;
  toolCallsAdded: number;
  cleanedReasoning?: string;
}

export interface NativeHarvestToolsInput {
  signal: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface NativeHarvestToolsOutput {
  deltaEvents: Array<Record<string, unknown>>;
  normalized?: Record<string, unknown>;
  stats?: Record<string, unknown>;
}

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseOutput(raw: string): NativeBridgeToolCallIdsOutput | null {
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

function parseEnsureMessagesArrayOutput(raw: string): NativeEnsureMessagesArrayOutput | null {
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

function parseBridgeHistoryOutput(raw: string): NativeBridgeHistoryOutput | null {
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

function parseNormalizeBridgeHistorySeedOutput(raw: string): NativeNormalizeBridgeHistorySeedOutput | null {
  return parseBridgeHistoryOutput(raw);
}

function parseResolveResponsesBridgeToolsOutput(
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

function parseResolveResponsesRequestBridgeDecisionsOutput(
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

function parseFilterBridgeInputForUpstreamOutput(
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

function parsePrepareResponsesRequestEnvelopeOutput(
  raw: string
): NativePrepareResponsesRequestEnvelopeOutput | null {
  const parsed = parseRecord(raw);
  if (!parsed || !parsed.request || typeof parsed.request !== 'object' || Array.isArray(parsed.request)) {
    return null;
  }
  return { request: parsed.request as Record<string, unknown> };
}

function parseAppendLocalImageBlockOnLatestUserInputOutput(
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

function parseBridgeInputToChatOutput(raw: string): NativeBridgeInputToChatOutput | null {
  const parsed = parseRecord(raw);
  if (!parsed || !Array.isArray(parsed.messages)) {
    return null;
  }
  const messages = parsed.messages.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
  );
  return { messages };
}

function parseBridgeActionState(raw: string): NativeBridgeActionState | null {
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

function parseApplyBridgeNormalizeHistoryOutput(
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

function parseApplyBridgeCaptureToolResultsOutput(
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

function parseApplyBridgeEnsureToolPlaceholdersOutput(
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

function parseEnsureBridgeOutputFieldsOutput(
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

function parseApplyBridgeMetadataActionOutput(
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

function parseApplyBridgeReasoningExtractOutput(
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

function parseApplyBridgeResponsesOutputReasoningOutput(
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

function parseApplyBridgeInjectSystemInstructionOutput(
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

function parseApplyBridgeEnsureSystemInstructionOutput(
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

function parseNormalizeMessageReasoningToolsOutput(
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

function parseRecord(raw: string): Record<string, unknown> | null {
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

export function normalizeBridgeToolCallIdsWithNative(
  input: NativeBridgeToolCallIdsInput
): NativeBridgeToolCallIdsOutput {
  const capability = 'normalizeBridgeToolCallIdsJson';
  const fail = (reason?: string) => failNativeRequired<NativeBridgeToolCallIdsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    messages: input.messages,
    rawRequest: input.rawRequest,
    capturedToolResults: input.capturedToolResults,
    idPrefix: input.idPrefix
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeNormalizeToolIdentifiersWithNative(
  input: NativeApplyBridgeNormalizeToolIdentifiersInput
): NativeBridgeToolCallIdsOutput {
  const capability = 'applyBridgeNormalizeToolIdentifiersJson';
  const fail = (reason?: string) => failNativeRequired<NativeBridgeToolCallIdsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    stage: input.stage,
    protocol: input.protocol,
    moduleType: input.moduleType,
    messages: input.messages,
    rawRequest: input.rawRequest,
    capturedToolResults: input.capturedToolResults,
    idPrefix: input.idPrefix
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildBridgeHistoryWithNative(
  input: NativeBridgeHistoryInput
): NativeBridgeHistoryOutput {
  const capability = 'buildBridgeHistoryJson';
  const fail = (reason?: string) => failNativeRequired<NativeBridgeHistoryOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    messages: input.messages,
    tools: input.tools
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseBridgeHistoryOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeBridgeHistorySeedWithNative(
  seed: Record<string, unknown>
): NativeNormalizeBridgeHistorySeedOutput {
  const capability = 'normalizeBridgeHistorySeedJson';
  const fail = (reason?: string) => failNativeRequired<NativeNormalizeBridgeHistorySeedOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(seed);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeBridgeHistorySeedOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveResponsesBridgeToolsWithNative(
  input: NativeResolveResponsesBridgeToolsInput
): NativeResolveResponsesBridgeToolsOutput {
  const capability = 'resolveResponsesBridgeToolsJson';
  const fail = (reason?: string) => failNativeRequired<NativeResolveResponsesBridgeToolsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    originalTools: input.originalTools,
    chatTools: input.chatTools,
    hasServerSideWebSearch: input.hasServerSideWebSearch,
    passthroughKeys: input.passthroughKeys,
    request: input.request
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseResolveResponsesBridgeToolsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveResponsesRequestBridgeDecisionsWithNative(
  input: NativeResolveResponsesRequestBridgeDecisionsInput
): NativeResolveResponsesRequestBridgeDecisionsOutput {
  const capability = 'resolveResponsesRequestBridgeDecisionsJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeResolveResponsesRequestBridgeDecisionsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    context: input.context,
    requestMetadata: input.requestMetadata,
    envelopeMetadata: input.envelopeMetadata,
    bridgeMetadata: input.bridgeMetadata,
    extraBridgeHistory: input.extraBridgeHistory
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseResolveResponsesRequestBridgeDecisionsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function filterBridgeInputForUpstreamWithNative(
  input: NativeFilterBridgeInputForUpstreamInput
): NativeFilterBridgeInputForUpstreamOutput {
  const capability = 'filterBridgeInputForUpstreamJson';
  const fail = (reason?: string) => failNativeRequired<NativeFilterBridgeInputForUpstreamOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    input: input.input,
    allowToolCallId: input.allowToolCallId
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseFilterBridgeInputForUpstreamOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function prepareResponsesRequestEnvelopeWithNative(
  input: NativePrepareResponsesRequestEnvelopeInput
): NativePrepareResponsesRequestEnvelopeOutput {
  const capability = 'prepareResponsesRequestEnvelopeJson';
  const fail = (reason?: string) => failNativeRequired<NativePrepareResponsesRequestEnvelopeOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    request: input.request,
    contextSystemInstruction: input.contextSystemInstruction,
    extraSystemInstruction: input.extraSystemInstruction,
    metadataSystemInstruction: input.metadataSystemInstruction,
    combinedSystemInstruction: input.combinedSystemInstruction,
    reasoningInstructionSegments: input.reasoningInstructionSegments,
    contextParameters: input.contextParameters,
    chatParameters: input.chatParameters,
    metadataParameters: input.metadataParameters,
    contextStream: input.contextStream,
    metadataStream: input.metadataStream,
    chatStream: input.chatStream,
    chatParametersStream: input.chatParametersStream,
    contextInclude: input.contextInclude,
    metadataInclude: input.metadataInclude,
    contextStore: input.contextStore,
    metadataStore: input.metadataStore,
    stripHostFields: input.stripHostFields,
    contextToolChoice: input.contextToolChoice,
    metadataToolChoice: input.metadataToolChoice,
    contextParallelToolCalls: input.contextParallelToolCalls,
    metadataParallelToolCalls: input.metadataParallelToolCalls,
    contextResponseFormat: input.contextResponseFormat,
    metadataResponseFormat: input.metadataResponseFormat,
    contextServiceTier: input.contextServiceTier,
    metadataServiceTier: input.metadataServiceTier,
    contextTruncation: input.contextTruncation,
    metadataTruncation: input.metadataTruncation,
    contextMetadata: input.contextMetadata,
    metadataMetadata: input.metadataMetadata
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parsePrepareResponsesRequestEnvelopeOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function appendLocalImageBlockOnLatestUserInputWithNative(
  input: NativeAppendLocalImageBlockOnLatestUserInputInput
): NativeAppendLocalImageBlockOnLatestUserInputOutput {
  const capability = 'appendLocalImageBlockOnLatestUserInputJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeAppendLocalImageBlockOnLatestUserInputOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    messages: input.messages
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseAppendLocalImageBlockOnLatestUserInputOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeNormalizeHistoryWithNative(
  input: NativeApplyBridgeNormalizeHistoryInput
): NativeApplyBridgeNormalizeHistoryOutput {
  const capability = 'applyBridgeNormalizeHistoryJson';
  const fail = (reason?: string) => failNativeRequired<NativeApplyBridgeNormalizeHistoryOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    messages: input.messages,
    tools: input.tools
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeNormalizeHistoryOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeCaptureToolResultsWithNative(
  input: NativeApplyBridgeCaptureToolResultsInput
): NativeApplyBridgeCaptureToolResultsOutput {
  const capability = 'applyBridgeCaptureToolResultsJson';
  const fail = (reason?: string) => failNativeRequired<NativeApplyBridgeCaptureToolResultsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    stage: input.stage,
    capturedToolResults: input.capturedToolResults,
    rawRequest: input.rawRequest,
    rawResponse: input.rawResponse,
    metadata: input.metadata
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeCaptureToolResultsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeEnsureToolPlaceholdersWithNative(
  input: NativeApplyBridgeEnsureToolPlaceholdersInput
): NativeApplyBridgeEnsureToolPlaceholdersOutput {
  const capability = 'applyBridgeEnsureToolPlaceholdersJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeApplyBridgeEnsureToolPlaceholdersOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    stage: input.stage,
    messages: input.messages,
    capturedToolResults: input.capturedToolResults,
    rawRequest: input.rawRequest,
    rawResponse: input.rawResponse
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeEnsureToolPlaceholdersOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function convertBridgeInputToChatMessagesWithNative(
  input: NativeBridgeInputToChatInput
): NativeBridgeInputToChatOutput {
  const capability = 'convertBridgeInputToChatMessagesJson';
  const fail = (reason?: string) => failNativeRequired<NativeBridgeInputToChatOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    input: input.input,
    tools: input.tools,
    toolResultFallbackText: input.toolResultFallbackText,
    normalizeFunctionName: input.normalizeFunctionName
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseBridgeInputToChatOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function coerceBridgeRoleWithNative(role: unknown): string {
  const capability = 'coerceBridgeRoleJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ role });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function serializeToolOutputWithNative(input: NativeSerializeToolOutputInput): string | null {
  const capability = 'serializeToolOutputJson';
  const fail = (reason?: string) => failNativeRequired<string | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ output: input.output });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string') {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' || parsed === null ? (parsed as string | null) : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function serializeToolArgumentsWithNative(input: NativeSerializeToolArgumentsInput): string {
  const capability = 'serializeToolArgumentsJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ args: input.args });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function ensureMessagesArrayWithNative(
  input: NativeEnsureMessagesArrayInput
): NativeEnsureMessagesArrayOutput {
  const capability = 'ensureMessagesArrayJson';
  const fail = (reason?: string) => failNativeRequired<NativeEnsureMessagesArrayOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ state: input.state });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseEnsureMessagesArrayOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function harvestToolsWithNative(input: NativeHarvestToolsInput): NativeHarvestToolsOutput {
  const capability = 'harvestToolsJson';
  const fail = (reason?: string) => failNativeRequired<NativeHarvestToolsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ signal: input.signal, context: input.context });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const row = parsed as Record<string, unknown>;
    if (!Array.isArray(row.deltaEvents)) {
      return fail('invalid payload');
    }
    return row as unknown as NativeHarvestToolsOutput;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function ensureBridgeOutputFieldsWithNative(
  input: NativeEnsureBridgeOutputFieldsInput
): NativeEnsureBridgeOutputFieldsOutput {
  const capability = 'ensureBridgeOutputFieldsJson';
  const fail = (reason?: string) => failNativeRequired<NativeEnsureBridgeOutputFieldsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    messages: input.messages,
    toolFallback: input.toolFallback,
    assistantFallback: input.assistantFallback
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseEnsureBridgeOutputFieldsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeMetadataActionWithNative(
  input: NativeApplyBridgeMetadataActionInput
): NativeApplyBridgeMetadataActionOutput {
  const capability = 'applyBridgeMetadataActionJson';
  const fail = (reason?: string) => failNativeRequired<NativeApplyBridgeMetadataActionOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    actionName: input.actionName,
    stage: input.stage,
    options: input.options,
    rawRequest: input.rawRequest,
    rawResponse: input.rawResponse,
    metadata: input.metadata
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeMetadataActionOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeReasoningExtractWithNative(
  input: NativeApplyBridgeReasoningExtractInput
): NativeApplyBridgeReasoningExtractOutput {
  const capability = 'applyBridgeReasoningExtractJson';
  const fail = (reason?: string) => failNativeRequired<NativeApplyBridgeReasoningExtractOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    messages: input.messages,
    dropFromContent: input.dropFromContent,
    idPrefixBase: input.idPrefixBase
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeReasoningExtractOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeResponsesOutputReasoningWithNative(
  input: NativeApplyBridgeResponsesOutputReasoningInput
): NativeApplyBridgeResponsesOutputReasoningOutput {
  const capability = 'applyBridgeResponsesOutputReasoningJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeApplyBridgeResponsesOutputReasoningOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    messages: input.messages,
    rawResponse: input.rawResponse,
    idPrefix: input.idPrefix
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeResponsesOutputReasoningOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeInjectSystemInstructionWithNative(
  input: NativeApplyBridgeInjectSystemInstructionInput
): NativeApplyBridgeInjectSystemInstructionOutput {
  const capability = 'applyBridgeInjectSystemInstructionJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeApplyBridgeInjectSystemInstructionOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    stage: input.stage,
    options: input.options,
    messages: input.messages,
    rawRequest: input.rawRequest
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeInjectSystemInstructionOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyBridgeEnsureSystemInstructionWithNative(
  input: NativeApplyBridgeEnsureSystemInstructionInput
): NativeApplyBridgeEnsureSystemInstructionOutput {
  const capability = 'applyBridgeEnsureSystemInstructionJson';
  const fail = (reason?: string) =>
    failNativeRequired<NativeApplyBridgeEnsureSystemInstructionOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    stage: input.stage,
    messages: input.messages,
    metadata: input.metadata
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseApplyBridgeEnsureSystemInstructionOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function runBridgeActionPipelineWithNative(
  input: NativeBridgeActionPipelineInput
): NativeBridgeActionState | null {
  const capability = 'runBridgeActionPipelineJson';
  const fail = (reason?: string) => failNativeRequired<NativeBridgeActionState>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    stage: input.stage,
    actions: input.actions,
    protocol: input.protocol,
    moduleType: input.moduleType,
    requestId: input.requestId,
    state: input.state
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseBridgeActionState(raw);
    if (!parsed) {
      return null;
    }
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeMessageReasoningToolsWithNative(
  message: Record<string, unknown>,
  idPrefix?: string
): NativeNormalizeMessageReasoningToolsOutput {
  const capability = 'normalizeMessageReasoningToolsJson';
  const fail = (reason?: string) => failNativeRequired<NativeNormalizeMessageReasoningToolsOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const messageJson = safeStringify(message);
  if (!messageJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(messageJson, typeof idPrefix === 'string' && idPrefix.trim().length ? idPrefix.trim() : undefined);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeMessageReasoningToolsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeChatResponseReasoningToolsWithNative(
  response: Record<string, unknown>,
  idPrefixBase?: string
): Record<string, unknown> {
  const capability = 'normalizeChatResponseReasoningToolsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const responseJson = safeStringify(response);
  if (!responseJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(
      responseJson,
      typeof idPrefixBase === 'string' && idPrefixBase.trim().length ? idPrefixBase.trim() : undefined
    );
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
