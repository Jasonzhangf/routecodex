import type { ProcessedRequest, StandardizedRequest } from '../types/standardized.js';
import {
  buildErrorResult,
  buildProcessedRequest,
  buildSuccessResult
} from './chat-process-node-result.js';
import { runReqProcessStage1ToolGovernance } from '../pipeline/stages/req_process/req_process_stage1_tool_governance/index.js';
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
    const processedRequest = shouldRunGovernance
      ? (await runReqProcessStage1ToolGovernance({
          request: options.request,
          rawPayload: options.rawPayload,
          metadata: options.metadata,
          entryEndpoint: options.entryEndpoint,
          requestId: options.requestId,
        })).processedRequest
      : buildProcessedRequest(options.request);
    if (!processedRequest) {
      throw new Error('Rust req_process total stage returned no processed request');
    }
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
