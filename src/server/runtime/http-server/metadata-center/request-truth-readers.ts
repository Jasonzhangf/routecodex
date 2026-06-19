import { MetadataCenter } from './metadata-center.js';

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export type RuntimeRequestTruthIdentifiers = {
  sessionId?: string;
  conversationId?: string;
};

export type RuntimeProviderObservationProjection = {
  target?: Record<string, unknown>;
  providerKey?: string;
  assignedModelId?: string;
  modelId?: string;
  clientModelId?: string;
  compatibilityProfile?: string;
  finishReason?: string;
  responseSemantics?: Record<string, unknown>;
};

export type RuntimeControlProjection = {
  routeHint?: string;
  routeName?: string;
  routeId?: string;
  providerProtocol?: string;
  providerFamily?: string;
  retryProviderKey?: string;
  preselectedRoute?: Record<string, unknown>;
  serverToolFollowup?: boolean;
  serverToolFollowupSource?: string;
  serverToolFollowupMode?: string;
  servertoolResponseOrchestration?: boolean;
  stoplessGoalStatus?: string;
  stoplessGoal?: {
    state?: Record<string, unknown>;
    hadDirective?: boolean;
    source?: string;
    status?: string;
    directiveTypes?: string[];
  };
  stopless?: {
    sessionId?: string;
    flowId?: string;
    repeatCount?: number;
    maxRepeats?: number;
    triggerHint?: string;
    continuationPrompt?: string;
    schemaFeedback?: Record<string, unknown>;
    active?: boolean;
    updatedAt?: number;
  };
  stopMessageState?: {
    stopMessageText?: string;
    stopMessageProviderKey?: string;
    stopMessageMaxRepeats?: number;
    stopMessageUsed?: number;
    stopMessageStageMode?: string;
  };
  serverToolLoopState?: {
    flowId?: string;
    repeatCount?: number;
    maxRepeats?: number;
    triggerHint?: string;
    schemaFeedback?: Record<string, unknown>;
  };
  stopMessageEnabled?: boolean;
  stopMessageExcludeDirect?: boolean;
  stopMessageClientInject?: {
    ready?: boolean;
    reason?: string;
    sessionScope?: string;
    tmuxSessionId?: string;
  };
  streamIntent?: string;
  clientAbort?: boolean;
};

export type RuntimeServerToolProjection = RuntimeRequestTruthIdentifiers & {
  assignedModelId?: string;
  compatibilityProfile?: string;
  stopless?: RuntimeControlProjection['stopless'];
};

export function writeStoplessRuntimeControl(args: {
  metadata: Record<string, unknown>;
  value: NonNullable<RuntimeControlProjection['stopless']>;
  writer: {
    module: string;
    symbol: string;
    stage: string;
  };
  reason?: string;
}): void {
  MetadataCenter.attach(args.metadata).writeRuntimeControl(
    'stopless',
    args.value,
    args.writer,
    args.reason
  );
}

