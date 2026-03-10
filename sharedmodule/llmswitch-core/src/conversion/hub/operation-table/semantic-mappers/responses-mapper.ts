import type { SemanticMapper } from '../../format-adapters/index.js';
import type {
  AdapterContext,
  ChatEnvelope,
  ChatMessage,
  ChatSemantics,
  ChatToolDefinition,
  ChatToolOutput,
  MissingField
} from '../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../types/format-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';
import {
  captureResponsesContext,
  buildChatRequestFromResponses,
  buildResponsesRequestFromChat,
  type ResponsesRequestContext
} from '../../../responses/responses-openai-bridge.js';
import { logHubStageTiming } from '../../pipeline/hub-stage-timing.js';
import { maybeAugmentApplyPatchErrorContent } from './chat-mapper.js';
import {
  mapReqInboundBridgeToolsToChatWithNative,
  mapReqInboundResumeToolOutputsDetailedWithNative
} from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

interface ResponsesToolOutputEntry extends JsonObject {
  tool_call_id?: string;
  call_id?: string;
  id?: string;
  output?: JsonValue;
  name?: string;
}

interface ResponsesPayload extends JsonObject {
  input?: JsonValue[];
  tools?: JsonValue[];
  tool_outputs?: ResponsesToolOutputEntry[];
}

interface ResponsesSubmitPayload extends JsonObject {
  response_id: string;
  tool_outputs: ResponsesToolOutputEntry[];
  stream?: boolean;
  model?: string;
  metadata?: JsonObject;
}

const RESPONSES_PARAMETER_KEYS: readonly string[] = [
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
  'user',
  'logit_bias',
  'seed',
  'stop',
  'stop_sequences',
  'modalities'
];

const RESPONSES_SUBMIT_ENDPOINT = '/v1/responses.submit_tool_outputs';

function mapToolOutputs(entries: ResponsesToolOutputEntry[] | undefined, missing: MissingField[]): ChatToolOutput[] | undefined {
  if (!entries || !entries.length) return undefined;
  const outputs: ChatToolOutput[] = [];
  entries.forEach((entry, index) => {
    if (!isJsonObject(entry)) {
      missing.push({ path: `tool_outputs[${index}]`, reason: 'invalid_entry', originalValue: jsonClone(entry as JsonValue) });
      return;
    }
    const callId = entry.tool_call_id || entry.call_id || entry.id;
    if (!callId) {
      missing.push({ path: `tool_outputs[${index}].tool_call_id`, reason: 'missing_tool_call_id' });
      return;
    }
    let content = '';
    if (typeof entry.output === 'string') {
      content = entry.output;
    } else if (entry.output != null) {
      try {
        content = JSON.stringify(entry.output);
      } catch {
        content = String(entry.output);
      }
    }
    const nameValue = typeof entry.name === 'string' ? entry.name : undefined;
    const augmented = maybeAugmentApplyPatchErrorContent(content, nameValue);
    outputs.push({
      tool_call_id: String(callId),
      content: augmented,
      name: nameValue
    });
  });
  return outputs.length ? outputs : undefined;
}

function deriveResumeToolOutputsFromResume(resume: Record<string, unknown>): ChatToolOutput[] | undefined {
  if (!resume || typeof resume !== 'object') {
    return undefined;
  }
  const mapped = mapReqInboundResumeToolOutputsDetailedWithNative(resume);
  if (!Array.isArray(mapped) || mapped.length === 0) {
    return undefined;
  }
  const outputs: ChatToolOutput[] = mapped.map((entry) => ({
    tool_call_id: entry.tool_call_id,
    content: entry.content
  }));
  return outputs.length ? outputs : undefined;
}

function collectParameters(payload: ResponsesPayload, streamHint: boolean | undefined): JsonObject | undefined {
  const params: JsonObject = {};
  for (const key of RESPONSES_PARAMETER_KEYS) {
    if (payload[key] !== undefined) {
      params[key] = payload[key] as JsonValue;
    }
  }
  if (streamHint !== undefined) {
    params.stream = streamHint;
  }
  return Object.keys(params).length ? params : undefined;
}

