import type { AdapterContext, ChatEnvelope } from '../../types/chat-envelope.js';
import { type JsonObject, type JsonValue } from '../../types/json.js';
import type { ResponsesRequestContext } from '../../../responses/responses-openai-bridge.js';
import { buildSubmitToolOutputsPayloadWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-semantic-mappers.js';

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

export function extractCapturedToolOutputs(
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
  for (const entry of snapshot) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const id = typeof row.tool_call_id === 'string' && row.tool_call_id.trim().length
      ? row.tool_call_id.trim()
      : typeof row.call_id === 'string' && row.call_id.trim().length
        ? row.call_id.trim()
        : undefined;
    if (!id) {
      continue;
    }
    entries.push({
      tool_call_id: id,
      id,
      output: row.output as JsonValue,
      ...(typeof row.name === 'string' ? { name: row.name } : {})
    });
  }
  return entries;
}

export function buildSubmitToolOutputsPayload(
  chat: ChatEnvelope,
  ctx: AdapterContext,
  responsesContext: ResponsesRequestContext
): ResponsesSubmitPayload {
  const chatEnvelopeForNative = {
    ...(chat as unknown as Record<string, unknown>),
    metadata: {
      ...(
        chat?.metadata && typeof chat.metadata === 'object' && !Array.isArray(chat.metadata)
          ? (chat.metadata as unknown as Record<string, unknown>)
          : {}
      ),
      responsesContext: (responsesContext || {}) as Record<string, unknown>
    }
  };
  const raw = buildSubmitToolOutputsPayloadWithNative({
    chatEnvelope: chatEnvelopeForNative as Record<string, unknown>,
    adapterContext: ctx as unknown as Record<string, unknown>,
    responsesContext: (responsesContext || {}) as Record<string, unknown>
  });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Submit tool outputs native bridge returned invalid payload');
  }
  const rawRecord = raw as Record<string, unknown>;
  const responseId = typeof rawRecord.response_id === 'string'
    ? rawRecord.response_id.trim()
    : typeof rawRecord.responseId === 'string'
      ? rawRecord.responseId.trim()
      : '';
  const toolOutputs = Array.isArray(rawRecord.tool_outputs)
    ? rawRecord.tool_outputs
    : Array.isArray(rawRecord.toolOutputs)
      ? rawRecord.toolOutputs
      : [];
  if (!responseId || toolOutputs.length < 1) {
    throw new Error('Submit tool outputs native bridge returned non-buildable payload');
  }
  return {
    ...(rawRecord as JsonObject),
    response_id: responseId,
    tool_outputs: toolOutputs as ResponsesToolOutputEntry[],
  } as ResponsesSubmitPayload;
}
