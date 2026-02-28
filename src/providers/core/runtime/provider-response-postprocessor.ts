import type { ProviderContext } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import { ProviderPayloadUtils } from './transport/provider-payload-utils.js';

function hasSessionRewriteActive(context: ProviderContext): boolean {
  const meta = context?.runtimeMetadata?.metadata;
  if (!meta || typeof meta !== 'object') {
    return false;
  }
  const value = (meta as Record<string, unknown>).__iflowSessionRewriteActive;
  return value === true;
}

function restoreClientSessionHeaders(
  context: ProviderContext,
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!hasSessionRewriteActive(context) || !headers) {
    return headers;
  }

  const meta = context.runtimeMetadata?.metadata as Record<string, unknown> | undefined;
  const clientSessionId =
    typeof meta?.__iflowClientSessionId === 'string'
      ? meta.__iflowClientSessionId
      : undefined;
  const clientConversationId =
    typeof meta?.__iflowClientConversationId === 'string'
      ? meta.__iflowClientConversationId
      : undefined;

  const nextHeaders: Record<string, string> = { ...headers };
  if (clientSessionId) {
    nextHeaders['session_id'] = clientSessionId;
    nextHeaders['session-id'] = clientSessionId;
  }
  if (clientConversationId) {
    nextHeaders['conversation_id'] = clientConversationId;
    nextHeaders['conversation-id'] = clientConversationId;
  }

  return nextHeaders;
}

export function buildPostprocessedProviderResponse(args: {
  response: unknown;
  context: ProviderContext;
  providerType: string;
}): UnknownObject {
  const processingTime = Date.now() - args.context.startTime;
  const processedResponse = args.response;
  const originalRecord = ProviderPayloadUtils.asResponseRecord(args.response);
  const processedRecord = ProviderPayloadUtils.asResponseRecord(processedResponse);

  const sseStream =
    processedRecord.__sse_responses ||
    processedRecord.data?.__sse_responses;
  if (sseStream) {
    const headersFromRecord = typeof processedRecord.headers === 'object' && processedRecord.headers !== null
      ? (processedRecord.headers as Record<string, string>)
      : undefined;
    const restoredHeaders = restoreClientSessionHeaders(args.context, headersFromRecord);
    const result: UnknownObject = { __sse_responses: sseStream };
    if (restoredHeaders && Object.keys(restoredHeaders).length > 0) {
      result.headers = restoredHeaders;
    }
    return result;
  }

  const baseHeaders = typeof processedRecord.headers === 'object' && processedRecord.headers !== null
    ? (processedRecord.headers as Record<string, string>)
    : typeof originalRecord.headers === 'object' && originalRecord.headers !== null
      ? (originalRecord.headers as Record<string, string>)
      : undefined;
  const restoredHeaders = restoreClientSessionHeaders(args.context, baseHeaders);

  const result: UnknownObject = {
    data: processedRecord.data || processedResponse,
    status: processedRecord.status ?? originalRecord.status
  };

  if (restoredHeaders && Object.keys(restoredHeaders).length > 0) {
    result.headers = restoredHeaders;
  }

  result.metadata = {
    requestId: args.context.requestId,
    processingTime,
    providerType: args.providerType,
    model:
      args.context.model ??
      ProviderPayloadUtils.extractModel(processedRecord) ??
      ProviderPayloadUtils.extractModel(originalRecord),
    usage:
      ProviderPayloadUtils.extractUsage(processedRecord) ??
      ProviderPayloadUtils.extractUsage(originalRecord)
  };

  return result;
}
