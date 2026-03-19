import type { AdapterContext, ChatEnvelope, ChatToolOutput } from '../../types/chat-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';
import type { ResponsesRequestContext } from '../../../responses/responses-openai-bridge.js';
import { mapReqInboundResumeToolOutputsDetailedWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

export interface ResponsesToolOutputEntry extends JsonObject {
  tool_call_id?: string;
  call_id?: string;
  id?: string;
  output?: JsonValue;
  name?: string;
}

export interface ResponsesSubmitPayload extends JsonObject {
  response_id: string;
  tool_outputs: ResponsesToolOutputEntry[];
  stream?: boolean;
  model?: string;
  metadata?: JsonObject;
}

const RESPONSES_SUBMIT_ENDPOINT = '/v1/responses.submit_tool_outputs';

export function isSubmitToolOutputsEndpoint(ctx: AdapterContext): boolean {
  if (!ctx || typeof ctx !== 'object') {
    return false;
  }
  const entry = typeof ctx.entryEndpoint === 'string' ? ctx.entryEndpoint.trim().toLowerCase() : '';
  return entry === RESPONSES_SUBMIT_ENDPOINT;
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

function readResponsesResumeFromSemantics(chat: ChatEnvelope): JsonObject | undefined {
  if (!chat?.semantics || typeof chat.semantics !== 'object') {
    return undefined;
  }
  const node = chat.semantics.responses;
  if (!node || !isJsonObject(node)) {
    return undefined;
  }
  const resumeNode = (node as JsonObject).resume;
  if (!resumeNode || !isJsonObject(resumeNode)) {
    return undefined;
  }
  return jsonClone(resumeNode as JsonObject);
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

export function buildSubmitToolOutputsPayload(
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
