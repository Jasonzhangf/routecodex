/**
 * Native Binding Exports Bridge
 *
 * Thin wrappers around llmswitch-core native bindings.
 */

// feature_id: responses.direct_tool_shape_contract
// canonical_builders: evaluate_responses_direct_route_decision_json, has_declared_apply_patch_tool_json

import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveCorePackageDir } from '../core-loader.js';

type AnyRecord = Record<string, unknown>;
type ToolExecutionFailureSignal = {
  toolName: 'exec_command' | 'apply_patch' | 'shell_command';
  errorType: string;
  matchedText: string;
  toolCallId?: string;
  callId?: string;
};
type RuntimeErrorSignal = {
  group: 'parse-error' | 'exec-error';
  errorType: string;
  matchedText: string;
};
type NativeFailureClassification = unknown;
type NativeFailurePolicyModule = {
  classifyProviderFailure?: (
    statusCode: number | undefined,
    errorCode: string | undefined,
    upstreamCode: string | undefined,
    isNetworkError: boolean,
  ) => string;
  resolveProviderRetryExecutionPolicyNative?: (input: {
    classification: NativeFailureClassification;
    isStreamingRequest?: boolean;
    hostContractFailure?: boolean;
    forceExcludeCurrentProviderOnRetry?: boolean;
    errorCode?: string;
    promptTooLong?: boolean;
    existingExclusion?: boolean;
  }) => {
    excludeCurrentProvider: boolean;
    reason: string;
  };
};

type NativeChatProcessNodeResultSemantics = {
  deriveFinishReasonJson?: (bodyJson: string) => string;
  hasRequestedToolsInSemanticsJson?: (requestSemanticsJson: string) => boolean;
  isRequiredToolCallTurnJson?: (requestSemanticsJson: string) => boolean;
  isToolResultFollowupTurnJson?: (requestSemanticsJson: string) => boolean;
  isProviderNativeResumeContinuationJson?: (requestSemanticsJson: string) => boolean;
  detectRetryableEmptyAssistantResponseJson?: (bodyJson: string, requestSemanticsJson: string) => string;
  isToolCallContinuationResponseJson?: (bodyJson: string) => boolean;
  isEmptyClientResponsePayloadJson?: (bodyJson: string) => boolean;
  classifyEmptyResponseSignalJson?: (stage: string, bodyJson: string) => string;
  detectToolExecutionFailuresJson?: (bodyJson: string) => string;
  classifyRuntimeErrorSignalJson?: (stage: string, payloadJson: string) => string;
  shouldLogClientToolErrorToConsoleJson?: (failureJson: string) => boolean;
  shouldLogRuntimeErrorSignalToConsoleJson?: (signalJson: string) => boolean;
  shouldWriteClientToolErrorsampleJson?: (
    endpoint: string,
    stage: string,
    failureJson: string,
    windowMs: number,
    nowMs: number
  ) => boolean;
  resetSnapshotRecorderErrorsampleStateJson?: () => boolean;
  appendSnapshotStageTraceJson?: (
    traceJson: string,
    stage: string,
    payloadJson: string,
    capturePayload: boolean,
    timestamp: string,
    serializeError: string
  ) => string;
  summarizeSnapshotStageTraceJson?: (traceJson: string, limit: number) => string;
  shouldInspectRuntimeErrorFastJson?: (stage: string, payloadJson: string) => boolean;
  shouldInspectToolFailuresJson?: (stage: string) => boolean;
  resolveRequestTailSummaryJson?: (stage: string, payloadJson: string) => string;
  summarizeClientToolObservationJson?: (payloadJson: string, failuresJson: string) => string;
  updateResponsesContractProbeFromSseChunkJson?: (chunkJson: string, probeJson: string) => string;
  updateResponsesSseTransportTerminalStateJson?: (
    chunkJson: string,
    stateJson: string,
    flushRemainder: boolean
  ) => string;
  resolveProviderResponseRequestSemanticsJson?: (
    processedJson: string,
    standardizedJson: string,
    requestMetadataJson: string
  ) => string;
};

function parseServertoolCliRouteHintCandidate(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const routeHint =
    typeof record.routeHint === 'string' && record.routeHint.trim()
      ? record.routeHint.trim()
      : typeof record.route_hint === 'string' && record.route_hint.trim()
        ? record.route_hint.trim()
        : undefined;
  return routeHint || undefined;
}

function readServertoolCliRouteHintFromRequestValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    try {
      return parseServertoolCliRouteHintCandidate(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const candidate of [
    record.output,
    record.content,
    record.text,
    record.outputText,
  ]) {
    const routeHint = readServertoolCliRouteHintFromRequestValue(candidate);
    if (routeHint) {
      return routeHint;
    }
  }
  return parseServertoolCliRouteHintCandidate(record);
}

