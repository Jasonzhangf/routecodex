function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
import {
  buildChatResponseFromResponsesFullWithNative,
  buildProviderProtocolErrorWithNative,
  createToolCallIdTransformerWithNative,
  ensureBridgeInstructionsWithNative,
  ensureRuntimeMetadataCarrierWithNative,
  mapChatToolsToBridgeWithNative,
  normalizeFunctionCallIdWithNative,
  normalizeFunctionCallOutputIdWithNative,
  normalizeResponsesCallIdWithNative,
  stripInternalToolingMetadataWithNative
} from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics.js';
import {
  captureReqInboundResponsesContextSnapshotWithNative,
  mapReqInboundBridgeToolsToChatWithNative
} from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics.js';
import {
  appendLocalImageBlockOnLatestUserInputWithNative,
  buildBridgeHistoryWithNative,
  buildSlimResponsesBridgeContextWithNative,
  convertBridgeInputToChatMessagesWithNative,
  extractResponsesMetadataExtraFieldsWithNative,
  filterBridgeInputForUpstreamWithNative,
  mergeRetainedResponsesRequestParametersWithNative,
  normalizeBridgeHistorySeedWithNative,
  pickResponsesBridgeDecisionMetadataWithNative,
  pickResponsesRequestParametersWithNative,
  pickResponsesToolPassthroughFieldsWithNative,
  prepareResponsesRequestEnvelopeWithNative,
  resolveResponsesRequestBridgeDecisionsWithNative,
  resolveResponsesBridgeToolsWithNative,
  runBridgeActionPipelineWithNative,
  sanitizeCapturedResponsesInputWithNative,
  stripResponsesToolControlFieldsWithNative,
  unwrapResponsesDataWithNative
} from './native-hub-bridge-action-direct-native.js';
import {
  buildResponsesPayloadFromChatWithNative,
  consumeResponsesPassthroughByAliasesWithNative as consumeResponsesPassthroughByAliases,
  consumeResponsesPayloadSnapshotByAliasesWithNative as consumeResponsesPayloadSnapshotByAliases,
  evaluateResponsesHostPolicyWithNative,
  planResponsesPayloadFromChatCloseoutWithNative,
} from './helpers/resp-semantics-direct-native.js';
import {
  resolveBridgePolicyActionsWithNative,
  resolveBridgePolicyWithNative,
  planResponsesBridgePolicyActionsWithNative
} from './native-hub-bridge-policy-direct-native.js';
export type Unknown = Record<string, unknown>;
type JsonObject = Record<string, unknown>;
type JsonValue = unknown;
type ProviderErrorCategory = 'EXTERNAL_ERROR' | 'TOOL_ERROR' | 'INTERNAL_ERROR';
type ToolCallIdStyle = 'preserve' | 'fc';
type RuntimeMetadataCarrier = Record<string, unknown> & { __rt?: JsonObject };
const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');
const RUST_SNAPSHOT_SYMBOL = Symbol.for('routecodex.metadataCenter.rustSnapshot');

interface CallIdTransformer {
  normalizeCallId(raw: unknown): string;
  normalizeItemId(raw: unknown, callId: string): string;
  normalizeOutputId(callId: string, raw: unknown): string;
}

type BridgeContentPart = {
  type: string;
  text?: string;
  content?: unknown;
};

export type BridgeInputItem = {
  type: string;
  role?: string;
  content?: Array<BridgeContentPart> | null;
  name?: string;
  arguments?: unknown;
  call_id?: string;
  output?: unknown;
  function?: { name?: string; arguments?: unknown };
  message?: { role?: string; content?: Array<BridgeContentPart> };
  id?: string;
  tool_call_id?: string;
  tool_use_id?: string;
  text?: string;
};

export interface BridgeInputBuildResult {
  input: BridgeInputItem[];
  combinedSystemInstruction?: string;
  latestUserInstruction?: string;
  originalSystemMessages: string[];
}

type ChatToolDefinition = {
  type: 'function' | string;
  name?: string;
  description?: string;
  defer_loading?: boolean;
  tools?: Array<{
    type?: 'function' | string;
    name?: string;
    description?: string;
    parameters?: unknown;
    strict?: boolean;
    defer_loading?: boolean;
  }>;
  function?: {
    name: string;
    description?: string;
    parameters?: unknown;
    strict?: boolean;
  };
  [key: string]: unknown;
};

