import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { JsonObject } from '../../../../types/json.js';
import type { ChatReasoningMode } from '../../../../../shared/openai-finalizer.js';
import { buildProcessedRequestFromChatResponse } from '../../../../response/chat-response-utils.js';
import type { ProcessedRequest } from '../../../../types/standardized.js';
import { recordStage } from '../../../stages/utils.js';
import { finalizeRespProcessChatResponseWithNative } from '../../../../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';

export interface RespProcessStage2FinalizeOptions {
  payload: JsonObject;
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
  const finalized = (await finalizeRespProcessChatResponseWithNative(
    {
      payload: options.payload,
      stream: options.wantsStream,
      reasoningMode: options.reasoningMode,
      endpoint: options.entryEndpoint,
      requestId: options.requestId
    }
  )) as JsonObject;
  const processedRequest = buildProcessedRequestFromChatResponse(finalized, {
    stream: options.wantsStream
  });
  recordStage(options.stageRecorder, 'chat_process.resp.stage8.finalize', {
    model: finalized.model,
    stream: options.wantsStream
  });
  return { finalizedPayload: finalized, processedRequest };
}
