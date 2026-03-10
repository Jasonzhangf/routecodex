import type { AdapterContext } from '../../../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../../../types/format-envelope.js';
import type { JsonObject } from '../../../../types/json.js';
import type { StageRecorder } from '../../../../format-adapters/index.js';
import { recordStage } from '../../../stages/utils.js';
import {
  parseRespInboundFormatEnvelopeWithNative,
  sanitizeFormatEnvelopeWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';
import {
  normalizeReasoningInAnthropicPayload,
  normalizeReasoningInChatPayload,
  normalizeReasoningInGeminiPayload,
  normalizeReasoningInResponsesPayload
} from '../../../../../shared/reasoning-normalizer.js';

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

function applyReasoningNormalization(payload: JsonObject, protocol: string): void {
  if (protocol === 'openai-responses') {
    normalizeReasoningInResponsesPayload(payload as unknown as Record<string, unknown>, {
      includeOutput: true,
      includeRequiredAction: true
    });
    return;
  }
  if (protocol === 'anthropic-messages') {
    normalizeReasoningInAnthropicPayload(payload);
    return;
  }
  if (protocol === 'gemini-chat') {
    normalizeReasoningInGeminiPayload(payload);
    return;
  }
  normalizeReasoningInChatPayload(payload as any);
}

export async function runRespInboundStage2FormatParse(
  options: RespInboundStage2FormatParseOptions
): Promise<FormatEnvelope<JsonObject>> {
  const protocol = resolveProtocolToken(options.adapterContext);
  applyReasoningNormalization(options.payload, protocol);
  const envelopeRaw = parseRespInboundFormatEnvelopeWithNative({
    payload: options.payload as unknown as Record<string, unknown>,
    protocol
  }) as unknown as FormatEnvelope<JsonObject>;
  const envelope = sanitizeFormatEnvelopeWithNative(envelopeRaw) as FormatEnvelope<JsonObject>;
  recordStage(options.stageRecorder, 'chat_process.resp.stage2.format_parse', envelope);
  return envelope;
}
