import { applyClientConnectionStateToContext } from '../../../utils/client-connection-state.js';
import { resolveStopMessageClientInjectReadiness } from './client-injection-flow.js';
import { extractClientModelId } from './provider-response-utils.js';
import {
  backfillAdapterContextSessionIdentifiersFromOriginalRequest,
  syncStoplessGoalStateFromCapturedRequest
} from './servertool-request-normalizer.js';
import { backfillServertoolAdapterContextToolsNative } from '../../../../modules/llmswitch/bridge/native-exports.js';

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

function hasManagedStoplessGoalInContext(baseContext: Record<string, unknown>): boolean {
  const directGoal =
    baseContext.stoplessGoalState && typeof baseContext.stoplessGoalState === 'object' && !Array.isArray(baseContext.stoplessGoalState)
      ? (baseContext.stoplessGoalState as Record<string, unknown>)
      : undefined;
  const directStatus =
    typeof directGoal?.status === 'string' ? directGoal.status.trim().toLowerCase() : '';
  if (directStatus === 'active' || directStatus === 'paused' || directStatus === 'stopped' || directStatus === 'completed') {
    return true;
  }
  const rt = asFlatRecord(baseContext.__rt);
  const rtStatus = typeof rt?.stoplessGoalStatus === 'string' ? rt.stoplessGoalStatus.trim().toLowerCase() : '';
  return rtStatus === 'active' || rtStatus === 'paused' || rtStatus === 'stopped' || rtStatus === 'completed';
}

function backfillCapturedChatRequestToolsFromRequestSemantics(
  baseContext: Record<string, unknown>,
  requestSemantics: unknown,
  options?: {
    forceReplace?: boolean;
  }
): void {
  const result = backfillServertoolAdapterContextToolsNative(
    baseContext,
    asFlatRecord(requestSemantics),
    options?.forceReplace === true
  );
  if (!result.changed) {
    return;
  }
  for (const key of Object.keys(baseContext)) {
    delete baseContext[key];
  }
  Object.assign(baseContext, result.context);
}

function preferOriginalRequestForStoplessGoalSync(
  baseContext: Record<string, unknown>,
  originalRequest: unknown
): void {
  if (!asFlatRecord(originalRequest)) {
    return;
  }
  if (!hasRccFenceInRequestPayload(originalRequest)) {
    return;
  }
  if (hasRccFenceInRequestPayload(baseContext.capturedChatRequest)) {
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
    baseContext.capturedChatRequest = args.originalRequest as Record<string, unknown>;
  }

  backfillAdapterContextSessionIdentifiersFromOriginalRequest(baseContext, args.originalRequest);
  preferOriginalRequestForStoplessGoalSync(baseContext, args.originalRequest);
  syncStoplessGoalStateFromCapturedRequest(baseContext, args.onReasoningStopSeedError);
  const managedStoplessGoal = hasManagedStoplessGoalInContext(baseContext);
  backfillCapturedChatRequestToolsFromRequestSemantics(
    baseContext,
    args.requestSemantics,
    managedStoplessGoal
      ? { forceReplace: true }
      : undefined
  );

  const routeName = readNonEmptyString(metadataBag.routeName) ?? readNonEmptyString(metadataBag.routeHint);
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
