import {
  normalizeProviderResponseEffectPlanWithNative,
  planProviderResponseServertoolRetirementEffectWithNative,
  planProviderResponseStoplessRuntimeControlEffectWithNative,
  planProviderResponseStreamPipeEffectWithNative,
  planChatProcessSessionUsageWithNative,
  publishResponsesRecordPlanWithNative,
  type NativeSseRuntimeProtocol,
  type ProviderResponseNativePlan,
  type ProviderResponseRuntimeEffectPlan,
  type PublishResponsesRecordPlan,
} from './provider-response-native-calls.js';
import {
  applyNativeRuntimeControlWritePlan,
  isRecord,
  readRequestTruthFromBoundMetadataCenter,
  readRuntimeControlFromBoundMetadataCenter,
  writeRustStopGatewayContextToMetadataCenter,
} from './provider-response-metadata-effects.js';
import {
  finalizeResponsesConversationRequestRetention,
  recordResponsesResponse,
} from './responses-conversation-store-host.js';

type AdapterContext = Record<string, unknown>;
type JsonObject = Record<string, unknown>;
type StageRecorder = { record(stage: string, payload: object): void };
type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function emitNativeHubPipelineDiagnosticAlarms(args: {
  requestId: string;
  diagnostics: Array<Record<string, unknown>>;
}): void {
  for (const diagnostic of args.diagnostics) {
    const details = isRecord(diagnostic.details) ? diagnostic.details : null;
    const alarm = readString(details?.alarm);
    if (!alarm) {
      continue;
    }
    try {
      console.warn(
        `[hub-pipeline][alarm] ${alarm} requestId=${args.requestId} details=${JSON.stringify(details)}`
      );
    } catch {
      console.warn(`[hub-pipeline][alarm] ${alarm} requestId=${args.requestId}`);
    }
  }
}

export function executeProviderResponseNativeOutboundEffects(args: {
  context: AdapterContext;
  nativeResponsePlan: ProviderResponseNativePlan;
}): {
  rawPayload: JsonObject;
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
} {
  const rawPayload = args.nativeResponsePlan.payload as JsonObject;
  const effects = args.nativeResponsePlan.effectPlan.effects;
  if (!Array.isArray(effects)) {
    throw new Error('Rust HubPipeline response path returned malformed effect plan');
  }
  emitNativeHubPipelineDiagnosticAlarms({
    requestId: args.nativeResponsePlan.requestId,
    diagnostics: args.nativeResponsePlan.diagnostics,
  });
  const normalizedEffects = normalizeProviderResponseEffectPlanWithNative({ effects });
  const runtimeEffects = normalizedEffects as ProviderResponseRuntimeEffectPlan;
  (args.context as Record<string, unknown>).__nativeResponsePlan = {
    payload: rawPayload,
    effectPlan: { effects },
    runtimeEffects,
    diagnostics: args.nativeResponsePlan.diagnostics,
  };
  return { rawPayload, runtimeEffects };
}

export async function executeProviderResponseNativeServertoolEffects(args: {
  payload: JsonObject;
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
  context: AdapterContext;
  requestId: string;
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  stageRecorder?: StageRecorder;
}): Promise<{ payload: JsonObject; stage: 'HubRespChatProcess03Governed' | 'unchanged' }> {
  void args.requestId;
  void args.entryEndpoint;
  void args.providerProtocol;
  void args.stageRecorder;
  const plan = planProviderResponseServertoolRetirementEffectWithNative({
    servertoolRuntimeActions: args.runtimeEffects.servertoolRuntimeActions,
  });
  if (plan.action === 'continue') {
    return { payload: args.payload, stage: 'unchanged' };
  }
  if (plan.action === 'reject_legacy_actions') {
    if (plan.stopGatewayWrite) {
      writeRustStopGatewayContextToMetadataCenter({
        metadata: args.context as unknown as Record<string, unknown>,
        stopGatewayContext: plan.stopGatewayWrite.stopGatewayContext,
        writer: plan.stopGatewayWrite.writer,
        reason: plan.stopGatewayWrite.reason,
      });
    }
    throw new Error(plan.errorMessage);
  }
  throw new Error(`unsupported provider response servertool retirement action: ${String(plan.action)}`);
}

export function executeProviderResponseNativeRuntimeStateEffect(args: {
  context: AdapterContext;
  entryEndpoint: string;
  requestId: string;
  response: JsonObject;
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
}): void {
  const stoplessWritePlan = planProviderResponseStoplessRuntimeControlEffectWithNative({
    stoplessMetadataCenterWrite: args.runtimeEffects.stoplessMetadataCenterWrite,
  });
  if (stoplessWritePlan.action === 'apply_runtime_control') {
    applyNativeRuntimeControlWritePlan({
      metadata: args.context as unknown as Record<string, unknown>,
      runtimeControl: stoplessWritePlan.runtimeControl,
      writer: stoplessWritePlan.writer,
      reason: stoplessWritePlan.reason,
    });
  } else if (stoplessWritePlan.action !== 'no_op') {
    throw new Error('unsupported provider response stopless runtime-control action');
  }

  const metadataCenterSnapshot = {
    requestTruth: readRequestTruthFromBoundMetadataCenter(args.context as unknown as Record<string, unknown>),
    runtimeControl: readRuntimeControlFromBoundMetadataCenter(args.context as unknown as Record<string, unknown>),
  };
  const plan: PublishResponsesRecordPlan = publishResponsesRecordPlanWithNative({
    requestId: args.requestId,
    response: args.response,
    context: metadataCenterSnapshot,
    runtimeStateWrite: args.runtimeEffects.runtimeStateWrite ?? null,
    entryEndpoint: args.entryEndpoint,
  });

  if (plan.recordArgs) {
    recordResponsesResponse(plan.recordArgs);
  }
  if (plan.finalizeArgs) {
    finalizeResponsesConversationRequestRetention(
      plan.finalizeArgs.requestId,
      { keepForSubmitToolOutputs: plan.finalizeArgs.keepForSubmitToolOutputs }
    );
  }
  if (plan.usageArgs) {
    planChatProcessSessionUsageWithNative({
      context: args.context as unknown as Record<string, unknown>,
      usage: plan.usageArgs.usage as Record<string, unknown> | undefined,
    });
  }
}

export function readProviderResponseNativeStreamPipe(args: {
  runtimeEffects: ProviderResponseRuntimeEffectPlan;
}): { codec: NativeSseRuntimeProtocol | string; requestId: string; payload: JsonObject } | null {
  const plan = planProviderResponseStreamPipeEffectWithNative({
    streamPipe: args.runtimeEffects.streamPipe,
  });
  if (plan.action === 'no_pipe') {
    return null;
  }
  if (plan.action === 'use_pipe') {
    return plan.pipe;
  }
  throw new Error('unsupported provider response stream-pipe action');
}