type BridgeToolDefinition = {
  type: string;
  name?: string;
  description?: string;
  strict?: boolean;
  defer_loading?: boolean;
  parameters?: unknown;
  tools?: Array<{
    type?: string;
    name?: string;
    description?: string;
    strict?: boolean;
    defer_loading?: boolean;
    parameters?: unknown;
    function?: {
      name?: string;
      description?: string;
      strict?: boolean;
      parameters?: unknown;
    };
  }>;
  function?: {
    name?: string;
    description?: string;
    strict?: boolean;
    parameters?: unknown;
  };
};

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function preserveMetadataCenterBinding(
  source: Record<string, unknown>,
  target: Record<string, unknown>
): void {
  const sourceCenter = Reflect.get(source, METADATA_CENTER_SYMBOL);
  if (sourceCenter !== undefined) {
    Reflect.set(target, METADATA_CENTER_SYMBOL, sourceCenter);
  }
  const sourceMetadata = source.metadata;
  const targetMetadata = target.metadata;
  if (
    sourceMetadata
    && typeof sourceMetadata === 'object'
    && !Array.isArray(sourceMetadata)
    && targetMetadata
    && typeof targetMetadata === 'object'
    && !Array.isArray(targetMetadata)
  ) {
    const metadataCenter = Reflect.get(sourceMetadata as Record<string, unknown>, METADATA_CENTER_SYMBOL);
    if (metadataCenter !== undefined) {
      Reflect.set(targetMetadata as Record<string, unknown>, METADATA_CENTER_SYMBOL, metadataCenter);
    }
  }
  const sourceSnapshot = Reflect.get(source, RUST_SNAPSHOT_SYMBOL);
  if (sourceSnapshot !== undefined) {
    Reflect.set(target, RUST_SNAPSHOT_SYMBOL, sourceSnapshot);
  }
}

function ensureRuntimeMetadata(carrier: Record<string, unknown>): JsonObject {
  if (!carrier || typeof carrier !== 'object') {
    throw new Error('ensureRuntimeMetadata requires object carrier');
  }
  const nextCarrier = ensureRuntimeMetadataCarrierWithNative(carrier);
  preserveMetadataCenterBinding(carrier, nextCarrier as Record<string, unknown>);
  for (const key of Object.keys(carrier)) {
    if (!Object.prototype.hasOwnProperty.call(nextCarrier, key)) {
      delete (carrier as Record<string, unknown>)[key];
    }
  }
  Object.assign(carrier, nextCarrier);
  const existing = (carrier as RuntimeMetadataCarrier).__rt;
  if (existing && isJsonObject(existing)) {
    return existing;
  }
  (carrier as RuntimeMetadataCarrier).__rt = {};
  return (carrier as RuntimeMetadataCarrier).__rt as JsonObject;
}

function assertResponsesBridgeToolNativeAvailable(): void {
  if (
    typeof createToolCallIdTransformerWithNative !== 'function' ||
    typeof normalizeFunctionCallIdWithNative !== 'function' ||
    typeof normalizeFunctionCallOutputIdWithNative !== 'function' ||
    typeof normalizeResponsesCallIdWithNative !== 'function' ||
    typeof stripInternalToolingMetadataWithNative !== 'function'
  ) {
    throw new Error('[responses-openai-bridge] responses tool native bindings unavailable');
  }
}

function createToolCallIdTransformer(style: ToolCallIdStyle): CallIdTransformer | null {
  assertResponsesBridgeToolNativeAvailable();
  if (style !== 'fc') {
    return null;
  }
  const state = createToolCallIdTransformerWithNative(style);
  return {
    normalizeCallId(raw: unknown): string {
      return normalizeResponsesCallIdWithNative({
        callId: typeof raw === 'string' && raw.trim().length ? raw.trim() : undefined,
        fallback: transformCounter(state, 'call')
      });
    },
    normalizeItemId(raw: unknown, callId: string): string {
      return normalizeFunctionCallIdWithNative({
        callId: typeof raw === 'string' && raw.trim().length ? raw.trim() : callId,
        fallback: transformCounter(state, 'item')
      });
    },
    normalizeOutputId(callId: string, raw: unknown): string {
      return normalizeFunctionCallOutputIdWithNative({
        callId,
        fallback: typeof raw === 'string' && raw.trim().length ? raw.trim() : transformCounter(state, 'tool')
      });
    }
  };
}

function transformCounter(state: Record<string, unknown>, prefix: string): string {
  const current = typeof state.__counter === 'number' ? state.__counter : 0;
  const next = current + 1;
  state.__counter = next;
  return `${prefix}_${next}`;
}

function replaceMutableRecord(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, next);
}

function stripInternalToolingMetadata(metadata: unknown): void {
  assertResponsesBridgeToolNativeAvailable();
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
  const normalized = stripInternalToolingMetadataWithNative(metadata);
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    replaceMutableRecord(metadata as Record<string, unknown>, normalized);
  }
}

function enforceToolCallIdStyle(input: BridgeInputItem[], transformer: CallIdTransformer): void {
  assertResponsesBridgeToolNativeAvailable();
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const type = typeof (entry as any).type === 'string' ? (entry as any).type.toLowerCase() : '';
    if (type === 'function_call') {
      const normalizedCallId = transformer.normalizeCallId((entry as any).call_id ?? (entry as any).id);
      (entry as any).call_id = normalizedCallId;
      (entry as any).id = transformer.normalizeItemId((entry as any).id ?? normalizedCallId, normalizedCallId);
      continue;
    }
    if (type === 'function_call_output' || type === 'tool_result' || type === 'tool_message') {
      const normalizedCallId = transformer.normalizeCallId(
        (entry as any).call_id ?? (entry as any).tool_call_id ?? (entry as any).id
      );
      (entry as any).call_id = normalizedCallId;
      (entry as any).tool_call_id = normalizedCallId;
      (entry as any).id = transformer.normalizeOutputId(normalizedCallId, (entry as any).id);
    }
  }
}

