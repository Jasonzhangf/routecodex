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
  symbol: 'runServertoolEnginePostflight',
  stage: 'HubRespChatProcess03Governed',
} as const;

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
  if (engineResult.metadataWritePlan && typeof engineResult.metadataWritePlan === 'object') {
    const runtimeControl = projectNativeMetadataWritePlanToRuntimeControl(engineResult.metadataWritePlan);
    if (Object.keys(runtimeControl).length > 0) {
      applyNativeRuntimeControlWritePlan({
        metadata: options.adapterContext as unknown as Record<string, unknown>,
        runtimeControl,
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
  if (runtimeAction.action === 'return_servertool_cli_projection_final') {
    args.logProgress(5, totalSteps, 'completed (servertool cli projection; no reenter)', { flowId });
    return {
      chat: engineResult.finalChatResponse,
      executed: true,
      flowId: engineResult.execution?.flowId
    };
  }

  if (runtimeAction.action === 'return_stop_message_terminal_final') {
    args.logProgress(5, totalSteps, 'completed (stop_message terminal)', { flowId });
    return {
      chat: engineResult.finalChatResponse,
      executed: true,
      flowId: engineResult.execution?.flowId
    };
  }

  if (runtimeAction.action === 'build_stop_message_cli_projection') {
    const adapterRecord = options.adapterContext as unknown as Record<string, unknown>;
    const sessionId = readRequestTruthSessionIdFromAnyBoundMetadataCenter(adapterRecord);
    const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(adapterRecord);
    const projection = buildStoplessAutoCliProjectionFromEngineWithNative({
      metadataCenterSnapshot: sessionId || runtimeControl
        ? {
            requestTruth: sessionId ? { sessionId } : {},
            runtimeControl: runtimeControl ?? {}
          }
        : null,
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
