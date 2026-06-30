import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineResult
} from './types.js';
import {
  buildServertoolPostflightObservationSummaryWithNative,
  buildStoplessAutoCliProjectionFromEngineWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  readRequestTruthSessionIdFromAnyBoundMetadataCenter,
  readRuntimeControlFromAnyBoundMetadataCenter
} from './metadata-center-carrier.js';
import {
  applyNativeRuntimeControlWritePlan,
  projectNativeMetadataWritePlanToRuntimeControl
} from '../conversion/hub/metadata-center-runtime-control-writer.js';

type EnginePostflightAction = {
  action: string;
};

const SERVERTOOL_POSTFLIGHT_RUNTIME_CONTROL_WRITER = {
  module: 'sharedmodule/llmswitch-core/src/servertool/engine-postflight-shell.ts',
  symbol: 'applyServertoolPostflightMetadataWritePlan',
  stage: 'HubRespChatProcess03Governed',
} as const;

function applyServertoolPostflightMetadataWritePlan(args: {
  adapterContext: AdapterContext;
  metadataWritePlan?: JsonObject;
}): void {
  if (!args.metadataWritePlan || typeof args.metadataWritePlan !== 'object') {
    return;
  }
  const runtimeControl = projectNativeMetadataWritePlanToRuntimeControl(args.metadataWritePlan);
  if (Object.keys(runtimeControl).length === 0) {
    return;
  }
  applyNativeRuntimeControlWritePlan({
    metadata: args.adapterContext as unknown as Record<string, unknown>,
    runtimeControl,
    writer: SERVERTOOL_POSTFLIGHT_RUNTIME_CONTROL_WRITER,
    reason: 'rust servertool postflight runtime control'
  });
}

function buildStoplessProjectionMetadataCenterSnapshot(
  adapterContext: AdapterContext
): Record<string, unknown> | undefined {
  const adapterRecord = adapterContext as unknown as Record<string, unknown>;
  const sessionId = readRequestTruthSessionIdFromAnyBoundMetadataCenter(adapterRecord);
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(adapterRecord);
  if (!sessionId && !runtimeControl) {
    return undefined;
  }
  return {
    requestTruth: sessionId ? { sessionId } : {},
    runtimeControl: runtimeControl ?? {}
  };
}

export async function runServertoolEnginePostflight(args: {
  options: {
    requestId: string;
    adapterContext: AdapterContext;
  };
  engineResult: ServerSideToolEngineResult;
  runtimeAction: EnginePostflightAction;
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
  applyServertoolPostflightMetadataWritePlan({
    adapterContext: options.adapterContext,
    metadataWritePlan: engineResult.metadataWritePlan
  });

  if (args.stageRecorder) {
    const summary = buildServertoolPostflightObservationSummaryWithNative({
      engineResult
    });
    args.stageRecorder.record('servertool.execution', summary);
  }
  const engineFinalResult = {
    chat: engineResult.finalChatResponse,
    executed: true,
    flowId: engineResult.execution?.flowId
  } as const;

  if (runtimeAction.action === 'return_servertool_cli_projection_final') {
    args.logProgress(5, totalSteps, 'completed (servertool cli projection; no reenter)', { flowId });
    return engineFinalResult;
  }

  if (runtimeAction.action === 'return_stop_message_terminal_final') {
    args.logProgress(5, totalSteps, 'completed (stop_message terminal)', { flowId });
    return engineFinalResult;
  }

  if (runtimeAction.action === 'build_stop_message_cli_projection') {
    const metadataCenterSnapshot = buildStoplessProjectionMetadataCenterSnapshot(options.adapterContext);
    const projection = buildStoplessAutoCliProjectionFromEngineWithNative({
      metadataCenterSnapshot: metadataCenterSnapshot ?? null,
      execution: engineResult.execution ?? null,
      metadataWritePlan: engineResult.metadataWritePlan ?? null,
      requestId: options.requestId ?? null
    });
    args.logProgress(5, totalSteps, 'completed (stop_message cli projection; no reenter)', { flowId });
    return {
      chat: projection.chatResponse,
      executed: true,
      flowId
    };
  }

  throw Object.assign(new Error(`[servertool] unexpected runtime action for flow ${flowId}`), {
    code: 'SERVERTOOL_RUNTIME_ACTION_INVALID',
    details: {
      requestId: options.requestId,
      flowId,
      runtimeAction: runtimeAction.action
    }
  });
}
