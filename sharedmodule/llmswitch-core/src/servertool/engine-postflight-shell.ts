import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineResult
} from './types.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import { buildServertoolCliProjectionForAutoFlow as buildServertoolCliProjectionForAutoFlowShell } from './cli-projection.js';
import { persistPendingServerToolInjection } from './pending-injection-block.js';
import { readRuntimeControlFromBoundMetadataCenter } from './stopless-metadata-carrier.js';
import {
  extractCurrentAssistantStopTextWithNative,
  planStoplessCliProjectionContextWithNative,
  resolveRuntimeStopMessageStateFromAdapterContextWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';

type StoplessProjectionContext = {
  reasoningText: string;
  repeatCount: number;
  maxRepeats: number;
  triggerHint?: string;
  schemaFeedback?: JsonObject;
};

export function resolveStoplessCliProjectionContext(
  execution: ServerSideToolEngineResult['execution'],
  adapterContext?: unknown,
  chatResponse?: JsonObject
): StoplessProjectionContext {
  const context =
    execution?.context && typeof execution.context === 'object' && !Array.isArray(execution.context)
      ? (execution.context as Record<string, unknown>)
      : {};
  const adapterRecord =
    adapterContext && typeof adapterContext === 'object' && !Array.isArray(adapterContext)
      ? (adapterContext as Record<string, unknown>)
      : undefined;
  const metadata =
    adapterRecord?.metadata &&
    typeof adapterRecord.metadata === 'object' &&
    !Array.isArray(adapterRecord.metadata)
      ? (adapterRecord.metadata as Record<string, unknown>)
      : undefined;
  const runtimeMetadata = adapterRecord ? readRuntimeMetadata(adapterRecord) : undefined;
  const runtimeControl = readRuntimeControlFromBoundMetadataCenter(metadata);
  const stoplessControl =
    runtimeControl?.stopless && typeof runtimeControl.stopless === 'object' && !Array.isArray(runtimeControl.stopless)
      ? (runtimeControl.stopless as Record<string, unknown>)
      : {};
  const runtimeSnapshot = resolveRuntimeStopMessageStateFromAdapterContextWithNative({
    adapterContext: adapterRecord ?? null,
    ...(runtimeMetadata ? { runtimeMetadata } : {})
  });
  return planStoplessCliProjectionContextWithNative({
    executionContext: context,
    stoplessControl,
    runtimeSnapshot: runtimeSnapshot
      ? {
          used: runtimeSnapshot.used,
          maxRepeats: runtimeSnapshot.maxRepeats
        }
      : undefined,
    chatStopText: extractCurrentAssistantStopTextWithNative(chatResponse ?? null),
    adapterStopText: extractCurrentAssistantStopTextWithNative(adapterRecord ?? null)
  });
}

type EnginePostflightAction = {
  action: string;
};

export async function runServertoolEnginePostflight(args: {
  options: {
    requestId: string;
    adapterContext: AdapterContext;
  };
  engineResult: ServerSideToolEngineResult;
  runtimeAction: EnginePostflightAction;
  flowId: string;
  totalSteps: number;
  stoplessPlan: {
    reason: string;
    sessionId?: string;
    isStopMessageFlow: boolean;
  };
  stageRecorder?: StageRecorder;
  resolveStoplessCliProjectionContext: () => StoplessProjectionContext;
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
  const { engineResult, runtimeAction, options, flowId, totalSteps, stoplessPlan } = args;

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
    args.logProgress(5, totalSteps, 'completed (stop_message_auto final terminal result)', {
      flowId,
      reason: args.stoplessPlan.reason
    });
    return {
      chat: engineResult.finalChatResponse,
      executed: true,
      flowId: engineResult.execution?.flowId
    };
  }

  if (runtimeAction.action === 'build_stop_message_cli_projection') {
    const projectionContext = args.resolveStoplessCliProjectionContext();
    const projection = buildServertoolCliProjectionForAutoFlowShell({
      options,
      flowId,
      reasoningText: projectionContext.reasoningText,
      ...(stoplessPlan.sessionId ? { sessionId: stoplessPlan.sessionId } : {}),
      input: {
        flowId,
        repeatCount: projectionContext.repeatCount,
        maxRepeats: projectionContext.maxRepeats,
        ...(projectionContext.triggerHint ? { triggerHint: projectionContext.triggerHint } : {}),
        ...(projectionContext.schemaFeedback ? { schemaFeedback: projectionContext.schemaFeedback } : {})
      }
    });
    args.logProgress(5, totalSteps, 'completed (stop_message_auto cli projection)', {
      flowId,
      reason: args.stoplessPlan.reason
    });
    return {
      chat: projection.chatResponse,
      executed: true,
      flowId: engineResult.execution?.flowId
    };
  }

  throw Object.assign(new Error(`[servertool] retired followup/reenter mainline reached for flow ${flowId}`), {
    code: 'SERVERTOOL_REENTER_RETIRED',
    details: {
      requestId: options.requestId,
      flowId,
      runtimeAction: runtimeAction.action
    }
  });
}
