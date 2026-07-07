import type { AdapterContext, JsonObject, StageRecorder } from './types.js';
import { runServerToolOrchestrationShell } from './engine-orchestration-shell.js';
import {
  planServertoolResponseStageGateWithNative,
  detectProviderResponseShapeWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';
import {
  materializeServertoolResponseStageOrchestrationOutputWithNative,
  extractServertoolResponseStageOrchestrationShellResultWithNative,
  resolveServertoolResponseStageOrchestrationGateApplicationWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';
import { readRuntimeControlFromAnyBoundMetadataCenter } from './metadata-center-carrier.js';

type ChatCompletionLike = JsonObject;

function normalizeRecordPayload(payload: unknown): object {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as object
    : {};
}

function recordServertoolStage(recorder: StageRecorder | undefined, stageId: string, payload: unknown): void {
  if (!recorder) {
    return;
  }
  recorder.record(stageId, normalizeRecordPayload(payload));
}

function isServertoolStageTimingDetailEnabled(): boolean {
  const raw = process.env.ROUTECODEX_STAGE_TIMING_DETAIL
    ?? process.env.RCC_STAGE_TIMING_DETAIL
    ?? process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL
    ?? process.env.RCC_HUB_STAGE_TIMING_DETAIL;
  if (raw === undefined) {
    return false;
  }
  const normalized = String(raw).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function logServertoolStageTiming(
  requestId: string,
  stage: string,
  phase: 'start' | 'completed' | 'error',
  details?: Record<string, unknown>
): void {
  const raw = process.env.ROUTECODEX_STAGE_TIMING
    ?? process.env.RCC_STAGE_TIMING
    ?? process.env.ROUTECODEX_HUB_STAGE_TIMING
    ?? process.env.RCC_HUB_STAGE_TIMING;
  if (raw === undefined || !requestId || !stage) {
    return;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (normalized !== '1' && normalized !== 'true' && normalized !== 'yes' && normalized !== 'on') {
    return;
  }
  let line = `[servertool.detail][${requestId}] ${stage}.${phase}`;
  if (details && Object.keys(details).length > 0) {
    line += ` ${JSON.stringify(details)}`;
  }
  if (phase === 'error') {
    console.error(line);
    return;
  }
  console.log(line);
}

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
  const forceDetailLog = isServertoolStageTimingDetailEnabled();
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(options.adapterContext);
  const gatePlan = planServertoolResponseStageGateWithNative({
    payload: options.payload,
    adapterContext: options.adapterContext,
    runtimeControl,
    allowFollowup: options.allowFollowup === true
  });
  const gateApplication = resolveServertoolResponseStageOrchestrationGateApplicationWithNative({
    responseStageGatePlan: gatePlan,
    baseObject: options.payload
  });

  if (gateApplication.bypass) {
    const skipReason = gateApplication.skipReason;
    recordServertoolStage(options.stageRecorder, 'HubRespChatProcess03Governed.servertool_orchestration', {
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

  logServertoolStageTiming(options.requestId, 'HubRespChatProcess03Governed.servertool_orchestration', 'start');
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
  logServertoolStageTiming(options.requestId, 'HubRespChatProcess03Governed.servertool_orchestration', 'completed', {
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

  recordServertoolStage(
    options.stageRecorder,
    'HubRespChatProcess03Governed.servertool_orchestration',
    output.recordEvent
  );
  return extractServertoolResponseStageOrchestrationShellResultWithNative(output);
}
