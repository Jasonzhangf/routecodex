import { applyClientConnectionStateToContext } from '../../../utils/client-connection-state.js';
import { resolveStopMessageClientInjectReadiness } from './client-injection-flow.js';
import { extractClientModelId } from './provider-response-utils.js';
import { MetadataCenter } from '../metadata-center/metadata-center.js';
import {
  backfillAdapterContextSessionIdentifiersFromEntryOriginRequest,
  syncStoplessGoalStateFromCapturedRequest
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

function readRequestTruthSessionId(metadataBag: Record<string, unknown>): string | undefined {
  const rt = asFlatRecord(metadataBag.__rt);
  return (
    readNonEmptyString(metadataBag.requestSessionId)
    ?? readNonEmptyString(metadataBag.request_session_id)
    ?? readNonEmptyString(rt?.requestSessionId)
    ?? readNonEmptyString(rt?.request_session_id)
  );
}

function readRequestTruthConversationId(metadataBag: Record<string, unknown>): string | undefined {
  const rt = asFlatRecord(metadataBag.__rt);
  return (
    readNonEmptyString(metadataBag.requestConversationId)
    ?? readNonEmptyString(metadataBag.request_conversation_id)
    ?? readNonEmptyString(rt?.requestConversationId)
    ?? readNonEmptyString(rt?.request_conversation_id)
  );
}

function readRequestTruthSessionIdFromEntryOrigin(entryOriginRequest: unknown): string | undefined {
  const entryOrigin = asFlatRecord(entryOriginRequest);
  const requestMetadata = asFlatRecord(entryOrigin?.metadata);
  return (
    readNonEmptyString(entryOrigin?.sessionId)
    ?? readNonEmptyString(entryOrigin?.session_id)
    ?? readNonEmptyString(requestMetadata?.sessionId)
    ?? readNonEmptyString(requestMetadata?.session_id)
  );
}

function readRequestTruthConversationIdFromEntryOrigin(entryOriginRequest: unknown): string | undefined {
  const entryOrigin = asFlatRecord(entryOriginRequest);
  const requestMetadata = asFlatRecord(entryOrigin?.metadata);
  return (
    readNonEmptyString(entryOrigin?.conversationId)
    ?? readNonEmptyString(entryOrigin?.conversation_id)
    ?? readNonEmptyString(requestMetadata?.conversationId)
    ?? readNonEmptyString(requestMetadata?.conversation_id)
  );
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

  if (originRecord) {
    backfillAdapterContextSessionIdentifiersFromEntryOriginRequest(baseContext, originRequest);
  }
  const metadataCenter = MetadataCenter.read(metadataBag);
  const centerRequestTruth = metadataCenter?.readRequestTruth();
  const requestTruthSessionId =
    readRequestTruthSessionIdFromEntryOrigin(originRequest)
    ?? centerRequestTruth?.sessionId
    ?? readRequestTruthSessionId(metadataBag);
  const requestTruthConversationId =
    readRequestTruthConversationIdFromEntryOrigin(originRequest)
    ?? centerRequestTruth?.conversationId
    ?? readRequestTruthConversationId(metadataBag);
  if (requestTruthSessionId) {
    baseContext.sessionId = requestTruthSessionId;
  } else {
    delete baseContext.sessionId;
  }
  if (requestTruthConversationId) {
    baseContext.conversationId = requestTruthConversationId;
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
  const assignedModelId = resolveAssignedModelId(metadataBag);
  if (assignedModelId) {
    baseContext.modelId = assignedModelId;
  }

  applyClientConnectionStateToContext(metadataBag, baseContext);

  const stopMessagePortEnabled = typeof metadataBag.stopMessageEnabled === 'boolean'
    ? metadataBag.stopMessageEnabled
    : typeof metadataBag.routecodexPortStopMessageEnabled === 'boolean'
      ? metadataBag.routecodexPortStopMessageEnabled
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
