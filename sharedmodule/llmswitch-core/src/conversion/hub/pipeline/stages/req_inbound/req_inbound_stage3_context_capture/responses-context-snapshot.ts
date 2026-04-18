import type { AdapterContext } from '../../../../types/chat-envelope.js';
import type { JsonObject } from '../../../../types/json.js';
import type { ResponsesRequestContext } from '../../../../../responses/responses-openai-bridge.js';
import { captureResponsesRequestContext } from '../../../../../shared/responses-conversation-store.js';
import {
  captureReqInboundResponsesContextSnapshotWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

export interface ResponsesContextCaptureOptions {
  rawRequest: JsonObject;
  adapterContext: AdapterContext;
}

export function captureResponsesContextSnapshot(
  options: ResponsesContextCaptureOptions
): ResponsesRequestContext {
  const context = captureReqInboundResponsesContextSnapshotWithNative({
    rawRequest: options.rawRequest as unknown as Record<string, unknown>,
    requestId: options.adapterContext.requestId,
    toolCallIdStyle: options.adapterContext.toolCallIdStyle
  }) as unknown as ResponsesRequestContext;

  // OpenAI Responses tool loop: store the request context keyed by requestId so that
  // `/v1/responses/:id/submit_tool_outputs` can resume the conversation later.
  //
  // This must be done on the hub pipeline inbound path (not in host/provider), because:
  // - the tool loop is a client-protocol behavior (/v1/responses), independent of providerProtocol;
  // - providers must remain transport-only;
  // - the host may later enhance requestId with providerKey/model for logging, which is handled via rebind.
  const requestId =
    typeof options.adapterContext.requestId === 'string' && options.adapterContext.requestId.trim().length
      ? options.adapterContext.requestId
      : undefined;
  if (requestId) {
    // captureResponsesRequestContext already best-effort wraps store failures.
    captureResponsesRequestContext({
      requestId,
      payload: options.rawRequest as unknown as Record<string, unknown>,
      context: context as unknown as Record<string, unknown>,
      sessionId:
        typeof (options.adapterContext as Record<string, unknown>).sessionId === 'string'
          ? String((options.adapterContext as Record<string, unknown>).sessionId).trim() || undefined
          : undefined,
      conversationId:
        typeof (options.adapterContext as Record<string, unknown>).conversationId === 'string'
          ? String((options.adapterContext as Record<string, unknown>).conversationId).trim() || undefined
          : undefined
    });
  }
  return context;
}