export interface ResponsesRequestContext extends Unknown {
  requestId?: string;
  targetProtocol?: string;
  originalSystemMessages?: string[];
  input?: BridgeInputItem[];
  metadata?: JsonObject;
  isChatPayload?: boolean;
  isResponsesPayload?: boolean;
  historyMessages?: Array<{ role: string; content: string }>;
  currentMessage?: { role: string; content: string } | null;
  toolsRaw?: BridgeToolDefinition[];
  toolsNormalized?: Array<Record<string, unknown>>;
  parameters?: Record<string, unknown>;
  systemInstruction?: string;
  toolCallIdStyle?: ToolCallIdStyle;
}

export interface BuildChatRequestResult {
  request: Record<string, unknown>;
  toolsNormalized?: ChatToolDefinition[];
}

export interface BuildResponsesRequestResult {
  request: Record<string, unknown>;
  originalSystemMessages?: string[];
}

function readCapturedToolResults(context: ResponsesRequestContext): Array<Record<string, unknown>> | undefined {
  const raw = (context as Record<string, unknown>).__captured_tool_results;
  return Array.isArray(raw)
    ? raw.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    : undefined;
}

function runNativeResponsesBridgePipeline(input: {
  stage: 'request_inbound' | 'request_outbound';
  actions?: Array<{ name: string; options?: Record<string, unknown> }>;
  protocol: 'openai-responses';
  moduleType: 'openai-responses';
  requestId?: string;
  messages: Array<Record<string, unknown>>;
  capturedToolResults?: Array<Record<string, unknown>>;
  rawRequest?: Record<string, unknown>;
}): {
  messages: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
} {
  const output = runBridgeActionPipelineWithNative({
    stage: input.stage,
    actions: input.actions,
    protocol: input.protocol,
    moduleType: input.moduleType,
    requestId: input.requestId,
    state: {
      messages: input.messages,
      ...(Array.isArray(input.capturedToolResults) ? { capturedToolResults: input.capturedToolResults } : {}),
      ...(input.rawRequest ? { rawRequest: input.rawRequest } : {})
    }
  });
  return {
    messages: Array.isArray(output?.messages) ? (output.messages as Array<Record<string, unknown>>) : input.messages,
    metadata:
      output?.metadata && typeof output.metadata === 'object' && !Array.isArray(output.metadata)
        ? (output.metadata as Record<string, unknown>)
        : undefined
  };
}

function ensureBridgeInstructions(payload: Record<string, unknown>): string | undefined {
  const normalized = ensureBridgeInstructionsWithNative(payload);
  if (normalized && typeof normalized === 'object') {
    if (Object.prototype.hasOwnProperty.call(normalized, 'input')) {
      payload.input = normalized.input;
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'instructions')) {
      payload.instructions = normalized.instructions;
    } else if (Object.prototype.hasOwnProperty.call(payload, 'instructions')) {
      delete payload.instructions;
    }
  }
  const instructions = payload.instructions;
  return typeof instructions === 'string' && instructions.length ? instructions : undefined;
}

function createProviderProtocolError(message: string, options: {
  code: string;
  protocol?: string;
  providerType?: string;
  category?: ProviderErrorCategory;
  details?: Record<string, unknown>;
}): Error & {
  code?: string;
  protocol?: string;
  providerType?: string;
  category?: ProviderErrorCategory;
  details?: Record<string, unknown>;
} {
  const native = buildProviderProtocolErrorWithNative({
    message,
    code: options.code,
    protocol: options.protocol,
    providerType: options.providerType,
    category: options.category,
    details: options.details
  });
  const error = new Error(message) as Error & {
    code?: string;
    protocol?: string;
    providerType?: string;
    category?: ProviderErrorCategory;
    details?: Record<string, unknown>;
  };
  error.name = 'ProviderProtocolError';
  error.code = options.code;
  error.protocol = typeof native.protocol === 'string' ? native.protocol : options.protocol;
  error.providerType = typeof native.providerType === 'string' ? native.providerType : options.providerType;
  error.category = (native.category as ProviderErrorCategory) || options.category || 'EXTERNAL_ERROR';
  error.details = (native.details as Record<string, unknown> | undefined) ?? options.details;
  return error;
}

function convertMessagesToBridgeInput(options: {
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>> | undefined;
  allowDanglingToolCalls?: boolean | undefined;
}): BridgeInputBuildResult {
  const { messages, tools, allowDanglingToolCalls } = options;
  const native = buildBridgeHistoryWithNative({
    messages,
    tools,
    allowPendingTerminalToolCall: allowDanglingToolCalls === true
  });
  return native as BridgeInputBuildResult;
}

function convertBridgeInputToChatMessages(options: {
  input?: BridgeInputItem[];
  tools?: Array<Record<string, unknown>>;
  normalizeFunctionName?: ((raw: unknown) => string | undefined) | 'default' | 'responses';
  toolResultFallbackText?: string;
  allowDanglingToolCalls?: boolean;
  allowOrphanToolResult?: boolean;
}): Array<Record<string, unknown>> {
  const { input, tools, normalizeFunctionName, toolResultFallbackText, allowDanglingToolCalls, allowOrphanToolResult } = options;
  const output = convertBridgeInputToChatMessagesWithNative({
    input: Array.isArray(input) ? input : [],
    tools,
    toolResultFallbackText,
    normalizeFunctionName: typeof normalizeFunctionName === 'string' ? normalizeFunctionName : undefined,
    allowPendingTerminalToolCall: allowDanglingToolCalls === true,
    allowOrphanToolResult: allowOrphanToolResult === true
  });
  return output.messages;
}

