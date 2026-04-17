import { applyClientConnectionStateToContext } from '../../../utils/client-connection-state.js';
import { resolveStopMessageClientInjectReadiness } from './client-injection-flow.js';
import { extractClientModelId } from './provider-response-utils.js';
import {
  backfillAdapterContextSessionIdentifiersFromOriginalRequest,
  seedReasoningStopStateFromCapturedRequest
} from './servertool-request-normalizer.js';

function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function hasStoplessDirectiveInRequestPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  try {
    return JSON.stringify(payload).toLowerCase().includes('<**stopless:');
  } catch {
    return false;
  }
}

function backfillCapturedChatRequestToolsFromRequestSemantics(
  baseContext: Record<string, unknown>,
  requestSemantics: unknown
): void {
  const capturedChatRequest = asFlatRecord(baseContext.capturedChatRequest);
  const semanticsRecord = asFlatRecord(requestSemantics);
  const toolsRecord = asFlatRecord(semanticsRecord?.tools);
  const clientToolsRaw = Array.isArray(toolsRecord?.clientToolsRaw) ? toolsRecord.clientToolsRaw : undefined;
  if (!capturedChatRequest || !clientToolsRaw?.length) {
    return;
  }
  const existingTools = Array.isArray(capturedChatRequest.tools) ? capturedChatRequest.tools : undefined;
  if (existingTools?.length) {
    return;
  }
  capturedChatRequest.tools = clientToolsRaw;
}

function preferOriginalRequestForReasoningStopSync(
  baseContext: Record<string, unknown>,
  originalRequest: unknown
): void {
  if (!asFlatRecord(originalRequest)) {
    return;
  }
  if (!hasStoplessDirectiveInRequestPayload(originalRequest)) {
    return;
  }
  if (hasStoplessDirectiveInRequestPayload(baseContext.capturedChatRequest)) {
    return;
  }
  baseContext.capturedChatRequest = originalRequest as Record<string, unknown>;
}

function resolveAssignedModelId(metadataBag?: Record<string, unknown>): string | undefined {
  return readNonEmptyString(metadataBag?.assignedModelId)
    ?? readNonEmptyString(asFlatRecord(metadataBag?.target)?.modelId)
    ?? readNonEmptyString(metadataBag?.modelId);
}

function resolveCompatProfile(metadataBag?: Record<string, unknown>): string | undefined {
  return readNonEmptyString(asFlatRecord(metadataBag?.target)?.compatibilityProfile)
    ?? readNonEmptyString(metadataBag?.compatibilityProfile);
}

export function buildServerToolAdapterContext(args: {
  metadata?: Record<string, unknown>;
  originalRequest?: Record<string, unknown>;
  requestSemantics?: Record<string, unknown>;
  requestId: string;
  entryEndpoint: string;
  providerProtocol: string;
  serverToolsEnabled?: boolean;
  onReasoningStopSeedError?: (error: unknown) => void;
}): Record<string, unknown> {
  const metadataBag = asFlatRecord(args.metadata) ?? {};
  const baseContext: Record<string, unknown> = {
    ...metadataBag
  };

  if (!asFlatRecord(baseContext.capturedChatRequest) && asFlatRecord(args.originalRequest)) {
    baseContext.capturedChatRequest = args.originalRequest;
  }

  preferOriginalRequestForReasoningStopSync(baseContext, args.originalRequest);
  backfillAdapterContextSessionIdentifiersFromOriginalRequest(baseContext, args.originalRequest);
  backfillCapturedChatRequestToolsFromRequestSemantics(baseContext, args.requestSemantics);
  seedReasoningStopStateFromCapturedRequest(baseContext, args.onReasoningStopSeedError);

  const routeName = readNonEmptyString(metadataBag.routeName);
  if (routeName) {
    baseContext.routeId = routeName;
  }
  baseContext.requestId = args.requestId;
  baseContext.entryEndpoint = args.entryEndpoint;
  baseContext.providerProtocol = args.providerProtocol;

  const originalModelId = extractClientModelId(metadataBag, args.originalRequest);
  if (originalModelId) {
    baseContext.originalModelId = originalModelId;
  }
  const assignedModelId = resolveAssignedModelId(metadataBag);
  if (assignedModelId) {
    baseContext.modelId = assignedModelId;
  }

  applyClientConnectionStateToContext(metadataBag, baseContext);

  const stopMessageInjectReadiness = resolveStopMessageClientInjectReadiness(baseContext);
  const rt = asFlatRecord(baseContext.__rt) ?? {};
  baseContext.__rt = {
    ...rt,
    stopMessageClientInjectReady: stopMessageInjectReadiness.ready,
    stopMessageClientInjectReason: stopMessageInjectReadiness.reason,
    ...(stopMessageInjectReadiness.sessionScope
      ? { stopMessageClientInjectSessionScope: stopMessageInjectReadiness.sessionScope }
      : {}),
    ...(stopMessageInjectReadiness.tmuxSessionId
      ? { stopMessageClientInjectTmuxSessionId: stopMessageInjectReadiness.tmuxSessionId }
      : {})
  };

  const compatProfile = resolveCompatProfile(metadataBag);
  if (compatProfile) {
    baseContext.compatibilityProfile = compatProfile;
  }

  if (typeof args.serverToolsEnabled === 'boolean') {
    baseContext.serverToolsEnabled = args.serverToolsEnabled;
    if (!args.serverToolsEnabled) {
      baseContext.serverToolsDisabled = true;
    } else if (Object.prototype.hasOwnProperty.call(baseContext, 'serverToolsDisabled')) {
      delete baseContext.serverToolsDisabled;
    }
  }

  return baseContext;
}
