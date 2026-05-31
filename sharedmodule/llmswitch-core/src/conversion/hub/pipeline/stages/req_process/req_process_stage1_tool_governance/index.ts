import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { ProcessedRequest, StandardizedRequest } from '../../../../types/standardized.js';
import type { HubProcessNodeResult } from '../../../../process/chat-process.js';
import { recordStage } from '../../../stages/utils.js';
import { runHubPipelineStageWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-lib.js';
import { applyHeartbeatDirectiveRuntimeSideEffectsFromProcessedRequest } from '../../../../process/blocks/chat-process-heartbeat-runtime-side-effects.js';
import { isRecord } from '../../../../../../shared/common-utils.js';

export interface ReqProcessStage1ToolGovernanceOptions {
  request: StandardizedRequest;
  rawPayload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  entryEndpoint: string;
  requestId: string;
  stageRecorder?: StageRecorder;
}

export interface ReqProcessStage1ToolGovernanceResult {
  processedRequest?: ProcessedRequest;
  nodeResult?: HubProcessNodeResult;
}


function parseProcessedRequest(value: unknown): ProcessedRequest {
  if (!isRecord(value)) {
    throw new Error('native req_process_stage1_tool_governance returned invalid processedRequest');
  }
  if (typeof value.model !== 'string' || !Array.isArray(value.messages) || !isRecord(value.parameters) || !isRecord(value.metadata)) {
    throw new Error('native req_process_stage1_tool_governance returned malformed processedRequest envelope');
  }
  if (!isRecord(value.processed) || !isRecord(value.processingMetadata)) {
    throw new Error('native req_process_stage1_tool_governance missing processed/processingMetadata');
  }
  return value as unknown as ProcessedRequest;
}

function parseNodeResult(value: unknown): HubProcessNodeResult {
  if (!isRecord(value) || typeof value.success !== 'boolean' || !isRecord(value.metadata)) {
    throw new Error('native req_process_stage1_tool_governance returned invalid nodeResult');
  }
  const errorValue = value.error;
  if (errorValue !== undefined && (!isRecord(errorValue) || typeof errorValue.message !== 'string')) {
    throw new Error('native req_process_stage1_tool_governance returned invalid nodeResult.error');
  }
  return value as unknown as HubProcessNodeResult;
}

export async function runReqProcessStage1ToolGovernance(
  options: ReqProcessStage1ToolGovernanceOptions
): Promise<ReqProcessStage1ToolGovernanceResult> {
  const stageResult = runHubPipelineStageWithNative({
    requestId: options.requestId,
    endpoint: options.entryEndpoint,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: typeof options.metadata.providerProtocol === 'string' ? options.metadata.providerProtocol : 'openai-chat',
    payload: options.request as unknown as Record<string, unknown>,
    metadata: {
      ...options.metadata,
      rawPayload: options.rawPayload,
      hasActiveStopMessageForContinueExecution: true,
    },
    stream: options.rawPayload.stream === true,
    processMode: 'chat',
    direction: 'request',
    stage: 'reqProcessToolGovernance',
  });

  const stageMetadata = isRecord(stageResult.metadata) ? stageResult.metadata : {};
  const processedRequest = parseProcessedRequest(stageResult.payload);
  const nodeResult = parseNodeResult(stageMetadata.nodeResult);
  await applyHeartbeatDirectiveRuntimeSideEffectsFromProcessedRequest(processedRequest);

  const nodeResultMetadata =
    nodeResult.metadata && typeof nodeResult.metadata === 'object'
      ? (nodeResult.metadata as Record<string, unknown>)
      : null;
  const dataProcessed =
    nodeResultMetadata?.dataProcessed && typeof nodeResultMetadata.dataProcessed === 'object'
      ? (nodeResultMetadata.dataProcessed as Record<string, unknown>)
      : null;
  if (dataProcessed) {
    dataProcessed.messages = Array.isArray(processedRequest.messages) ? processedRequest.messages.length : 0;
    dataProcessed.tools = Array.isArray(processedRequest.tools) ? processedRequest.tools.length : 0;
  }

  recordStage(options.stageRecorder, 'chat_process.req.stage4.tool_governance', processedRequest);

  return {
    processedRequest,
    nodeResult
  };
}