export function collectResponsesRequestParameters(
  payload: Record<string, unknown> | undefined,
  options?: {
    streamHint?: boolean | undefined;
  }
): Record<string, unknown> | undefined {
  return pickResponsesRequestParametersWithNative({
    payload,
    streamHint: options?.streamHint
  });
}

function pickResponsesToolPassthroughFields(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return pickResponsesToolPassthroughFieldsWithNative({ value });
}

function buildSlimResponsesBridgeContext(
  context: ResponsesRequestContext | undefined
): Record<string, unknown> | undefined {
  return buildSlimResponsesBridgeContextWithNative(context as Record<string, unknown> | undefined);
}

function buildSlimBridgeDecisionMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return pickResponsesBridgeDecisionMetadataWithNative(metadata);
}

function sanitizeCapturedResponsesInput(
  input: BridgeInputItem[] | undefined
): BridgeInputItem[] | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    return input;
  }
  return sanitizeCapturedResponsesInputWithNative({ input }).input as BridgeInputItem[];
}

function extractMetadataExtraFields(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return extractResponsesMetadataExtraFieldsWithNative(metadata);
}

function stripToolControlFieldsFromContextMetadata(
  metadata: JsonObject | undefined
): JsonObject | undefined {
  return stripResponsesToolControlFieldsWithNative({
    value: metadata,
    nestedExtraFields: true
  }) as JsonObject | undefined;
}

function stripToolControlFieldsFromParameterObject(
  value: JsonObject | undefined
): JsonObject | undefined {
  return stripResponsesToolControlFieldsWithNative({
    value,
    nestedExtraFields: false
  }) as JsonObject | undefined;
}

function mergeRetainedResponsesRequestParameters(
  request: Record<string, unknown>,
  retainedParameters: Record<string, unknown> | undefined
): Record<string, unknown> {
  return mergeRetainedResponsesRequestParametersWithNative({
    request,
    retainedParameters
  });
}

function unwrapData(value: Record<string, unknown>): Record<string, unknown> {
  return unwrapResponsesDataWithNative({ value });
}

