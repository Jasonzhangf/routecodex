import type { ProviderContext } from '../api/provider-types.js';
import type { UnknownObject } from '../../../types/common-types.js';
import { ProviderPayloadUtils } from './transport/provider-payload-utils.js';

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
    return { __sse_responses: sseStream } as UnknownObject;
  }

  return {
    data: processedRecord.data || processedResponse,
    status: processedRecord.status ?? originalRecord.status,
    headers: processedRecord.headers || originalRecord.headers,
    metadata: {
      requestId: args.context.requestId,
      processingTime,
      providerType: args.providerType,
      model: args.context.model
        ?? ProviderPayloadUtils.extractModel(processedRecord)
        ?? ProviderPayloadUtils.extractModel(originalRecord),
      usage: ProviderPayloadUtils.extractUsage(processedRecord)
        ?? ProviderPayloadUtils.extractUsage(originalRecord)
    }
  } as UnknownObject;
}
