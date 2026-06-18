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
  stoplessGoalStatus?: string;
  stopMessageEnabled?: boolean;
  stopMessageExcludeDirect?: boolean;
  streamIntent?: string;
  clientAbort?: boolean;
};

export type RuntimeServerToolProjection = RuntimeRequestTruthIdentifiers & {
  assignedModelId?: string;
  compatibilityProfile?: string;
};

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
  const stoplessGoalStatus = readTrimmedString(runtimeControl?.stoplessGoalStatus);
  const stopMessageEnabled = readBoolean(runtimeControl?.stopMessageEnabled);
  const stopMessageExcludeDirect = readBoolean(runtimeControl?.stopMessageExcludeDirect);
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
    ...(stoplessGoalStatus ? { stoplessGoalStatus } : {}),
    ...(stopMessageEnabled !== undefined ? { stopMessageEnabled } : {}),
    ...(stopMessageExcludeDirect !== undefined ? { stopMessageExcludeDirect } : {}),
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
  return {
    ...requestTruth,
    ...(assignedModelId ? { assignedModelId } : {}),
    ...(compatibilityProfile ? { compatibilityProfile } : {}),
  };
}