type NativeRouterHotpathJsonBinding = {
  // -- req_executor_pipeline_attempt batch #1 --
  normalizeExplicitRoutePoolJson?: (inputJson: string) => string;
  mergeObservedRoutePoolChainJson?: (existingJson: string | null, observedJson: string) => string | null;

  // -- hub_pipeline batch #6 --
  resolveEntryProtocolFromEndpointJson?: (entryEndpoint: string) => string;
  captureReqInboundResponsesContextSnapshotJson?: (inputJson: string) => string;
  planResponsesRequestContextJson?: (inputJson: string) => string;
  planResponsesHandlerEntryJson?: (
    payloadJson: string,
    entryEndpoint?: string,
    responseIdFromPath?: string
  ) => string;
  materializeProviderOwnedSubmitContextJson?: (payloadJson: string) => string;
  planResponsesContinuationRequestActionJson?: (inputJson: string) => string;
  stripResponsesStoredContextInputMediaJson?: (
    inputEntriesJson: string,
    placeholderText: string
  ) => string;
  mapChatToolsToBridgeJson?: (toolsJson: string) => string;
  injectMcpToolsForChatJson?: (toolsJson: string, discoveredServersJson: string) => string;
  injectMcpToolsForResponsesJson?: (toolsJson: string, discoveredServersJson: string) => string;
  normalizeAssistantTextToToolCallsJson?: (
    messageJson: string,
    optionsJson?: string
  ) => string;
  buildAnthropicResponseFromChatJson?: (
    chatResponseJson: string,
    aliasMapJson: string
  ) => string;
  sanitizeProviderOutboundPayloadJson?: (inputJson: string) => string;
  normalizeResponsesDirectCurrentRequestPayloadJson?: (inputJson: string) => string;
  extractSessionIdentifiersJson?: (metadataJson: string) => string;
  planResponsesRequestBodyForHttpJson?: (payloadJson: string) => string;
  shouldManageResponsesConversationForHttpJson?: (entryEndpoint: string) => boolean;
  buildResponsesConversationPortScopeForHttpJson?: (portContextJson: string) => string;
  buildResponsesResumeControlForContinuationContextForHttpJson?: (resumeMetaJson: string) => string;
  buildResponsesScopeContinuationExpiredErrorForHttpJson?: () => string;
  buildResponsesResumeClientErrorForHttpJson?: (argsJson: string) => string;
  shouldProjectResponsesResumeClientErrorForHttpJson?: (origin: string) => boolean;
  planResponsesHandlerStreamForHttpJson?: (
    payloadJson: string,
    acceptsSse: boolean,
    forceStream?: boolean,
    requestTimeoutMs?: number
  ) => string;
  finalizeResponsesHandlerPayloadForHttpJson?: (
    payloadJson: string,
    isSubmitToolOutputs: boolean,
    outboundStream: boolean
  ) => string;

  // -- failure_policy batch #2 (error classification) --
  isContextLengthExceededErrorJson?: (inputJson: string) => string;
  isRateLimitLikeErrorJson?: (inputJson: string) => string;
  isRetryableNetworkSseWrapperErrorJson?: (inputJson: string) => string;
  isClientDisconnectLikeErrorJson?: (inputJson: string) => string;
  isGenericBridgeResponseContractErrorJson?: (inputJson: string) => string;

  // -- provider_response_tool_validation_blocks batch #5 --
  validateCanonicalClientToolCallJson?: (inputJson: string) => string;
  validateApplyPatchArgumentsJson?: (inputJson: string) => string;
  containsBroadKillCommandJson?: (inputJson: string) => string;
  hasInvalidShellWrapperShapeJson?: (inputJson: string) => string;

  // -- provider_response_shared_pure_blocks batch #3 --
  asFlatRecordJson?: (inputJson: string) => string | null;
  extractFirstBalancedJsonObjectJson?: (rawString: string) => string | null;
  tryParseJsonLikeStringJson?: (rawString: string) => string | null;
  extractContentTextForStoplessScanJson?: (inputJson: string) => string;
  extractLatestUserTextForStoplessScanJson?: (inputJson: string) => string;
  hasStoplessDirectiveInRequestPayloadJson?: (inputJson: string) => boolean;
  findNestedRawStringJson?: (inputJson: string) => string;
  findNestedErrorMarkerJson?: (inputJson: string) => string;
  extractBridgeProviderResponsePayloadJson?: (inputJson: string) => string | null;

  // -- direct_decision batch #4 --
  decideDirectRouterRetryJson?: (inputJson: string) => string;
  decideDirectProviderRetryJson?: (inputJson: string) => string;

  // -- traffic-governor-core (独立基础设施) --
  trafficGovernorAcquireJson?: (inputJson: string) => string;
  trafficGovernorReleaseJson?: (inputJson: string) => string;
  trafficGovernorIsAtCapacityJson?: (inputJson: string) => boolean;
  trafficGovernorObserveOutcomeJson?: (inputJson: string) => void;

  classifyProviderFailureJson?: (
    statusCode: number | undefined,
    errorCode: string | undefined,
    upstreamCode: string | undefined,
    isNetworkError: boolean
  ) => string;
  resolveProviderRetryExecutionPolicyJson?: (
    inputJson: string
  ) => string;
  buildResponsesPayloadFromChatJson?: (
    payloadJson: string,
    contextJson?: string
  ) => string;
  buildResponsesRequestFromChatJson?: (
    inputJson: string
  ) => string;
  buildChatResponseFromResponsesJson?: (
    payloadJson: string
  ) => string;
  buildRequestStageRuntimeControlWritePlanJson?: (
    inputJson: string
  ) => string;
  projectResponsesClientPayloadForClientJson?: (
    payloadJson: string,
    toolsRawJson?: string,
    metadataJson?: string,
    contextJson?: string
  ) => string;
  projectResponsesSseFrameForClientJson?: (
    frameJson: string,
    eventNameJson: string,
    dataJson: string,
    toolsRawJson: string,
    metadataJson: string,
    stateJson: string
  ) => string;
  projectSseErrorEventPayloadJson?: (inputJson: string) => string;
  evaluateSingletonRoutePoolExhaustionJson?: (
    inputJson: string
  ) => string;
  resolveErrorErr05RouteAvailabilityDecisionJson?: (
    inputJson: string
  ) => string;
  planPrimaryExhaustedToDefaultPoolJson?: (
    inputJson: string
  ) => string;
  resolveSessionColorStr?: (sessionId?: string | null) => string;
  resolveSessionLogColorKeyJson?: (inputJson: string) => string;
  evaluateResponsesDirectRouteDecisionJson?: (
    payloadJson: string,
    metadataJson: string,
    inboundProtocolJson: string,
    applyPatchModeJson: string
  ) => string;
  runResponsesOpenaiRequestCodecJson?: (
    payloadJson: string,
    optionsJson?: string
  ) => string;

  // -- servertool orchestration (Phase 3) --
  runServertoolResponseStageJson?: (payloadJson: string, requestId: string) => string;
  planServertoolFollowupRuntimeJson?: (flowId: string) => string;
  resolveFollowupModelJson?: (seedModelJson: string, adapterContextJson: string) => string;
  webSearchIsGeminiEngine?: (providerKeyJson: string) => string;
  webSearchIsQwenEngine?: (providerKeyJson: string) => string;
  webSearchIsGlmEngine?: (providerKeyJson: string) => string;
  webSearchNormalizeResultCountJson?: (valueJson: string) => string;
  webSearchBuildSystemPrompt?: (targetCount: number) => string;
  webSearchSanitizeBackendErrorJson?: (message: string) => string;
  webSearchCollectHitsJson?: (chatResponseJson: string, targetCount: number) => string;
  webSearchFormatHitsSummaryJson?: (hitsJson: string) => string;
  webSearchLimitHitsJson?: (hitsJson: string) => string;
  webSearchExtractAssistantMessageJson?: (chatResponseJson: string) => string;
  webSearchBuildToolMessagesJson?: (chatResponseJson: string) => string;
  visionBuildAnalysisPayloadJson?: (sourceJson: string) => string;
  visionBuildPinnedMetadataJson?: (adapterContextJson: string, payloadJson: string) => string;
  visionExtractOriginalUserPromptJson?: (messagesJson: string) => string;
  readFollowupClientInjectSourceJson?: (adapterContextJson: string) => string;
};

let cachedFailurePolicyModule: NativeFailurePolicyModule | null | undefined;
let cachedRouterHotpathJsonBindingSync: NativeRouterHotpathJsonBinding | null | undefined;

function buildFailurePolicyModuleFromRouterHotpathBinding(
  binding: NativeRouterHotpathJsonBinding
): NativeFailurePolicyModule | null {
  if (
    typeof binding.classifyProviderFailureJson !== 'function'
    || typeof binding.resolveProviderRetryExecutionPolicyJson !== 'function'
  ) {
    return null;
  }
  return {
    classifyProviderFailure: (
      statusCode: number | undefined,
      errorCode: string | undefined,
      upstreamCode: string | undefined,
      isNetworkError: boolean,
    ) => JSON.parse(String(binding.classifyProviderFailureJson!(
      statusCode,
      errorCode,
      upstreamCode,
      isNetworkError,
    ))) as string,
    resolveProviderRetryExecutionPolicyNative: (input) =>
      JSON.parse(String(binding.resolveProviderRetryExecutionPolicyJson!(
        JSON.stringify(input)
      ))) as { excludeCurrentProvider: boolean; reason: string },
  };
}

