import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { recordStage } from '../conversion/hub/pipeline/stages/utils.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../conversion/hub/pipeline/hub-stage-timing.js';
import { runServerToolOrchestrationShell } from './engine-orchestration-shell.js';
import {
  planServertoolResponseStageGateWithNative,
  detectProviderResponseShapeWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  materializeServertoolResponseStageOrchestrationOutputWithNative,
  extractServertoolResponseStageOrchestrationShellResultWithNative,
  resolveServertoolResponseStageOrchestrationGateDecisionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { readRuntimeControlFromAnyBoundMetadataCenter } from './metadata-center-carrier.js';

type ChatCompletionLike = JsonObject;

export interface ServertoolResponseStageShellOptions {
  payload: ChatCompletionLike;
  adapterContext: AdapterContext;
  requestId: string;
  entryEndpoint: string;
  allowFollowup?: boolean;
  stageRecorder?: StageRecorder;
}

export interface ServertoolResponseStageShellResult {
  payload: ChatCompletionLike;
  executed: boolean;
  flowId?: string;
  skipReason?: string;
}

export async function runServertoolResponseStageOrchestrationShell(
  options: ServertoolResponseStageShellOptions
): Promise<ServertoolResponseStageShellResult> {
  const forceDetailLog = isHubStageTimingDetailEnabled();
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(options.adapterContext);
  const gatePlan = planServertoolResponseStageGateWithNative({
    payload: options.payload,
    adapterContext: options.adapterContext,
    runtimeControl,
    allowFollowup: options.allowFollowup === true
  });
  const gateDecision = resolveServertoolResponseStageOrchestrationGateDecisionWithNative({
    responseStageGatePlan: gatePlan
  });

  if (gateDecision.action === 'return_passthrough_bypass') {
    const skipReason = gateDecision.skipReason;
    recordStage(options.stageRecorder, 'HubRespChatProcess03Governed.servertool_orchestration', {
      executed: false,
      skipReason,
      inputShape: detectProviderResponseShapeWithNative(options.payload)
    });
    return {
      payload: options.payload,
      executed: false,
      skipReason
    };
  }
  const inputShape = detectProviderResponseShapeWithNative(options.payload);

  logHubStageTiming(options.requestId, 'HubRespChatProcess03Governed.servertool_orchestration', 'start');
  const orchestrationStart = Date.now();
  const orchestration = await runServerToolOrchestrationShell(
    {
      chat: options.payload,
      adapterContext: options.adapterContext,
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint,
      stageRecorder: options.stageRecorder
    }
  );
  logHubStageTiming(options.requestId, 'HubRespChatProcess03Governed.servertool_orchestration', 'completed', {
    elapsedMs: Date.now() - orchestrationStart,
    executed: orchestration.executed,
    flowId: orchestration.flowId,
    forceLog: forceDetailLog
  });

  const output = materializeServertoolResponseStageOrchestrationOutputWithNative({
    originalPayload: options.payload,
    executedPayload: orchestration.chat as ChatCompletionLike,
    orchestrationExecuted: orchestration.executed,
    orchestrationFlowId: orchestration.flowId,
    inputShape,
    outputShape: orchestration.executed
      ? detectProviderResponseShapeWithNative(orchestration.chat as ChatCompletionLike)
      : undefined
  });

  recordStage(
    options.stageRecorder,
    'HubRespChatProcess03Governed.servertool_orchestration',
    output.recordEvent
  );
  return extractServertoolResponseStageOrchestrationShellResultWithNative(output);
}
