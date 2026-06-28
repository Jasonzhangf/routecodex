import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineResult
} from './types.js';
import { persistPendingServerToolInjection } from './pending-injection-block.js';
import { readNativeFunction } from '../native/router-hotpath/native-shared-conversion-semantics-core.js';
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
  logNonBlocking: (stage: string, error: unknown, details?: Record<string, unknown>) => void;
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
    try {
      const finalChat = engineResult.finalChatResponse as Record<string, unknown>;
      const toolOutputs = Array.isArray(finalChat.tool_outputs) ? finalChat.tool_outputs : [];
      const firstToolOutput =
        toolOutputs.length > 0 && toolOutputs[0] && typeof toolOutputs[0] === 'object' && !Array.isArray(toolOutputs[0])
          ? (toolOutputs[0] as Record<string, unknown>)
          : null;
      const summary: Record<string, unknown> = {
        mode: engineResult.mode,
        flowId: engineResult.execution?.flowId,
        hasFollowup: Boolean(engineResult.execution?.followup),
        pendingInjection: Boolean(engineResult.pendingInjection),
        toolOutputCount: toolOutputs.length
      };
      if (firstToolOutput) {
        if (typeof firstToolOutput.tool_name === 'string') {
          summary.toolName = firstToolOutput.tool_name;
        }
        if (typeof firstToolOutput.tool_call_id === 'string') {
          summary.toolCallId = firstToolOutput.tool_call_id;
        }
        if (typeof firstToolOutput.content === 'string') {
          summary.toolOutputContent = firstToolOutput.content;
        }
      }
      if (engineResult.execution?.context && typeof engineResult.execution.context === 'object') {
        summary.context = engineResult.execution.context;
      }
      const followup = engineResult.execution?.followup;
      if (followup && typeof followup === 'object' && !Array.isArray(followup)) {
        const followupEntryEndpoint =
          'entryEndpoint' in followup && typeof followup.entryEndpoint === 'string'
            ? followup.entryEndpoint
            : undefined;
        const followupSummary: Record<string, unknown> = {
          requestIdSuffix: typeof followup.requestIdSuffix === 'string' ? followup.requestIdSuffix : undefined,
          entryEndpoint: followupEntryEndpoint
        };
        if ('payload' in followup) {
          followupSummary.mode = 'payload';
          const payload = followup.payload;
          if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            const payloadRecord = payload as Record<string, unknown>;
            if (Array.isArray(payloadRecord.messages)) {
              followupSummary.messageCount = payloadRecord.messages.length;
            }
            if (Array.isArray(payloadRecord.input)) {
              followupSummary.inputCount = payloadRecord.input.length;
            }
          }
        } else if ('injection' in followup) {
          followupSummary.mode = 'injection';
          const ops = Array.isArray(followup.injection?.ops) ? followup.injection.ops : [];
          followupSummary.injectionOps = ops
            .map((item) => (item && typeof item === 'object' && 'op' in item ? (item as { op?: unknown }).op : undefined))
            .filter((value) => typeof value === 'string');
        } else {
          followupSummary.mode = 'metadata_only';
        }
        summary.followup = followupSummary;
      }
      args.stageRecorder.record('servertool.execution', summary);
    } catch (error) {
      args.logNonBlocking('record_servertool_execution_snapshot', error, {
        requestId: options.requestId,
        flowId: engineResult.execution?.flowId
      });
    }
  }

  if (runtimeAction.action === 'persist_pending_injection_and_return' && engineResult.pendingInjection) {
    await persistPendingServerToolInjection({
      pendingInjection: engineResult.pendingInjection,
      requestId: options.requestId,
      flowId,
      adapterContext: options.adapterContext
    });
    args.logProgress(5, totalSteps, 'completed (mixed tools; no reenter)', { flowId });
    return {
      chat: engineResult.finalChatResponse,
      executed: true,
      flowId: engineResult.execution?.flowId
    };
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
    const fn = readNativeFunction('buildStoplessAutoCliProjectionFromEngineJson');
    if (!fn) {
      throw new Error('buildStoplessAutoCliProjectionFromEngineJson native unavailable');
    }
    const metadataCenterSnapshot = buildStoplessProjectionMetadataCenterSnapshot(options.adapterContext);
    const adapterContextForRust = metadataCenterSnapshot
      ? {
          ...(options.adapterContext as Record<string, unknown>),
          metadataCenterSnapshot
        }
      : options.adapterContext as Record<string, unknown>;
    const inputJson = JSON.stringify({
      adapterContext: adapterContextForRust,
      execution: engineResult.execution ?? null,
      metadataWritePlan: engineResult.metadataWritePlan ?? null,
      requestId: options.requestId ?? null
    });
    const raw = fn(inputJson);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const projectionChatResponse = parsed.chatResponse as JsonObject;
    args.logProgress(5, totalSteps, 'completed (stop_message cli projection; no reenter)', { flowId });
    return {
      chat: projectionChatResponse,
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