function normalizeTools(rawTools: JsonValue[] | undefined, missing: MissingField[]): ChatToolDefinition[] | undefined {
  if (!rawTools || rawTools.length === 0) {
    return undefined;
  }
  const tools = mapReqInboundBridgeToolsToChatWithNative(rawTools as unknown[]) as unknown as ChatToolDefinition[];
  if (tools.length === 0) {
    rawTools.forEach((tool, index) => {
      missing.push({ path: `tools[${index}]`, reason: 'invalid_entry', originalValue: jsonClone(tool as JsonValue) });
    });
  }
  return tools.length ? tools : undefined;
}

function normalizeMessages(value: JsonValue | undefined, missing: MissingField[]): ChatEnvelope['messages'] {
  if (!Array.isArray(value)) {
    if (value !== undefined) {
      missing.push({ path: 'messages', reason: 'invalid_type', originalValue: jsonClone(value) });
    } else {
      missing.push({ path: 'messages', reason: 'absent' });
    }
    return [];
  }
  const messages: ChatEnvelope['messages'] = [];
  value.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      missing.push({ path: `messages[${index}]`, reason: 'invalid_entry', originalValue: jsonClone(item as JsonValue) });
      return;
    }
    messages.push(item as ChatEnvelope['messages'][number]);
  });
  return messages;
}

function serializeSystemContent(message: ChatMessage): string | undefined {
  if (!message) return undefined;
  const content = message.content as unknown;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    content.forEach(part => {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (part && typeof part === 'object') {
        const text = (part as JsonObject).text;
        if (typeof text === 'string') {
          parts.push(text);
        }
      }
    });
    return parts.join('');
  }
  if (content != null) {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return undefined;
}

function mergeMetadata(a?: JsonObject, b?: JsonObject): JsonObject | undefined {
  if (!a && !b) {
    return undefined;
  }
  if (!a && b) {
    return jsonClone(b) as JsonObject;
  }
  if (a && !b) {
    return jsonClone(a) as JsonObject;
  }
  const left = jsonClone(a as JsonObject) as JsonObject;
  const right = jsonClone(b as JsonObject) as JsonObject;
  return { ...left, ...right };
}

function isSubmitToolOutputsEndpoint(ctx: AdapterContext): boolean {
  if (!ctx || typeof ctx !== 'object') {
    return false;
  }
  const entry = typeof ctx.entryEndpoint === 'string' ? ctx.entryEndpoint.trim().toLowerCase() : '';
  return entry === RESPONSES_SUBMIT_ENDPOINT;
}

function attachResponsesSemantics(
  existing: ChatSemantics | undefined,
  context?: ResponsesRequestContext,
  resume?: JsonObject
): ChatSemantics | undefined {
  if (!context && !resume) {
    return existing;
  }
  const next: ChatSemantics = existing ? { ...existing } : {};
  const currentNode =
    next.responses && isJsonObject(next.responses) ? ({ ...(next.responses as JsonObject) } as JsonObject) : ({} as JsonObject);
  if (context) {
    currentNode.context = jsonClone(context as JsonObject);
  }
  if (resume) {
    currentNode.resume = jsonClone(resume);
  }
  next.responses = currentNode;
  return next;
}

function extractResponsesSemanticsNode(chat: ChatEnvelope): JsonObject | undefined {
  if (!chat?.semantics || typeof chat.semantics !== 'object') {
    return undefined;
  }
  const node = chat.semantics.responses;
  return node && isJsonObject(node) ? (node as JsonObject) : undefined;
}

function readResponsesContextFromSemantics(chat: ChatEnvelope): ResponsesRequestContext | undefined {
  const node = extractResponsesSemanticsNode(chat);
  if (!node) {
    return undefined;
  }
  const contextNode = node.context;
  if (!contextNode || !isJsonObject(contextNode)) {
    return undefined;
  }
  return jsonClone(contextNode as JsonObject) as ResponsesRequestContext;
}

