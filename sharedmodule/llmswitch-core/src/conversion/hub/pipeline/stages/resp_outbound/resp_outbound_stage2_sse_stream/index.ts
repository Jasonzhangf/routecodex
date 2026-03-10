import type { Readable } from 'node:stream';
import { defaultSseCodecRegistry, type SseProtocol } from '../../../../../../sse/index.js';
import { recordStage } from '../../../stages/utils.js';
import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { JsonObject } from '../../../../types/json.js';
import { resolveSseStreamModeWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';

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
  const shouldStream = resolveSseStreamModeWithNative(options.wantsStream, options.clientProtocol);
  if (!shouldStream) {
    recordStage(options.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
      passthrough: false,
      protocol: options.clientProtocol,
      payload: options.clientPayload
    });
    return { body: options.clientPayload };
  }

  const codec = defaultSseCodecRegistry.get(options.clientProtocol as SseProtocol);
  const stream = await codec.convertJsonToSse(options.clientPayload, {
    requestId: options.requestId
  });
  recordStage(options.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
    passthrough: false,
    protocol: options.clientProtocol,
    payload: options.clientPayload
  });
  return { stream };
}
