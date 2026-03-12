import type { AdapterContext } from '../../../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../../../types/format-envelope.js';
import type { JsonObject } from '../../../../types/json.js';
import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { ResponseMapper, ChatCompletionLike } from '../../../../response/response-mappers.js';
import { recordStage } from '../../../stages/utils.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../../hub-stage-timing.js';
import { sanitizeChatCompletionLikeWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';

export interface RespInboundStage3SemanticMapOptions {
  adapterContext: AdapterContext;
  formatEnvelope: FormatEnvelope<JsonObject>;
  mapper: ResponseMapper;
  requestSemantics?: JsonObject;
  stageRecorder?: StageRecorder;
}

export async function runRespInboundStage3SemanticMap(
  options: RespInboundStage3SemanticMapOptions
): Promise<ChatCompletionLike> {
  const requestId = options.adapterContext.requestId || 'unknown';
  const forceDetailLog = isHubStageTimingDetailEnabled();
  logHubStageTiming(requestId, 'resp_inbound.stage3_mapper_to_chat', 'start');
  const mapperStart = Date.now();
  const chatResponseRaw = await options.mapper.toChatCompletion(options.formatEnvelope, options.adapterContext, {
    requestSemantics: options.requestSemantics
  });
  logHubStageTiming(requestId, 'resp_inbound.stage3_mapper_to_chat', 'completed', {
    elapsedMs: Date.now() - mapperStart,
    forceLog: forceDetailLog
  });
  logHubStageTiming(requestId, 'resp_inbound.stage3_sanitize_chat', 'start');
  const sanitizeStart = Date.now();
  const chatResponse = sanitizeChatCompletionLikeWithNative(chatResponseRaw) as ChatCompletionLike;
  logHubStageTiming(requestId, 'resp_inbound.stage3_sanitize_chat', 'completed', {
    elapsedMs: Date.now() - sanitizeStart,
    forceLog: forceDetailLog
  });
  recordStage(options.stageRecorder, 'chat_process.resp.stage4.semantic_map_to_chat', chatResponse);
  return chatResponse;
}
