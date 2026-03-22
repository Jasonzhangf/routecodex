import type {
  AdapterContext,
  ChatEnvelope,
  MissingField,
} from '../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../types/format-envelope.js';
import { type JsonObject, type JsonValue } from '../../types/json.js';
import {
  captureResponsesContext,
  buildChatRequestFromResponses,
  collectResponsesRequestParameters,
} from '../../../responses/responses-openai-bridge.js';
import { logHubStageTiming } from '../../pipeline/hub-stage-timing.js';
import {
  attachResponsesSemantics,
  mapToolOutputs,
  normalizeMessages,
  normalizeTools,
} from './responses-mapper-helpers.js';
import type { ResponsesPayload } from './responses-mapper-config.js';

function collectParameters(
  payload: ResponsesPayload,
  streamHint: boolean | undefined,
): JsonObject | undefined {
  return (collectResponsesRequestParameters(payload, { streamHint }) as JsonObject | undefined) ?? undefined;
}

export async function buildResponsesChatEnvelopeFromPayload(
  format: FormatEnvelope<ResponsesPayload>,
  ctx: AdapterContext,
): Promise<ChatEnvelope> {
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
  const toolOutputs = mapToolOutputs(payload.tool_outputs, missingFields);
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
