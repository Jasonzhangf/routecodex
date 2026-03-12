import type { AdapterContext } from '../../../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../../../types/format-envelope.js';
import type { JsonObject } from '../../../../types/json.js';
import type { StageRecorder } from '../../../../format-adapters/index.js';
import { recordStage } from '../../../stages/utils.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../../hub-stage-timing.js';
import {
  parseRespInboundFormatEnvelopeWithNative,
  sanitizeFormatEnvelopeWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';
import {
  normalizeRespInboundReasoningPayloadWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';

export interface RespInboundStage2FormatParseOptions {
  adapterContext: AdapterContext;
  payload: JsonObject;
  stageRecorder?: StageRecorder;
}

function resolveProtocolToken(adapterContext: AdapterContext): string {
  const candidate =
    typeof adapterContext.providerProtocol === 'string' && adapterContext.providerProtocol.trim().length
      ? adapterContext.providerProtocol.trim().toLowerCase()
      : '';
  if (candidate === 'openai-chat' || candidate === 'openai-responses' || candidate === 'anthropic-messages' || candidate === 'gemini-chat') {
    return candidate;
  }
  return 'openai-chat';
}

export async function runRespInboundStage2FormatParse(
  options: RespInboundStage2FormatParseOptions
): Promise<FormatEnvelope<JsonObject>> {
  const requestId = options.adapterContext.requestId || 'unknown';
  const forceDetailLog = isHubStageTimingDetailEnabled();
  const protocol = resolveProtocolToken(options.adapterContext);
  logHubStageTiming(requestId, 'resp_inbound.stage2_reasoning_normalize', 'start', { protocol });
  const normalizeStart = Date.now();
  const normalizedPayload = normalizeRespInboundReasoningPayloadWithNative({
    payload: options.payload as unknown as Record<string, unknown>,
    protocol
  }) as JsonObject;
  logHubStageTiming(requestId, 'resp_inbound.stage2_reasoning_normalize', 'completed', {
    elapsedMs: Date.now() - normalizeStart,
    protocol,
    forceLog: forceDetailLog
  });
  logHubStageTiming(requestId, 'resp_inbound.stage2_native_parse', 'start', { protocol });
  const parseStart = Date.now();
  const envelopeRaw = parseRespInboundFormatEnvelopeWithNative({
    payload: normalizedPayload as unknown as Record<string, unknown>,
    protocol
  }) as unknown as FormatEnvelope<JsonObject>;
  logHubStageTiming(requestId, 'resp_inbound.stage2_native_parse', 'completed', {
    elapsedMs: Date.now() - parseStart,
    protocol,
    forceLog: forceDetailLog
  });
  logHubStageTiming(requestId, 'resp_inbound.stage2_sanitize', 'start', { protocol });
  const sanitizeStart = Date.now();
  const envelope = sanitizeFormatEnvelopeWithNative(envelopeRaw) as FormatEnvelope<JsonObject>;
  logHubStageTiming(requestId, 'resp_inbound.stage2_sanitize', 'completed', {
    elapsedMs: Date.now() - sanitizeStart,
    protocol,
    forceLog: forceDetailLog
  });
  recordStage(options.stageRecorder, 'chat_process.resp.stage2.format_parse', envelope);
  return envelope;
}
