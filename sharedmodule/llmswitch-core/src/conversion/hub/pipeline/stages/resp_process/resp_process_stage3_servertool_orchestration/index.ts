import type { AdapterContext } from '../../../../types/chat-envelope.js';
import type { JsonObject } from '../../../../types/json.js';
import type { StageRecorder } from '../../../../format-adapters/index.js';
import type { ChatCompletionLike } from '../../../../response/response-mappers.js';
import type { ProviderInvoker } from '../../../../../../servertool/types.js';
import { runServerToolOrchestration } from '../../../../../../servertool/engine.js';
import { detectProviderResponseShapeWithNative } from '../../../../../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import { recordStage } from '../../../stages/utils.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../../hub-stage-timing.js';

type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';

type ReenterPipeline = (options: {
  entryEndpoint: string;
  requestId: string;
  body: JsonObject;
  metadata?: JsonObject;
}) => Promise<{ body?: JsonObject; __sse_responses?: NodeJS.ReadableStream; format?: string }>;
type ClientInjectDispatch = (options: {
  entryEndpoint: string;
  requestId: string;
  body?: JsonObject;
  metadata?: JsonObject;
}) => Promise<{ ok: boolean; reason?: string }>;

function readFollowupClientInjectSource(
  adapterContext: AdapterContext
): string {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return '';
  }
  const record = adapterContext as Record<string, unknown>;
  const direct =
    typeof record.clientInjectSource === 'string' && record.clientInjectSource.trim().length
      ? record.clientInjectSource.trim()
      : '';
  if (direct) {
    return direct;
  }
  const runtimeMeta =
    record.__rt && typeof record.__rt === 'object' && !Array.isArray(record.__rt)
      ? (record.__rt as Record<string, unknown>)
      : undefined;
  return typeof runtimeMeta?.clientInjectSource === 'string' && runtimeMeta.clientInjectSource.trim().length
    ? runtimeMeta.clientInjectSource.trim()
    : '';
}

function markServertoolResponseOrchestration(adapterContext: AdapterContext): void {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return;
  }
  const record = adapterContext as Record<string, unknown>;
  const currentRt =
    record.__rt && typeof record.__rt === 'object' && !Array.isArray(record.__rt)
      ? (record.__rt as Record<string, unknown>)
      : {};
  record.__rt = {
    ...currentRt,
    servertoolResponseOrchestration: true
  };
}

export interface RespProcessStage3ServerToolOrchestrationOptions {
  payload: ChatCompletionLike;
  adapterContext: AdapterContext;
  requestId: string;
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  allowFollowup?: boolean;
  stageRecorder?: StageRecorder;
  providerInvoker?: ProviderInvoker;
  reenterPipeline?: ReenterPipeline;
  clientInjectDispatch?: ClientInjectDispatch;
}

export interface RespProcessStage3ServerToolOrchestrationResult {
  payload: ChatCompletionLike;
  executed: boolean;
  flowId?: string;
  skipReason?: 'no_servertool_support';
}

export async function runRespProcessStage3ServerToolOrchestration(
  options: RespProcessStage3ServerToolOrchestrationOptions
): Promise<RespProcessStage3ServerToolOrchestrationResult> {
  const forceDetailLog = isHubStageTimingDetailEnabled();
  const runtimeMeta =
    options.adapterContext &&
    typeof options.adapterContext === 'object' &&
    !Array.isArray(options.adapterContext)
      ? ((options.adapterContext as Record<string, unknown>).__rt as Record<string, unknown> | undefined)
      : undefined;
  const followupSource = readFollowupClientInjectSource(options.adapterContext);
  const allowReasoningStopFollowupReentry =
    followupSource === 'servertool.reasoning_stop_guard'
    || followupSource === 'servertool.reasoning_stop_continue';
  if (
    runtimeMeta?.serverToolFollowup === true
    && options.allowFollowup !== true
    && !allowReasoningStopFollowupReentry
  ) {
    recordStage(options.stageRecorder, 'chat_process.resp.stage5.servertool_orchestration', {
      executed: false,
      skipReason: 'followup_bypass',
      inputShape: detectProviderResponseShapeWithNative(options.payload)
    });
    return {
      payload: options.payload,
      executed: false
    };
  }
  const hasServerToolSupport =
    Boolean(options.providerInvoker) || Boolean(options.reenterPipeline) || Boolean(options.clientInjectDispatch);
  const inputShape = detectProviderResponseShapeWithNative(options.payload);
  if (!hasServerToolSupport) {
    recordStage(options.stageRecorder, 'chat_process.resp.stage5.servertool_orchestration', {
      executed: false,
      skipReason: 'no_servertool_support',
      inputShape
    });
    return {
      payload: options.payload,
      executed: false,
      skipReason: 'no_servertool_support'
    };
  }

  logHubStageTiming(options.requestId, 'resp_process.stage3_orchestration_engine', 'start');
  const orchestrationStart = Date.now();
  markServertoolResponseOrchestration(options.adapterContext);
  const orchestration = await runServerToolOrchestration({
    chat: options.payload as JsonObject,
    adapterContext: options.adapterContext,
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: options.providerProtocol,
    stageRecorder: options.stageRecorder,
    providerInvoker: options.providerInvoker,
    reenterPipeline: options.reenterPipeline,
    clientInjectDispatch: options.clientInjectDispatch
  });
  logHubStageTiming(options.requestId, 'resp_process.stage3_orchestration_engine', 'completed', {
    elapsedMs: Date.now() - orchestrationStart,
    executed: orchestration.executed,
    flowId: orchestration.flowId,
    forceLog: forceDetailLog
  });

  if (orchestration.executed) {
    const outputPayload = orchestration.chat as ChatCompletionLike;
    const outputShape = detectProviderResponseShapeWithNative(outputPayload);
    recordStage(options.stageRecorder, 'chat_process.resp.stage5.servertool_orchestration', {
      executed: true,
      flowId: orchestration.flowId,
      inputShape,
      outputShape
    });
    return {
      payload: outputPayload,
      executed: true,
      flowId: orchestration.flowId
    };
  }

  recordStage(options.stageRecorder, 'chat_process.resp.stage5.servertool_orchestration', {
    executed: false,
    inputShape
  });
  return {
    payload: options.payload,
    executed: false
  };
}
