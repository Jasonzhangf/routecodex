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
  input?: unknown[];
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