function readPreviousResponseIdFromChatSemantics(chat: Record<string, unknown>): string {
  const semantics =
    chat?.semantics && typeof chat.semantics === 'object' && !Array.isArray(chat.semantics)
      ? (chat.semantics as Record<string, unknown>)
      : undefined;
  if (!semantics) {
    return '';
  }
  const continuation =
    semantics.continuation && typeof semantics.continuation === 'object' && !Array.isArray(semantics.continuation)
      ? (semantics.continuation as Record<string, unknown>)
      : undefined;
  const resumeFrom =
    continuation?.resumeFrom && typeof continuation.resumeFrom === 'object' && !Array.isArray(continuation.resumeFrom)
      ? (continuation.resumeFrom as Record<string, unknown>)
      : undefined;
  const responses =
    semantics.responses && typeof semantics.responses === 'object' && !Array.isArray(semantics.responses)
      ? (semantics.responses as Record<string, unknown>)
      : undefined;
  const responsesResume =
    responses?.resume && typeof responses.resume === 'object' && !Array.isArray(responses.resume)
      ? (responses.resume as Record<string, unknown>)
      : undefined;
  const candidates = [
    resumeFrom?.previousResponseId,
    responsesResume?.restoredFromResponseId,
    resumeFrom?.responseId
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return '';
}

function readResumeInputFromChatSemantics(chat: Record<string, unknown>): BridgeInputItem[] | undefined {
  const semantics =
    chat?.semantics && typeof chat.semantics === 'object' && !Array.isArray(chat.semantics)
      ? (chat.semantics as Record<string, unknown>)
      : undefined;
  const responses =
    semantics?.responses && typeof semantics.responses === 'object' && !Array.isArray(semantics.responses)
      ? (semantics.responses as Record<string, unknown>)
      : undefined;
  const responsesResume =
    responses?.resume && typeof responses.resume === 'object' && !Array.isArray(responses.resume)
      ? (responses.resume as Record<string, unknown>)
      : undefined;
  const fullInput = responsesResume?.fullInput;
  if (Array.isArray(fullInput)) {
    return jsonClone(fullInput as JsonValue) as BridgeInputItem[];
  }
  const deltaInput = responsesResume?.deltaInput;
  return Array.isArray(deltaInput)
    ? (jsonClone(deltaInput as JsonValue) as BridgeInputItem[])
    : undefined;
}

function readResumeToolsFromChatSemantics(chat: Record<string, unknown>): BridgeToolDefinition[] | undefined {
  const semantics =
    chat?.semantics && typeof chat.semantics === 'object' && !Array.isArray(chat.semantics)
      ? (chat.semantics as Record<string, unknown>)
      : undefined;
  const responses =
    semantics?.responses && typeof semantics.responses === 'object' && !Array.isArray(semantics.responses)
      ? (semantics.responses as Record<string, unknown>)
      : undefined;
  const responsesResume =
    responses?.resume && typeof responses.resume === 'object' && !Array.isArray(responses.resume)
      ? (responses.resume as Record<string, unknown>)
      : undefined;
  const restoredTools = responsesResume?.restoredTools;
  return Array.isArray(restoredTools)
    ? (jsonClone(restoredTools as JsonValue) as BridgeToolDefinition[])
    : undefined;
}

export function captureResponsesContext(
  payload: Record<string, unknown>,
  dto?: { route?: { requestId?: string } }
): ResponsesRequestContext {
  const preservedInput = Array.isArray(payload.input)
    ? (payload.input as BridgeInputItem[])
    : undefined;
  ensureBridgeInstructions(payload);
  const captured = captureReqInboundResponsesContextSnapshotWithNative({
    rawRequest: payload,
    requestId: dto?.route?.requestId,
    toolCallIdStyle: (payload as any)?.toolCallIdStyle ?? (payload as any)?.metadata?.toolCallIdStyle
  }) as unknown as ResponsesRequestContext;
  const instructionReasoning = (payload as any)?.__rcc_reasoning_instructions;
  if (instructionReasoning !== undefined && instructionReasoning !== null) {
    const segments = Array.isArray(instructionReasoning) ? instructionReasoning : [instructionReasoning];
    const normalized = segments
      .map((entry) => (typeof entry === 'string' ? entry.trim() : String(entry ?? '').trim()))
      .filter((entry) => entry.length > 0);
    if (normalized.length) {
      (captured as any).__rcc_reasoning_instructions_segments = normalized;
    }
  }
  if (preservedInput && (!Array.isArray(captured.input) || captured.input.length === 0)) {
    captured.input = preservedInput;
  }
  captured.input = sanitizeCapturedResponsesInput(captured.input);
  if (!captured.systemInstruction && typeof (payload as any).instructions === 'string' && (payload as any).instructions.trim().length) {
    captured.systemInstruction = (payload as any).instructions;
  }
  if (captured.metadata && isJsonObject(captured.metadata as JsonValue)) {
    const rawMetadata = captured.metadata as JsonObject;
    if (Object.prototype.hasOwnProperty.call(rawMetadata as Record<string, unknown>, 'extraFields')) {
      const cloned = jsonClone(rawMetadata);
      delete (cloned as Record<string, unknown>).extraFields;
      captured.metadata = cloned;
    }
  }
  return captured;
}

export function buildChatRequestFromResponses(
  payload: Record<string, unknown>,
  context: ResponsesRequestContext
): BuildChatRequestResult {
  const chat = unwrapData(payload) as any;
  const requestId =
    typeof context.requestId === 'string' && context.requestId.trim().length
      ? context.requestId
      : 'unknown';
  const resumeToolsFromSemantics = readResumeToolsFromChatSemantics(chat as Record<string, unknown>);
  const toolsNormalized = Array.isArray(context.toolsNormalized) && context.toolsNormalized.length
    ? (context.toolsNormalized as unknown as ChatToolDefinition[])
    : (
      Array.isArray((payload as any).tools) && (payload as any).tools.length
        ? (mapReqInboundBridgeToolsToChatWithNative((payload as any).tools) as unknown as ChatToolDefinition[])
        : (
          Array.isArray(resumeToolsFromSemantics) && resumeToolsFromSemantics.length
            ? (mapReqInboundBridgeToolsToChatWithNative(resumeToolsFromSemantics) as unknown as ChatToolDefinition[])
            : []
        )
    );
  const topLevelPreviousResponseId =
    typeof (payload as Record<string, unknown>).previous_response_id === 'string'
      && String((payload as Record<string, unknown>).previous_response_id).trim().length > 0
      ? String((payload as Record<string, unknown>).previous_response_id).trim()
      : '';
  const previousResponseId =
    topLevelPreviousResponseId.length > 0
      ? topLevelPreviousResponseId
      : readPreviousResponseIdFromChatSemantics(chat as Record<string, unknown>);
  const stripHostFields = shouldStripHostManagedFields(context);
  const continuationPreviousResponseId = stripHostFields ? '' : previousResponseId;
  const resumedInput =
    continuationPreviousResponseId.length > 0
      ? readResumeInputFromChatSemantics(chat as Record<string, unknown>)
      : undefined;
  const inputForMessages =
    continuationPreviousResponseId.length > 0 && Array.isArray(resumedInput)
      ? resumedInput
      : context.input;

  const convertStart = Date.now();
  let messages = convertBridgeInputToChatMessages({
    input: inputForMessages,
    tools: toolsNormalized,
    normalizeFunctionName: 'responses',
    toolResultFallbackText: '',
    allowDanglingToolCalls: false,
    allowOrphanToolResult:
      typeof (payload as Record<string, unknown>).previous_response_id === 'string'
      && ((payload as Record<string, unknown>).previous_response_id as string).trim().length > 0
  });
  void convertStart;
  const policyActions = planResponsesBridgePolicyActionsWithNative({
    stage: 'request_inbound',
    actions: resolveBridgePolicyActionsWithNative(
      resolveBridgePolicyWithNative({ protocol: 'openai-responses', moduleType: 'openai-responses' }),
      'request_inbound'
    ),
    messages
  });
  if (policyActions?.length) {
    const policyStart = Date.now();
    const actionState = runNativeResponsesBridgePipeline({
      stage: 'request_inbound',
      actions: policyActions,
      protocol: 'openai-responses',
      moduleType: 'openai-responses',
      requestId: context.requestId,
      messages,
      capturedToolResults: readCapturedToolResults(context),
      rawRequest: payload
    });
    messages = actionState.messages;
    void policyStart;
  }
  if (Array.isArray(context.originalSystemMessages) && context.originalSystemMessages.length) {
    const preservedSystems = context.originalSystemMessages
      .map((text) => ({ role: 'system' as const, content: text }))
      .filter((message) => typeof message.content === 'string');
    if (preservedSystems.length) {
      const nonSystemMessages = messages.filter((msg: any) => String(msg?.role).toLowerCase() !== 'system');
      messages = [...preservedSystems, ...nonSystemMessages];
    }
  } else if (typeof context.systemInstruction === 'string' && context.systemInstruction.trim().length) {
    const hasSystemInstruction = messages.some((message: any) => String(message?.role).toLowerCase() === 'system');
    if (!hasSystemInstruction) {
      messages = [
        { role: 'system', content: context.systemInstruction.trim() },
        ...messages
      ];
    }
  }
  messages = appendLocalImageBlockOnLatestUserInputWithNative({ messages }).messages;
  if (!messages.length) {
    throw createProviderProtocolError('Responses payload produced no chat messages', {
      code: 'MALFORMED_REQUEST',
      protocol: 'openai-responses',
      providerType: 'responses',
      details: {
        context: 'buildChatRequestFromResponses',
        inputLength: Array.isArray(context.input) ? context.input.length : undefined,
        requestId: context.requestId
      }
    });
  }

  const parameterSource: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  if (typeof parameterSource.max_tokens === 'number' && parameterSource.max_output_tokens === undefined) {
    parameterSource.max_output_tokens = parameterSource.max_tokens;
  }
  const bridgeParameters = collectResponsesRequestParameters(parameterSource, {
    streamHint: typeof (payload as any).stream === 'boolean' ? (payload as any).stream : undefined
  });
  if (bridgeParameters) {
    delete bridgeParameters.store;
  }
  const result: Record<string, unknown> = {
    model: (payload as any).model,
    messages,
    ...(bridgeParameters ?? {})
  };
  if (Array.isArray(toolsNormalized) && toolsNormalized.length) {
    (result as any).tools = toolsNormalized;
  }
  return { request: result, toolsNormalized };
}


function normalizeBridgeHistory(seed: unknown): BridgeInputBuildResult | undefined {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) {
    return undefined;
  }
  return normalizeBridgeHistorySeedWithNative(seed as Record<string, unknown>) as unknown as BridgeInputBuildResult;
}