function readResponsesResumeFromSemantics(chat: ChatEnvelope): JsonObject | undefined {
  const node = extractResponsesSemanticsNode(chat);
  if (!node) {
    return undefined;
  }
  const resumeNode = node.resume;
  if (!resumeNode || !isJsonObject(resumeNode)) {
    return undefined;
  }
  return jsonClone(resumeNode as JsonObject);
}

function selectResponsesContextSnapshot(
  chat: ChatEnvelope,
  envelopeMetadata?: JsonObject
): ResponsesRequestContext {
  const semanticsContext = readResponsesContextFromSemantics(chat);
  const context: ResponsesRequestContext =
    semanticsContext ??
    ({
      metadata: envelopeMetadata
    } as ResponsesRequestContext);
  const mergedMetadata = mergeMetadata(
    (context.metadata as JsonObject | undefined) ?? undefined,
    envelopeMetadata
  );
  if (mergedMetadata) {
    context.metadata = mergedMetadata;
  }
  return context;
}

function resolveSubmitResponseId(
  resumeMeta: Record<string, unknown> | undefined,
  responsesContext?: ResponsesRequestContext
): string | undefined {
  const resumeId =
    typeof resumeMeta?.restoredFromResponseId === 'string'
      ? resumeMeta.restoredFromResponseId.trim()
      : undefined;
  if (resumeId) {
    return resumeId;
  }
  const contextRecord =
    responsesContext && typeof responsesContext === 'object'
      ? (responsesContext as Record<string, unknown>)
      : undefined;
  const previousId =
    typeof contextRecord?.previous_response_id === 'string'
      ? contextRecord.previous_response_id.trim()
      : undefined;
  if (previousId) {
    return previousId;
  }
  return undefined;
}

function extractSubmitMetadata(
  responsesContext?: ResponsesRequestContext,
  resumeMeta?: Record<string, unknown>
): JsonObject | undefined {
  if (responsesContext && responsesContext.metadata && isJsonObject(responsesContext.metadata)) {
    return jsonClone(responsesContext.metadata as JsonObject);
  }
  if (resumeMeta && resumeMeta.metadata && isJsonObject(resumeMeta.metadata as any)) {
    return jsonClone(resumeMeta.metadata as any as JsonObject);
  }
  return undefined;
}

function coerceOutputText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractCapturedToolOutputs(
  responsesContext?: ResponsesRequestContext
): ResponsesToolOutputEntry[] {
  if (!responsesContext || typeof responsesContext !== 'object') {
    return [];
  }
  const snapshot = (responsesContext as Record<string, unknown>).__captured_tool_results;
  if (!Array.isArray(snapshot) || !snapshot.length) {
    return [];
  }
  const entries: ResponsesToolOutputEntry[] = [];
  snapshot.forEach((entry) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const record = entry as Record<string, unknown>;
    const toolId =
      typeof record.tool_call_id === 'string' && record.tool_call_id.trim().length
        ? record.tool_call_id.trim()
        : typeof record.call_id === 'string' && record.call_id.trim().length
          ? record.call_id.trim()
          : undefined;
    if (!toolId) {
      return;
    }
    entries.push({
      tool_call_id: toolId,
      id: toolId,
      output: typeof record.output === 'string' ? record.output : coerceOutputText(record.output),
      name: typeof record.name === 'string' ? record.name : undefined
    });
  });
  return entries;
}

