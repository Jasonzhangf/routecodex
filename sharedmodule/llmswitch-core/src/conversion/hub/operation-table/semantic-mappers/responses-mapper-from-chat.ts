import type { AdapterContext, ChatEnvelope, ChatMessage } from '../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../types/format-envelope.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../types/json.js';
import { buildResponsesRequestFromChat } from '../../../responses/responses-openai-bridge.js';
import { logHubStageTiming } from '../../pipeline/hub-stage-timing.js';
import {
  buildSubmitToolOutputsPayload,
  isSubmitToolOutputsEndpoint,
} from './responses-submit-tool-outputs.js';
import {
  readResponsesRequestParametersFromSemantics,
  selectResponsesContextSnapshot,
  serializeSystemContent,
} from './responses-mapper-helpers.js';
import type { ResponsesPayload } from './responses-mapper-config.js';

export async function buildResponsesFormatEnvelopeFromChat(
  chat: ChatEnvelope,
  ctx: AdapterContext,
): Promise<FormatEnvelope<ResponsesPayload>> {
  const requestId = typeof ctx.requestId === 'string' && ctx.requestId.trim().length ? ctx.requestId : 'unknown';
  const envelopeMetadata = chat.metadata && isJsonObject(chat.metadata as unknown as JsonValue) ? (chat.metadata as JsonObject) : undefined;
  const responsesContext = selectResponsesContextSnapshot(chat, envelopeMetadata);
  const semanticsParameters = readResponsesRequestParametersFromSemantics(chat);
  const mergedParameters =
    semanticsParameters || chat.parameters
      ? ({
          ...(semanticsParameters ?? {}),
          ...(chat.parameters ?? {})
        } as JsonObject)
      : undefined;
  if (isSubmitToolOutputsEndpoint(ctx)) {
    const submitPayload = buildSubmitToolOutputsPayload(chat, ctx, responsesContext);
    return {
      protocol: 'openai-responses',
      direction: 'response',
      payload: submitPayload,
      meta: {
        context: ctx as unknown as JsonValue as unknown as JsonValue,
        submitToolOutputs: true
      }
    };
  }
  const modelValue = mergedParameters?.model;
  if (typeof modelValue !== 'string' || !modelValue.trim()) {
    throw new Error('ChatEnvelope.parameters.model is required for openai-responses outbound conversion');
  }
  const requestShape: JsonObject = {
    ...(mergedParameters || {}),
    model: modelValue,
    messages: chat.messages as unknown as JsonValue,
    tools: chat.tools as unknown as JsonValue,
    semantics:
      chat.semantics && typeof chat.semantics === 'object'
        ? (chat.semantics as JsonObject)
        : undefined
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
  delete (responses as Record<string, unknown>).temperature;
  delete (responses as Record<string, unknown>).top_p;
  if (mergedParameters && mergedParameters.stream !== undefined) {
    (responses as ResponsesPayload).stream = mergedParameters.stream as JsonValue;
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
      context: ctx as unknown as JsonValue as unknown as JsonObject
    }
  };

  return result;
}