export function buildResponsesRequestFromChat(payload: Record<string, unknown>, ctx?: ResponsesRequestContext, extras?: {
  bridgeHistory?: BridgeInputBuildResult;
  systemInstruction?: string;
}): BuildResponsesRequestResult {
  const chat = unwrapData(payload) as any;
  const out: any = {};
  const envelopeMetadata = ctx?.metadata && typeof ctx.metadata === 'object' ? (ctx.metadata as Record<string, unknown>) : undefined;
  const requestMetadata =
    chat && typeof chat === 'object' && (chat as any).metadata && typeof (chat as any).metadata === 'object'
      ? ((chat as any).metadata as Record<string, unknown>)
      : undefined;

  // 基本字段
  out.model = chat.model;

  let messages: any[] = Array.isArray(chat.messages) ? chat.messages as any[] : [];
  let bridgeMetadata: Record<string, unknown> | undefined;
  const policyActions = planResponsesBridgePolicyActionsWithNative({
    stage: 'request_outbound',
    actions: resolveBridgePolicyActionsWithNative(
      resolveBridgePolicyWithNative({ protocol: 'openai-responses', moduleType: 'openai-responses' }),
      'request_outbound'
    ),
    messages: messages as Array<Record<string, unknown>>
  });
  if (policyActions?.length) {
    const actionState = runNativeResponsesBridgePipeline({
      stage: 'request_outbound',
      actions: policyActions,
      protocol: 'openai-responses',
      moduleType: 'openai-responses',
      requestId: ctx?.requestId,
      messages,
      rawRequest: chat as Record<string, unknown>
    });
    messages = actionState.messages as any[];
    if (actionState.metadata && Object.keys(actionState.metadata).length) {
      bridgeMetadata = actionState.metadata;
    }
  }
  const metadataExtraFields = extractMetadataExtraFields(envelopeMetadata);
  const bridgeDecisions = resolveResponsesRequestBridgeDecisionsWithNative({
    context: buildSlimResponsesBridgeContext(ctx),
    requestMetadata: buildSlimBridgeDecisionMetadata(requestMetadata),
    envelopeMetadata: buildSlimBridgeDecisionMetadata(envelopeMetadata),
    bridgeMetadata: buildSlimBridgeDecisionMetadata(bridgeMetadata),
    extraBridgeHistory: extras?.bridgeHistory as unknown as Record<string, unknown> | undefined,
    requestSemantics:
      chat?.semantics && typeof chat.semantics === 'object' && !Array.isArray(chat.semantics)
        ? (chat.semantics as Record<string, unknown>)
        : undefined
  });
  const forceWebSearch = bridgeDecisions.forceWebSearch === true;
  const toolCallIdStyle = bridgeDecisions.toolCallIdStyle;
  const historySeed = bridgeDecisions.historySeed as unknown as BridgeInputBuildResult | undefined;
  const stripHostFields = shouldStripHostManagedFields(ctx);
  const continuationPreviousResponseId = stripHostFields
    ? ''
    : readPreviousResponseIdFromChatSemantics(chat as Record<string, unknown>);

  // tools: 反向映射为 ResponsesToolDefinition 形状
  const chatTools: ChatToolDefinition[] = Array.isArray(chat.tools) ? (chat.tools as ChatToolDefinition[]) : [];

  const responsesToolsFromChat = chatTools.length
    ? (mapChatToolsToBridgeWithNative(chatTools, { sanitizeMode: 'responses' }) as BridgeToolDefinition[])
    : undefined;

  const resumeTools = continuationPreviousResponseId.length > 0
    ? readResumeToolsFromChatSemantics(chat as Record<string, unknown>)
    : undefined;
  const resolvedBridgeTools = resolveResponsesBridgeToolsWithNative({
    originalTools: Array.isArray(resumeTools)
        ? (resumeTools as Array<Record<string, unknown>>)
        : undefined,
    chatTools: Array.isArray(responsesToolsFromChat) ? (responsesToolsFromChat as Array<Record<string, unknown>>) : undefined,
    allowBuiltinWebSearch: bridgeDecisions.allowBuiltinWebSearch === true,
    hasServerSideWebSearch: true,
    request: pickResponsesToolPassthroughFields(chat as Record<string, unknown>)
  });
  const mergedTools = resolvedBridgeTools.mergedTools as BridgeToolDefinition[] | undefined;

  if (mergedTools?.length) {
    out.tools = mergedTools;
  }
  if (resolvedBridgeTools.request && typeof resolvedBridgeTools.request === 'object') {
    for (const [key, value] of Object.entries(resolvedBridgeTools.request)) {
      if (out[key] === undefined) {
        out[key] = value;
      }
    }
  }
  if (forceWebSearch) {
    const metadataCarrier =
      out.metadata && typeof out.metadata === 'object' && !Array.isArray(out.metadata)
        ? (out.metadata as Record<string, unknown>)
        : ((out.metadata = {}) as Record<string, unknown>);
    const rt = ensureRuntimeMetadata(metadataCarrier);
    rt.forceWebSearch = true;
  }

  const history =
    (continuationPreviousResponseId ? undefined : historySeed) ??
    (convertMessagesToBridgeInput({
      messages,
      tools: Array.isArray(out.tools) ? (out.tools as Array<Record<string, unknown>>) : undefined,
      allowDanglingToolCalls: true
    }) as unknown as BridgeInputBuildResult);
  const callIdTransformer = createToolCallIdTransformer(toolCallIdStyle);
  if (callIdTransformer) {
    enforceToolCallIdStyle(history.input, callIdTransformer);
  }
  const {
    input,
    combinedSystemInstruction,
    originalSystemMessages
  } = history;

  // 不追加 metadata，以便 roundtrip 与原始 payload 对齐；系统提示直接写入 instructions。
  const inputForUpstream = input;
  if (callIdTransformer) {
    enforceToolCallIdStyle(inputForUpstream, callIdTransformer);
  }
  const upstreamInput = filterBridgeInputForUpstreamWithNative({
    input: inputForUpstream,
    allowToolCallId: toolCallIdStyle === 'preserve'
  }).input as BridgeInputItem[];
  if (upstreamInput.length) {
    out.input = upstreamInput;
  }
  if (continuationPreviousResponseId.length > 0) {
    out.previous_response_id = continuationPreviousResponseId;
  }
  const streamFromChat = typeof (chat as any).stream === 'boolean' ? ((chat as any).stream as boolean) : undefined;
  const streamFromParameters = (chat as any)?.parameters && typeof ((chat as any).parameters as any)?.stream === 'boolean'
    ? (((chat as any).parameters as any).stream as boolean)
    : undefined;
  const chatRootParameters = collectResponsesRequestParameters(chat as Record<string, unknown>, {
    streamHint: streamFromChat
  });
  const mergedChatParameters: Record<string, unknown> | undefined = {
    ...(chatRootParameters ?? {}),
    ...(
      chat.parameters && typeof chat.parameters === 'object' && !Array.isArray(chat.parameters)
        ? (chat.parameters as Record<string, unknown>)
        : {}
    )
  };
  if (Object.keys(mergedChatParameters).length === 0) {
    delete (mergedChatParameters as Record<string, unknown>).stream;
  }
  const preparedEnvelope = prepareResponsesRequestEnvelopeWithNative({
    request: out as Record<string, unknown>,
    extraSystemInstruction: extras?.systemInstruction,
    combinedSystemInstruction,
    reasoningInstructionSegments: (ctx as Record<string, unknown> | undefined)?.__rcc_reasoning_instructions_segments,
    chatParameters: Object.keys(mergedChatParameters).length ? mergedChatParameters : undefined,
    chatStream: streamFromChat,
    chatParametersStream: streamFromParameters,
    stripHostFields,
  });
  Object.assign(out, preparedEnvelope.request);
  delete out.parameters;

  const retainedParameters: Record<string, unknown> = {
    ...(Object.keys(mergedChatParameters).length ? mergedChatParameters : {})
  };
  Object.assign(out, mergeRetainedResponsesRequestParameters(out as Record<string, unknown>, retainedParameters));
  if (out.stream === undefined) {
    const retainedStream =
      streamFromChat ??
      streamFromParameters ??
      (typeof (ctx as any)?.stream === 'boolean' ? ((ctx as any).stream as boolean) : undefined);
    if (retainedStream !== undefined) {
      out.stream = retainedStream;
    }
  }

  ensureBridgeInstructions(out);

  return { request: out, originalSystemMessages };
}