function getFailurePolicyModule(): NativeFailurePolicyModule {
  if (cachedFailurePolicyModule !== undefined) {
    if (!cachedFailurePolicyModule) {
      throw new Error('[llmswitch-bridge] native-failure-policy not available');
    }
    return cachedFailurePolicyModule;
  }
  try {
    cachedFailurePolicyModule = buildFailurePolicyModuleFromRouterHotpathBinding(
      getRouterHotpathJsonBindingSync()
    );
  } catch {
    cachedFailurePolicyModule = null;
  }
  if (!cachedFailurePolicyModule) {
    throw new Error('[llmswitch-bridge] native-failure-policy not available');
  }
  return cachedFailurePolicyModule;
}

export function getRouterHotpathJsonBindingSync(): NativeRouterHotpathJsonBinding {
  if (cachedRouterHotpathJsonBindingSync !== undefined) {
    if (!cachedRouterHotpathJsonBindingSync) {
      throw new Error('[llmswitch-bridge] router_hotpath_napi native binding not available');
    }
    return cachedRouterHotpathJsonBindingSync;
  }

  try {
    const packageDir = resolveCorePackageDir();
    const candidates = [
      path.join(packageDir, 'rust-core', 'target', 'release', 'router_hotpath_napi.node'),
      path.join(packageDir, 'rust-core', 'target', 'debug', 'router_hotpath_napi.node'),
      path.join(packageDir, 'dist', 'native', 'router_hotpath_napi.node'),
      path.join(packageDir, 'router_hotpath_napi.node'),
    ];
    const requireFromPackage = createRequire(path.join(packageDir, 'package.json'));
    for (const candidate of candidates) {
      try {
        const loaded = requireFromPackage(candidate) as NativeRouterHotpathJsonBinding;
        if (loaded && typeof loaded === 'object') {
          cachedRouterHotpathJsonBindingSync = loaded;
          return cachedRouterHotpathJsonBindingSync;
        }
      } catch {
        // try the next canonical native artifact location
      }
    }
  } catch {
    cachedRouterHotpathJsonBindingSync = null;
  }

  cachedRouterHotpathJsonBindingSync = null;
  throw new Error('[llmswitch-bridge] router_hotpath_napi native binding not available');
}

function stringifyNativeJsonArg(capability: string, value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[llmswitch-bridge] ${capability} JSON stringify failed: ${detail}`);
  }
}

function invokeRouterHotpathJsonCapability(capability: string, args: unknown[]): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;
  const fn = binding[capability];
  if (typeof fn !== 'function') {
    throw new Error(`[llmswitch-bridge] ${String(capability)} not available`);
  }
  const encodedArgs = args.map((arg) => stringifyNativeJsonArg(String(capability), arg));
  const raw = (fn as (...args: string[]) => unknown)(...encodedArgs);
  if (raw instanceof Error) {
    throw new Error(`[llmswitch-bridge] ${String(capability)} native error: ${raw.message || 'unknown error'}`);
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { message?: unknown }).message === 'string') {
    throw new Error(`[llmswitch-bridge] ${String(capability)} native error: ${String((raw as { message: unknown }).message)}`);
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`[llmswitch-bridge] ${String(capability)} returned non-string or empty result`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[llmswitch-bridge] ${String(capability)} JSON parse failed: ${detail}`);
  }
}

function invokeRouterHotpathPreencodedCapability(capability: string, args: unknown[]): unknown {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;
  const fn = binding[capability];
  if (typeof fn !== 'function') {
    throw new Error(`[llmswitch-bridge] ${String(capability)} not available`);
  }
  const raw = fn(...args);
  if (raw instanceof Error) {
    throw new Error(`[llmswitch-bridge] ${String(capability)} native error: ${raw.message || 'unknown error'}`);
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { message?: unknown }).message === 'string') {
    throw new Error(`[llmswitch-bridge] ${String(capability)} native error: ${String((raw as { message: unknown }).message)}`);
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`[llmswitch-bridge] ${String(capability)} returned non-string or empty result`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[llmswitch-bridge] ${String(capability)} JSON parse failed: ${detail}`);
  }
}

function assertNativeObject(capability: string, value: unknown): AnyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[llmswitch-bridge] ${String(capability)} returned invalid payload`);
  }
  return value as AnyRecord;
}

function assertNativeArray(capability: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`[llmswitch-bridge] ${String(capability)} returned invalid payload`);
  }
  return value;
}

function getChatProcessNodeResultSemantics(): NativeChatProcessNodeResultSemantics {
  return getRouterHotpathJsonBindingSync() as NativeChatProcessNodeResultSemantics;
}

export async function normalizeAssistantTextToToolCallsJson(
  message: Record<string, unknown>,
  options?: Record<string, unknown>
): Promise<AnyRecord> {
  const parsed = invokeRouterHotpathJsonCapability('normalizeAssistantTextToToolCallsJson', [
    message && typeof message === 'object' ? message : {},
    options ?? null,
  ]);
  return assertNativeObject('normalizeAssistantTextToToolCallsJson', parsed);
}

export function captureReqInboundResponsesContextSnapshotJson(input: {
  rawRequest: Record<string, unknown>;
  requestId?: string;
  toolCallIdStyle?: unknown;
}): AnyRecord {
  const parsed = invokeRouterHotpathJsonCapability('captureReqInboundResponsesContextSnapshotJson', [
    input,
  ]);
  return assertNativeObject('captureReqInboundResponsesContextSnapshotJson', parsed);
}

export function stripResponsesStoredContextInputMediaNative(
  inputEntries: unknown,
  placeholderText = '[Image omitted]'
): { changed: boolean; messages: unknown[] } {
  const parsed = invokeRouterHotpathJsonCapability('stripResponsesStoredContextInputMediaJson', [
    Array.isArray(inputEntries) ? inputEntries : [],
    String(placeholderText || '[Image omitted]'),
  ]);
  const row = assertNativeObject('stripResponsesStoredContextInputMediaJson', parsed);
  if (typeof row.changed !== 'boolean' || !Array.isArray(row.messages)) {
    throw new Error('[llmswitch-bridge] stripResponsesStoredContextInputMediaJson returned invalid payload');
  }
  return row as { changed: boolean; messages: unknown[] };
}

export async function captureReqInboundResponsesContextSnapshot(input: {
  rawRequest: Record<string, unknown>;
  requestId?: string;
  toolCallIdStyle?: unknown;
}): Promise<AnyRecord> {
  return captureReqInboundResponsesContextSnapshotJson(input);
}

export async function planResponsesHandlerEntry(
  payload: unknown,
  entryEndpoint?: string,
  responseIdFromPath?: string
): Promise<{ mode: 'none' | 'submit_tool_outputs' | 'scope_materialize'; responseId?: string; payload: AnyRecord }> {
  const parsed = invokeRouterHotpathPreencodedCapability('planResponsesHandlerEntryJson', [
    stringifyNativeJsonArg('planResponsesHandlerEntryJson', payload ?? null),
    entryEndpoint,
    responseIdFromPath,
  ]);
  const row = assertNativeObject('planResponsesHandlerEntryJson', parsed);
  if (
    row.mode !== 'none'
    && row.mode !== 'submit_tool_outputs'
    && row.mode !== 'scope_materialize'
  ) {
    throw new Error('[llmswitch-bridge] planResponsesHandlerEntryJson returned invalid mode');
  }
  if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
    throw new Error('[llmswitch-bridge] planResponsesHandlerEntryJson returned invalid payload');
  }
  return row as { mode: 'none' | 'submit_tool_outputs' | 'scope_materialize'; responseId?: string; payload: AnyRecord };
}

