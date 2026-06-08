import type { ProcessedRequest, StandardizedRequest } from '../types/standardized.js';
import type { JsonObject } from '../types/json.js';
import {
  buildChatNodeResultObservationWithNative,
  applyChatProcessedRequestWithNative,
  buildChatNodeResultMetadataWithNative
} from '../../../native/router-hotpath/native-chat-process-node-result-semantics.js';

export interface HubProcessNodeResult {
  success: boolean;
  metadata: {
    node: string;
    executionTime: number;
    startTime: number;
    endTime: number;
  };
  observation?: {
    dataProcessed?: {
      messages: number;
      tools: number;
    };
  };
  error?: {
    code?: string;
    message: string;
    details?: JsonObject;
  };
}

export function buildProcessedRequest(request: StandardizedRequest): ProcessedRequest {
  const timestamp = Date.now();
  return applyChatProcessedRequestWithNative(
    request as unknown as Record<string, unknown>,
    timestamp
  ) as unknown as ProcessedRequest;
}

export function buildSuccessResult(startTime: number, processedRequest: ProcessedRequest): HubProcessNodeResult {
  const endTime = Date.now();
  const metadata = buildChatNodeResultMetadataWithNative(
    startTime,
    endTime,
    processedRequest.messages.length,
    processedRequest.tools?.length ?? 0,
    true
  );
  return {
    success: true,
    metadata: metadata as HubProcessNodeResult['metadata'],
    observation: buildChatNodeResultObservationWithNative(
      processedRequest.messages.length,
      processedRequest.tools?.length ?? 0
    ) as HubProcessNodeResult['observation']
  };
}

export function buildErrorResult(startTime: number, error: unknown): HubProcessNodeResult {
  const endTime = Date.now();
  const metadata = buildChatNodeResultMetadataWithNative(
    startTime,
    endTime,
    0,
    0,
    false
  );
  return {
    success: false,
    metadata: metadata as HubProcessNodeResult['metadata'],
    observation: buildChatNodeResultObservationWithNative(0, 0) as HubProcessNodeResult['observation'],
    error: {
      message: error instanceof Error ? error.message : String(error)
    }
  };
}