function shouldStripHostManagedFields(context?: ResponsesRequestContext): boolean {
  const result = evaluateResponsesHostPolicyWithNative(
    context,
    typeof context?.targetProtocol === 'string' ? context?.targetProtocol : undefined
  );
  return result.shouldStripHostManagedFields;
}

export function buildResponsesPayloadFromChat(payload: unknown, context?: ResponsesRequestContext): Record<string, unknown> | unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const stripHostManagedFields = shouldStripHostManagedFields(context);
  const closeoutPlan = planResponsesPayloadFromChatCloseoutWithNative(payload, {
    requestId: context?.requestId,
    toolsRaw: Array.isArray(context?.toolsRaw) ? context.toolsRaw : [],
    metadata: context?.metadata,
    stripHostManagedFields
  });
  const response = closeoutPlan.response as Record<string, unknown> | undefined;
  if (!response || typeof response !== 'object') return payload;

  if (closeoutPlan.kind === 'existing_responses_payload') {
    const plannedPayload = closeoutPlan.payload;
    if (plannedPayload && typeof plannedPayload === 'object' && !Array.isArray(plannedPayload)) {
      if ((plannedPayload as any).metadata) {
        stripInternalToolingMetadata((plannedPayload as any).metadata);
      }
      return plannedPayload;
    }
    return payload;
  }

  const snapshotLookupKeys = Array.isArray(closeoutPlan.snapshotLookupKeys)
    ? (closeoutPlan.snapshotLookupKeys as unknown[]).filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const snapshotPayload = snapshotLookupKeys.length ? consumeResponsesPayloadSnapshotByAliases(snapshotLookupKeys) : undefined;
  const passthroughPayload = snapshotLookupKeys.length ? consumeResponsesPassthroughByAliases(snapshotLookupKeys) : undefined;
  const sourceForRetention =
    (passthroughPayload && typeof passthroughPayload === 'object' ? passthroughPayload : undefined) ??
    (closeoutPlan.inlinePassthrough && typeof closeoutPlan.inlinePassthrough === 'object' && !Array.isArray(closeoutPlan.inlinePassthrough)
      ? (closeoutPlan.inlinePassthrough as Record<string, unknown>)
      : undefined) ??
    (snapshotPayload && typeof snapshotPayload === 'object' ? snapshotPayload : undefined) ??
    (closeoutPlan.inlineSnapshot && typeof closeoutPlan.inlineSnapshot === 'object' && !Array.isArray(closeoutPlan.inlineSnapshot)
      ? (closeoutPlan.inlineSnapshot as Record<string, unknown>)
      : undefined);

  const nativeBuilt = buildResponsesPayloadFromChatWithNative(response as Record<string, unknown>, {
    requestId: context?.requestId,
    toolsRaw: Array.isArray(context?.toolsRaw) ? context?.toolsRaw : [],
    metadata: context?.metadata,
    stripHostManagedFields,
    sourceForRetention: sourceForRetention as Record<string, unknown> | undefined
  });

  const out: any = {
    ...nativeBuilt
  };
  if ((out as any).metadata) {
    stripInternalToolingMetadata((out as any).metadata);
  }
  return out;
}

export function extractRequestIdFromResponse(response: any): string | undefined {
  if (response && typeof response === 'object' && 'metadata' in response && (response as any).metadata && typeof (response as any).metadata === 'object') {
    const meta = (response as any).metadata as Record<string, unknown>;
    if (typeof meta.requestId === 'string') return meta.requestId;
  }
  return undefined;
}

export function buildChatResponseFromResponses(payload: unknown): Record<string, unknown> | unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const output = buildChatResponseFromResponsesFullWithNative({
    payload: JSON.stringify(payload)
  });
  const parsed = JSON.parse(output) as { result?: string };
  if (typeof parsed.result !== 'string') {
    throw new Error('[responses-openai-bridge] native full conversion returned no result');
  }
  return JSON.parse(parsed.result);
}
// (imports moved to top)
