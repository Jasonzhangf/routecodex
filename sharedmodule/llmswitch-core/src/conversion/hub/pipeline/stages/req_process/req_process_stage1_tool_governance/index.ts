import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { ProcessedRequest, StandardizedRequest } from '../../../../types/standardized.js';
import type { HubProcessNodeResult } from '../../../../process/chat-process.js';
import { recordStage } from '../../../stages/utils.js';
import { applyReqProcessToolGovernanceWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-process-semantics.js';
import { maybeInjectClockRemindersAndApplyDirectives } from '../../../../process/chat-process-clock-reminders.js';
import { resolveHasActiveStopMessageForContinueExecution } from '../../../../process/chat-process-continue-execution.js';
import { sanitizeChatProcessRequest } from '../../../../process/chat-process-request-sanitizer.js';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
  const hasActiveStopMessageForContinueExecution =
    resolveHasActiveStopMessageForContinueExecution(options.metadata);
  const nativeResult = applyReqProcessToolGovernanceWithNative({
    request: options.request as unknown as Record<string, unknown>,
    rawPayload: options.rawPayload,
    metadata: options.metadata,
    entryEndpoint: options.entryEndpoint,
    requestId: options.requestId,
    hasActiveStopMessageForContinueExecution
  });

  let processedRequest = parseProcessedRequest(nativeResult.processedRequest);
  const nodeResult = parseNodeResult(nativeResult.nodeResult);

  processedRequest = await maybeInjectClockRemindersAndApplyDirectives(
    processedRequest as unknown as StandardizedRequest,
    options.metadata,
    options.requestId
  ) as ProcessedRequest;
  processedRequest = sanitizeChatProcessRequest(processedRequest as unknown as StandardizedRequest) as ProcessedRequest;

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
