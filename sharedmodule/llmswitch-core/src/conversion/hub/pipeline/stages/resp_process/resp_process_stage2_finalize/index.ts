import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { JsonObject } from '../../../../types/json.js';
import type { ProcessedRequest } from '../../../../types/standardized.js';
import { recordStage } from '../../../stages/utils.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../../hub-stage-timing.js';
import { runHubPipelineStageWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-protocol.js';
import { isRecord } from '../../../../../../shared/common-utils.js';

export type ChatReasoningMode = 'keep' | 'drop' | 'append_to_content';

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
  logHubStageTiming(options.requestId, 'resp_process.stage2_rust_stage_finalize', 'start');
  const nativeStageStart = Date.now();
  const stageResult = runHubPipelineStageWithNative({
    requestId: options.requestId,
    endpoint: options.entryEndpoint,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: 'openai-chat',
    payload: options.payload,
    metadata: {
      reasoningMode: options.reasoningMode,
      originalPayload: options.originalPayload,
    },
    stream: options.wantsStream,
    processMode: 'chat',
    direction: 'response',
    stage: 'respProcessFinalize',
  });
  const finalized = stageResult.payload;
  const stageMetadata = isRecord(stageResult.metadata) ? stageResult.metadata : {};
  const processedRequest = stageMetadata.processedRequest;
  if (!isRecord(finalized)) {
    throw new Error('resp_process.stage2 finalize returned non-object payload');
  }
  if (!isRecord(processedRequest)) {
    throw new Error('resp_process.stage2 finalize returned invalid processedRequest');
  }
  logHubStageTiming(options.requestId, 'resp_process.stage2_rust_stage_finalize', 'completed', {
    elapsedMs: Date.now() - nativeStageStart,
    forceLog: forceDetailLog
  });
  recordStage(options.stageRecorder, 'chat_process.resp.stage8.finalize', {
    model: finalized.model,
    stream: options.wantsStream
  });
  return { finalizedPayload: finalized as JsonObject, processedRequest: processedRequest as unknown as ProcessedRequest };
}
