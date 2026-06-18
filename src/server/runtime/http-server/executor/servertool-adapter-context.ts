import { applyClientConnectionStateToContext } from '../../../utils/client-connection-state.js';
// feature_id: hub.metadata_center_servertool_context
import { syncStoplessGoalStateFromRequest } from '../../../../modules/llmswitch/bridge.js';
import { resolveStopMessageClientInjectReadiness } from './client-injection-flow.js';
import { extractClientModelId } from './provider-response-utils.js';
import {
  readRuntimeControlProjection,
  readRuntimeServerToolProjection
} from '../metadata-center/request-truth-readers.js';

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

function hasRccFenceInRequestPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  try {
    return JSON.stringify(payload).includes('<**rcc**>');
  } catch {
    return false;
  }
}

function syncStoplessGoalStateFromCapturedRequest(
  baseContext: Record<string, unknown>,
  onError?: (error: unknown) => void
): void {
  const capturedChatRequest = asFlatRecord(baseContext.capturedChatRequest);
  const capturedEntryRequest = asFlatRecord(baseContext.capturedEntryRequest);
  if (
    capturedEntryRequest
    && hasRccFenceInRequestPayload(capturedEntryRequest)
    && (!capturedChatRequest || !hasRccFenceInRequestPayload(capturedChatRequest))
  ) {
    baseContext.capturedChatRequest = capturedEntryRequest;
  }
  try {
    syncStoplessGoalStateFromRequest(baseContext);
  } catch (error) {
    onError?.(error);
  }
}

function preferEntryOriginRequestForStoplessGoalSync(
  baseContext: Record<string, unknown>,
  entryOriginRequest: unknown
): void {
  if (!asFlatRecord(entryOriginRequest)) {
    return;
  }
  if (!hasRccFenceInRequestPayload(entryOriginRequest)) {
    return;
  }
  if (hasRccFenceInRequestPayload(baseContext.capturedEntryRequest)) {
    return;
  }
  baseContext.capturedEntryRequest = entryOriginRequest as Record<string, unknown>;
}

export function buildServerToolAdapterContext(args: {
  metadata?: Record<string, unknown>;
  entryOriginRequest?: Record<string, unknown>;
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
  const originRequest = args.entryOriginRequest;
  const originRecord = asFlatRecord(originRequest);
  if (!asFlatRecord(baseContext.capturedEntryRequest) && asFlatRecord(originRequest)) {
    baseContext.capturedEntryRequest = originRequest as Record<string, unknown>;
  }
  const existingCapturedChatRequest = asFlatRecord(baseContext.capturedChatRequest);
  if (originRecord && (!existingCapturedChatRequest || hasRccFenceInRequestPayload(originRecord))) {
    baseContext.capturedChatRequest = originRecord;
  }
  const serverToolProjection = readRuntimeServerToolProjection(metadataBag);
  if (serverToolProjection.sessionId) {
    baseContext.sessionId = serverToolProjection.sessionId;
  } else {
    delete baseContext.sessionId;
  }
  if (serverToolProjection.conversationId) {
    baseContext.conversationId = serverToolProjection.conversationId;
  } else {
    delete baseContext.conversationId;
  }
  preferEntryOriginRequestForStoplessGoalSync(baseContext, originRequest);
  syncStoplessGoalStateFromCapturedRequest(baseContext, args.onReasoningStopSeedError);

  const routeName = readNonEmptyString(metadataBag.routeName) ?? readNonEmptyString(metadataBag.routeHint);
  if (routeName) {
    baseContext.routeId = routeName;
  }
  baseContext.requestId = args.requestId;
  baseContext.entryEndpoint = args.entryEndpoint;
  baseContext.providerProtocol = args.providerProtocol;

  const originalModelId = extractClientModelId(metadataBag, originRequest);
  if (originalModelId) {
    baseContext.originalModelId = originalModelId;
  }
  const assignedModelId = serverToolProjection.assignedModelId;
  if (assignedModelId) {
    baseContext.modelId = assignedModelId;
  }

  applyClientConnectionStateToContext(metadataBag, baseContext);

  const runtimeControl = readRuntimeControlProjection(metadataBag);
  const stopMessagePortEnabled = typeof runtimeControl.stopMessageEnabled === 'boolean'
    ? runtimeControl.stopMessageEnabled
    : undefined;

  const stopMessageInjectReadiness = resolveStopMessageClientInjectReadiness(baseContext);
  const rt = asFlatRecord(baseContext.__rt) ?? {};
  const followupFlag =
    metadataBag.isServerToolFollowup === true
    || metadataBag.serverToolFollowup === true
    || rt.serverToolFollowup === true;
  const providerFamily = readNonEmptyString(metadataBag.providerFamily)?.toLowerCase();
  const clientProtocol = readNonEmptyString(metadataBag.clientProtocol)
    ?? readNonEmptyString(rt.clientProtocol)
    ?? (args.entryEndpoint.includes('/v1/responses') ? 'openai-responses' : undefined);
  baseContext.__rt = {
    ...rt,
    ...(followupFlag ? { serverToolFollowup: true } : {}),
    ...(clientProtocol ? { clientProtocol } : {}),
    ...(providerFamily ? { providerFamily } : {}),
    ...(typeof stopMessagePortEnabled === 'boolean' ? { stopMessagePortEnabled } : {}),
    stopMessageClientInjectReady: stopMessageInjectReadiness.ready,
    stopMessageClientInjectReason: stopMessageInjectReadiness.reason,
    ...(stopMessageInjectReadiness.sessionScope
      ? { stopMessageClientInjectSessionScope: stopMessageInjectReadiness.sessionScope }
      : {}),
    ...(stopMessageInjectReadiness.tmuxSessionId
      ? { stopMessageClientInjectTmuxSessionId: stopMessageInjectReadiness.tmuxSessionId }
      : {})
  };

  const compatProfile = serverToolProjection.compatibilityProfile;
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