export async function materializeProviderOwnedSubmitContext(input: {
  payload: Record<string, unknown>;
}): Promise<{ payload: AnyRecord; context: { input: unknown[] } } | null> {
  const parsed = invokeRouterHotpathJsonCapability('materializeProviderOwnedSubmitContextJson', [
    input.payload ?? null,
  ]);
  if (parsed === null) {
    return null;
  }
  const row = assertNativeObject('materializeProviderOwnedSubmitContextJson', parsed);
  if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
    throw new Error('[llmswitch-bridge] materializeProviderOwnedSubmitContextJson returned invalid payload');
  }
  const context = row.context;
  if (!context || typeof context !== 'object' || Array.isArray(context) || !Array.isArray((context as AnyRecord).input)) {
    throw new Error('[llmswitch-bridge] materializeProviderOwnedSubmitContextJson returned invalid context');
  }
  return row as { payload: AnyRecord; context: { input: unknown[] } };
}

export async function planResponsesRequestContext(input: {
  payload: Record<string, unknown>;
  resumeMeta?: Record<string, unknown>;
}): Promise<AnyRecord> {
  const parsed = invokeRouterHotpathJsonCapability('planResponsesRequestContextJson', [
    input,
  ]);
  return assertNativeObject('planResponsesRequestContextJson', parsed);
}

export async function planResponsesContinuationRequestAction(input: {
  plannedEntryMode: 'none' | 'submit_tool_outputs' | 'scope_materialize';
  entryEndpoint: string;
  responseId?: string;
  previousResponseId?: string;
  continuation?: Record<string, unknown> | null;
}): Promise<AnyRecord> {
  const parsed = invokeRouterHotpathJsonCapability('planResponsesContinuationRequestActionJson', [
    input,
  ]);
  return assertNativeObject('planResponsesContinuationRequestActionJson', parsed);
}

export async function sanitizeProviderOutboundPayload(input: {
  protocol?: string;
  compatibilityProfile?: string;
  enforceLayout?: boolean;
  payload: Record<string, unknown>;
}): Promise<AnyRecord> {
  const parsed = invokeRouterHotpathJsonCapability('sanitizeProviderOutboundPayloadJson', [
    {
      protocol: input.protocol,
      compatibilityProfile: input.compatibilityProfile,
      enforceLayout: input.enforceLayout,
      payload: input.payload ?? {},
    },
  ]);
  return assertNativeObject('sanitizeProviderOutboundPayloadJson', parsed);
}

export function normalizeResponsesDirectCurrentRequestPayload(input: Record<string, unknown>): {
  changed: boolean;
  payload: Record<string, unknown>;
} {
  const parsed = invokeRouterHotpathJsonCapability('normalizeResponsesDirectCurrentRequestPayloadJson', [
    input ?? {},
  ]);
  const row = assertNativeObject('normalizeResponsesDirectCurrentRequestPayloadJson', parsed);
  return {
    changed: row.changed === true,
    payload:
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {},
  };
}

export function evaluateSingletonRoutePoolExhaustionNative(input: {
  pipelineError: unknown;
  initialRoutePoolLen?: number | null;
  explicitSingletonPool?: boolean;
  excludedProviderCount: number;
}): {
  shouldBlock: boolean;
  waitMs?: number;
  candidateProviderCount?: number;
} {
  const parsed = invokeRouterHotpathJsonCapability('evaluateSingletonRoutePoolExhaustionJson', [
    {
      pipelineError: input.pipelineError ?? null,
      initialRoutePoolLen:
        typeof input.initialRoutePoolLen === 'number' && Number.isFinite(input.initialRoutePoolLen)
          ? Math.max(0, Math.floor(input.initialRoutePoolLen))
          : undefined,
      explicitSingletonPool: input.explicitSingletonPool === true,
      excludedProviderCount: Math.max(0, Math.floor(input.excludedProviderCount || 0)),
    }
  ]);
  return assertNativeObject('evaluateSingletonRoutePoolExhaustionJson', parsed) as {
    shouldBlock: boolean;
    waitMs?: number;
    candidateProviderCount?: number;
  };
}

export function resolveErrorErr05RouteAvailabilityDecisionNative(input: {
  routeName?: string;
  routePool?: string[];
  routeTiers?: Array<{
    id?: string;
    targets: string[];
    priority?: number;
    backup?: boolean;
  }>;
  defaultRouteTiers?: Array<{
    id?: string;
    targets: string[];
    priority?: number;
    backup?: boolean;
  }>;
  excludedProviderKeys?: string[] | Set<string>;
  providerKey?: string;
  routingDecisionRoutePoolPresent?: boolean;
}): {
  routePoolRemainingAfterExclusion: string[];
  remainingRouteCandidates: number;
  defaultPoolAvailable: boolean;
  policyExhausted: boolean;
  mayProject: boolean;
  routePoolAuthoritative: boolean;
  verifiedLastProvider: boolean;
  hasAlternativeCandidate: boolean;
  reasonCode: string;
} {
  const excludedProviderKeys = input.excludedProviderKeys instanceof Set
    ? Array.from(input.excludedProviderKeys)
    : Array.isArray(input.excludedProviderKeys) ? input.excludedProviderKeys : [];
  const parsed = invokeRouterHotpathJsonCapability('resolveErrorErr05RouteAvailabilityDecisionJson', [
    {
      routeName: typeof input.routeName === 'string' ? input.routeName : undefined,
      routePool: Array.isArray(input.routePool) ? input.routePool : [],
      routeTiers: Array.isArray(input.routeTiers) ? input.routeTiers : [],
      defaultRouteTiers: Array.isArray(input.defaultRouteTiers) ? input.defaultRouteTiers : [],
      excludedProviderKeys,
      providerKey: typeof input.providerKey === 'string' ? input.providerKey : undefined,
      routingDecisionRoutePoolPresent: input.routingDecisionRoutePoolPresent === true,
    }
  ]);
  return assertNativeObject('resolveErrorErr05RouteAvailabilityDecisionJson', parsed) as {
    routePoolRemainingAfterExclusion: string[];
    remainingRouteCandidates: number;
    defaultPoolAvailable: boolean;
    policyExhausted: boolean;
    mayProject: boolean;
    routePoolAuthoritative: boolean;
    verifiedLastProvider: boolean;
    hasAlternativeCandidate: boolean;
    reasonCode: string;
  };
}

export function planPrimaryExhaustedToDefaultPoolNative(input: {
  route: string;
  tiers: Array<{
    id: string;
    targets: string[];
    priority: number;
    backup?: boolean;
  }>;
  exhaustedTargets: string[];
  knownTargets: string[];
}): {
  status: 'no_default_pool_needed' | 'default_pool' | 'unknown_target' | 'route_not_configured';
  defaultPoolTargets: string[];
  fromTierId?: string | null;
  fromTierPriority?: number | null;
} {
  const parsed = invokeRouterHotpathJsonCapability('planPrimaryExhaustedToDefaultPoolJson', [
    {
      route: String(input.route || ''),
      tiers: Array.isArray(input.tiers) ? input.tiers : [],
      exhaustedTargets: Array.isArray(input.exhaustedTargets) ? input.exhaustedTargets : [],
      knownTargets: Array.isArray(input.knownTargets) ? input.knownTargets : [],
    }
  ]);
  return assertNativeObject('planPrimaryExhaustedToDefaultPoolJson', parsed) as {
    status: 'no_default_pool_needed' | 'default_pool' | 'unknown_target' | 'route_not_configured';
    defaultPoolTargets: string[];
    fromTierId?: string | null;
    fromTierPriority?: number | null;
  };
}

