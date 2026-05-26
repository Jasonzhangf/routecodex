import { applyClientConnectionStateToContext } from '../../../utils/client-connection-state.js';
import { resolveStopMessageClientInjectReadiness } from './client-injection-flow.js';
import { extractClientModelId } from './provider-response-utils.js';
import {
  backfillAdapterContextSessionIdentifiersFromOriginalRequest,
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

function readToolName(tool: unknown): string {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return '';
  }
  const directName = readNonEmptyString((tool as { name?: unknown }).name);
  if (directName) {
    return directName.toLowerCase();
  }
  const fn = (tool as { function?: unknown }).function;
  if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
    return '';
  }
  return readNonEmptyString((fn as { name?: unknown }).name)?.toLowerCase() ?? '';
}

function shouldReplaceCapturedChatRequestTools(args: {
  baseContext: Record<string, unknown>;
  existingTools?: unknown[];
  clientToolsRaw?: unknown[];
  forceReplace?: boolean;
}): boolean {
  const existingTools = Array.isArray(args.existingTools) ? args.existingTools : undefined;
  const clientToolsRaw = Array.isArray(args.clientToolsRaw) ? args.clientToolsRaw : undefined;
  if (!clientToolsRaw?.length) {
    return false;
  }
  if (!existingTools?.length) {
    return true;
  }
  if (args.forceReplace) {
    const existingNames = existingTools.map(readToolName).filter(Boolean);
    const clientNames = new Set(clientToolsRaw.map(readToolName).filter(Boolean));
    return existingNames.length < clientNames.size && existingNames.every((name) => clientNames.has(name));
  }

  const rt = asFlatRecord(args.baseContext.__rt);
  const isServerToolFollowup =
    rt?.serverToolFollowup === true
    || args.baseContext.serverToolFollowup === true
    || args.baseContext.isServerToolFollowup === true;
  if (!isServerToolFollowup) {
    return false;
  }

  const existingNames = existingTools.map(readToolName).filter(Boolean);
  const clientNames = new Set(clientToolsRaw.map(readToolName).filter(Boolean));
  if (!existingNames.length || !clientNames.size) {
    return false;
  }

  return existingNames.length < clientNames.size && existingNames.every((name) => clientNames.has(name));
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
  const capturedChatRequest = asFlatRecord(baseContext.capturedChatRequest);
  const semanticsRecord = asFlatRecord(requestSemantics);
  const toolsRecord = asFlatRecord(semanticsRecord?.tools);
  const clientToolsRaw = Array.isArray(toolsRecord?.clientToolsRaw) ? toolsRecord.clientToolsRaw : undefined;
  if (!capturedChatRequest || !clientToolsRaw?.length) {
    return;
  }
  const existingTools = Array.isArray(capturedChatRequest.tools) ? capturedChatRequest.tools : undefined;
  if (!shouldReplaceCapturedChatRequestTools({
    baseContext,
    existingTools,
    clientToolsRaw,
    forceReplace: options?.forceReplace
  })) {
    return;
  }
  capturedChatRequest.tools = clientToolsRaw;
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
