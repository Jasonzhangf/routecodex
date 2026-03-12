import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { JsonObject } from '../../../../types/json.js';
import type { ChatCompletionLike } from '../../../../response/response-mappers.js';
import { runChatResponseToolFilters } from '../../../../../shared/tool-filter-pipeline.js';
import { recordStage } from '../../../stages/utils.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../../hub-stage-timing.js';
import {
  applyRespProcessToolGovernanceWithNative,
  prepareRespProcessToolGovernancePayloadWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';

type ClientProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export interface RespProcessStage1ToolGovernanceOptions {
  payload: ChatCompletionLike;
  entryEndpoint: string;
  requestId: string;
  clientProtocol: ClientProtocol;
  stageRecorder?: StageRecorder;
}

export interface RespProcessStage1ToolGovernanceResult {
  governedPayload: JsonObject;
}

export async function runRespProcessStage1ToolGovernance(
  options: RespProcessStage1ToolGovernanceOptions
): Promise<RespProcessStage1ToolGovernanceResult> {
  const forceDetailLog = isHubStageTimingDetailEnabled();
  logHubStageTiming(options.requestId, 'resp_process.stage1_prepare_native', 'start');
  const prepareStart = Date.now();
  const preparedNative = prepareRespProcessToolGovernancePayloadWithNative(options.payload as JsonObject);
  const preparedPayload = preparedNative.preparedPayload as JsonObject;
  logHubStageTiming(options.requestId, 'resp_process.stage1_prepare_native', 'completed', {
    elapsedMs: Date.now() - prepareStart,
    forceLog: forceDetailLog
  });

  recordStage(options.stageRecorder, 'chat_process.resp.stage6.canonicalize_chat_completion', {
    converted: preparedNative.summary.converted,
    shapeSanitized: preparedNative.summary.shapeSanitized,
    harvestedToolCalls: preparedNative.summary.harvestedToolCalls,
    canonicalPayload: preparedPayload
  });

  logHubStageTiming(options.requestId, 'resp_process.stage1_tool_filters', 'start');
  const filterStart = Date.now();
  const filtered = await runChatResponseToolFilters(preparedPayload, {
    entryEndpoint: options.entryEndpoint,
    requestId: options.requestId,
    profile: 'openai-chat'
  });
  logHubStageTiming(options.requestId, 'resp_process.stage1_tool_filters', 'completed', {
    elapsedMs: Date.now() - filterStart,
    forceLog: forceDetailLog
  });
  logHubStageTiming(options.requestId, 'resp_process.stage1_apply_native', 'start');
  const applyStart = Date.now();
  const patchedNative = applyRespProcessToolGovernanceWithNative({
    payload: filtered as JsonObject,
    clientProtocol: options.clientProtocol,
    entryEndpoint: options.entryEndpoint,
    requestId: options.requestId
  });
  logHubStageTiming(options.requestId, 'resp_process.stage1_apply_native', 'completed', {
    elapsedMs: Date.now() - applyStart,
    forceLog: forceDetailLog
  });
  const governed = patchedNative.governedPayload as JsonObject;
  recordStage(options.stageRecorder, 'chat_process.resp.stage7.tool_governance', {
    summary: patchedNative.summary,
    applied: patchedNative.summary?.applied === true,
    filteredPayload: filtered as JsonObject,
    governedPayload: governed
  });
  return { governedPayload: governed as JsonObject };
}
