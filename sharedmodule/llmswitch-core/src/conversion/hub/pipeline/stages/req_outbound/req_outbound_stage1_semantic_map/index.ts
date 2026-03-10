import type { AdapterContext, ChatEnvelope } from '../../../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../../../types/format-envelope.js';
import type { JsonObject } from '../../../../types/json.js';
import type { StageRecorder, SemanticMapper } from '../../../../format-adapters/index.js';
import type { ProcessedRequest, StandardizedRequest } from '../../../../types/standardized.js';
import {
  applyHubOperationTableOutboundPostMap,
  applyHubOperationTableOutboundPreMap
} from '../../../../operation-table/operation-table-runner.js';
import { recordStage } from '../../../stages/utils.js';
import {
  applyContextSnapshotToChatEnvelope,
  applyToolCallIdStyleMetadata
} from './context-merge.js';
import {
  shouldAttachReqOutboundContextSnapshotWithNative,
  standardizedToChatEnvelopeWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { validateChatEnvelopeWithNative } from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../../hub-stage-timing.js';

export interface ReqOutboundStage1SemanticMapOptions {
  request: StandardizedRequest | ProcessedRequest;
  adapterContext: AdapterContext;
  semanticMapper: Pick<SemanticMapper, 'fromChat'>;
  contextSnapshot?: Record<string, unknown>;
  contextMetadataKey?: string;
  stageRecorder?: StageRecorder;
}

export interface ReqOutboundStage1SemanticMapResult {
  chatEnvelope: ChatEnvelope;
  formatEnvelope: FormatEnvelope<JsonObject>;
}

export async function runReqOutboundStage1SemanticMap(
  options: ReqOutboundStage1SemanticMapOptions
): Promise<ReqOutboundStage1SemanticMapResult> {
  const requestId = options.adapterContext.requestId || 'unknown';
  const forceDetailLog = isHubStageTimingDetailEnabled();
  logHubStageTiming(requestId, 'req_outbound.stage1_native_to_chat_envelope', 'start');
  const toChatStart = Date.now();
  const chatEnvelope = standardizedToChatEnvelopeWithNative({
    request: options.request as unknown as JsonObject,
    adapterContext: options.adapterContext as unknown as Record<string, unknown>
  }) as unknown as ChatEnvelope;
  logHubStageTiming(requestId, 'req_outbound.stage1_native_to_chat_envelope', 'completed', {
    elapsedMs: Date.now() - toChatStart,
    forceLog: forceDetailLog
  });
  applyToolCallIdStyleMetadata(chatEnvelope, options.adapterContext, options.contextSnapshot);
  const shouldAttachContextSnapshot = shouldAttachReqOutboundContextSnapshotWithNative(
    Boolean(options.contextSnapshot),
    options.contextMetadataKey
  );
  if (shouldAttachContextSnapshot && options.contextSnapshot && options.contextMetadataKey) {
    logHubStageTiming(requestId, 'req_outbound.stage1_context_merge', 'start');
    const contextMergeStart = Date.now();
    const snapshot = options.contextSnapshot;
    if (options.contextMetadataKey !== 'responsesContext') {
      (chatEnvelope.metadata as Record<string, unknown>)[options.contextMetadataKey] = snapshot;
    }
    applyContextSnapshotToChatEnvelope(chatEnvelope, snapshot);
    logHubStageTiming(requestId, 'req_outbound.stage1_context_merge', 'completed', {
      elapsedMs: Date.now() - contextMergeStart,
      forceLog: forceDetailLog
    });
  }
  logHubStageTiming(requestId, 'req_outbound.stage1_validate_chat_envelope', 'start');
  const validateStart = Date.now();
  validateChatEnvelopeWithNative(chatEnvelope, {
    stage: 'req_outbound',
    direction: 'request'
  });
  logHubStageTiming(requestId, 'req_outbound.stage1_validate_chat_envelope', 'completed', {
    elapsedMs: Date.now() - validateStart,
    forceLog: forceDetailLog
  });
  logHubStageTiming(requestId, 'req_outbound.stage1_operation_table_pre_map', 'start');
  const preMapStart = Date.now();
  await applyHubOperationTableOutboundPreMap({
    protocol: options.adapterContext.providerProtocol,
    chatEnvelope,
    adapterContext: options.adapterContext
  });
  logHubStageTiming(requestId, 'req_outbound.stage1_operation_table_pre_map', 'completed', {
    elapsedMs: Date.now() - preMapStart,
    forceLog: forceDetailLog
  });
  logHubStageTiming(requestId, 'req_outbound.stage1_mapper_from_chat', 'start');
  const fromChatStart = Date.now();
  const formatEnvelope = (await options.semanticMapper.fromChat(
    chatEnvelope,
    options.adapterContext
  )) as FormatEnvelope<JsonObject>;
  logHubStageTiming(requestId, 'req_outbound.stage1_mapper_from_chat', 'completed', {
    elapsedMs: Date.now() - fromChatStart,
    forceLog: forceDetailLog
  });
  logHubStageTiming(requestId, 'req_outbound.stage1_operation_table_post_map', 'start');
  const postMapStart = Date.now();
  applyHubOperationTableOutboundPostMap({
    chatEnvelope,
    formatEnvelope,
    adapterContext: options.adapterContext
  });
  logHubStageTiming(requestId, 'req_outbound.stage1_operation_table_post_map', 'completed', {
    elapsedMs: Date.now() - postMapStart,
    forceLog: forceDetailLog
  });
  recordStage(options.stageRecorder, 'chat_process.req.stage6.outbound.semantic_map', chatEnvelope);
  return { chatEnvelope, formatEnvelope };
}
