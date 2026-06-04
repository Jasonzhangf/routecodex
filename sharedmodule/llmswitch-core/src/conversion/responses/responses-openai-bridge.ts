import { ensureBridgeInstructions } from '../bridge-instructions.js';
import { evaluateResponsesHostPolicy } from './responses-host-policy.js';
import type { BridgeInputItem, BridgeToolDefinition } from '../types/bridge-message-types.js';
import type { ChatToolDefinition } from '../hub/types/chat-envelope.js';
import type { JsonObject, JsonValue } from '../hub/types/json.js';
import {
  convertMessagesToBridgeInput,
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
import { ensureRuntimeMetadata } from '../runtime-metadata.js';
import {
  captureReqInboundResponsesContextSnapshotWithNative,
  mapReqInboundBridgeToolsToChatWithNative
} from '../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import {
  appendLocalImageBlockOnLatestUserInputWithNative,
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
  ResponsesRequestContext
} from './responses-openai-bridge/types.js';
export type {
  BuildChatRequestResult,
  BuildResponsesRequestResult,
  ResponsesRequestContext
} from './responses-openai-bridge/types.js';

// --- Utilities (ported strictly) ---
import { resolveBridgePolicy, resolvePolicyActions } from '../bridge-policies.js';
import { logHubStageTiming } from '../hub/pipeline/hub-stage-timing.js';
import {
  RESPONSES_TOOL_PASSTHROUGH_KEYS,
  RESPONSES_REQUEST_PARAMETER_KEYS,
  buildSlimBridgeDecisionMetadata,
  buildSlimResponsesBridgeContext,
  collectResponsesRequestParameters,
  extractMetadataExtraFields,
  pickObjectFields,
  sanitizeCapturedResponsesInput,
  stripToolControlFieldsFromContextMetadata,
  stripToolControlFieldsFromParameterObject,
  unwrapData
} from './responses-openai-bridge/utils.js';

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

function hasToolSignalsInMessages(messages: Array<Record<string, unknown>>): boolean {
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
    if (role === 'tool') {
      return true;
    }
    if (typeof message.tool_call_id === 'string' && message.tool_call_id.trim().length) {
      return true;
    }
    const toolCalls = (message as Record<string, unknown>).tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      return true;
    }
  }
  return false;
}

function filterResponsesInboundActionsByPayloadHints(
  actions: Array<{ name: string; options?: Record<string, unknown> }> | undefined,
  messages: Array<Record<string, unknown>>
): Array<{ name: string; options?: Record<string, unknown> }> | undefined {
  if (!actions?.length) {
    return actions;
  }
  const hasToolSignals = hasToolSignalsInMessages(messages);
  if (hasToolSignals) {
    return actions;
  }
  const toolOnlyActions = new Set([
    'tools.normalize-call-ids',
    'tools.ensure-placeholders'
  ]);
  return actions.filter((action) => {
    const name = typeof action?.name === 'string' ? action.name.trim().toLowerCase() : '';
    return !toolOnlyActions.has(name);
  });
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

function readResumeDeltaInputFromChatSemantics(chat: Record<string, unknown>): BridgeInputItem[] | undefined {
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
  const requestId =
    typeof context.requestId === 'string' && context.requestId.trim().length
      ? context.requestId
      : 'unknown';
  const toolsNormalized = Array.isArray(context.toolsNormalized) && context.toolsNormalized.length
    ? (context.toolsNormalized as unknown as ChatToolDefinition[])
    : (mapReqInboundBridgeToolsToChatWithNative((payload as any).tools) as unknown as ChatToolDefinition[]);

  logHubStageTiming(requestId, 'req_inbound.responses.convert_input_to_messages', 'start');
  const convertStart = Date.now();
  let messages = convertBridgeInputToChatMessages({
    input: context.input,
    tools: toolsNormalized,
    normalizeFunctionName: 'responses',
    toolResultFallbackText: '',
    allowDanglingToolCalls: true,
    allowOrphanToolResult:
      typeof (payload as Record<string, unknown>).previous_response_id === 'string'
      && ((payload as Record<string, unknown>).previous_response_id as string).trim().length > 0
  });
  logHubStageTiming(requestId, 'req_inbound.responses.convert_input_to_messages', 'completed', {
    elapsedMs: Date.now() - convertStart,
    forceLog: true
  });
  const bridgePolicy = resolveBridgePolicy({ protocol: 'openai-responses', moduleType: 'openai-responses' });
  const policyActions = filterResponsesInboundActionsByPayloadHints(
    filterRedundantResponsesReasoningAction(
      resolvePolicyActions(bridgePolicy, 'request_inbound')
    ),
    messages
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
  if (Array.isArray(context.originalSystemMessages) && context.originalSystemMessages.length) {
    const preservedSystems = context.originalSystemMessages
      .map((text) => ({ role: 'system' as const, content: text }))
      .filter((message) => typeof message.content === 'string');
    if (preservedSystems.length) {
      const nonSystemMessages = messages.filter((msg: any) => String(msg?.role).toLowerCase() !== 'system');
      messages = [...preservedSystems, ...nonSystemMessages];
    }
  }
  messages = appendLocalImageBlockOnLatestUserInputWithNative({ messages }).messages;
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
  const previousResponseId =
    typeof bridgeDecisions.previousResponseId === 'string' && bridgeDecisions.previousResponseId.trim().length > 0
      ? bridgeDecisions.previousResponseId.trim()
      : readPreviousResponseIdFromChatSemantics(chat as Record<string, unknown>);
  const stripHostFields = shouldStripHostManagedFields(ctx);
  const continuationPreviousResponseId = stripHostFields ? '' : previousResponseId;
  const resumedDeltaInput =
    continuationPreviousResponseId.length > 0
      ? readResumeDeltaInputFromChatSemantics(chat as Record<string, unknown>)
      : undefined;

  // tools: 反向映射为 ResponsesToolDefinition 形状
  const chatTools: ChatToolDefinition[] = Array.isArray(chat.tools) ? (chat.tools as ChatToolDefinition[]) : [];

  const responsesToolsFromChat = mapChatToolsToBridge(chatTools, {
    sanitizeName: sanitizeResponsesFunctionName
  });

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
  const inputForUpstream =
    continuationPreviousResponseId.length > 0 && Array.isArray(resumedDeltaInput)
      ? resumedDeltaInput
      : input;
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
  for (const key of RESPONSES_REQUEST_PARAMETER_KEYS) {
    if (key === 'temperature' || key === 'top_p') {
      continue;
    }
    if (out[key] !== undefined || retainedParameters[key] === undefined) {
      continue;
    }
    out[key] = jsonClone(retainedParameters[key] as JsonValue);
  }
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
  const result = evaluateResponsesHostPolicy(context, typeof context?.targetProtocol === 'string' ? context?.targetProtocol : undefined);
  return result.shouldStripHostManagedFields;
}

export {
  buildResponsesPayloadFromChat,
  extractRequestIdFromResponse
} from './responses-openai-bridge/response-payload.js';

export { buildChatResponseFromResponses } from '../shared/responses-response-utils.js';
export { collectResponsesRequestParameters } from './responses-openai-bridge/utils.js';
// (imports moved to top)
