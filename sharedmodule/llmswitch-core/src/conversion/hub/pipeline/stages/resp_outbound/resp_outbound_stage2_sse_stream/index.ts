import type { Readable } from 'node:stream';
import { defaultSseCodecRegistry, type SseProtocol } from '../../../../../../sse/index.js';
import { recordStage } from '../../../stages/utils.js';
import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { JsonObject } from '../../../../types/json.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../../hub-stage-timing.js';
import { processSseStreamWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';

type ClientProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export interface RespOutboundStage2SseStreamOptions {
  clientPayload: JsonObject;
  clientProtocol: ClientProtocol;
  requestId: string;
  wantsStream: boolean;
  stageRecorder?: StageRecorder;
}

export interface RespOutboundStage2SseStreamResult {
  body?: JsonObject;
  stream?: Readable;
}

export async function runRespOutboundStage2SseStream(
  options: RespOutboundStage2SseStreamOptions
): Promise<RespOutboundStage2SseStreamResult> {
  const forceDetailLog = isHubStageTimingDetailEnabled();
  const streamDecision = processSseStreamWithNative({
    clientPayload: options.clientPayload,
    clientProtocol: options.clientProtocol,
    requestId: options.requestId,
    wantsStream: options.wantsStream
  });
  const shouldStream = streamDecision.shouldStream;
  const nativePayload = streamDecision.payload as JsonObject;
  if (!shouldStream) {
    recordStage(options.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
      passthrough: false,
      protocol: options.clientProtocol,
      payload: nativePayload
    });
    return { body: nativePayload };
  }

  const codec = defaultSseCodecRegistry.get(options.clientProtocol as SseProtocol);
  logHubStageTiming(options.requestId, 'resp_outbound.stage2_codec_stream', 'start', {
    clientProtocol: options.clientProtocol
  });
  const codecStart = Date.now();
  const stream = await codec.convertJsonToSse(options.clientPayload, {
    requestId: options.requestId
  });
  logHubStageTiming(options.requestId, 'resp_outbound.stage2_codec_stream', 'completed', {
    elapsedMs: Date.now() - codecStart,
    clientProtocol: options.clientProtocol,
    forceLog: forceDetailLog
  });
  recordStage(options.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
    passthrough: false,
    protocol: options.clientProtocol,
    payload: options.clientPayload
  });
  return { stream };
}