function collectSubmitToolOutputs(
  chat: ChatEnvelope,
  responsesContext?: ResponsesRequestContext
): ResponsesToolOutputEntry[] {
  const outputs: ResponsesToolOutputEntry[] = [];
  const seen = new Set<string>();
  const append = (idSeed: unknown, outputSeed: unknown, name?: string) => {
    const trimmed = typeof idSeed === 'string' && idSeed.trim().length ? idSeed.trim() : '';
    const fallbackId = trimmed || `submit_tool_${outputs.length + 1}`;
    if (seen.has(fallbackId)) {
      return;
    }
    seen.add(fallbackId);
    outputs.push({
      tool_call_id: fallbackId,
      id: fallbackId,
      output: coerceOutputText(outputSeed),
      name
    });
  };
  if (Array.isArray(chat.toolOutputs) && chat.toolOutputs.length) {
    chat.toolOutputs.forEach((entry) => {
      append(entry.tool_call_id ?? (entry as Record<string, unknown>).call_id, entry.content, entry.name);
    });
  }
  if (!outputs.length) {
    const captured = extractCapturedToolOutputs(responsesContext);
    captured.forEach((entry) => append(entry.tool_call_id ?? entry.id, entry.output, entry.name));
  }
  if (!outputs.length) {
    const resume = readResponsesResumeFromSemantics(chat);
    if (resume) {
      const resumeOutputs = deriveResumeToolOutputsFromResume(resume as Record<string, unknown>);
      if (resumeOutputs?.length) {
        resumeOutputs.forEach((entry) => append(entry.tool_call_id, entry.content, entry.name));
      }
    }
  }
  return outputs;
}

function resolveSubmitStreamFlag(
  chat: ChatEnvelope,
  _ctx: AdapterContext,
  _responsesContext?: ResponsesRequestContext
): boolean | undefined {
  if (chat.parameters && typeof chat.parameters.stream === 'boolean') {
    return chat.parameters.stream;
  }
  return undefined;
}

function resolveSubmitModel(
  chat: ChatEnvelope,
  _responsesContext?: ResponsesRequestContext
): string | undefined {
  const direct = chat.parameters && typeof chat.parameters.model === 'string'
    ? chat.parameters.model.trim()
    : undefined;
  if (direct) {
    return direct;
  }
  return undefined;
}

