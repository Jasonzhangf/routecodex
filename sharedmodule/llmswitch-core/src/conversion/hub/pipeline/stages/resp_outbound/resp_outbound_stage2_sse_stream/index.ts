import type { Readable } from 'node:stream';
import { defaultSseCodecRegistry, type SseProtocol } from '../../../../../../sse/index.js';
import { recordStage } from '../../../stages/utils.js';
import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { JsonObject } from '../../../../types/json.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../../hub-stage-timing.js';
import { planSseStreamEffectWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';

type ClientProtocol = SseProtocol;

type StreamPipeEffect = {
  kind: 'streamPipe';
  payload: {
    codec: ClientProtocol;
    requestId: string;
    payload: JsonObject;
    body?: JsonObject;
  };
};

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

function readStreamPipeEffect(effectPlan: { effects: Array<Record<string, unknown>> }): StreamPipeEffect | null {
  if (effectPlan.effects.length === 0) {
    return null;
  }
  if (effectPlan.effects.length !== 1) {
    throw new Error('Rust SSE effect plan must contain at most one effect');
  }
  const effect = effectPlan.effects[0];
  if (effect?.kind !== 'streamPipe') {
    throw new Error('Rust SSE effect plan returned unsupported effect kind');
  }
  const payload = effect.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Rust SSE streamPipe effect missing payload');
  }
  const record = payload as Record<string, unknown>;
  const codec = record.codec;
  const requestId = record.requestId;
  const streamPayload = record.payload;
  if (
    codec !== 'openai-chat'
    && codec !== 'openai-responses'
    && codec !== 'anthropic-messages'
    && codec !== 'gemini-chat'
  ) {
    throw new Error('Rust SSE streamPipe effect returned unsupported codec');
  }
  if (typeof requestId !== 'string' || !requestId.trim()) {
    throw new Error('Rust SSE streamPipe effect missing requestId');
  }
  if (!streamPayload || typeof streamPayload !== 'object' || Array.isArray(streamPayload)) {
    throw new Error('Rust SSE streamPipe effect missing stream payload');
  }
  return {
    kind: 'streamPipe',
    payload: {
      codec,
      requestId,
      payload: streamPayload as JsonObject,
      ...(record.body && typeof record.body === 'object' && !Array.isArray(record.body)
        ? { body: record.body as JsonObject }
        : {})
    }
  };
}

export async function runRespOutboundStage2SseStream(
  options: RespOutboundStage2SseStreamOptions
): Promise<RespOutboundStage2SseStreamResult> {
  const forceDetailLog = isHubStageTimingDetailEnabled();
  const nativePlan = planSseStreamEffectWithNative({
    clientPayload: options.clientPayload,
    clientProtocol: options.clientProtocol,
    requestId: options.requestId,
    wantsStream: options.wantsStream
  });
  const nativePayload = nativePlan.payload as JsonObject;
  const effect = readStreamPipeEffect(nativePlan.effectPlan);
  if (!effect) {
    recordStage(options.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
      passthrough: false,
      protocol: nativePlan.clientProtocol,
      payload: nativePayload
    });
    return { body: nativePayload };
  }

  const codec = defaultSseCodecRegistry.get(effect.payload.codec);
  logHubStageTiming(options.requestId, 'resp_outbound.stage2_codec_stream', 'start', {
    clientProtocol: effect.payload.codec
  });
  const codecStart = Date.now();
  const stream = await codec.convertJsonToSse(effect.payload.payload, {
    requestId: effect.payload.requestId
  });
  logHubStageTiming(options.requestId, 'resp_outbound.stage2_codec_stream', 'completed', {
    elapsedMs: Date.now() - codecStart,
    clientProtocol: effect.payload.codec,
    forceLog: forceDetailLog
  });
  recordStage(options.stageRecorder, 'chat_process.resp.stage10.sse_stream', {
    passthrough: false,
    protocol: effect.payload.codec,
    payload: effect.payload.payload
  });
  return { stream };
}
