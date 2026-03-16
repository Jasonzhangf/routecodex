import { ensureBridgeInstructions } from '../bridge-instructions.js';
import { evaluateResponsesHostPolicy } from './responses-host-policy.js';
import type { BridgeInputItem, BridgeToolDefinition } from '../types/bridge-message-types.js';
import type { ChatToolDefinition } from '../hub/types/chat-envelope.js';
import type { JsonObject, JsonValue } from '../hub/types/json.js';
import {
  convertBridgeInputToChatMessages
} from '../bridge-message-utils.js';
import type { BridgeInputBuildResult } from '../bridge-message-utils.js';
import {
  createToolCallIdTransformer,
  enforceToolCallIdStyle,
  sanitizeResponsesFunctionName
} from '../shared/responses-tool-utils.js';
import { mapChatToolsToBridge } from '../shared/tool-mapping.js';
import { ProviderProtocolError } from '../provider-protocol-error.js';
import { isJsonObject, jsonClone } from '../hub/types/json.js';
import {
  captureReqInboundResponsesContextSnapshotWithNative,
  mapReqInboundBridgeToolsToChatWithNative
} from '../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import {
  appendLocalImageBlockOnLatestUserInputWithNative,
  buildBridgeHistoryWithNative,
  filterBridgeInputForUpstreamWithNative,
  normalizeBridgeHistorySeedWithNative,
  prepareResponsesRequestEnvelopeWithNative,
  resolveResponsesRequestBridgeDecisionsWithNative,
  resolveResponsesBridgeToolsWithNative,
  runBridgeActionPipelineWithNative
} from '../../router/virtual-router/engine-selection/native-hub-bridge-action-semantics.js';
import type {
  BuildChatRequestResult,
  BuildResponsesRequestResult,
  ResponsesRequestContext,
  Unknown
} from './responses-openai-bridge/types.js';
export type {
  BuildChatRequestResult,
  BuildResponsesRequestResult,
  ResponsesRequestContext
} from './responses-openai-bridge/types.js';

// --- Utilities (ported strictly) ---
import { resolveBridgePolicy, resolvePolicyActions } from '../bridge-policies.js';
import { logHubStageTiming } from '../hub/pipeline/hub-stage-timing.js';

function isObject(v: unknown): v is Unknown {
  return !!v && typeof v === 'object' && !Array.isArray(v);
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

function filterRedundantResponsesReasoningAction(
  actions: Array<{ name: string; options?: Record<string, unknown> }> | undefined
): Array<{ name: string; options?: Record<string, unknown> }> | undefined {
  return actions?.filter((action) => {
    const name = typeof action?.name === 'string' ? action.name.trim().toLowerCase() : '';
    return name !== 'reasoning.extract';
  });
}

const RESPONSES_TOOL_PASSTHROUGH_KEYS = [
  'temperature',
  'tool_choice',
  'parallel_tool_calls',
  'response_format',
  'user',
  'top_p',
  'prompt_cache_key',
  'reasoning',
  'logit_bias',
  'seed'
] as const;

export const RESPONSES_REQUEST_PARAMETER_KEYS = [
  'model',
  'temperature',
  'top_p',
  'top_k',
  'prompt_cache_key',
  'reasoning',
  'max_tokens',
  'max_output_tokens',
  'response_format',
  'tool_choice',
  'parallel_tool_calls',
  'service_tier',
  'truncation',
  'include',
  'store',
  'text',
  'user',
  'logit_bias',
  'seed',
  'stop',
  'stop_sequences',
  'modalities'
] as const;

function pickObjectFields(
  value: Record<string, unknown> | undefined,
  keys: readonly string[]
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (value[key] !== undefined) {
      picked[key] = value[key];
    }
  }
  return Object.keys(picked).length ? picked : undefined;
}

