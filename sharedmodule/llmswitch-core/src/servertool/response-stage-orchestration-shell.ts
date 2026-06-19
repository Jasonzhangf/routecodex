import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { recordStage } from '../conversion/hub/pipeline/stages/utils.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../conversion/hub/pipeline/hub-stage-timing.js';
import type { ProviderInvoker } from './types.js';
import { runServerToolOrchestration } from './engine.js';
import { isStopEligibleForServerTool } from './stop-gateway-context.js';
import {
  detectProviderResponseShapeWithNative,
  readFollowupClientInjectSourceWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  readRuntimeControlFromBoundMetadataCenter,
  writeRuntimeControlToBoundMetadataCenter
} from './stopless-metadata-carrier.js';

type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';
type ChatCompletionLike = JsonObject;

type ReenterPipeline = (options: {
  entryEndpoint: string;
  requestId: string;
  body: JsonObject;
  metadata?: JsonObject;
}) => Promise<{ body?: JsonObject; sseStream?: NodeJS.ReadableStream; format?: string }>;

type ClientInjectDispatch = (options: {
  entryEndpoint: string;
  requestId: string;
  body?: JsonObject;
  metadata?: JsonObject;
}) => Promise<{ ok: boolean; reason?: string }>;

export interface ServertoolResponseStageShellOptions {
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

export interface ServertoolResponseStageShellResult {
  payload: ChatCompletionLike;
  executed: boolean;
  flowId?: string;
  skipReason?: 'no_servertool_support' | 'followup_bypass';
}

function markServertoolResponseOrchestration(adapterContext: AdapterContext): void {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return;
  }
  writeRuntimeControlToBoundMetadataCenter({
    metadata: adapterContext as Record<string, unknown>,
    key: 'servertoolResponseOrchestration',
    value: true,
    writer: {
      module: 'sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts',
      symbol: 'markServertoolResponseOrchestration',
      stage: 'HubRespChatProcess03Governed.servertool_orchestration'
    },
    reason: 'servertool-response-stage-orchestration',
    required: true
  });
}

function projectRuntimeControlSideChannel(adapterContext: AdapterContext, runtimeControl: Record<string, unknown> | undefined): void {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext) || !runtimeControl) {
    return;
  }
  const record = adapterContext as Record<string, unknown>;
  const existing = record.runtime_control && typeof record.runtime_control === 'object' && !Array.isArray(record.runtime_control)
    ? record.runtime_control as Record<string, unknown>
    : {};
  record.runtime_control = {
    ...existing,
    ...runtimeControl
  };
}

export async function runServertoolResponseStageOrchestrationShell(
  options: ServertoolResponseStageShellOptions
): Promise<ServertoolResponseStageShellResult> {
  const forceDetailLog = isHubStageTimingDetailEnabled();
  const runtimeControl = readRuntimeControlFromBoundMetadataCenter(options.adapterContext as Record<string, unknown>);
  projectRuntimeControlSideChannel(options.adapterContext, runtimeControl);
  const followupSource = readFollowupClientInjectSourceWithNative(options.adapterContext as Record<string, unknown>);
  const allowReasoningStopFollowupReentry =
    followupSource === 'servertool.reasoning_stop_guard'
    || followupSource === 'servertool.reasoning_stop_continue';
  const stoplessEligibleFollowup = isStopEligibleForServerTool(options.payload, options.adapterContext);

  if (
    runtimeControl?.serverToolFollowup === true
    && options.allowFollowup !== true
    && !allowReasoningStopFollowupReentry
    && !stoplessEligibleFollowup
  ) {
    recordStage(options.stageRecorder, 'HubRespChatProcess03Governed.servertool_orchestration', {
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
    recordStage(options.stageRecorder, 'HubRespChatProcess03Governed.servertool_orchestration', {
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

  logHubStageTiming(options.requestId, 'HubRespChatProcess03Governed.servertool_orchestration', 'start');
  const orchestrationStart = Date.now();
  markServertoolResponseOrchestration(options.adapterContext);
  projectRuntimeControlSideChannel(
    options.adapterContext,
    readRuntimeControlFromBoundMetadataCenter(options.adapterContext as Record<string, unknown>)
  );
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
  logHubStageTiming(options.requestId, 'HubRespChatProcess03Governed.servertool_orchestration', 'completed', {
    elapsedMs: Date.now() - orchestrationStart,
    executed: orchestration.executed,
    flowId: orchestration.flowId,
    forceLog: forceDetailLog
  });

  if (orchestration.executed) {
    const outputPayload = orchestration.chat as ChatCompletionLike;
    const outputShape = detectProviderResponseShapeWithNative(outputPayload);
    recordStage(options.stageRecorder, 'HubRespChatProcess03Governed.servertool_orchestration', {
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

  recordStage(options.stageRecorder, 'HubRespChatProcess03Governed.servertool_orchestration', {
    executed: false,
    inputShape
  });
  return {
    payload: options.payload,
    executed: false
  };
}
