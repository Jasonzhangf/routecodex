import { failNativeRequired, isNativeDisabledByEnv } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

export interface NativeHubPipelineOrchestrationInput {
  requestId: string;
  endpoint: string;
  entryEndpoint: string;
  providerProtocol: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  stream: boolean;
  processMode: 'chat';
  direction: 'request' | 'response';
  stage: 'inbound' | 'outbound';
}

function readNativeFunction(name: string): ((...args: string[]) => string) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null | undefined;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: string[]) => string) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export interface NativeHubPipelineOrchestrationOutput {
  requestId: string;
  success: boolean;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface NativeStopMessageRouterMetadataOutput {
  stopMessageClientInjectSessionScope?: string;
  stopMessageClientInjectScope?: string;
  clientTmuxSessionId?: string;
  client_tmux_session_id?: string;
  tmuxSessionId?: string;
  tmux_session_id?: string;
}

export interface NativeRouterMetadataRuntimeFlagsOutput {
  estimatedInputTokens?: number;
}

export interface NativeHubPolicyOverrideOutput {
  mode: 'off' | 'observe' | 'enforce';
  sampleRate?: number;
}

export interface NativeHubShadowCompareConfigOutput {
  baselineMode: 'off' | 'observe' | 'enforce';
}

export interface NativeAdapterContextMetadataSignalsOutput {
  clientRequestId?: string;
  groupRequestId?: string;
  originalModelId?: string;
  clientModelId?: string;
  modelId?: string;
  estimatedInputTokens?: number;
  sessionId?: string;
  conversationId?: string;
}

export interface NativeAdapterContextObjectCarriersOutput {
  runtime?: Record<string, unknown>;
  capturedChatRequest?: Record<string, unknown>;
  clientConnectionState?: Record<string, unknown>;
  clientDisconnected?: boolean;
}

export interface NativeLiftResponsesResumeIntoSemanticsOutput {
  request: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface NativeRouterMetadataInputBuildInput {
  requestId: string;
  entryEndpoint: string;
  processMode: 'chat';
  stream: boolean;
  direction: 'request' | 'response';
  providerProtocol: string;
  routeHint?: string;
  stage?: 'inbound' | 'outbound';
  responsesResume?: unknown;
  requestSemantics?: unknown;
  includeEstimatedInputTokens?: boolean;
  serverToolRequired?: boolean;
  sessionId?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

export interface NativeHubPipelineResultMetadataBuildInput {
  normalized: {
    metadata: Record<string, unknown>;
    entryEndpoint: string;
    stream: boolean;
    processMode: 'chat';
    routeHint?: string;
  };
  outboundProtocol: string;
  target?: unknown;
  outboundStream?: boolean;
  capturedChatRequest: Record<string, unknown>;
  shadowCompareBaselineMode?: 'off' | 'observe' | 'enforce';
  effectivePolicy?: { mode?: 'off' | 'observe' | 'enforce' };
  shadowBaselineProviderPayload?: Record<string, unknown>;
}

export interface NativeReqOutboundNodeResultBuildInput {
  outboundStart: number;
  outboundEnd: number;
  messages: number;
  tools: number;
}

export interface NativeReqInboundNodeResultBuildInput {
  inboundStart: number;
  inboundEnd: number;
  messages: number;
  tools: number;
}

export interface NativeReqInboundSkippedNodeBuildInput {
  reason?: string;
}

export interface NativeCapturedChatRequestSnapshotBuildInput {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  parameters?: unknown;
}

export interface NativeCoerceStandardizedRequestInput {
  payload: Record<string, unknown>;
  normalized: {
    id: string;
    entryEndpoint: string;
    stream: boolean;
    processMode: 'chat';
    routeHint?: string;
  };
}

export interface NativeCoerceStandardizedRequestOutput {
  standardizedRequest: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
}

export interface NativeServertoolRuntimeMetadataBuildInput {
  metadata?: Record<string, unknown>;
  webSearchConfig?: Record<string, unknown>;
  execCommandGuard?: Record<string, unknown>;
  applyPatchConfig?: Record<string, unknown>;
}

export interface NativeHasImageAttachmentFlagInput {
  metadata?: Record<string, unknown>;
  hasImageAttachment: boolean;
}

export interface NativeSessionIdentifiersMetadataSyncInput {
  metadata?: Record<string, unknown>;
  sessionId?: string;
  conversationId?: string;
}

export interface NativeToolGovernanceNodeResultInput {
  success?: boolean;
  metadata?: Record<string, unknown>;
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
}

export {
  applyOutboundStreamPreferenceWithNative,
  extractModelHintFromMetadataWithNative,
  normalizeHubEndpointWithNative,
  resolveHubClientProtocolWithNative,
  resolveHubProviderProtocolWithNative,
  resolveHubSseProtocolFromMetadataWithNative,
  resolveOutboundStreamIntentWithNative,
  resolveSseProtocolWithNative,
  runHubPipelineOrchestrationWithNative
} from './native-hub-pipeline-orchestration-semantics-protocol.js';

export {
  resolveAdapterContextMetadataSignalsWithNative,
  resolveAdapterContextObjectCarriersWithNative,
  resolveHubPolicyOverrideFromMetadataWithNative,
  resolveHubShadowCompareConfigWithNative,
  resolveRouterMetadataRuntimeFlagsWithNative,
  resolveStopMessageRouterMetadataWithNative,
  extractAdapterContextMetadataFieldsWithNative
} from './native-hub-pipeline-orchestration-semantics-metadata-policy.js';

export {
  applyHasImageAttachmentFlagWithNative,
  buildCapturedChatRequestSnapshotWithNative,
  buildHubPipelineResultMetadataWithNative,
  buildReqInboundNodeResultWithNative,
  buildReqInboundSkippedNodeWithNative,
  buildReqOutboundNodeResultWithNative,
  buildRouterMetadataInputWithNative,
  buildToolGovernanceNodeResultWithNative,
  coerceStandardizedRequestFromPayloadWithNative,
  prepareRuntimeMetadataForServertoolsWithNative,
  syncSessionIdentifiersToMetadataWithNative
} from './native-hub-pipeline-orchestration-semantics-builders.js';

export {
  applyDirectBuiltinWebSearchToolWithNative,
  isCanonicalWebSearchToolDefinitionWithNative,
  isSearchRouteIdWithNative,
  liftResponsesResumeIntoSemanticsWithNative,
  readResponsesResumeFromMetadataWithNative,
  readResponsesResumeFromRequestSemanticsWithNative,
  syncResponsesContextFromCanonicalMessagesWithNative
} from './native-hub-pipeline-orchestration-semantics-search-resume.js';

function parseStringArray(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.every((entry) => typeof entry === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

export function findMappableSemanticsKeysWithNative(metadata: unknown): string[] {
  const capability = 'findMappableSemanticsKeysJson';
  const fail = (reason?: string): string[] => failNativeRequired<string[]>(capability, reason);
  if (isNativeDisabledByEnv()) return fail('native disabled');
  const fn = readNativeFunction(capability);
  if (!fn) return fail();
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) return fail('json stringify failed');
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) return fail('empty result');
    return parseStringArray(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