export function collectResponsesRequestParameters(
  payload: Record<string, unknown> | undefined,
  options?: {
    streamHint?: boolean | undefined;
  }
): Record<string, unknown> | undefined {
  if (!payload) {
    return undefined;
  }
  let params = pickObjectFields(payload, RESPONSES_REQUEST_PARAMETER_KEYS);
  if (options?.streamHint !== undefined) {
    (params ??= {}).stream = options.streamHint;
  }
  return params && Object.keys(params).length ? params : undefined;
}

function buildSlimResponsesBridgeContext(
  context: ResponsesRequestContext | undefined
): Record<string, unknown> | undefined {
  if (!context || typeof context !== 'object') {
    return undefined;
  }
  const slim: Record<string, unknown> = {};
  if (Array.isArray(context.input) && context.input.length) {
    slim.input = context.input;
  }
  if (Array.isArray(context.originalSystemMessages) && context.originalSystemMessages.length) {
    slim.originalSystemMessages = context.originalSystemMessages;
  }
  if (typeof context.systemInstruction === 'string' && context.systemInstruction.trim().length) {
    slim.systemInstruction = context.systemInstruction;
  }
  if (typeof context.toolCallIdStyle === 'string' && context.toolCallIdStyle.trim().length) {
    slim.toolCallIdStyle = context.toolCallIdStyle;
  }
  if (context.metadata && typeof context.metadata === 'object' && !Array.isArray(context.metadata)) {
    slim.metadata = context.metadata as Record<string, unknown>;
  }
  return Object.keys(slim).length ? slim : undefined;
}

function buildSlimBridgeDecisionMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  return pickObjectFields(metadata, ['toolCallIdStyle', 'bridgeHistory']);
}

function sanitizeCapturedResponsesInput(
  input: BridgeInputItem[] | undefined
): BridgeInputItem[] | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    return input;
  }
  const acceptedCallIds = new Set<string>();
  const out: BridgeInputItem[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const type = typeof (entry as any).type === 'string' ? String((entry as any).type).trim().toLowerCase() : '';
    if (type === 'function_call') {
      const sanitizedName = sanitizeResponsesFunctionName((entry as any).name);
      if (!sanitizedName) {
        continue;
      }
      const next = jsonClone(entry as JsonValue) as BridgeInputItem;
      (next as any).name = sanitizedName;
      const callId = typeof (next as any).call_id === 'string' ? String((next as any).call_id).trim() : '';
      if (callId) {
        acceptedCallIds.add(callId);
      }
      out.push(next);
      continue;
    }
    if (type === 'function_call_output') {
      const callId = typeof (entry as any).call_id === 'string' ? String((entry as any).call_id).trim() : '';
      if (!callId || !acceptedCallIds.has(callId)) {
        continue;
      }
    }
    out.push(jsonClone(entry as JsonValue) as BridgeInputItem);
  }
  return out;
}

// normalizeTools unified in ../args-mapping.ts

// NOTE: 自修复提示已移除（统一标准：不做模糊兜底）。


// --- Public bridge functions ---

export function captureResponsesContext(payload: Record<string, unknown>, dto?: { route?: { requestId?: string } }): ResponsesRequestContext {
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
    const cloned = jsonClone(captured.metadata as JsonObject);
    delete (cloned as Record<string, unknown>).extraFields;
    captured.metadata = cloned;
  }
  return captured;
}

