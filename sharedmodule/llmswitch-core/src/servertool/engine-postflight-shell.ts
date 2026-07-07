import type {
  AdapterContext,
  JsonObject,
  StageRecorder,
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
  projectMetadataWritePlanToRuntimeControlWritePlanWithNative
} from '../native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';
import { writeRuntimeControlToBoundMetadataCenter } from './metadata-center-carrier.js';

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
    const writePlan = projectMetadataWritePlanToRuntimeControlWritePlanWithNative({
      plan: engineResult.metadataWritePlan
    });
    if (writePlan.runtimeControl) {
      for (const [key, value] of Object.entries(writePlan.runtimeControl)) {
        if (value === undefined) {
          continue;
        }
        writeRuntimeControlToBoundMetadataCenter({
          metadata: options.adapterContext,
          key,
          value,
          writer: SERVERTOOL_POSTFLIGHT_RUNTIME_CONTROL_WRITER,
          reason: 'rust servertool postflight runtime control',
          required: true
        });
      }
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
