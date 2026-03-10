import type { ProcessedRequest, StandardizedRequest } from '../types/standardized.js';
import type { JsonObject } from '../types/json.js';
import {
  applyChatProcessedRequestWithNative,
  buildChatNodeResultMetadataWithNative
} from '../../../router/virtual-router/engine-selection/native-chat-process-node-result-semantics.js';

export interface HubProcessNodeResult {
  success: boolean;
  metadata: {
    node: string;
    executionTime: number;
    startTime: number;
    endTime: number;
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
    metadata: metadata as HubProcessNodeResult['metadata']
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
    error: {
      message: error instanceof Error ? error.message : String(error)
    }
  };
}