export function convertResponsesRequestToChatNative(
  payload: Record<string, unknown>,
  options?: Record<string, unknown>
): AnyRecord {
  const parsed = invokeRouterHotpathJsonCapability('runResponsesOpenaiRequestCodecJson', [
    payload,
    options ?? {},
  ]);
  return assertNativeObject('runResponsesOpenaiRequestCodecJson', parsed);
}

export function buildResponsesPayloadFromChatNative(
  payload: unknown,
  context?: Record<string, unknown>
): Record<string, unknown> {
  const parsed = invokeRouterHotpathJsonCapability('buildResponsesPayloadFromChatJson', [
    payload ?? null,
    context ?? null,
  ]);
  return assertNativeObject('buildResponsesPayloadFromChatJson', parsed);
}

export function buildResponsesRequestFromChatNative(
  payload: Record<string, unknown>,
  context?: Record<string, unknown>,
  extras?: Record<string, unknown>
): {
  request: Record<string, unknown>;
  originalSystemMessages?: string[];
} {
  const parsed = invokeRouterHotpathJsonCapability('buildResponsesRequestFromChatJson', [
    {
      payload: payload ?? {},
      context: context ?? null,
      extras: extras ?? null,
    },
  ]);
  const row = assertNativeObject('buildResponsesRequestFromChatJson', parsed);
  const request = row.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('[llmswitch-bridge] buildResponsesRequestFromChatJson returned invalid request');
  }
  const originalSystemMessages = Array.isArray(row.originalSystemMessages)
    ? row.originalSystemMessages.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  return {
    request: request as Record<string, unknown>,
    ...(originalSystemMessages ? { originalSystemMessages } : {}),
  };
}

export function buildRequestStageRuntimeControlWritePlanNative(input: {
  outputMetadata: Record<string, unknown>;
}): {
  runtimeControl?: Record<string, unknown> | null;
} {
  const parsed = invokeRouterHotpathJsonCapability('buildRequestStageRuntimeControlWritePlanJson', [
    {
      outputMetadata: input.outputMetadata ?? {},
    },
  ]);
  const row = assertNativeObject('buildRequestStageRuntimeControlWritePlanJson', parsed);
  const runtimeControl = row.runtimeControl;
  if (
    runtimeControl !== undefined
    && runtimeControl !== null
    && (
      typeof runtimeControl !== 'object'
      || Array.isArray(runtimeControl)
    )
  ) {
    throw new Error('[llmswitch-bridge] buildRequestStageRuntimeControlWritePlanJson returned invalid runtimeControl');
  }
  return {
    runtimeControl: runtimeControl as Record<string, unknown> | null | undefined,
  };
}

export function projectResponsesClientPayloadForClientNative(args: {
  payload: unknown;
  toolsRaw: unknown[];
  metadata?: Record<string, unknown>;
  context?: Record<string, unknown>;
}): Record<string, unknown> {
  const parsed = invokeRouterHotpathJsonCapability('projectResponsesClientPayloadForClientJson', [
    args.payload ?? null,
    Array.isArray(args.toolsRaw) ? args.toolsRaw : [],
    args.metadata ?? null,
    args.context ?? null,
  ]);
  return assertNativeObject('projectResponsesClientPayloadForClientJson', parsed);
}

export function planResponsesJsonClientDispatchNative(input: unknown): AnyRecord {
  const parsed = invokeRouterHotpathJsonCapability('planResponsesJsonClientDispatchJson', [
    input ?? null,
  ]);
  return assertNativeObject('planResponsesJsonClientDispatchJson', parsed);
}

export function projectResponsesSseFrameForClientNative(args: {
  frame: string;
  eventName?: string;
  data: Record<string, unknown>;
  toolsRaw: unknown[];
  metadata?: Record<string, unknown>;
  state: {
    pendingApplyPatchArgumentDeltas: Record<string, string>;
    applyPatchCallIds: string[];
    emittedApplyPatchDoneCallIds: string[];
  };
}): {
  emit: boolean;
  frame: string;
  state: {
    pendingApplyPatchArgumentDeltas: Record<string, string>;
    applyPatchCallIds: string[];
      emittedApplyPatchDoneCallIds: string[];
    };
} {
  const parsed = invokeRouterHotpathJsonCapability('projectResponsesSseFrameForClientJson', [
    args.frame ?? '',
    args.eventName ?? null,
    args.data ?? null,
    Array.isArray(args.toolsRaw) ? args.toolsRaw : [],
    args.metadata ?? {},
    args.state ?? {
      pendingApplyPatchArgumentDeltas: {},
      applyPatchCallIds: [],
      emittedApplyPatchDoneCallIds: [],
    },
  ]);
  return assertNativeObject('projectResponsesSseFrameForClientJson', parsed) as {
    emit: boolean;
    frame: string;
    state: {
      pendingApplyPatchArgumentDeltas: Record<string, string>;
      applyPatchCallIds: string[];
      emittedApplyPatchDoneCallIds: string[];
    };
  };
}

export function projectSseErrorEventPayloadNative(args: {
  requestId: string;
  status: number;
  message: string;
  code: string;
  error?: Record<string, unknown>;
}): {
  type: 'error';
  status: number;
  error: Record<string, unknown>;
} {
  const parsed = invokeRouterHotpathJsonCapability('projectSseErrorEventPayloadJson', [
    {
      requestId: args.requestId,
      status: Number.isFinite(args.status) ? Math.floor(args.status) : args.status,
      message: args.message,
      code: args.code,
      error: args.error,
    }
  ]);
  const row = assertNativeObject('projectSseErrorEventPayloadJson', parsed);
  const error = row.error;
  if (
    row.type !== 'error'
    || typeof row.status !== 'number'
    || !error
    || typeof error !== 'object'
    || Array.isArray(error)
    || typeof (error as Record<string, unknown>).message !== 'string'
    || typeof (error as Record<string, unknown>).code !== 'string'
    || typeof (error as Record<string, unknown>).request_id !== 'string'
  ) {
    throw new Error('[llmswitch-bridge] projectSseErrorEventPayloadJson returned invalid payload');
  }
  return row as {
    type: 'error';
    status: number;
    error: Record<string, unknown>;
  };
}

export function shouldRecordSnapshotsNative(): boolean {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>;
  const fn = binding.shouldRecordSnapshotsJson as undefined | (() => string);
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] shouldRecordSnapshotsJson not available');
  }
  return JSON.parse(String(fn())) as boolean;
}

export function writeSnapshotViaHooksNative(options: AnyRecord): void {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>;
  const fn = binding.writeSnapshotViaHooksJson as undefined | ((optionsJson: string) => string | void);
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] writeSnapshotViaHooksJson not available');
  }
  fn(JSON.stringify(options ?? null));
}

export function classifyProviderFailure(
  statusCode: number | undefined,
  errorCode: string | undefined,
  upstreamCode: string | undefined,
  isNetworkError: boolean,
): string {
  const fn = getFailurePolicyModule().classifyProviderFailure;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] classifyProviderFailure not available');
  }
  return fn(statusCode, errorCode, upstreamCode, isNetworkError);
}

