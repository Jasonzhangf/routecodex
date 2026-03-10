import type { ProcessedRequest, StandardizedRequest } from '../types/standardized.js';
import {
  buildErrorResult,
  buildProcessedRequest,
  buildSuccessResult
} from './chat-process-node-result.js';
import { applyRequestToolGovernance } from './chat-process-governance-orchestration.js';
import { shouldRunHubChatProcessWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import type { HubProcessNodeResult } from './chat-process-node-result.js';

export type { HubProcessNodeResult } from './chat-process-node-result.js';

export interface HubChatProcessOptions {
  request: StandardizedRequest;
  requestId: string;
  entryEndpoint: string;
  rawPayload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface HubChatProcessResult {
  processedRequest?: ProcessedRequest;
  nodeResult: HubProcessNodeResult;
}

export async function runHubChatProcess(options: HubChatProcessOptions): Promise<HubChatProcessResult> {
  const startTime = Date.now();
  try {
    const shouldRunGovernance = shouldRunHubChatProcessWithNative(
      options.requestId,
      options.entryEndpoint
    );
    const governed = shouldRunGovernance
      ? await applyRequestToolGovernance(options.request, {
          entryEndpoint: options.entryEndpoint,
          requestId: options.requestId,
          metadata: options.metadata,
          rawPayload: options.rawPayload
        })
      : options.request;
    const processedRequest = buildProcessedRequest(governed);
    return {
      processedRequest,
      nodeResult: buildSuccessResult(startTime, processedRequest)
    };
  } catch (error) {
    return {
      nodeResult: buildErrorResult(startTime, error)
    };
  }
}
