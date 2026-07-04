import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineResult
} from './types.js';
import {
  type ServertoolEngineRuntimeActionPlan,
  buildServertoolPostflightObservationSummaryWithNative,
  resolveServertoolEnginePostflightPayloadWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';
import {
  readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter
} from './metadata-center-carrier.js';
import {
  applyNativeRuntimeControlWritePlan,
  projectNativeMetadataWritePlanToRuntimeControlWritePlan
} from '../conversion/hub/metadata-center-runtime-control-writer.js';

const SERVERTOOL_POSTFLIGHT_RUNTIME_CONTROL_WRITER = {
  module: 'sharedmodule/llmswitch-core/src/servertool/engine-postflight-shell.ts',
  symbol: 'runServertoolEnginePostflight',
  stage: 'HubRespChatProcess03Governed',
} as const;

export async function runServertoolEnginePostflight(args: {
  options: {
    requestId: string;
    adapterContext: AdapterContext;
  };
  engineResult: ServerSideToolEngineResult;
  runtimeAction: ServertoolEngineRuntimeActionPlan;
  flowId: string;
  totalSteps: number;
  stageRecorder?: StageRecorder;
  logProgress: (step: number, total: number, status: string, details?: Record<string, unknown>) => void;
}): Promise<
  | {
      chat: JsonObject;
      executed: boolean;
      flowId?: string;
    }
  | undefined
> {
  const { engineResult, runtimeAction, options, flowId, totalSteps } = args;
  if (engineResult.metadataWritePlan != null && typeof engineResult.metadataWritePlan === 'object') {
    const writePlan = projectNativeMetadataWritePlanToRuntimeControlWritePlan(engineResult.metadataWritePlan);
    if (writePlan.runtimeControl) {
      applyNativeRuntimeControlWritePlan({
        metadata: options.adapterContext,
        runtimeControl: writePlan.runtimeControl,
        writer: SERVERTOOL_POSTFLIGHT_RUNTIME_CONTROL_WRITER,
        reason: 'rust servertool postflight runtime control'
      });
    }
  }

  if (args.stageRecorder) {
    const summary = buildServertoolPostflightObservationSummaryWithNative({
      engineResult
    });
    args.stageRecorder.record('servertool.execution', summary);
  }
  const runtimeMetadataSnapshot = readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(options.adapterContext);
  const metadataCenterSnapshot = runtimeMetadataSnapshot?.metadataCenterSnapshot;
  const chat = resolveServertoolEnginePostflightPayloadWithNative({
    runtimeAction,
    engineResult,
    metadataCenterSnapshot: metadataCenterSnapshot ?? null,
    requestId: options.requestId ?? null
  });
  args.logProgress(5, totalSteps, runtimeAction.progressStatus, { flowId });
  return {
    chat,
    executed: runtimeAction.executed,
    flowId: runtimeAction.projectedFlowId
  };
}