export function deriveFinishReasonNative(body: unknown): string | undefined {
  const fn = getChatProcessNodeResultSemantics().deriveFinishReasonJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] deriveFinishReasonJson not available');
  }
  const raw = fn(JSON.stringify(body ?? null));
  const parsed = JSON.parse(raw) as unknown;
  return typeof parsed === 'string' ? parsed : undefined;
}

export function isToolCallContinuationResponseNative(body: unknown): boolean {
  const fn = getChatProcessNodeResultSemantics().isToolCallContinuationResponseJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] isToolCallContinuationResponseJson not available');
  }
  return Boolean(fn(JSON.stringify(body ?? null)));
}

export function hasRequestedToolsInSemanticsNative(requestSemantics?: Record<string, unknown>): boolean {
  const fn = getChatProcessNodeResultSemantics().hasRequestedToolsInSemanticsJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] hasRequestedToolsInSemanticsJson not available');
  }
  return Boolean(fn(JSON.stringify(requestSemantics ?? null)));
}

export function isRequiredToolCallTurnNative(requestSemantics?: Record<string, unknown>): boolean {
  const fn = getChatProcessNodeResultSemantics().isRequiredToolCallTurnJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] isRequiredToolCallTurnJson not available');
  }
  return Boolean(fn(JSON.stringify(requestSemantics ?? null)));
}

export function isToolResultFollowupTurnNative(requestSemantics?: Record<string, unknown>): boolean {
  const fn = getChatProcessNodeResultSemantics().isToolResultFollowupTurnJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] isToolResultFollowupTurnJson not available');
  }
  return Boolean(fn(JSON.stringify(requestSemantics ?? null)));
}

export function isProviderNativeResumeContinuationNative(requestSemantics?: Record<string, unknown>): boolean {
  const fn = getChatProcessNodeResultSemantics().isProviderNativeResumeContinuationJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] isProviderNativeResumeContinuationJson not available');
  }
  return Boolean(fn(JSON.stringify(requestSemantics ?? null)));
}

export function detectRetryableEmptyAssistantResponseNative(
  body: unknown,
  requestSemantics?: Record<string, unknown>
): { reason: string; marker: string } | null {
  const fn = getChatProcessNodeResultSemantics().detectRetryableEmptyAssistantResponseJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] detectRetryableEmptyAssistantResponseJson not available');
  }
  const raw = fn(JSON.stringify(body ?? null), JSON.stringify(requestSemantics ?? null));
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw) as unknown;
  return parsed === null ? null : (parsed as { reason: string; marker: string });
}


export function extractSessionIdentifiersFromMetadataNative(
  metadata: Record<string, unknown> | undefined
): { sessionId?: string; conversationId?: string } {
  const fn = getRouterHotpathJsonBindingSync().extractSessionIdentifiersJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] extractSessionIdentifiersJson not available');
  }
  const parsed = JSON.parse(fn(JSON.stringify(metadata ?? null))) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] extractSessionIdentifiersJson returned invalid payload');
  }
  const record = parsed as Record<string, unknown>;
  return {
    ...(typeof record.sessionId === 'string' && record.sessionId.trim()
      ? { sessionId: record.sessionId.trim() }
      : {}),
    ...(typeof record.conversationId === 'string' && record.conversationId.trim()
      ? { conversationId: record.conversationId.trim() }
      : {}),
  };
}

export function planResponsesRequestBodyForHttpNative(payload: unknown): {
  requestBodyMetadata?: Record<string, unknown>;
  pipelineBody: AnyRecord;
} {
  const fn = getRouterHotpathJsonBindingSync().planResponsesRequestBodyForHttpJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] planResponsesRequestBodyForHttpJson not available');
  }
  const parsed = JSON.parse(fn(JSON.stringify(payload ?? null))) as unknown;
  const record = assertNativeObject('planResponsesRequestBodyForHttpJson', parsed);
  const pipelineBody = assertNativeObject(
    'planResponsesRequestBodyForHttpJson.pipelineBody',
    record.pipelineBody
  );
  const requestBodyMetadata =
    record.requestBodyMetadata === undefined
      ? undefined
      : assertNativeObject(
          'planResponsesRequestBodyForHttpJson.requestBodyMetadata',
          record.requestBodyMetadata
        );
  return {
    ...(requestBodyMetadata ? { requestBodyMetadata } : {}),
    pipelineBody,
  };
}

export function shouldManageResponsesConversationForHttpNative(entryEndpoint: string | undefined): boolean {
  const fn = getRouterHotpathJsonBindingSync().shouldManageResponsesConversationForHttpJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] shouldManageResponsesConversationForHttpJson not available');
  }
  return fn(String(entryEndpoint ?? '')) === true;
}

export function buildResponsesConversationPortScopeForHttpNative(portContext: {
  matchedPort?: unknown;
  localPort?: unknown;
  routingPolicyGroup?: unknown;
} | null | undefined): {
  matchedPort?: number;
  routingPolicyGroup?: string;
} {
  const fn = getRouterHotpathJsonBindingSync().buildResponsesConversationPortScopeForHttpJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] buildResponsesConversationPortScopeForHttpJson not available');
  }
  const parsed = JSON.parse(fn(JSON.stringify(portContext ?? null))) as unknown;
  const record = assertNativeObject('buildResponsesConversationPortScopeForHttpJson', parsed);
  return {
    ...(typeof record.matchedPort === 'number' ? { matchedPort: record.matchedPort } : {}),
    ...(typeof record.routingPolicyGroup === 'string' && record.routingPolicyGroup.trim()
      ? { routingPolicyGroup: record.routingPolicyGroup.trim() }
      : {}),
  };
}

export function buildResponsesResumeControlForContinuationContextForHttpNative(
  resumeMeta: Record<string, unknown>
): Record<string, unknown> {
  const fn = getRouterHotpathJsonBindingSync().buildResponsesResumeControlForContinuationContextForHttpJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] buildResponsesResumeControlForContinuationContextForHttpJson not available');
  }
  const parsed = JSON.parse(fn(JSON.stringify(resumeMeta))) as unknown;
  return assertNativeObject(
    'buildResponsesResumeControlForContinuationContextForHttpJson',
    parsed
  );
}

export function buildResponsesScopeContinuationExpiredErrorForHttpNative(): {
  error: {
    message: string;
    type: 'invalid_request_error';
    code: 'responses_continuation_expired';
  };
} {
  const fn = getRouterHotpathJsonBindingSync().buildResponsesScopeContinuationExpiredErrorForHttpJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] buildResponsesScopeContinuationExpiredErrorForHttpJson not available');
  }
  const parsed = JSON.parse(fn()) as unknown;
  const record = assertNativeObject('buildResponsesScopeContinuationExpiredErrorForHttpJson', parsed);
  const errorRecord = assertNativeObject(
    'buildResponsesScopeContinuationExpiredErrorForHttpJson.error',
    record.error
  );
  return {
    error: {
      message: String(errorRecord.message ?? ''),
      type: 'invalid_request_error',
      code: 'responses_continuation_expired',
    },
  };
}

