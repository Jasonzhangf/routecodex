import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { JsonObject } from '../../../../types/json.js';
import type { ChatReasoningMode } from '../../../../../shared/openai-finalizer.js';
import { buildProcessedRequestFromChatResponse } from '../../../../response/chat-response-utils.js';
import type { ProcessedRequest } from '../../../../types/standardized.js';
import { recordStage } from '../../../stages/utils.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../../hub-stage-timing.js';
import { finalizeRespProcessChatResponseWithNative } from '../../../../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';
import { filterOutExecutedServerToolCalls } from '../../../../../../servertool/strip-servertool-calls.js';

export interface RespProcessStage2FinalizeOptions {
  payload: JsonObject;
  originalPayload?: JsonObject;
  skipServerToolStrip?: boolean;
  entryEndpoint: string;
  requestId: string;
  wantsStream: boolean;
  reasoningMode: ChatReasoningMode;
  stageRecorder?: StageRecorder;
}

export interface RespProcessStage2FinalizeResult {
  finalizedPayload: JsonObject;
  processedRequest: ProcessedRequest;
}

export async function runRespProcessStage2Finalize(
  options: RespProcessStage2FinalizeOptions
): Promise<RespProcessStage2FinalizeResult> {
  const forceDetailLog = isHubStageTimingDetailEnabled();
  logHubStageTiming(options.requestId, 'resp_process.stage2_native_finalize', 'start');
  const nativeFinalizeStart = Date.now();
  let finalized = (await finalizeRespProcessChatResponseWithNative(
    {
      payload: options.payload,
      stream: options.wantsStream,
      reasoningMode: options.reasoningMode,
      endpoint: options.entryEndpoint,
      requestId: options.requestId
    }
  )) as JsonObject;

  // Strip executed servertool calls before returning to client (single source of truth).
  const stripSource = options.originalPayload ?? options.payload;
  if (!options.skipServerToolStrip && stripSource && typeof stripSource === 'object') {
    finalized = filterOutExecutedServerToolCalls(finalized, stripSource as JsonObject);
  }
  logHubStageTiming(options.requestId, 'resp_process.stage2_native_finalize', 'completed', {
    elapsedMs: Date.now() - nativeFinalizeStart,
    forceLog: forceDetailLog
  });
  logHubStageTiming(options.requestId, 'resp_process.stage2_build_processed_request', 'start');
  const buildProcessedRequestStart = Date.now();
  const processedRequest = buildProcessedRequestFromChatResponse(finalized, {
    stream: options.wantsStream
  });
  logHubStageTiming(options.requestId, 'resp_process.stage2_build_processed_request', 'completed', {
    elapsedMs: Date.now() - buildProcessedRequestStart,
    forceLog: forceDetailLog
  });
  recordStage(options.stageRecorder, 'chat_process.resp.stage8.finalize', {
    model: finalized.model,
    stream: options.wantsStream
  });
  return { finalizedPayload: finalized, processedRequest };
}