export function buildChatRequestFromResponses(payload: Record<string, unknown>, context: ResponsesRequestContext): BuildChatRequestResult {
  const requestId =
    typeof context.requestId === 'string' && context.requestId.trim().length
      ? context.requestId
      : 'unknown';
  // V3: 对 Responses 路径仅做“形状转换”，不做参数解析/修复。
  // 将顶层 { type,name,description,parameters,strict } 归一为 OpenAI Chat tools 形状：
  // { type:'function', function:{ name,description,parameters,strict? } }
  const toolsNormalized = Array.isArray(context.toolsNormalized) && context.toolsNormalized.length
    ? (context.toolsNormalized as unknown as ChatToolDefinition[])
    : (mapReqInboundBridgeToolsToChatWithNative((payload as any).tools) as unknown as ChatToolDefinition[]);
  // 不在 Responses 路径进行 MCP 工具注入；统一由 Chat 后半段治理注入

  logHubStageTiming(requestId, 'req_inbound.responses.convert_input_to_messages', 'start');
  const convertStart = Date.now();
  let messages = convertBridgeInputToChatMessages({
    input: context.input,
    tools: toolsNormalized,
    normalizeFunctionName: 'responses',
    toolResultFallbackText: 'Command succeeded (no output).'
  });
  logHubStageTiming(requestId, 'req_inbound.responses.convert_input_to_messages', 'completed', {
    elapsedMs: Date.now() - convertStart,
    forceLog: true
  });
  try {
    const bridgePolicy = resolveBridgePolicy({ protocol: 'openai-responses', moduleType: 'openai-responses' });
    const policyActions = filterRedundantResponsesReasoningAction(
      resolvePolicyActions(bridgePolicy, 'request_inbound')
    );
    if (policyActions?.length) {
      logHubStageTiming(requestId, 'req_inbound.responses.inbound_policy', 'start');
      const policyStart = Date.now();
      const actionState = runNativeResponsesBridgePipeline({
        stage: 'request_inbound',
        actions: policyActions,
        protocol: (bridgePolicy?.protocol ?? 'openai-responses') as 'openai-responses',
        moduleType: (bridgePolicy?.moduleType ?? 'openai-responses') as 'openai-responses',
        requestId: context.requestId,
        messages,
        capturedToolResults: readCapturedToolResults(context),
        rawRequest: payload
      });
      messages = actionState.messages;
      logHubStageTiming(requestId, 'req_inbound.responses.inbound_policy', 'completed', {
        elapsedMs: Date.now() - policyStart,
        forceLog: true
      });
    }
  } catch {
    // Policy application is best-effort; fall back to raw mapping on failure.
  }
  if (Array.isArray(context.originalSystemMessages) && context.originalSystemMessages.length) {
    const preservedSystems = context.originalSystemMessages
      .map(text => ({ role: 'system' as const, content: text }))
      .filter(message => typeof message.content === 'string');
    if (preservedSystems.length) {
      const nonSystemMessages = messages.filter((msg: any) => String(msg?.role).toLowerCase() !== 'system');
      messages = [...preservedSystems, ...nonSystemMessages];
    }
  }
  messages = appendLocalImageBlockOnLatestUserInputWithNative({ messages }).messages;
  // 不在 Responses 路径做工具治理；统一在 Chat 后半段处理
  // No system tips for MCP on OpenAI Responses path (avoid leaking tool names)
  if (!messages.length) {
    throw new ProviderProtocolError('Responses payload produced no chat messages', {
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

  // 如果只有 system 消息且无 user/assistant/tool，后续桥接 action 会从 instructions 注入兜底 user 消息

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
  if (Array.isArray(toolsNormalized) && toolsNormalized.length) (result as any).tools = toolsNormalized;
  return { request: result, toolsNormalized };
}

/**
 * Chat 请求 → Responses 请求（非流），用于 V3 process=chat 且 providerWire=responses 的请求编码。
 *
 * 设计目标：
 *  - 保留 model / tools / tool_choice / parallel_tool_calls 等字段；
 *  - 将 system 消息折叠到 instructions；
 *  - 将 user/assistant/tool 消息编码为 input[] 中的 message 块，使得 mapResponsesInputToChat 能够还原为等价 Chat 请求。
 */
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
  try {
    const bridgePolicy = resolveBridgePolicy({ protocol: 'openai-responses', moduleType: 'openai-responses' });
    const policyActions = filterRedundantResponsesReasoningAction(
      resolvePolicyActions(bridgePolicy, 'request_outbound')
    );
    if (policyActions?.length) {
      const actionState = runNativeResponsesBridgePipeline({
        stage: 'request_outbound',
        actions: policyActions,
        protocol: (bridgePolicy?.protocol ?? 'openai-responses') as 'openai-responses',
        moduleType: (bridgePolicy?.moduleType ?? 'openai-responses') as 'openai-responses',
        requestId: ctx?.requestId,
        messages,
        rawRequest: chat as Record<string, unknown>
      });
      messages = actionState.messages as any[];
      if (actionState.metadata && Object.keys(actionState.metadata).length) {
        bridgeMetadata = actionState.metadata;
      }
    }
  } catch {
    // ignore policy errors
  }
  const metadataExtraFields = extractMetadataExtraFields(envelopeMetadata);
  const bridgeDecisions = resolveResponsesRequestBridgeDecisionsWithNative({
    context: buildSlimResponsesBridgeContext(ctx),
    requestMetadata: buildSlimBridgeDecisionMetadata(requestMetadata),
    envelopeMetadata: buildSlimBridgeDecisionMetadata(envelopeMetadata),
    bridgeMetadata: buildSlimBridgeDecisionMetadata(bridgeMetadata),
    extraBridgeHistory: extras?.bridgeHistory as unknown as Record<string, unknown> | undefined
  });
  const forceWebSearch = bridgeDecisions.forceWebSearch === true;
  const toolCallIdStyle = bridgeDecisions.toolCallIdStyle;
  const historySeed = bridgeDecisions.historySeed as unknown as BridgeInputBuildResult | undefined;

  // tools: 反向映射为 ResponsesToolDefinition 形状
  const chatTools: ChatToolDefinition[] = Array.isArray(chat.tools) ? (chat.tools as ChatToolDefinition[]) : [];

  const responsesToolsFromChat = mapChatToolsToBridge(chatTools, {
    sanitizeName: sanitizeResponsesFunctionName
  });

  const originalTools = Array.isArray(ctx?.toolsRaw) ? (ctx!.toolsRaw as BridgeToolDefinition[]) : undefined;
  const resolvedBridgeTools = resolveResponsesBridgeToolsWithNative({
    originalTools: Array.isArray(originalTools) ? (originalTools as Array<Record<string, unknown>>) : undefined,
    chatTools: Array.isArray(responsesToolsFromChat) ? (responsesToolsFromChat as Array<Record<string, unknown>>) : undefined,
    hasServerSideWebSearch: !forceWebSearch,
    passthroughKeys: [...RESPONSES_TOOL_PASSTHROUGH_KEYS],
    request: pickObjectFields(chat as Record<string, unknown>, RESPONSES_TOOL_PASSTHROUGH_KEYS)
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

  const history =
    historySeed ??
    (buildBridgeHistoryWithNative({
      messages,
      tools: Array.isArray(out.tools) ? (out.tools as Array<Record<string, unknown>>) : undefined
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
  const upstreamInput = filterBridgeInputForUpstreamWithNative({
    input,
    allowToolCallId: toolCallIdStyle === 'preserve'
  }).input as BridgeInputItem[];
  if (upstreamInput.length) {
    out.input = upstreamInput;
  }
  const streamFromChat = typeof (chat as any).stream === 'boolean' ? ((chat as any).stream as boolean) : undefined;
  const streamFromParameters = (chat as any)?.parameters && typeof ((chat as any).parameters as any)?.stream === 'boolean'
    ? (((chat as any).parameters as any).stream as boolean)
    : undefined;
  const stripHostFields = shouldStripHostManagedFields(ctx);
  const preparedEnvelope = prepareResponsesRequestEnvelopeWithNative({
    request: out as Record<string, unknown>,
    contextSystemInstruction: ctx?.systemInstruction,
    extraSystemInstruction: extras?.systemInstruction,
    metadataSystemInstruction: envelopeMetadata?.systemInstruction,
    combinedSystemInstruction,
    reasoningInstructionSegments: (ctx as any)?.__rcc_reasoning_instructions_segments,
    contextParameters: undefined,
    chatParameters: chat.parameters,
    metadataParameters: stripToolControlFieldsFromParameterObject(
      metadataExtraFields?.parameters as JsonObject | undefined
    ),
    contextStream: undefined,
    metadataStream: undefined,
    chatStream: streamFromChat,
    chatParametersStream: streamFromParameters,
    contextInclude: undefined,
    metadataInclude: undefined,
    contextStore: undefined,
    metadataStore: undefined,
    stripHostFields,
    contextToolChoice: undefined,
    contextParallelToolCalls: undefined,
    contextResponseFormat: undefined,
    metadataResponseFormat: undefined,
    contextServiceTier: undefined,
    metadataServiceTier: undefined,
    contextTruncation: undefined,
    metadataTruncation: undefined,
    contextMetadata: stripToolControlFieldsFromContextMetadata(ctx?.metadata),
    metadataMetadata: metadataExtraFields?.metadata
  });
  Object.assign(out, preparedEnvelope.request);
  delete out.parameters;

  ensureBridgeInstructions(out);

  return { request: out, originalSystemMessages };
}

function extractMetadataExtraFields(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const extras = (metadata as Record<string, unknown>).extraFields;
  if (extras && typeof extras === 'object' && !Array.isArray(extras)) {
    return extras as Record<string, unknown>;
  }
  return undefined;
}

function stripToolControlFieldsFromContextMetadata(
  metadata: JsonObject | undefined
): JsonObject | undefined {
  if (!metadata) {
    return undefined;
  }
  const cloned = jsonClone(metadata) as JsonObject;
  const extras = cloned.extraFields;
  if (!extras || !isPlainObject(extras)) {
    return cloned;
  }
  delete (extras as Record<string, unknown>).tool_choice;
  delete (extras as Record<string, unknown>).parallel_tool_calls;
  if (Object.keys(extras as Record<string, unknown>).length === 0) {
    delete cloned.extraFields;
  }
  return cloned;
}

function stripToolControlFieldsFromParameterObject(
  value: JsonObject | undefined
): JsonObject | undefined {
  if (!value) {
    return undefined;
  }
  const cloned = jsonClone(value) as JsonObject;
  delete cloned.tool_choice;
  delete cloned.parallel_tool_calls;
  return Object.keys(cloned).length ? cloned : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function unwrapData(value: Record<string, unknown>): Record<string, unknown> {
  let current: any = value;
  const seen = new Set<any>();
  while (current && typeof current === 'object' && !Array.isArray(current) && !seen.has(current)) {
    seen.add(current);
    if ('choices' in current || 'message' in current) break;
    if ('data' in current && typeof (current as any).data === 'object') { current = (current as any).data; continue; }
    break;
  }
  return current as Record<string, unknown>;
}

function resolveSnapshotLookupKey(response: Record<string, unknown>, context?: ResponsesRequestContext): string | undefined {
  if (typeof (response as any)?.request_id === 'string') {
    return (response as any).request_id as string;
  }
  if (typeof context?.requestId === 'string') {
    return context.requestId;
  }
  if (typeof (response as any)?.id === 'string') {
    return (response as any).id as string;
  }
  return undefined;
}

function shouldStripHostManagedFields(context?: ResponsesRequestContext): boolean {
  const result = evaluateResponsesHostPolicy(context, typeof context?.targetProtocol === 'string' ? context?.targetProtocol : undefined);
  return result.shouldStripHostManagedFields;
}

export {
  buildResponsesPayloadFromChat,
  extractRequestIdFromResponse
} from './responses-openai-bridge/response-payload.js';

export { buildChatResponseFromResponses } from '../shared/responses-response-utils.js';
// (imports moved to top)