export function buildResponsesResumeClientErrorForHttpNative(args: {
  status?: number;
  code?: string;
  origin?: string;
  message?: string;
}): {
  status: number;
  body: {
    error: {
      message: string;
      type: 'invalid_request_error';
      code: string;
      origin: string;
    };
  };
} {
  const fn = getRouterHotpathJsonBindingSync().buildResponsesResumeClientErrorForHttpJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] buildResponsesResumeClientErrorForHttpJson not available');
  }
  const payload: Record<string, unknown> = {};
  if (typeof args.status === 'number') payload.status = args.status;
  if (typeof args.code === 'string') payload.code = args.code;
  if (typeof args.origin === 'string') payload.origin = args.origin;
  if (typeof args.message === 'string') payload.message = args.message;
  const parsed = JSON.parse(fn(JSON.stringify(payload))) as unknown;
  const record = assertNativeObject('buildResponsesResumeClientErrorForHttpJson', parsed);
  const bodyRecord = assertNativeObject(
    'buildResponsesResumeClientErrorForHttpJson.body',
    record.body
  );
  const errorRecord = assertNativeObject(
    'buildResponsesResumeClientErrorForHttpJson.body.error',
    bodyRecord.error
  );
  return {
    status: typeof record.status === 'number' ? record.status : 422,
    body: {
      error: {
        message: String(errorRecord.message ?? 'Unable to resume Responses conversation'),
        type: 'invalid_request_error',
        code: String(errorRecord.code ?? 'responses_resume_failed'),
        origin: String(errorRecord.origin ?? 'client'),
      },
    },
  };
}

export function shouldProjectResponsesResumeClientErrorForHttpNative(origin: string | undefined): boolean {
  const fn = getRouterHotpathJsonBindingSync().shouldProjectResponsesResumeClientErrorForHttpJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] shouldProjectResponsesResumeClientErrorForHttpJson not available');
  }
  return fn(String(origin ?? '')) === true;
}

export function planResponsesHandlerStreamForHttpNative(args: {
  payload: AnyRecord;
  forceStream?: boolean;
  acceptsSse: boolean;
  requestTimeoutMs?: number;
}): {
  originalStream: boolean;
  outboundStream: boolean;
  inboundStream: boolean;
  acceptsSse: boolean;
  requestStartMeta: Record<string, unknown>;
} {
  const fn = getRouterHotpathJsonBindingSync().planResponsesHandlerStreamForHttpJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] planResponsesHandlerStreamForHttpJson not available');
  }
  const parsed = JSON.parse(
    fn(
      JSON.stringify(args.payload ?? {}),
      args.acceptsSse,
      args.forceStream,
      args.requestTimeoutMs
    )
  ) as unknown;
  const record = assertNativeObject('planResponsesHandlerStreamForHttpJson', parsed);
  return {
    originalStream: record.originalStream === true,
    outboundStream: record.outboundStream === true,
    inboundStream: record.inboundStream === true,
    acceptsSse: record.acceptsSse === true,
    requestStartMeta: assertNativeObject(
      'planResponsesHandlerStreamForHttpJson.requestStartMeta',
      record.requestStartMeta
    ),
  };
}

export function finalizeResponsesHandlerPayloadForHttpNative(args: {
  payload: AnyRecord;
  isSubmitToolOutputs: boolean;
  outboundStream: boolean;
}): AnyRecord {
  const fn = getRouterHotpathJsonBindingSync().finalizeResponsesHandlerPayloadForHttpJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] finalizeResponsesHandlerPayloadForHttpJson not available');
  }
  const parsed = JSON.parse(
    fn(
      JSON.stringify(args.payload ?? {}),
      args.isSubmitToolOutputs === true,
      args.outboundStream === true
    )
  ) as unknown;
  return assertNativeObject('finalizeResponsesHandlerPayloadForHttpJson', parsed);
}

export function classifyEmptyResponseSignalNative(
  stage: string,
  body: unknown
): { errorType: string; matchedText: string; responseSummary: Record<string, unknown> } | null {
  const fn = getChatProcessNodeResultSemantics().classifyEmptyResponseSignalJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] classifyEmptyResponseSignalJson not available');
  }
  const raw = fn(String(stage || ''), JSON.stringify(body ?? null));
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] classifyEmptyResponseSignalJson returned invalid payload');
  }
  return parsed as { errorType: string; matchedText: string; responseSummary: Record<string, unknown> };
}

export function detectToolExecutionFailuresNative(body: unknown): ToolExecutionFailureSignal[] {
  const fn = getChatProcessNodeResultSemantics().detectToolExecutionFailuresJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] detectToolExecutionFailuresJson not available');
  }
  const raw = fn(JSON.stringify(body ?? null));
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] detectToolExecutionFailuresJson returned invalid payload');
  }
  return parsed as ToolExecutionFailureSignal[];
}

export function classifyRuntimeErrorSignalNative(
  stage: string,
  payload: unknown
): RuntimeErrorSignal | null {
  const fn = getChatProcessNodeResultSemantics().classifyRuntimeErrorSignalJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] classifyRuntimeErrorSignalJson not available');
  }
  const raw = fn(String(stage || ''), JSON.stringify(payload ?? null));
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] classifyRuntimeErrorSignalJson returned invalid payload');
  }
  return parsed as RuntimeErrorSignal;
}

export function shouldLogClientToolErrorToConsoleNative(failure: ToolExecutionFailureSignal): boolean {
  const fn = getChatProcessNodeResultSemantics().shouldLogClientToolErrorToConsoleJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] shouldLogClientToolErrorToConsoleJson not available');
  }
  return fn(JSON.stringify(failure ?? null));
}

export function shouldLogRuntimeErrorSignalToConsoleNative(signal: RuntimeErrorSignal): boolean {
  const fn = getChatProcessNodeResultSemantics().shouldLogRuntimeErrorSignalToConsoleJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] shouldLogRuntimeErrorSignalToConsoleJson not available');
  }
  return fn(JSON.stringify(signal ?? null));
}

export function shouldWriteClientToolErrorsampleNative(args: {
  endpoint: string;
  stage: string;
  failure: ToolExecutionFailureSignal;
  windowMs: number;
  nowMs: number;
}): boolean {
  const fn = getChatProcessNodeResultSemantics().shouldWriteClientToolErrorsampleJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] shouldWriteClientToolErrorsampleJson not available');
  }
  return fn(
    String(args.endpoint || ''),
    String(args.stage || ''),
    JSON.stringify(args.failure ?? null),
    Number(args.windowMs),
    Number(args.nowMs)
  );
}

export function resetSnapshotRecorderErrorsampleStateNative(): void {
  const fn = getChatProcessNodeResultSemantics().resetSnapshotRecorderErrorsampleStateJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resetSnapshotRecorderErrorsampleStateJson not available');
  }
  fn();
}

export function appendSnapshotStageTraceNative(args: {
  trace: unknown[];
  stage: string;
  payloadJson: string;
  capturePayload: boolean;
  timestamp: string;
  serializeError: string;
}): unknown[] {
  const fn = getChatProcessNodeResultSemantics().appendSnapshotStageTraceJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] appendSnapshotStageTraceJson not available');
  }
  const raw = fn(
    JSON.stringify(args.trace ?? []),
    String(args.stage || ''),
    String(args.payloadJson || 'null'),
    Boolean(args.capturePayload),
    String(args.timestamp || ''),
    String(args.serializeError || '')
  );
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] appendSnapshotStageTraceJson returned invalid payload');
  }
  return parsed;
}

