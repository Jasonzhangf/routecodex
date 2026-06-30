import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { recordStage } from '../conversion/hub/pipeline/stages/utils.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../conversion/hub/pipeline/hub-stage-timing.js';
import { runServerToolOrchestration } from './engine.js';
import {
  planServertoolResponseStageGateWithNative,
  detectProviderResponseShapeWithNative,
  readFollowupClientInjectSourceWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  readRuntimeControlFromBoundMetadataCenter,
  writeRuntimeControlToBoundMetadataCenter
} from './metadata-center-carrier.js';

type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';
type ChatCompletionLike = JsonObject;

export interface ServertoolResponseStageShellOptions {
  payload: ChatCompletionLike;
  adapterContext: AdapterContext;
  requestId: string;
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  allowFollowup?: boolean;
  stageRecorder?: StageRecorder;
}

export interface ServertoolResponseStageShellResult {
  payload: ChatCompletionLike;
  executed: boolean;
  flowId?: string;
  skipReason?: 'no_servertool_support' | 'followup_bypass';
}

export async function runServertoolResponseStageOrchestrationShell(
  options: ServertoolResponseStageShellOptions
): Promise<ServertoolResponseStageShellResult> {
  const forceDetailLog = isHubStageTimingDetailEnabled();
  const runtimeControl = readRuntimeControlFromBoundMetadataCenter(options.adapterContext as Record<string, unknown>);
  const providerProtocol =
    typeof runtimeControl?.providerProtocol === 'string' && runtimeControl.providerProtocol.trim()
      ? runtimeControl.providerProtocol.trim()
      : undefined;
  if (!providerProtocol) {
    throw new Error('Servertool response stage orchestration requires metadata center runtime_control.providerProtocol');
  }
  if (runtimeControl?.servertoolResponseOrchestration === true) {
    writeRuntimeControlToBoundMetadataCenter({
      metadata: options.adapterContext as Record<string, unknown>,
      key: 'servertoolResponseOrchestration',
      value: true,
      writer: {
        module: 'sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts',
        symbol: 'runServertoolResponseStageOrchestrationShell',
        stage: 'HubRespChatProcess03Governed'
      },
      reason: 'response-stage orchestration marker'
    });
  }
  const gatePlan = planServertoolResponseStageGateWithNative({
    payload: options.payload,
    adapterContext: options.adapterContext as Record<string, unknown>,
    runtimeControl,
    allowFollowup: options.allowFollowup === true
  });

  if (gatePlan.nextAction === 'bypass') {
    recordStage(options.stageRecorder, 'HubRespChatProcess03Governed.servertool_orchestration', {
      executed: false,
      skipReason: gatePlan.skipReason || 'followup_bypass',
      inputShape: detectProviderResponseShapeWithNative(options.payload)
    });
    return {
      payload: options.payload,
      executed: false,
      ...(gatePlan.skipReason === 'no_servertool_support' || gatePlan.skipReason === 'followup_bypass'
        ? { skipReason: gatePlan.skipReason }
        : {})
    };
  }
  const inputShape = detectProviderResponseShapeWithNative(options.payload);

  logHubStageTiming(options.requestId, 'HubRespChatProcess03Governed.servertool_orchestration', 'start');
  const orchestrationStart = Date.now();
  const orchestration = await runServerToolOrchestration({
    chat: options.payload as JsonObject,
    adapterContext: options.adapterContext,
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol,
    stageRecorder: options.stageRecorder
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