function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function readRuntimeRequestTruthIdentifiers(
  metadata: Record<string, unknown> | undefined
): RuntimeRequestTruthIdentifiers {
  if (!metadata) {
    return {};
  }
  const center = MetadataCenter.read(metadata);
  const requestTruth = center?.readRequestTruth();
  const sessionId = readTrimmedString(requestTruth?.sessionId);
  const conversationId = readTrimmedString(requestTruth?.conversationId);
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

export function readRuntimeProviderObservationProjection(
  metadata: Record<string, unknown> | undefined
): RuntimeProviderObservationProjection {
  if (!metadata) {
    return {};
  }
  const centerObservation = MetadataCenter.read(metadata)?.readProviderObservation();
  const target = asFlatRecord(centerObservation?.target);
  const responseSemantics = asFlatRecord(centerObservation?.responseSemantics);
  const providerKey = readTrimmedString(centerObservation?.providerKey);
  const assignedModelId = readTrimmedString(centerObservation?.assignedModelId);
  const modelId = readTrimmedString(centerObservation?.modelId);
  const clientModelId = readTrimmedString(centerObservation?.clientModelId);
  const compatibilityProfile = readTrimmedString(centerObservation?.compatibilityProfile);
  const finishReason = readTrimmedString(centerObservation?.finishReason);
  return {
    ...(target ? { target } : {}),
    ...(providerKey ? { providerKey } : {}),
    ...(assignedModelId ? { assignedModelId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(clientModelId ? { clientModelId } : {}),
    ...(compatibilityProfile ? { compatibilityProfile } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(responseSemantics ? { responseSemantics } : {}),
  };
}

export function readRuntimeControlProjection(
  metadata: Record<string, unknown> | undefined
): RuntimeControlProjection {
  if (!metadata) {
    return {};
  }
  const runtimeControl = MetadataCenter.read(metadata)?.readRuntimeControl();
  const routeHint = readTrimmedString(runtimeControl?.routeHint);
  const routeName = readTrimmedString(runtimeControl?.routeName);
  const routeId = readTrimmedString(runtimeControl?.routeId);
  const providerProtocol = readTrimmedString(runtimeControl?.providerProtocol);
  const providerFamily = readTrimmedString(runtimeControl?.providerFamily);
  const retryProviderKey = readTrimmedString(runtimeControl?.retryProviderKey);
  const preselectedRoute = asFlatRecord(runtimeControl?.preselectedRoute);
  const serverToolFollowup = readBoolean(runtimeControl?.serverToolFollowup);
  const serverToolFollowupSource = readTrimmedString(runtimeControl?.serverToolFollowupSource);
  const serverToolFollowupMode = readTrimmedString(runtimeControl?.serverToolFollowupMode);
  const servertoolResponseOrchestration = readBoolean(runtimeControl?.servertoolResponseOrchestration);
  const stoplessGoalStatus = readTrimmedString(runtimeControl?.stoplessGoalStatus);
  const stoplessGoal = asFlatRecord(runtimeControl?.stoplessGoal);
  const stopless = asFlatRecord(runtimeControl?.stopless);
  const stopMessageState = asFlatRecord(runtimeControl?.stopMessageState);
  const serverToolLoopState = asFlatRecord(runtimeControl?.serverToolLoopState);
  const stopMessageEnabled = readBoolean(runtimeControl?.stopMessageEnabled);
  const stopMessageExcludeDirect = readBoolean(runtimeControl?.stopMessageExcludeDirect);
  const stopMessageClientInject = asFlatRecord(runtimeControl?.stopMessageClientInject);
  const streamIntent = readTrimmedString(runtimeControl?.streamIntent);
  const clientAbort = readBoolean(runtimeControl?.clientAbort);
  return {
    ...(routeHint ? { routeHint } : {}),
    ...(routeName ? { routeName } : {}),
    ...(routeId ? { routeId } : {}),
    ...(providerProtocol ? { providerProtocol } : {}),
    ...(providerFamily ? { providerFamily } : {}),
    ...(retryProviderKey ? { retryProviderKey } : {}),
    ...(preselectedRoute ? { preselectedRoute } : {}),
    ...(serverToolFollowup !== undefined ? { serverToolFollowup } : {}),
    ...(serverToolFollowupSource ? { serverToolFollowupSource } : {}),
    ...(serverToolFollowupMode ? { serverToolFollowupMode } : {}),
    ...(servertoolResponseOrchestration !== undefined ? { servertoolResponseOrchestration } : {}),
    ...(stoplessGoalStatus ? { stoplessGoalStatus } : {}),
    ...(stoplessGoal
      ? {
          stoplessGoal: {
            ...(asFlatRecord(stoplessGoal.state) ? { state: asFlatRecord(stoplessGoal.state) } : {}),
            ...(typeof stoplessGoal.hadDirective === 'boolean' ? { hadDirective: stoplessGoal.hadDirective } : {}),
            ...(readTrimmedString(stoplessGoal.source) ? { source: readTrimmedString(stoplessGoal.source) } : {}),
            ...(readTrimmedString(stoplessGoal.status) ? { status: readTrimmedString(stoplessGoal.status) } : {}),
            ...(Array.isArray(stoplessGoal.directiveTypes)
              ? { directiveTypes: stoplessGoal.directiveTypes.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()) }
              : {}),
          }
        }
      : {}),
    ...(stopless
      ? {
          stopless: {
            ...(readTrimmedString(stopless.sessionId) ? { sessionId: readTrimmedString(stopless.sessionId) } : {}),
            ...(readTrimmedString(stopless.flowId) ? { flowId: readTrimmedString(stopless.flowId) } : {}),
            ...(typeof stopless.repeatCount === 'number' ? { repeatCount: stopless.repeatCount } : {}),
            ...(typeof stopless.maxRepeats === 'number' ? { maxRepeats: stopless.maxRepeats } : {}),
            ...(readTrimmedString(stopless.triggerHint) ? { triggerHint: readTrimmedString(stopless.triggerHint) } : {}),
            ...(readTrimmedString(stopless.continuationPrompt)
              ? { continuationPrompt: readTrimmedString(stopless.continuationPrompt) }
              : {}),
            ...(asFlatRecord(stopless.schemaFeedback)
              ? { schemaFeedback: asFlatRecord(stopless.schemaFeedback) }
              : {}),
            ...(typeof stopless.active === 'boolean' ? { active: stopless.active } : {}),
            ...(typeof stopless.updatedAt === 'number' ? { updatedAt: stopless.updatedAt } : {}),
          }
        }
      : {}),
    ...(stopMessageState
      ? {
          stopMessageState: {
            ...(readTrimmedString(stopMessageState.stopMessageText)
              ? { stopMessageText: readTrimmedString(stopMessageState.stopMessageText) }
              : {}),
            ...(readTrimmedString(stopMessageState.stopMessageProviderKey)
              ? { stopMessageProviderKey: readTrimmedString(stopMessageState.stopMessageProviderKey) }
              : {}),
            ...(typeof stopMessageState.stopMessageMaxRepeats === 'number'
              ? { stopMessageMaxRepeats: stopMessageState.stopMessageMaxRepeats }
              : {}),
            ...(typeof stopMessageState.stopMessageUsed === 'number'
              ? { stopMessageUsed: stopMessageState.stopMessageUsed }
              : {}),
            ...(readTrimmedString(stopMessageState.stopMessageStageMode)
              ? { stopMessageStageMode: readTrimmedString(stopMessageState.stopMessageStageMode) }
              : {}),
          }
        }
      : {}),
    ...(serverToolLoopState
      ? {
          serverToolLoopState: {
            ...(readTrimmedString(serverToolLoopState.flowId) ? { flowId: readTrimmedString(serverToolLoopState.flowId) } : {}),
            ...(typeof serverToolLoopState.repeatCount === 'number' ? { repeatCount: serverToolLoopState.repeatCount } : {}),
            ...(typeof serverToolLoopState.maxRepeats === 'number' ? { maxRepeats: serverToolLoopState.maxRepeats } : {}),
            ...(readTrimmedString(serverToolLoopState.triggerHint) ? { triggerHint: readTrimmedString(serverToolLoopState.triggerHint) } : {}),
            ...(asFlatRecord(serverToolLoopState.schemaFeedback)
              ? { schemaFeedback: asFlatRecord(serverToolLoopState.schemaFeedback) }
              : {}),
          }
        }
      : {}),
    ...(stopMessageEnabled !== undefined ? { stopMessageEnabled } : {}),
    ...(stopMessageExcludeDirect !== undefined ? { stopMessageExcludeDirect } : {}),
    ...(stopMessageClientInject
      ? {
          stopMessageClientInject: {
            ...(typeof stopMessageClientInject.ready === 'boolean' ? { ready: stopMessageClientInject.ready } : {}),
            ...(readTrimmedString(stopMessageClientInject.reason) ? { reason: readTrimmedString(stopMessageClientInject.reason) } : {}),
            ...(readTrimmedString(stopMessageClientInject.sessionScope)
              ? { sessionScope: readTrimmedString(stopMessageClientInject.sessionScope) }
              : {}),
            ...(readTrimmedString(stopMessageClientInject.tmuxSessionId)
              ? { tmuxSessionId: readTrimmedString(stopMessageClientInject.tmuxSessionId) }
              : {}),
          }
        }
      : {}),
    ...(streamIntent ? { streamIntent } : {}),
    ...(clientAbort !== undefined ? { clientAbort } : {}),
  };
}

export function readRuntimeServerToolProjection(
  metadata: Record<string, unknown> | undefined
): RuntimeServerToolProjection {
  const requestTruth = readRuntimeRequestTruthIdentifiers(metadata);
  const providerObservation = readRuntimeProviderObservationProjection(metadata);
  const target = providerObservation.target;
  const assignedModelId =
    providerObservation.assignedModelId
    ?? providerObservation.modelId
    ?? readTrimmedString(target?.modelId)
    ?? readTrimmedString(metadata?.modelId);
  const compatibilityProfile =
    providerObservation.compatibilityProfile
    ?? readTrimmedString(target?.compatibilityProfile);
  const runtimeControl = readRuntimeControlProjection(metadata);
  return {
    ...requestTruth,
    ...(assignedModelId ? { assignedModelId } : {}),
    ...(compatibilityProfile ? { compatibilityProfile } : {}),
    ...(runtimeControl.stopless ? { stopless: runtimeControl.stopless } : {}),
  };
}