export function summarizeSnapshotStageTraceNative(trace: unknown[], limit: number): Array<Record<string, unknown>> {
  const fn = getChatProcessNodeResultSemantics().summarizeSnapshotStageTraceJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] summarizeSnapshotStageTraceJson not available');
  }
  const raw = fn(JSON.stringify(trace ?? []), Number(limit));
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] summarizeSnapshotStageTraceJson returned invalid payload');
  }
  return parsed as Array<Record<string, unknown>>;
}

export function shouldInspectRuntimeErrorFastNative(stage: string, payload: unknown): boolean {
  const fn = getChatProcessNodeResultSemantics().shouldInspectRuntimeErrorFastJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] shouldInspectRuntimeErrorFastJson not available');
  }
  return fn(String(stage || ''), JSON.stringify(payload ?? null));
}

export function shouldInspectToolFailuresNative(stage: string): boolean {
  const fn = getChatProcessNodeResultSemantics().shouldInspectToolFailuresJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] shouldInspectToolFailuresJson not available');
  }
  return fn(String(stage || ''));
}

export function resolveRequestTailSummaryNative(
  stage: string,
  payload: unknown
): { stage: string; preview: string } | null {
  const fn = getChatProcessNodeResultSemantics().resolveRequestTailSummaryJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveRequestTailSummaryJson not available');
  }
  const raw = fn(String(stage || ''), JSON.stringify(payload ?? null));
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] resolveRequestTailSummaryJson returned invalid payload');
  }
  return parsed as { stage: string; preview: string };
}

export function summarizeClientToolObservationNative(
  payload: unknown,
  failures: ToolExecutionFailureSignal[]
): Record<string, unknown> {
  const fn = getChatProcessNodeResultSemantics().summarizeClientToolObservationJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] summarizeClientToolObservationJson not available');
  }
  const raw = fn(JSON.stringify(payload ?? null), JSON.stringify(failures ?? []));
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] summarizeClientToolObservationJson returned invalid payload');
  }
  return parsed as Record<string, unknown>;
}

export function resolveProviderResponseRequestSemanticsNative(
  processed: Record<string, unknown> | undefined,
  standardized: Record<string, unknown> | undefined,
  requestMetadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const fn = getChatProcessNodeResultSemantics().resolveProviderResponseRequestSemanticsJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveProviderResponseRequestSemanticsJson not available');
  }
  const raw = fn(
    JSON.stringify(processed ?? null),
    JSON.stringify(standardized ?? null),
    JSON.stringify(requestMetadata ?? null)
  );
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null) {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] resolveProviderResponseRequestSemanticsJson returned invalid payload');
  }
  return parsed as Record<string, unknown>;
}

export function updateResponsesSseTransportTerminalStateNative(input: {
  chunk: unknown;
  state: Record<string, unknown> | undefined;
  flushRemainder?: boolean;
}): { state: Record<string, unknown>; observedTerminal: boolean } {
  const fn = getChatProcessNodeResultSemantics().updateResponsesSseTransportTerminalStateJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] updateResponsesSseTransportTerminalStateJson not available');
  }
  const raw = fn(
    JSON.stringify(typeof input.chunk === 'string' ? input.chunk : String(input.chunk ?? '')),
    JSON.stringify(input.state ?? {}),
    input.flushRemainder === true
  );
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] updateResponsesSseTransportTerminalStateJson returned invalid payload');
  }
  const state = (parsed as { state?: unknown }).state;
  const sawTerminalEvent = (parsed as { sawTerminalEvent?: unknown }).sawTerminalEvent;
  if (!state || typeof state !== 'object' || Array.isArray(state) || typeof sawTerminalEvent !== 'boolean') {
    throw new Error('[llmswitch-bridge] updateResponsesSseTransportTerminalStateJson returned invalid shape');
  }
  return {
    state: state as Record<string, unknown>,
    observedTerminal: sawTerminalEvent,
  };
}

export function extractServertoolCliResultRouteHintFromRequestNative(input: {
  adapterContext?: Record<string, unknown>;
  runtimeMetadata?: Record<string, unknown>;
}): string | undefined {
  const adapterContext =
    input.adapterContext && typeof input.adapterContext === 'object' && !Array.isArray(input.adapterContext)
      ? input.adapterContext
      : undefined;
  const rawRequestBody =
    adapterContext?.__raw_request_body
      && typeof adapterContext.__raw_request_body === 'object'
      && !Array.isArray(adapterContext.__raw_request_body)
      ? (adapterContext.__raw_request_body as Record<string, unknown>)
      : undefined;
  if (!rawRequestBody) {
    return undefined;
  }
  const toolOutputs = Array.isArray(rawRequestBody.tool_outputs) ? rawRequestBody.tool_outputs : [];
  for (const item of toolOutputs) {
    const routeHint = readServertoolCliRouteHintFromRequestValue(item);
    if (routeHint) {
      return routeHint;
    }
  }
  const inputItems = Array.isArray(rawRequestBody.input) ? rawRequestBody.input : [];
  for (const item of inputItems) {
    const routeHint = readServertoolCliRouteHintFromRequestValue(item);
    if (routeHint) {
      return routeHint;
    }
  }
  return undefined;
}

export function resolveProviderRetryExecutionPolicyNative(input: {
  classification: NativeFailureClassification;
  isStreamingRequest?: boolean;
  hostContractFailure?: boolean;
  forceExcludeCurrentProviderOnRetry?: boolean;
  errorCode?: string;
  promptTooLong?: boolean;
  existingExclusion?: boolean;
}): {
  excludeCurrentProvider: boolean;
  reason: string;
} {
  const fn = getFailurePolicyModule().resolveProviderRetryExecutionPolicyNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveProviderRetryExecutionPolicyNative not available');
  }
  return fn(input);
}

// ---------------------------------------------------------------------------
// req_executor_pipeline_attempt — Rust migration batch #1
// ---------------------------------------------------------------------------

export function normalizeExplicitRoutePoolNative(value: unknown): string[] {
  const parsed = invokeRouterHotpathJsonCapability('normalizeExplicitRoutePoolJson', [value]);
  const result = assertNativeObject('normalizeExplicitRoutePoolJson', parsed);
  return Array.isArray(result.pool) ? result.pool as string[] : [];
}

export function mergeObservedRoutePoolChainNative(
  existing: string[] | null,
  observed: string[]
): string[] | null {
  const existingJson = existing !== null ? JSON.stringify(existing) : null;
  const observedJson = JSON.stringify(observed);
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.mergeObservedRoutePoolChainJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] mergeObservedRoutePoolChainJson not available');
  }
  const raw = fn(existingJson, observedJson);
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return null;
  }
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// batch #6: resolveEntryProtocolFromEndpoint
// ---------------------------------------------------------------------------

export function resolveEntryProtocolFromEndpointNative(entryEndpoint: string): string {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.resolveEntryProtocolFromEndpointJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveEntryProtocolFromEndpointJson not available');
  }
  return fn(entryEndpoint);
}

// Native router hotpath parser types are owned by the Rust/native entry wrappers.

// Servertool / stopless / followup semantics are Rust-owned.
// Production TS intentionally exposes no per-capability servertool wrapper fan-out here.
