import type { StandardizedRequest } from '../types/standardized.js';
import type { ToolGovernanceLike } from './chat-process-governance-finalize.js';
import { applyReqProcessToolGovernanceWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-process-semantics.js';
import { maybeInjectClockRemindersAndApplyDirectives } from './chat-process-clock-reminders.js';
import { finalizeGovernedRequest } from './chat-process-governance-finalize.js';
import { sanitizeChatProcessRequest } from './chat-process-request-sanitizer.js';

export interface GovernanceContext {
  entryEndpoint: string;
  requestId: string;
  metadata: Record<string, unknown>;
  rawPayload?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseGovernedRequest(value: unknown): StandardizedRequest {
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.messages)) {
    throw new Error('native chat governance returned malformed request envelope');
  }
  const normalized: Record<string, unknown> = {
    ...row,
    parameters: isRecord(row.parameters) ? row.parameters : {},
    metadata: isRecord(row.metadata) ? row.metadata : {}
  };
  return normalized as unknown as StandardizedRequest;
}

function resolveProviderProtocol(context: GovernanceContext): string {
  const metadataProtocol = context.metadata.providerProtocol;
  if (typeof metadataProtocol === 'string' && metadataProtocol) {
    return metadataProtocol;
  }
  return context.entryEndpoint === '/v1/messages' ? 'anthropic-chat' : 'openai-chat';
}

export async function applyRequestToolGovernance(
  request: StandardizedRequest,
  context: GovernanceContext,
  governanceEngine?: ToolGovernanceLike
): Promise<StandardizedRequest> {
  if (!isRecord(request) || !Array.isArray(request.messages)) {
    throw new Error('chat governance input request is invalid');
  }
  const nativeResult = applyReqProcessToolGovernanceWithNative({
    request: request as unknown as Record<string, unknown>,
    rawPayload: context.rawPayload ?? (request as unknown as Record<string, unknown>),
    metadata: context.metadata,
    entryEndpoint: context.entryEndpoint,
    requestId: context.requestId,
    // continue_execution tool injection has been disabled globally.
    // Force stop-message-active semantics here so native governance never injects it.
    hasActiveStopMessageForContinueExecution: true
  });
  const governedRequest = parseGovernedRequest(nativeResult.processedRequest);
  const requestAfterInject = await maybeInjectClockRemindersAndApplyDirectives(
    governedRequest,
    context.metadata,
    context.requestId
  );
  if (!governanceEngine) {
    return sanitizeChatProcessRequest(requestAfterInject);
  }
  return sanitizeChatProcessRequest(finalizeGovernedRequest({
    request: requestAfterInject,
    providerProtocol: resolveProviderProtocol(context),
    governanceEngine
  }));
}