function buildSubmitToolOutputsPayload(
  chat: ChatEnvelope,
  ctx: AdapterContext,
  responsesContext: ResponsesRequestContext
): ResponsesSubmitPayload {
  const resumeMeta = (() => {
    try {
      const resume = readResponsesResumeFromSemantics(chat);
      return resume && typeof resume === 'object' && !Array.isArray(resume) ? (resume as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  })();
  const responseId = resolveSubmitResponseId(resumeMeta, responsesContext);
  if (!responseId) {
    throw new Error('Submit tool outputs requires response_id from Responses resume context');
  }
  const toolOutputs = collectSubmitToolOutputs(chat, responsesContext);
  if (!toolOutputs.length) {
    throw new Error('Submit tool outputs requires at least one tool output entry');
  }
  const payload: ResponsesSubmitPayload = {
    response_id: responseId,
    tool_outputs: toolOutputs
  };
  const modelValue = resolveSubmitModel(chat, responsesContext);
  if (modelValue) {
    payload.model = modelValue;
  }
  const streamValue = resolveSubmitStreamFlag(chat, ctx, responsesContext);
  if (typeof streamValue === 'boolean') {
    payload.stream = streamValue;
  }
  const metadata = extractSubmitMetadata(responsesContext, resumeMeta);
  if (metadata) {
    payload.metadata = metadata;
  }
  return payload;
}

export class ResponsesSemanticMapper implements SemanticMapper {
  async toChat(format: FormatEnvelope<ResponsesPayload>, ctx: AdapterContext): Promise<ChatEnvelope> {
    const requestId = typeof ctx.requestId === 'string' && ctx.requestId.trim().length ? ctx.requestId : 'unknown';
    const payload = format.payload || {};
    logHubStageTiming(requestId, 'req_inbound.responses.capture_context', 'start');
    const captureStart = Date.now();
    const responsesContext = captureResponsesContext(payload, { route: { requestId: ctx.requestId } });
    logHubStageTiming(requestId, 'req_inbound.responses.capture_context', 'completed', {
      elapsedMs: Date.now() - captureStart,
      forceLog: true
    });
    logHubStageTiming(requestId, 'req_inbound.responses.build_chat_request', 'start');
    const buildChatStart = Date.now();
    const { request, toolsNormalized } = buildChatRequestFromResponses(payload, responsesContext);
    logHubStageTiming(requestId, 'req_inbound.responses.build_chat_request', 'completed', {
      elapsedMs: Date.now() - buildChatStart,
      forceLog: true
    });
    const missingFields: MissingField[] = [];
    const messages = normalizeMessages(request.messages as JsonValue, missingFields);
    let toolOutputs = mapToolOutputs(payload.tool_outputs, missingFields);
    const parameters = collectParameters(
      payload,
      typeof payload.stream === 'boolean' ? payload.stream : undefined
    );
    const metadata: ChatEnvelope['metadata'] = { context: ctx };
    if (missingFields.length) {
      metadata.missingFields = missingFields;
    }
    // Keep responses protocol semantics in chat.semantics (not metadata).
    const semantics = attachResponsesSemantics(undefined, responsesContext, undefined);
    return {
      messages,
      tools: normalizeTools(toolsNormalized as JsonValue[] | undefined, missingFields),
      toolOutputs,
      parameters,
      semantics,
      metadata
    };
  }

  async fromChat(chat: ChatEnvelope, ctx: AdapterContext): Promise<FormatEnvelope> {
    const requestId = typeof ctx.requestId === 'string' && ctx.requestId.trim().length ? ctx.requestId : 'unknown';
    const envelopeMetadata = chat.metadata && isJsonObject(chat.metadata) ? (chat.metadata as JsonObject) : undefined;
    const responsesContext = selectResponsesContextSnapshot(chat, envelopeMetadata);
    if (isSubmitToolOutputsEndpoint(ctx)) {
      const submitPayload = buildSubmitToolOutputsPayload(chat, ctx, responsesContext);
      return {
        protocol: 'openai-responses',
        direction: 'response',
        payload: submitPayload,
        meta: {
          context: ctx,
          submitToolOutputs: true
        }
      };
    }
    const modelValue = chat.parameters?.model;
    if (typeof modelValue !== 'string' || !modelValue.trim()) {
      throw new Error('ChatEnvelope.parameters.model is required for openai-responses outbound conversion');
    }
    const requestShape: JsonObject = {
      ...(chat.parameters || {}),
      model: modelValue,
      messages: chat.messages,
      tools: chat.tools
    };
    if (!Array.isArray(responsesContext.originalSystemMessages) || responsesContext.originalSystemMessages.length === 0) {
      const originalSystemMessages = (chat.messages || [])
        .filter((message): message is ChatMessage => Boolean(message && typeof message === 'object' && message.role === 'system'))
        .map(message => serializeSystemContent(message))
        .filter((content): content is string => typeof content === 'string' && content.length > 0);
      responsesContext.originalSystemMessages = originalSystemMessages;
    }
    logHubStageTiming(requestId, 'req_outbound.responses.build_request', 'start');
    const buildRequestStart = Date.now();
    const responsesResult = buildResponsesRequestFromChat(requestShape, responsesContext);
    logHubStageTiming(requestId, 'req_outbound.responses.build_request', 'completed', {
      elapsedMs: Date.now() - buildRequestStart,
      forceLog: true
    });
    const responses = responsesResult.request as JsonObject;
    if (chat.parameters && chat.parameters.stream !== undefined) {
      (responses as ResponsesPayload).stream = chat.parameters.stream as JsonValue;
    }
    // Do not forward ChatEnvelope.toolOutputs to OpenAI Responses create requests.
    // Upstream expects historical tool results to remain inside input[] as
    // tool role messages; sending the legacy top-level `tool_outputs` field
    // causes providers like FAI to reject the request (HTTP 400). Any actual
    // submit_tool_outputs call should be issued via the dedicated endpoint
    // upstream, not through this mapper.
    const result: FormatEnvelope<ResponsesPayload> = {
      protocol: 'openai-responses',
      direction: 'response',
      payload: responses as ResponsesPayload,
      meta: {
        context: ctx
      }
    };
    
    // Sampling knobs should remain intact for OpenAI Responses protocol.
    // Provider-specific removal belongs in compatibility profiles, not here.

    return result;
  }
}
