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
import type { AnyRecord } from './module-loader.js';
import type { ToolExecutionFailureSignal } from './snapshot-recorder-types.js';

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
  getNetworkErrorCodes?: () => string[];
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
  updateResponsesContractProbeFromSseChunkJson?: (chunkJson: string, probeJson: string) => string;
  updateResponsesSseTransportTerminalStateJson?: (
    chunkJson: string,
    stateJson: string,
    flushRemainder: boolean
  ) => string;
  buildResponsesTerminalSseFramesFromProbeJson?: (probeJson: string, requestLabel: string) => string;
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
  networkErrorSetJson?: () => string;
  hasDeclaredApplyPatchToolJson?: (payloadJson: string) => string;
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

type NativeHubVrNodeContracts = {
  describeHubPipelineContractsWithNative?: () => AnyRecord;
  describeVirtualRouterContractsWithNative?: () => AnyRecord;
  describeMetaCarrierContractsWithNative?: () => AnyRecord;
  describePipelineContractWithNative?: (nodeId: string) => AnyRecord;
  describeServerContractsWithNative?: () => AnyRecord;
  describeServerModuleHelpWithNative?: (moduleId: string) => AnyRecord;
  validatePipelineNodeContractBoundaryWithNative?: (
    nodeId: string,
    before: unknown,
    after: unknown
  ) => AnyRecord;
};

let cachedFailurePolicyModule: NativeFailurePolicyModule | null | undefined;
let cachedRouterHotpathJsonBindingSync: NativeRouterHotpathJsonBinding | null | undefined;
let cachedHubVrNodeContracts: NativeHubVrNodeContracts | null | undefined;

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
    getNetworkErrorCodes: () => {
      const fn = binding.networkErrorSetJson;
      if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] networkErrorSetJson not available');
      }
      return JSON.parse(String(fn())) as string[];
    },
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

function buildHubVrNodeContractsFromRouterHotpathBinding(
  binding: NativeRouterHotpathJsonBinding
): NativeHubVrNodeContracts | null {
  const required = [
    'describeHubPipelineContractsJson',
    'describeVirtualRouterContractsJson',
    'describeMetaCarrierContractsJson',
    'describePipelineContractJson',
    'validatePipelineNodeContractBoundaryJson',
  ];
  if (!required.every((name) => typeof (binding as Record<string, unknown>)[name] === 'function')) {
    return null;
  }
  const invoke = (capability: string, args: string[] = []): AnyRecord => {
    const fn = (binding as Record<string, unknown>)[capability];
    if (typeof fn !== 'function') {
      throw new Error(`[llmswitch-bridge] ${capability} not available`);
    }
    const raw = (fn as (...rawArgs: string[]) => unknown)(...args);
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(`[llmswitch-bridge] ${capability} returned empty result`);
    }
    const parsed = JSON.parse(raw) as unknown;
    return assertNativeObject(capability, parsed);
  };
  return {
    describeHubPipelineContractsWithNative: () =>
      invoke('describeHubPipelineContractsJson'),
    describeVirtualRouterContractsWithNative: () =>
      invoke('describeVirtualRouterContractsJson'),
    describeMetaCarrierContractsWithNative: () =>
      invoke('describeMetaCarrierContractsJson'),
    describePipelineContractWithNative: (nodeId: string) =>
      invoke('describePipelineContractJson', [String(nodeId || '')]),
    describeServerContractsWithNative: () =>
      invoke('describeServerContractsJson'),
    describeServerModuleHelpWithNative: (moduleId: string) =>
      invoke('describeServerModuleHelpJson', [String(moduleId || '')]),
    validatePipelineNodeContractBoundaryWithNative: (
      nodeId: string,
      before: unknown,
      after: unknown
    ) =>
      invoke('validatePipelineNodeContractBoundaryJson', [
        String(nodeId || ''),
        JSON.stringify(before ?? null),
        JSON.stringify(after ?? null),
      ]),
  };
}

function getHubVrNodeContracts(): NativeHubVrNodeContracts {
  if (cachedHubVrNodeContracts !== undefined) {
    if (!cachedHubVrNodeContracts) {
      throw new Error('[llmswitch-bridge] native-hub-vr-node-contracts not available');
    }
    return cachedHubVrNodeContracts;
  }
  try {
    cachedHubVrNodeContracts = buildHubVrNodeContractsFromRouterHotpathBinding(
      getRouterHotpathJsonBindingSync()
    );
  } catch {
    cachedHubVrNodeContracts = null;
  }
  if (!cachedHubVrNodeContracts) {
    throw new Error('[llmswitch-bridge] native-hub-vr-node-contracts not available');
  }
  return cachedHubVrNodeContracts;
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

export async function mapChatToolsToBridgeJson(rawTools: unknown): Promise<AnyRecord[]> {
  const parsed = invokeRouterHotpathJsonCapability('mapChatToolsToBridgeJson', [
    Array.isArray(rawTools) ? rawTools : [],
  ]);
  return assertNativeArray('mapChatToolsToBridgeJson', parsed) as AnyRecord[];
}

export async function injectMcpToolsForChatJson(
  tools: unknown[] | undefined,
  discoveredServers: string[]
): Promise<AnyRecord[]> {
  const parsed = invokeRouterHotpathJsonCapability('injectMcpToolsForChatJson', [
    Array.isArray(tools) ? tools : [],
    Array.isArray(discoveredServers) ? discoveredServers : [],
  ]);
  return assertNativeArray('injectMcpToolsForChatJson', parsed) as AnyRecord[];
}

export async function injectMcpToolsForResponsesJson(
  tools: unknown[] | undefined,
  discoveredServers: string[]
): Promise<AnyRecord[]> {
  const parsed = invokeRouterHotpathJsonCapability('injectMcpToolsForResponsesJson', [
    Array.isArray(tools) ? tools : [],
    Array.isArray(discoveredServers) ? discoveredServers : [],
  ]);
  return assertNativeArray('injectMcpToolsForResponsesJson', parsed) as AnyRecord[];
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

export async function buildAnthropicResponseFromChatJson(
  chatResponse: unknown,
  aliasMap?: Record<string, string>
): Promise<AnyRecord> {
  const parsed = invokeRouterHotpathJsonCapability('buildAnthropicResponseFromChatJson', [
    chatResponse ?? null,
    aliasMap ?? null,
  ]);
  return assertNativeObject('buildAnthropicResponseFromChatJson', parsed);
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

export function hasDeclaredApplyPatchToolNative(payload: unknown): boolean {
  const parsed = invokeRouterHotpathJsonCapability('hasDeclaredApplyPatchToolJson', [payload ?? null]);
  const row = assertNativeObject('hasDeclaredApplyPatchToolJson', parsed);
  return row.hasDeclaredApplyPatchTool === true;
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

export function evaluateResponsesDirectRouteDecisionNative(input: {
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  inboundProtocol: string;
  applyPatchMode?: string;
}): {
  providerWireValid: boolean;
  requiresHubRelay: boolean;
  reason?: string;
  hasDeclaredApplyPatchTool?: boolean;
} {
  const parsed = invokeRouterHotpathJsonCapability('evaluateResponsesDirectRouteDecisionJson', [
    input.payload ?? {},
    input.metadata ?? {},
    input.inboundProtocol ?? '',
    input.applyPatchMode ?? '',
  ]);
  return assertNativeObject('evaluateResponsesDirectRouteDecisionJson', parsed) as {
    providerWireValid: boolean;
    requiresHubRelay: boolean;
    reason?: string;
    hasDeclaredApplyPatchTool?: boolean;
  };
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

export function buildChatResponseFromResponsesNative(
  payload: unknown
): Record<string, unknown> {
  const parsed = invokeRouterHotpathJsonCapability('buildChatResponseFromResponsesJson', [
    payload ?? null,
  ]);
  return assertNativeObject('buildChatResponseFromResponsesJson', parsed);
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

export function describeHubPipelineContractsNative(): AnyRecord {
  const fn = getHubVrNodeContracts().describeHubPipelineContractsWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] describeHubPipelineContractsWithNative not available');
  }
  return fn();
}

export function describeHubPipelineContractsWithNative(): AnyRecord {
  return describeHubPipelineContractsNative();
}

export function describeVirtualRouterContractsNative(): AnyRecord {
  const fn = getHubVrNodeContracts().describeVirtualRouterContractsWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] describeVirtualRouterContractsWithNative not available');
  }
  return fn();
}

export function describeVirtualRouterContractsWithNative(): AnyRecord {
  return describeVirtualRouterContractsNative();
}

export function describeMetaCarrierContractsNative(): AnyRecord {
  const fn = getHubVrNodeContracts().describeMetaCarrierContractsWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] describeMetaCarrierContractsWithNative not available');
  }
  return fn();
}

export function describeMetaCarrierContractsWithNative(): AnyRecord {
  return describeMetaCarrierContractsNative();
}

export function describePipelineContractNative(nodeId: string): AnyRecord {
  const fn = getHubVrNodeContracts().describePipelineContractWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] describePipelineContractWithNative not available');
  }
  return fn(nodeId);
}

export function describePipelineContractWithNative(nodeId: string): AnyRecord {
  return describePipelineContractNative(nodeId);
}

export function describeServerContractsWithNative(): AnyRecord {
  const fn = getHubVrNodeContracts().describeServerContractsWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] describeServerContractsWithNative not available');
  }
  return fn();
}

export function describeServerModuleHelpWithNative(moduleId: string): AnyRecord {
  const fn = getHubVrNodeContracts().describeServerModuleHelpWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] describeServerModuleHelpWithNative not available');
  }
  return fn(moduleId);
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

export function validatePipelineNodeContractBoundaryNative(
  nodeId: string,
  before: unknown,
  after: unknown
): AnyRecord {
  const fn = getHubVrNodeContracts().validatePipelineNodeContractBoundaryWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] validatePipelineNodeContractBoundaryWithNative not available');
  }
  return fn(nodeId, before, after);
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

export function isEmptyClientResponsePayloadNative(body: unknown): boolean {
  const fn = getChatProcessNodeResultSemantics().isEmptyClientResponsePayloadJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] isEmptyClientResponsePayloadJson not available');
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


export function validateApplyPatchArgumentsNative(applyPatchArgsSource: unknown): {
  ok: boolean;
  reason?: string;
  message?: string;
  normalizedArguments?: unknown;
} {
  const fn = getRouterHotpathJsonBindingSync().validateApplyPatchArgumentsJson as
    ((argsJson: string) => string) | undefined;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] validateApplyPatchArgumentsJson not available');
  }
  return JSON.parse(fn(JSON.stringify(applyPatchArgsSource ?? null)));
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

export function updateResponsesContractProbeFromSseChunkNative(
  chunk: unknown,
  probe: Record<string, unknown> | undefined
): Record<string, unknown> {
  const fn = getChatProcessNodeResultSemantics().updateResponsesContractProbeFromSseChunkJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] updateResponsesContractProbeFromSseChunkJson not available');
  }
  const raw = fn(JSON.stringify(typeof chunk === 'string' ? chunk : String(chunk ?? '')), JSON.stringify(probe ?? {}));
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[llmswitch-bridge] updateResponsesContractProbeFromSseChunkJson returned invalid payload');
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

export function buildResponsesTerminalSseFramesFromProbeNative(
  probe: Record<string, unknown> | undefined,
  requestLabel: string
): string[] {
  const fn = getChatProcessNodeResultSemantics().buildResponsesTerminalSseFramesFromProbeJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] buildResponsesTerminalSseFramesFromProbeJson not available');
  }
  const raw = fn(JSON.stringify(probe ?? {}), String(requestLabel || 'unknown'));
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((frame) => typeof frame === 'string')) {
    throw new Error('[llmswitch-bridge] buildResponsesTerminalSseFramesFromProbeJson returned invalid payload');
  }
  return parsed as string[];
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

export function getNetworkErrorCodes(): string[] {
  const fn = getFailurePolicyModule().getNetworkErrorCodes;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] getNetworkErrorCodes not available');
  }
  return fn();
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

// === SERVERTOOL ORCHESTRATION WRAPPERS (Phase 3) ===
// 63 wrappers: bridge native-chat-process-servertool-orchestration-semantics.ts -> native-exports.ts

export function detectEmptyAssistantPayloadContractSignalWithNative(payload: unknown): unknown {
  return invokeRouterHotpathJsonCapability('detectEmptyAssistantPayloadContractSignalJson', [payload]);
}

export function detectProviderResponseShapeWithNative(payload: unknown): unknown {
  return invokeRouterHotpathJsonCapability('detectProviderResponseShapeJson', [payload]);
}

export function containsSyntheticRouteCodexControlTextWithNative(payload: unknown): boolean {
  const result = invokeRouterHotpathJsonCapability('containsSyntheticRoutecodexControlTextJson', [payload]);
  return result === true;
}

export function planChatWebSearchOperationsWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planChatWebSearchOperationsJson', [input]);
}

export function runServertoolResponseStageWithNative(payload: unknown, requestId: string): unknown {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.runServertoolResponseStageJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] runServertoolResponseStageJson not available');
  }
  const payloadJson = JSON.stringify(payload);
  let raw: unknown;
  try {
    raw = fn(payloadJson, requestId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[llmswitch-bridge] runServertoolResponseStageJson native error: ${detail}`);
  }
  if (raw instanceof Error) {
    throw new Error(`[llmswitch-bridge] runServertoolResponseStageJson native error: ${raw.message || 'unknown error'}`);
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { message?: unknown }).message === 'string') {
    throw new Error(`[llmswitch-bridge] runServertoolResponseStageJson native error: ${String((raw as { message: unknown }).message)}`);
  }
  if (typeof raw !== 'string') {
    throw new Error('[llmswitch-bridge] runServertoolResponseStageJson returned non-string result');
  }
  const rawText = raw.trimStart();
  if (rawText.startsWith('Error:')) {
    throw new Error(rawText);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[llmswitch-bridge] runServertoolResponseStageJson JSON parse failed: ${detail}; raw=${raw}`);
  }
}

export function planServertoolResponseStageGateWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolResponseStageGateJson', [input]);
}

export function getDefaultServertoolSkeletonDocumentWithNative(): unknown {
  return invokeRouterHotpathJsonCapability('getDefaultServertoolSkeletonDocumentJson', []);
}

export function planServertoolSkeletonDerivedConfigWithNative(input?: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolSkeletonDerivedConfigJson', input !== undefined ? [input] : [{}]);
}

export function readServertoolPrimaryAutoHookIdsWithNative(input?: unknown): string[] {
  const derivedConfig = planServertoolSkeletonDerivedConfigWithNative(input) as Record<string, unknown>;
  const autoHookQueueConfig = derivedConfig?.autoHookQueueConfig;
  if (!autoHookQueueConfig || typeof autoHookQueueConfig !== 'object' || Array.isArray(autoHookQueueConfig)) {
    throw new Error('[llmswitch-bridge] readServertoolPrimaryAutoHookIdsWithNative: missing autoHookQueueConfig');
  }
  const config = autoHookQueueConfig as Record<string, unknown>;
  const optionalPrimaryOrder = config.optionalPrimaryOrder;
  if (!Array.isArray(optionalPrimaryOrder)) {
    throw new Error('[llmswitch-bridge] readServertoolPrimaryAutoHookIdsWithNative: missing optionalPrimaryOrder');
  }
  return optionalPrimaryOrder.filter((entry): entry is string => typeof entry === 'string');
}

export function buildServertoolDispatchPlanInputWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildServertoolDispatchPlanInputJson', [input]);
}

export function buildServertoolOutcomePlanInputWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildServertoolOutcomePlanInputJson', [input]);
}

export function planServertoolHandlerContractWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolHandlerContractJson', [input]);
}

export function normalizeServertoolRegistrationSpecWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('normalizeServertoolRegistrationSpecJson', [input]);
}

export function resolveServertoolToolSpecWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveServertoolToolSpecJson', [input]);
}

export function planServertoolBuiltinHandlerEntryWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolBuiltinHandlerEntryJson', [input]);
}

export function resolveServertoolBuiltinHandlerEntryWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveServertoolBuiltinHandlerEntryJson', [input]);
}

export function planStoplessCliProjectionContextWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planStoplessCliProjectionContextJson', [input]);
}

export function planServertoolBuiltinHandlerNamesWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolBuiltinHandlerNamesJson', [input]);
}

export function planServertoolBuiltinAutoHandlerEntriesWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolBuiltinAutoHandlerEntriesJson', [input]);
}

export function planServertoolBuiltinHandlerRecordEntriesWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolBuiltinHandlerRecordEntriesJson', [input]);
}

export function planServertoolRegistryLookupFromSkeletonWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolRegistryLookupFromSkeletonJson', [input]);
}

export function resolveServertoolRegistryHandlerWithNative(input: unknown): unknown {
  const request = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const name = typeof request.name === 'string' ? request.name : '';
  const entry = resolveServertoolBuiltinHandlerEntryWithNative({ name });
  const actionPlan = planServertoolRegistryLookupFromSkeletonWithNative({
    name,
    hasBuiltinEntry: entry != null,
    builtinEntryPresent: entry != null,
  }) as Record<string, unknown>;
  if (actionPlan.action === 'return_builtin') {
    return entry;
  }
  if (actionPlan.action === 'return_none') {
    return null;
  }
  throw new Error('[servertool] invalid registry lookup action');
}

export function resolveServertoolRegisteredNameWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveServertoolRegisteredNameJson', [input]);
}

export function resolveServertoolProgressToolNameWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveServertoolProgressToolNameJson', [input]);
}

export function shouldUseServertoolGoldProgressHighlightWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('shouldUseServertoolGoldProgressHighlightJson', [input]);
}

export function resolveServertoolProgressStageWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveServertoolProgressStageJson', [input]);
}

export function normalizeServertoolProgressResultWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('normalizeServertoolProgressResultJson', [input]);
}

export function normalizeServertoolProgressTokenWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('normalizeServertoolProgressTokenJson', [input]);
}

export function normalizeServertoolProgressFlowIdWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('normalizeServertoolProgressFlowIdJson', [input]);
}

export function buildServertoolMatchSkippedProgressEventWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildServertoolMatchSkippedProgressEventJson', [input]);
}

export function buildServertoolAutoHookTraceProgressEventWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildServertoolAutoHookTraceProgressEventJson', [input]);
}

export function buildServertoolStopEntryProgressEventWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildServertoolStopEntryProgressEventJson', [input]);
}

export function buildServertoolStopCompareProgressEventWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildServertoolStopCompareProgressEventJson', [input]);
}

export function planServertoolToolCallDispatchWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolToolCallDispatchJson', [input]);
}

export function planServertoolOutcomeWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolOutcomeJson', [input]);
}

export function planServertoolAutoHookQueuesWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolAutoHookQueuesJson', [input]);
}

export function planServertoolAutoHookQueueItemsWithNative<T>(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolAutoHookQueueItemsJson', [input]);
}

export function runServertoolOrchestrationMutationWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('runServertoolOrchestrationMutationJson', [input]);
}

export function planServertoolFollowupRuntimeWithNative(flowId: string): unknown {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.planServertoolFollowupRuntimeJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] planServertoolFollowupRuntimeJson not available');
  }
  const raw = fn(flowId);
  return JSON.parse(raw);
}

export function extractCapturedChatSeedWithNative(captured: unknown): unknown {
  return invokeRouterHotpathJsonCapability('extractCapturedChatSeedJson', [captured]);
}

export function buildServertoolReq04FollowupPayloadWithNative(adapterContext: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildServertoolReq04FollowupPayloadJson', [adapterContext]);
}

export function resolveFollowupModelWithNative(seedModel: unknown, adapterContext: unknown): string {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.resolveFollowupModelJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveFollowupModelJson not available');
  }
  const raw = fn(JSON.stringify(seedModel), JSON.stringify(adapterContext));
  return raw;
}

export function normalizeFollowupParametersWithNative(parameters: unknown): unknown {
  return invokeRouterHotpathJsonCapability('normalizeFollowupParametersJson', [parameters]);
}

export function extractAssistantFollowupMessageWithNative(finalChatResponse: unknown): unknown {
  return invokeRouterHotpathJsonCapability('extractAssistantFollowupMessageJson', [finalChatResponse]);
}

export function applyFollowupDeltaPlanWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('applyFollowupDeltaPlanJson', [input]);
}

export function buildServertoolToolOutputPayloadWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildServertoolToolOutputPayloadJson', [input]);
}

export function buildServertoolHandlerErrorToolOutputPayloadWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildServertoolHandlerErrorToolOutputPayloadJson', [input]);
}

export function collectServertoolAdditionalClientToolCallsWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('collectServertoolAdditionalClientToolCallsJson', [input]);
}

export function isServertoolClientExecCliProjectionToolCallWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('isServertoolClientExecCliProjectionToolCallJson', [input]);
}

export function webSearchIsGeminiEngineWithNative(providerKey: string): boolean {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchIsGeminiEngine;
  if (typeof fn !== 'function') {
    return false;
  }
  const raw = fn(JSON.stringify(providerKey));
  return raw === 'true';
}

export function webSearchIsQwenEngineWithNative(providerKey: string): boolean {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchIsQwenEngine;
  if (typeof fn !== 'function') {
    return false;
  }
  const raw = fn(JSON.stringify(providerKey));
  return raw === 'true';
}

export function webSearchIsGlmEngineWithNative(providerKey: string): boolean {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchIsGlmEngine;
  if (typeof fn !== 'function') {
    return false;
  }
  const raw = fn(JSON.stringify(providerKey));
  return raw === 'true';
}

export function webSearchNormalizeResultCountWithNative(valueJson: string): number {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchNormalizeResultCountJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] webSearchNormalizeResultCountJson not available');
  }
  const raw = fn(valueJson);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('[llmswitch-bridge] webSearchNormalizeResultCountJson: invalid result');
  }
  return n;
}

export function webSearchBuildSystemPromptWithNative(targetCount: number): string {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchBuildSystemPrompt;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] webSearchBuildSystemPrompt not available');
  }
  return fn(targetCount);
}

export function webSearchSanitizeBackendErrorWithNative(message: string): string {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchSanitizeBackendErrorJson;
  if (typeof fn !== 'function') {
    return message;
  }
  return fn(message);
}

export function webSearchCollectHitsWithNative(chatResponseJson: string, targetCount: number): string {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchCollectHitsJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] webSearchCollectHitsJson not available');
  }
  return fn(chatResponseJson, targetCount);
}

export function webSearchFormatHitsSummaryWithNative(hitsJson: string): string {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchFormatHitsSummaryJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] webSearchFormatHitsSummaryJson not available');
  }
  return fn(hitsJson);
}

export function webSearchLimitHitsWithNative(hitsJson: string): string {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchLimitHitsJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] webSearchLimitHitsJson not available');
  }
  return fn(hitsJson);
}

export function webSearchExtractAssistantMessageWithNative(chatResponseJson: string): string {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchExtractAssistantMessageJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] webSearchExtractAssistantMessageJson not available');
  }
  return fn(chatResponseJson);
}

export function webSearchBuildToolMessagesWithNative(chatResponseJson: string): string {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchBuildToolMessagesJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] webSearchBuildToolMessagesJson not available');
  }
  return fn(chatResponseJson);
}

export function visionBuildAnalysisPayloadWithNative(sourceJson: string): string {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.visionBuildAnalysisPayloadJson;
  if (typeof fn !== 'function') {
    return 'null';
  }
  try {
    const raw = fn(sourceJson);
    return typeof raw === 'string' ? raw : 'null';
  } catch {
    return 'null';
  }
}

export function visionBuildPinnedMetadataWithNative(adapterContextJson: string, payloadJson: string): string {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.visionBuildPinnedMetadataJson;
  if (typeof fn !== 'function') {
    return 'null';
  }
  try {
    const raw = fn(adapterContextJson, payloadJson);
    return typeof raw === 'string' ? raw : 'null';
  } catch {
    return 'null';
  }
}

export function visionExtractOriginalUserPromptWithNative(messagesJson: string): string {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.visionExtractOriginalUserPromptJson;
  if (typeof fn !== 'function') {
    return '';
  }
  try {
    const raw = fn(messagesJson);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

export function readFollowupClientInjectSourceWithNative(adapterContext: Record<string, unknown>): string {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.readFollowupClientInjectSourceJson;
  if (typeof fn !== 'function') {
    return '';
  }
  try {
    const ctxJson = JSON.stringify(adapterContext);
    const raw = fn(ctxJson);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

// Native router hotpath parser types are owned by the Rust/native entry wrappers.

// === SERVERTOOL CORE BRIDGE WRAPPERS (Phase 4) ===

export function extractTextFromChatLikeWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('extractServertoolTextFromChatLikeJson', [input]);
}

export function inspectStopGatewaySignalWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('inspectStopGatewaySignal', [input]);
}

export function normalizeStopGatewayContextWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('normalizeStopGatewayContextJson', [input]);
}

export function extractStopMessageBlockedReportFromMessagesWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('extractStopMessageBlockedReportFromMessagesJson', [input]);
}

export function normalizeStopMessageCompareContextWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('normalizeStopMessageCompareContextJson', [input]);
}

export function formatStopMessageCompareContextWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('formatStopMessageCompareContextJson', [input]);
}

export function evaluateLoopGuardWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('evaluateLoopGuard', [input]);
}

export function calculateBudgetWithNative(observed: boolean, stop_eligible: boolean, snapshot: unknown, default_config: unknown): unknown {
  const binding = getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>;
  const fn = binding.calculateBudget;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] calculateBudget not available');
  }
  const resultJson = (fn as Function)(
    observed,
    stop_eligible,
    snapshot ? JSON.stringify(snapshot) : undefined,
    default_config ? JSON.stringify(default_config) : undefined
  );
  if (typeof resultJson !== 'string') {
    throw new Error('[llmswitch-bridge] calculateBudget returned non-string');
  }
  return JSON.parse(resultJson);
}

export function planBudgetStateUpdateWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planBudgetStateUpdateJson', [input]);
}

export function resolveStopMessageSessionScopeWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveStopMessageSessionScopeJson', [input]);
}

export function resolveServertoolStickyKeyWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveServertoolStickyKeyJson', [input]);
}

export function resolveServertoolStateKeyWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveServertoolStateKeyJson', [input]);
}

export function resolveRuntimeStopMessageStateWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveRuntimeStopMessageStateJson', [input]);
}

export function readRuntimeStopMessageStageModeWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('readRuntimeStopMessageStageModeJson', [input]);
}

export function normalizeStopMessageStageModeValueWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('normalizeStopMessageStageModeValueJson', [input]);
}

export function hasArmedStopMessageStateWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('hasArmedStopMessageStateJson', [input]);
}

export function planStopMessageRoutingSnapshotWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planStopMessageRoutingSnapshotJson', [input]);
}

export function planStopMessageRoutingStateApplyWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planStopMessageRoutingStateApplyJson', [input]);
}

export function planStopMessageRoutingStateClearWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planStopMessageRoutingStateClearJson', [input]);
}

export function buildClientExecCliProjectionOutputWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildClientExecCliProjectionOutputJson', [input]);
}

export function parseServertoolCliProjectionToolArgumentsWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('parseServertoolCliProjectionToolArgumentsJson', [input]);
}

export function normalizeStoplessTriggerHintForMetadataWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('normalizeStoplessTriggerHintForMetadataJson', [input]);
}

export function planStoplessLearnedNoteWriteWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planStoplessLearnedNoteWriteJson', [input]);
}

export function validateServertoolHookSkeletonPhaseWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('validateServertoolHookSkeletonPhaseJson', [input]);
}

export function planServertoolHookScheduleWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolHookScheduleJson', [input]);
}

export function buildClientVisibleProjectionShellWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildClientVisibleProjectionShellJson', [input]);
}

export function buildServertoolCliProjectionExecutionContextWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildServertoolCliProjectionExecutionContextJson', [input]);
}

export function buildServertoolCliProjectionRuntimeBranchWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildServertoolCliProjectionRuntimeBranchJson', [input]);
}

export function validateClientExecCommandResultWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('validateClientExecCommandResultJson', [input]);
}

export function resolveRuntimeStopMessageStateFromMetadataCenterWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveRuntimeStopMessageStateFromMetadataCenterJson', [input]);
}

export function resolveBdWorkingDirectoryForRecordWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveBdWorkingDirectoryForRecordJson', [input]);
}

export function resolveStopMessageFollowupProviderKeyWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveStopMessageFollowupProviderKeyJson', [input]);
}

export function resolveClientConnectionStateWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveClientConnectionStateJson', [input]);
}

export function hasCompactionFlagWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('hasCompactionFlagJson', [input]);
}

export function resolveEntryEndpointWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveEntryEndpointJson', [input]);
}

export function resolveDefaultStopMessageSnapshotWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveDefaultStopMessageSnapshotJson', [input]);
}

export function resolveImplicitGeminiStopMessageSnapshotWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveImplicitGeminiStopMessageSnapshotJson', [input]);
}

export function readServertoolLoopStateWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('readServertoolLoopStateJson', [input]);
}

export function planServertoolLoopStateWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolLoopStateJson', [input]);
}

export function parseServertoolTimeoutMsWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('parseServertoolTimeoutMsJson', [input]);
}

export function planServertoolTimeoutWatcherWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolTimeoutWatcherJson', [input]);
}

export function isAdapterClientDisconnectedWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('isAdapterClientDisconnectedJson', [input]);
}

export function planClientDisconnectWatcherWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planClientDisconnectWatcherJson', [input]);
}

export function createServertoolExecutionLoopStateWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('createServertoolExecutionLoopStateJson', [input]);
}

export function readClientInjectOnlyWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('readClientInjectOnlyJson', [input]);
}

export function normalizeClientInjectTextWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('normalizeClientInjectTextJson', [input]);
}

export function compactFollowupErrorReasonWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('compactFollowupErrorReasonJson', [input]);
}

export function resolveAdapterContextProviderKeyWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveAdapterContextProviderKeyJson', [input]);
}

export function extractCurrentAssistantReasoningStopArgumentsWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('extractCurrentAssistantReasoningStopArgumentsJson', [input]);
}

export function stripStopSchemaControlTextWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('stripStopSchemaControlTextJson', [input]);
}


// servertool-core bridge: planStoplessExecutionWithNative
export function planStoplessExecutionWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planStoplessExecutionJson', [input]);
}

// servertool-core bridge: buildStoplessAutoCliProjectionFromEngineWithNative
export function buildStoplessAutoCliProjectionFromEngineWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildStoplessAutoCliProjectionFromEngineJson', [input]);
}

// servertool-core bridge: resolveServertoolEnginePostflightPayloadWithNative
export function resolveServertoolEnginePostflightPayloadWithNative(input: unknown): unknown {
  const record = assertNativeObject('resolveServertoolEnginePostflightPayloadWithNative', input);
  const runtimeAction = assertNativeObject(
    'resolveServertoolEnginePostflightPayloadWithNative.runtimeAction',
    record.runtimeAction
  );
  if (runtimeAction.finalPayloadSource === 'engine_result') {
    const engineResult = assertNativeObject(
      'resolveServertoolEnginePostflightPayloadWithNative.engineResult',
      record.engineResult
    );
    return engineResult.finalChatResponse;
  }
  if (runtimeAction.finalPayloadSource === 'stop_message_cli_projection') {
    const projection = buildStoplessAutoCliProjectionFromEngineWithNative({
      metadataCenterSnapshot: record.metadataCenterSnapshot ?? null,
      execution:
        record.engineResult && typeof record.engineResult === 'object' && !Array.isArray(record.engineResult)
          ? (record.engineResult as Record<string, unknown>).execution ?? null
          : null,
      metadataWritePlan:
        record.engineResult && typeof record.engineResult === 'object' && !Array.isArray(record.engineResult)
          ? (record.engineResult as Record<string, unknown>).metadataWritePlan ?? null
          : null,
      requestId: record.requestId ?? null
    });
    return assertNativeObject(
      'resolveServertoolEnginePostflightPayloadWithNative.projection',
      projection
    ).chatResponse;
  }
  throw Object.assign(new Error('[servertool] unexpected postflight payload source'), {
    code: 'SERVERTOOL_RUNTIME_ACTION_INVALID',
    details: {
      requestId: record.requestId ?? null,
      finalPayloadSource: runtimeAction.finalPayloadSource
    }
  });
}

// servertool-core bridge: planAutoHookRuntimeAttemptWithNative
export function planAutoHookRuntimeAttemptWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planAutoHookRuntimeAttemptJson', [input]);
}

// servertool-core bridge: resolveAutoHookRuntimeAttemptDecisionWithNative
export function resolveAutoHookRuntimeAttemptDecisionWithNative(input: unknown): unknown {
  const plan = assertNativeObject(
    'resolveAutoHookRuntimeAttemptDecisionWithNative',
    planAutoHookRuntimeAttemptWithNative(input)
  );
  if (plan.action === 'return_result') {
    return {
      traceEvent: plan.traceEvent,
      returnResult: true,
      continueQueue: false,
      rethrowError: false
    };
  }
  if (plan.action === 'continue_queue') {
    return {
      traceEvent: plan.traceEvent,
      returnResult: false,
      continueQueue: true,
      rethrowError: false
    };
  }
  if (plan.action === 'rethrow_error') {
    return {
      traceEvent: plan.traceEvent,
      returnResult: false,
      continueQueue: false,
      rethrowError: true,
      ...(typeof plan.errorMessage === 'string' ? { errorMessage: plan.errorMessage } : {})
    };
  }
  throw new Error('[servertool] invalid auto-hook attempt action');
}

// servertool-core bridge: planAutoHookCallerFinalizationWithNative
export function planAutoHookCallerFinalizationWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planAutoHookCallerFinalizationJson', [input]);
}

// servertool-core bridge: resolveAutoHookCallerFinalizationDecisionWithNative
export function resolveAutoHookCallerFinalizationDecisionWithNative(input: unknown): unknown {
  const plan = assertNativeObject(
    'resolveAutoHookCallerFinalizationDecisionWithNative',
    planAutoHookCallerFinalizationWithNative(input)
  );
  if (plan.action === 'return_result') {
    return {
      returnResult: true,
      continueNextQueue: false,
      returnNull: false,
      result: plan.result
    };
  }
  if (plan.action === 'continue_next_queue') {
    return {
      returnResult: false,
      continueNextQueue: true,
      returnNull: false
    };
  }
  if (plan.action === 'return_null') {
    return {
      returnResult: false,
      continueNextQueue: false,
      returnNull: true
    };
  }
  throw new Error('[servertool] invalid auto-hook caller finalization action');
}

// servertool-core bridge: planAutoHookCallerResultProjectionWithNative
export function planAutoHookCallerResultProjectionWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planAutoHookCallerResultProjectionJson', [input]);
}

// servertool-core bridge: planServertoolExecutionBranchWithNative
export function planServertoolExecutionBranchWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolExecutionBranchJson', [input]);
}

// servertool-core bridge: resolveServertoolPreExecutionBranchDecisionWithNative
export function resolveServertoolPreExecutionBranchDecisionWithNative(input: unknown): unknown {
  const branchPlan = planServertoolExecutionBranchWithNative({
    executableToolCalls: assertNativeObject(
      'resolveServertoolPreExecutionBranchDecisionWithNative',
      input
    ).executableToolCalls,
    executedToolCallsLen: 0
  });
  const application = assertNativeObject(
    'resolveServertoolPreExecutionBranchDecisionWithNative.application',
    invokeRouterHotpathJsonCapability('planServertoolExecutionBranchApplicationJson', [{
      branchPlan,
      phase: 'pre_execution'
    }])
  );
  if (application.projectClientExecCli) {
    return {
      projectClientExecCli: true,
      continueResponseStage: false,
      projectedToolCall: application.projectedToolCall
    };
  }
  return {
    projectClientExecCli: false,
    continueResponseStage: true
  };
}

// servertool-core bridge: resolveServertoolPostExecutionBranchDecisionWithNative
export function resolveServertoolPostExecutionBranchDecisionWithNative(input: unknown): unknown {
  const branchPlan = planServertoolExecutionBranchWithNative(input);
  const application = assertNativeObject(
    'resolveServertoolPostExecutionBranchDecisionWithNative.application',
    invokeRouterHotpathJsonCapability('planServertoolExecutionBranchApplicationJson', [{
      branchPlan,
      phase: 'post_execution'
    }])
  );
  if (application.resolveExecutionOutcome) {
    return {
      resolveExecutionOutcome: true,
      continueResponseStage: false
    };
  }
  return {
    resolveExecutionOutcome: false,
    continueResponseStage: true
  };
}

// servertool-core bridge: planServertoolEnginePreflightWithNative
export function planServertoolEnginePreflightWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolEnginePreflightJson', [input]);
}

// servertool-core bridge: resolveServertoolEnginePreflightDecisionWithNative
export function resolveServertoolEnginePreflightDecisionWithNative(input: unknown): unknown {
  const record = assertNativeObject('resolveServertoolEnginePreflightDecisionWithNative', input);
  const preflightAction = assertNativeObject(
    'resolveServertoolEnginePreflightDecisionWithNative.preflightAction',
    record.preflightAction
  );
  if (preflightAction.action === 'return_original_chat') {
    return { result: preflightAction.result, shouldRunSideEffects: false };
  }
  if (
    preflightAction.action === 'return_original_chat_direct_passthrough' ||
    preflightAction.action === 'continue_to_engine'
  ) {
    return { result: preflightAction.result, shouldRunSideEffects: true };
  }
  throw new Error('[servertool] invalid engine preflight action');
}

// servertool-core bridge: planServertoolEngineOrchestrationPreflightActionWithNative
export function planServertoolEngineOrchestrationPreflightActionWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolEngineOrchestrationPreflightActionJson', [input]);
}

// servertool-core bridge: resolveServertoolEngineOrchestrationPreflightDecisionWithNative
export function resolveServertoolEngineOrchestrationPreflightDecisionWithNative(input: unknown): unknown {
  const record = assertNativeObject('resolveServertoolEngineOrchestrationPreflightDecisionWithNative', input);
  const preflight = assertNativeObject(
    'resolveServertoolEngineOrchestrationPreflightDecisionWithNative.preflight',
    record.preflight
  );
  const actionPlan = planServertoolEngineOrchestrationPreflightActionWithNative({
    preflightKind: preflight.kind
  });
  return invokeRouterHotpathJsonCapability('planServertoolEngineOrchestrationPreflightApplicationJson', [{
    actionPlan,
    preflightKind: preflight.kind,
    ...(preflight.chat !== undefined ? { chat: preflight.chat } : {}),
    ...(preflight.stopSignal !== undefined ? { stopSignal: preflight.stopSignal } : {})
  }]);
}

// servertool-core bridge: planServertoolEngineRuntimeActionWithNative
export function planServertoolEngineRuntimeActionWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolEngineRuntimeActionJson', [input]);
}

// servertool-core bridge: runStoplessBuiltinHandlerForRuntimeWithNative
export function runStoplessBuiltinHandlerForRuntimeWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('runStoplessBuiltinHandlerForRuntimeJson', [input]);
}

// servertool-core bridge: planServertoolEngineTriggerObservationWithNative
export function planServertoolEngineTriggerObservationWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolEngineTriggerObservationJson', [input]);
}

// servertool-core bridge: planServertoolEngineSkipWithNative
export function planServertoolEngineSkipWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolEngineSkipJson', [input]);
}

// servertool-core bridge: resolveServertoolEngineSkipDecisionWithNative
export function resolveServertoolEngineSkipDecisionWithNative(input: unknown): unknown {
  const skipPlan = planServertoolEngineSkipWithNative(input);
  const application = assertNativeObject(
    'resolveServertoolEngineSkipDecisionWithNative.application',
    invokeRouterHotpathJsonCapability('planServertoolEngineSkipApplicationJson', [{ skipPlan }])
  );
  if (application.returnSkipped) {
    return {
      returnSkipped: true,
      continueMatchedFlow: false,
      skipReason: application.skipReason,
      triggerResult: application.triggerResult,
      shellResult: application.shellResult
    };
  }
  return {
    returnSkipped: false,
    continueMatchedFlow: true
  };
}

// servertool-core bridge: planServertoolExecutionOutcomeMaterializationWithNative
export function planServertoolExecutionOutcomeMaterializationWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolExecutionOutcomeMaterializationJson', [input]);
}

// servertool-core bridge: createServertoolProviderProtocolErrorFromPlanWithNative
export function createServertoolProviderProtocolErrorFromPlanWithNative(input: unknown): unknown {
  const plan = assertNativeObject('createServertoolProviderProtocolErrorFromPlanWithNative', input);
  const error = new Error(
    typeof plan.message === 'string' ? plan.message : '[servertool] provider protocol error'
  ) as Error & {
    code?: unknown;
    category?: unknown;
    details?: unknown;
    status?: unknown;
  };
  error.code = plan.code;
  error.category = plan.category;
  error.details = plan.details;
  error.status = plan.status;
  return error;
}

// servertool-core bridge: materializeNativeToolCallExecutionOutcomeWithNative
export function materializeNativeToolCallExecutionOutcomeWithNative(input: unknown): unknown {
  const args = assertNativeObject('materializeNativeToolCallExecutionOutcomeWithNative', input);
  const executionState = assertNativeObject(
    'materializeNativeToolCallExecutionOutcomeWithNative.executionState',
    args.executionState
  );
  const outcomePlan = planServertoolOutcomeWithNative(
    buildServertoolOutcomePlanInputWithNative({
      toolCalls: args.toolCalls,
      executionState,
      adapterContext:
        args.options && typeof args.options === 'object' && !Array.isArray(args.options)
          ? (args.options as Record<string, unknown>).adapterContext
          : undefined,
      baseForExecution: args.baseForExecution
    })
  ) as Record<string, unknown>;
  const executedToolCalls = Array.isArray(executionState.executedToolCalls)
    ? executionState.executedToolCalls
    : [];
  const materializationPlan = assertNativeObject(
    'materializeNativeToolCallExecutionOutcomeWithNative.materializationPlan',
    planServertoolExecutionOutcomeMaterializationWithNative({
      requestId:
        args.options && typeof args.options === 'object' && !Array.isArray(args.options)
          ? (args.options as Record<string, unknown>).requestId
          : undefined,
      outcomeMode: outcomePlan.outcomeMode,
      requiresPendingInjection: outcomePlan.requiresPendingInjection,
      hasLastExecution: executionState.lastExecution != null,
      executedToolCallsLen: executedToolCalls.length,
      lastExecution: executionState.lastExecution,
      flowId: outcomePlan.flowId
    })
  );
  if (materializationPlan.action === 'throw_dispatch_error') {
    throw createServertoolProviderProtocolErrorFromPlanWithNative(materializationPlan.errorPlan);
  }
  if (materializationPlan.action === 'return_tool_flow') {
    return {
      mode: materializationPlan.resultMode,
      finalChatResponse: args.baseForExecution,
      execution: {
        flowId: materializationPlan.executionFlowId
      }
    };
  }
  throw new Error('[servertool] invalid execution outcome materialization action');
}

// servertool-core bridge: planServertoolExecutionOutcomeRuntimeActionWithNative
export function planServertoolExecutionOutcomeRuntimeActionWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolExecutionOutcomeRuntimeActionJson', [input]);
}

// servertool-core bridge: planServertoolExecutionLoopRuntimeActionWithNative
export function planServertoolExecutionLoopRuntimeActionWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolExecutionLoopRuntimeActionJson', [input]);
}

// servertool-core bridge: resolveServertoolExecutionLoopInitialDecisionWithNative
export function resolveServertoolExecutionLoopInitialDecisionWithNative(input: unknown): unknown {
  const plan = assertNativeObject(
    'resolveServertoolExecutionLoopInitialDecisionWithNative',
    planServertoolExecutionLoopRuntimeActionWithNative({
      ...(input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}),
      hasMaterializedResult: false,
      hasHandlerError: false
    })
  );
  if (plan.action === 'skip_non_tool_call_handler') {
    return { action: 'skip_non_tool_call_handler' };
  }
  if (plan.action === 'throw_dispatch_spec_mismatch') {
    return { action: 'throw_dispatch_spec_mismatch' };
  }
  if (plan.action === 'continue_without_effect') {
    return { action: 'continue_to_handler' };
  }
  throw new Error('[servertool] invalid execution loop initial action');
}

// servertool-core bridge: resolveServertoolExecutionLoopResultDecisionWithNative
export function resolveServertoolExecutionLoopResultDecisionWithNative(input: unknown): unknown {
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const plan = assertNativeObject(
    'resolveServertoolExecutionLoopResultDecisionWithNative',
    planServertoolExecutionLoopRuntimeActionWithNative({
      hasHandlerEntry: true,
      triggerMode: record.triggerMode,
      hasMaterializedResult: record.hasMaterializedResult,
      hasHandlerError: record.hasHandlerError
    })
  );
  if (plan.action === 'apply_materialized_result') {
    return { action: 'apply_materialized_result' };
  }
  if (plan.action === 'apply_handler_error_tool_output') {
    return { action: 'apply_handler_error_tool_output' };
  }
  if (plan.action === 'continue_without_effect') {
    return { action: 'continue_without_effect' };
  }
  throw new Error('[servertool] invalid execution loop result action');
}

// servertool-core bridge: applyServertoolExecutionLoopInitialDecisionWithNative
export function applyServertoolExecutionLoopInitialDecisionWithNative<T>(
  decision: unknown,
  application: {
    skipNonToolCallHandler: () => T;
    throwDispatchSpecMismatch: () => T;
    continueToHandler: () => T;
  }
): T {
  const record = assertNativeObject('applyServertoolExecutionLoopInitialDecisionWithNative', decision);
  if (record.action === 'skip_non_tool_call_handler') {
    return application.skipNonToolCallHandler();
  }
  if (record.action === 'throw_dispatch_spec_mismatch') {
    return application.throwDispatchSpecMismatch();
  }
  if (record.action === 'continue_to_handler') {
    return application.continueToHandler();
  }
  throw new Error('[servertool] invalid execution loop initial action');
}

// servertool-core bridge: applyServertoolExecutionLoopResultDecisionWithNative
export function applyServertoolExecutionLoopResultDecisionWithNative<T>(
  decision: unknown,
  application: {
    applyMaterializedResult: () => T;
    applyHandlerErrorToolOutput: () => T;
    continueWithoutEffect: () => T;
  }
): T {
  const record = assertNativeObject('applyServertoolExecutionLoopResultDecisionWithNative', decision);
  if (record.action === 'apply_materialized_result') {
    return application.applyMaterializedResult();
  }
  if (record.action === 'apply_handler_error_tool_output') {
    return application.applyHandlerErrorToolOutput();
  }
  if (record.action === 'continue_without_effect') {
    return application.continueWithoutEffect();
  }
  throw new Error('[servertool] invalid execution loop result action');
}

// servertool-core bridge: planServertoolExecutionLoopEffectWithNative
export function planServertoolExecutionLoopEffectWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolExecutionLoopEffectJson', [input]);
}

// servertool-core bridge: planServertoolExecutionLoopEffectWithNative

// servertool-core bridge: planServertoolExecutionLoopEffectWithNative

// servertool-core bridge: planServertoolHandlerErrorExecutionLoopEffectWithNative
export function planServertoolHandlerErrorExecutionLoopEffectWithNative(input: unknown): unknown {
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  return planServertoolExecutionLoopEffectWithNative({
    mode: 'handler_error',
    toolCall: record.toolCall,
    handlerErrorMessage: record.handlerErrorMessage
  });
}

// servertool-core bridge: planServertoolResponseStageRuntimeActionWithNative
export function planServertoolResponseStageRuntimeActionWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolResponseStageRuntimeActionJson', [input]);
}

// servertool-core bridge: resolveServertoolResponseStagePrepassInitialDecisionWithNative
export function resolveServertoolResponseStagePrepassInitialDecisionWithNative(input: unknown): unknown {
  const record = assertNativeObject('resolveServertoolResponseStagePrepassInitialDecisionWithNative', input);
  const action = assertNativeObject(
    'resolveServertoolResponseStagePrepassInitialDecisionWithNative.action',
    planServertoolResponseStageRuntimeActionWithNative({
      responseStageGatePlan: record.responseStageGatePlan,
      baseObject: record.baseObject,
      autoHookEvaluated: false,
      hasAutoHookResult: false
    })
  );
  if (action.action === 'run_auto_hooks') {
    return { action: 'run_auto_hooks' };
  }
  if (action.action === 'return_passthrough_no_auto_hook_result') {
    return {
      action: 'return_prepass_result',
      result: action.prepassResult
    };
  }
  throw new Error('[servertool] invalid response-stage prepass action');
}

// servertool-core bridge: resolveServertoolResponseStagePrepassInitialApplicationWithNative
export function resolveServertoolResponseStagePrepassInitialApplicationWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolResponseStagePrepassInitialApplicationJson', [input]);
}

// servertool-core bridge: resolveServertoolResponseStageOrchestrationGateApplicationWithNative
export function resolveServertoolResponseStageOrchestrationGateApplicationWithNative(input: unknown): unknown {
  const record = assertNativeObject('resolveServertoolResponseStageOrchestrationGateApplicationWithNative', input);
  const runtimeAction = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: record.responseStageGatePlan,
    baseObject: record.baseObject,
    autoHookEvaluated: false,
    hasAutoHookResult: false
  });
  return invokeRouterHotpathJsonCapability('planServertoolResponseStageOrchestrationGateApplicationJson', [{
    runtimeAction
  }]);
}

// servertool-core bridge: resolveServertoolResponseStagePrepassAfterAutoHookWithNative
export function resolveServertoolResponseStagePrepassAfterAutoHookWithNative(input: unknown): unknown {
  const record = assertNativeObject('resolveServertoolResponseStagePrepassAfterAutoHookWithNative', input);
  const autoHookResult = assertNativeObject(
    'resolveServertoolResponseStagePrepassAfterAutoHookWithNative.responseStageAutoHookResult',
    record.responseStageAutoHookResult
  );
  const action = assertNativeObject(
    'resolveServertoolResponseStagePrepassAfterAutoHookWithNative.action',
    planServertoolResponseStageRuntimeActionWithNative({
      responseStageGatePlan: record.responseStageGatePlan,
      baseObject: record.baseObject,
      autoHookEvaluated: true,
      hasAutoHookResult: autoHookResult.action === 'return_auto_hook_result',
      autoHookResult: autoHookResult.action === 'return_auto_hook_result' ? autoHookResult.result : null
    })
  );
  if (
    action.action === 'return_auto_hook_result' ||
    action.action === 'return_passthrough_bypass' ||
    action.action === 'return_passthrough_no_auto_hook_result'
  ) {
    return {
      action: 'return_prepass_result',
      result: action.prepassResult
    };
  }
  throw new Error('[servertool] invalid response-stage prepass auto-hook action');
}

// servertool-core bridge: finalizeServertoolResponseStageWithNative
export function finalizeServertoolResponseStageWithNative(input: unknown): unknown {
  const record = assertNativeObject('finalizeServertoolResponseStageWithNative', input);
  const autoHookResult = assertNativeObject(
    'finalizeServertoolResponseStageWithNative.responseStageAutoHookResult',
    record.responseStageAutoHookResult
  );
  const action = assertNativeObject(
    'finalizeServertoolResponseStageWithNative.action',
    planServertoolResponseStageRuntimeActionWithNative({
      responseStageGatePlan: record.responseStageGatePlan,
      baseObject: record.baseObject,
      autoHookEvaluated: true,
      hasAutoHookResult: autoHookResult.action === 'return_auto_hook_result',
      autoHookResult: autoHookResult.action === 'return_auto_hook_result' ? autoHookResult.result : null
    })
  );
  if (
    action.action === 'return_auto_hook_result' ||
    action.action === 'return_passthrough_bypass' ||
    action.action === 'return_passthrough_no_auto_hook_result'
  ) {
    return action.finalizeResult;
  }
  throw new Error('[servertool] invalid response-stage finalize action');
}

// servertool-core bridge: resolveServertoolResponseStageAutoHookPreDecisionWithNative
export function resolveServertoolResponseStageAutoHookPreDecisionWithNative(input: unknown): unknown {
  const record = assertNativeObject('resolveServertoolResponseStageAutoHookPreDecisionWithNative', input);
  const action = assertNativeObject(
    'resolveServertoolResponseStageAutoHookPreDecisionWithNative.action',
    planServertoolResponseStageRuntimeActionWithNative({
      responseStageGatePlan: record.responseStageGatePlan,
      baseObject: record.baseObject,
      autoHookEvaluated: false,
      hasAutoHookResult: false
    })
  );
  if (action.action === 'return_passthrough_bypass') {
    return {
      action: 'return_pass_result',
      result: action.passResult
    };
  }
  if (action.action === 'run_auto_hooks') {
    return { action: 'run_auto_hooks' };
  }
  throw new Error('[servertool] invalid response-stage pre auto-hook action');
}

// servertool-core bridge: resolveServertoolResponseStageAutoHookPreApplicationWithNative
export function resolveServertoolResponseStageAutoHookPreApplicationWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolResponseStageAutoHookPreApplicationJson', [input]);
}

// servertool-core bridge: resolveServertoolResponseStageAutoHookPostDecisionWithNative
export function resolveServertoolResponseStageAutoHookPostDecisionWithNative(input: unknown): unknown {
  const record = assertNativeObject('resolveServertoolResponseStageAutoHookPostDecisionWithNative', input);
  const action = assertNativeObject(
    'resolveServertoolResponseStageAutoHookPostDecisionWithNative.action',
    planServertoolResponseStageRuntimeActionWithNative({
      responseStageGatePlan: record.responseStageGatePlan,
      baseObject: record.baseObject,
      autoHookEvaluated: true,
      hasAutoHookResult: record.autoHookResult != null,
      autoHookResult: record.autoHookResult
    })
  );
  if (action.action === 'return_required_response_hook_empty') {
    return {
      action: 'throw_required_response_hook_empty',
      errorPlan: planServertoolRequiredResponseHookEmptyErrorWithNative({
        requestId: record.requestId,
        responseHookName: action.responseHookName
      })
    };
  }
  if (
    action.action === 'return_auto_hook_result' ||
    action.action === 'return_passthrough_no_auto_hook_result'
  ) {
    return {
      action: 'return_pass_result',
      result: action.passResult
    };
  }
  throw new Error('[servertool] invalid response-stage post auto-hook action');
}

// servertool-core bridge: resolveServertoolResponseStageAutoHookPostApplicationWithNative
export function resolveServertoolResponseStageAutoHookPostApplicationWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolResponseStageAutoHookPostApplicationJson', [input]);
}

// servertool-core bridge: materializeServertoolResponseStageOrchestrationOutputWithNative
export function materializeServertoolResponseStageOrchestrationOutputWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('materializeServertoolResponseStageOrchestrationOutputJson', [input]);
}

// servertool-core bridge: extractServertoolResponseStageOrchestrationShellResultWithNative
export function extractServertoolResponseStageOrchestrationShellResultWithNative(input: unknown): unknown {
  return assertNativeObject('extractServertoolResponseStageOrchestrationShellResultWithNative', input).shellResult;
}

// servertool-core bridge: planServertoolEntryPreflightWithNative
export function planServertoolEntryPreflightWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolEntryPreflightJson', [input]);
}

// servertool-core bridge: readServertoolEntryBaseObjectWithNative
export function readServertoolEntryBaseObjectWithNative(input: unknown): unknown {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  return input;
}

// servertool-core bridge: resolveServertoolEntryPreflightWithNative
export function resolveServertoolEntryPreflightWithNative(input: unknown): unknown {
  const record = assertNativeObject('resolveServertoolEntryPreflightWithNative', input);
  const plan = assertNativeObject(
    'resolveServertoolEntryPreflightWithNative.plan',
    planServertoolEntryPreflightWithNative({
      hasBaseObject: record.baseObject != null,
      adapterClientDisconnected: record.adapterClientDisconnected,
      chatResponse: record.chatResponse
    })
  );
  if (plan.action === 'return_passthrough_non_object_chat') {
    return { action: 'return_result', result: plan.passthroughResult };
  }
  if (plan.action === 'throw_client_disconnected') {
    return {
      action: 'throw_error',
      errorPlan: planServertoolClientDisconnectedErrorWithNative({
        requestId: record.requestId
      })
    };
  }
  if (plan.action === 'continue_to_tool_flow') {
    if (record.baseObject == null) {
      throw new Error('[servertool] invalid entry preflight continue without base object');
    }
    return { action: 'continue', baseObject: record.baseObject };
  }
  throw new Error('[servertool] invalid entry preflight action');
}

// servertool-core bridge: resolveServertoolEntryPreflightApplicationWithNative
export function resolveServertoolEntryPreflightApplicationWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolEntryPreflightApplicationJson', [input]);
}

// servertool-core bridge: resolveServertoolRunEngineEntryPreflightDecisionWithNative
export function resolveServertoolRunEngineEntryPreflightDecisionWithNative(input: unknown): unknown {
  const record = assertNativeObject('resolveServertoolRunEngineEntryPreflightDecisionWithNative', input);
  const entryPreflight = assertNativeObject(
    'resolveServertoolRunEngineEntryPreflightDecisionWithNative.entryPreflight',
    record.entryPreflight
  );
  if (entryPreflight.action === 'return_result') {
    return { action: 'return_result', result: entryPreflight.result };
  }
  if (entryPreflight.action === 'continue') {
    return { action: 'continue', baseObject: entryPreflight.baseObject };
  }
  throw new Error('[servertool] invalid entry preflight result action');
}

// servertool-core bridge: resolveServertoolRunEngineEntryPreflightApplicationWithNative
export function resolveServertoolRunEngineEntryPreflightApplicationWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolRunEngineEntryPreflightApplicationJson', [input]);
}

// servertool-core bridge: planServertoolEntryContextWithNative
export function planServertoolEntryContextWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolEntryContextJson', [input]);
}

// servertool-core bridge: planServertoolEnginePrepassActionWithNative
export function planServertoolEnginePrepassActionWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolEnginePrepassActionJson', [input]);
}

// servertool-core bridge: resolveServertoolRunEnginePrepassDecisionWithNative
export function resolveServertoolRunEnginePrepassDecisionWithNative(input: unknown): unknown {
  const action = assertNativeObject(
    'resolveServertoolRunEnginePrepassDecisionWithNative.action',
    planServertoolEnginePrepassActionWithNative(input)
  );
  if (action.action === 'return_prepass_result') {
    return {
      action: 'return_result',
      result: action.result
    };
  }
  if (action.action === 'continue_to_execution') {
    return { action: 'continue_to_execution' };
  }
  throw new Error('[servertool] invalid engine prepass action');
}

// servertool-core bridge: resolveServertoolRunEnginePrepassApplicationWithNative
export function resolveServertoolRunEnginePrepassApplicationWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolRunEnginePrepassApplicationJson', [input]);
}

// servertool-core bridge: planServertoolRegistryAutoHookDescriptorsWithNative
export function planServertoolRegistryAutoHookDescriptorsWithNative(input: unknown): unknown {
  const record = assertNativeObject('planServertoolRegistryAutoHookDescriptorsWithNative', input);
  if (!Array.isArray(record.hooks)) {
    throw new Error('[servertool] planServertoolRegistryAutoHookDescriptorsWithNative requires hooks array');
  }
  return invokeRouterHotpathJsonCapability('planServertoolRegistryAutoHookDescriptorsJson', [record.hooks]);
}

// servertool-core bridge: planServertoolRegistryBuiltinAutoHookEntriesWithNative
export function planServertoolRegistryBuiltinAutoHookEntriesWithNative(input: unknown): unknown {
  const record = assertNativeObject('planServertoolRegistryBuiltinAutoHookEntriesWithNative', input);
  const hooks = Array.isArray(record.hooks) ? record.hooks : [];
  const descriptors = planServertoolRegistryAutoHookDescriptorsWithNative({
    hooks: hooks.map((hook) => {
      const source = assertNativeObject('planServertoolRegistryBuiltinAutoHookEntriesWithNative.hook', hook);
      return {
        id: source.id,
        phase: source.phase,
        priority: source.priority,
        order: source.order
      };
    })
  }) as unknown[];
  return descriptors.map((descriptor) => {
    const desc = assertNativeObject('planServertoolRegistryBuiltinAutoHookEntriesWithNative.descriptor', descriptor);
    const sourceIndex = typeof desc.sourceIndex === 'number' ? desc.sourceIndex : -1;
    const source = hooks[sourceIndex];
    const sourceRecord = assertNativeObject('planServertoolRegistryBuiltinAutoHookEntriesWithNative.source', source);
    return {
      id: desc.id,
      phase: desc.phase,
      priority: desc.priority,
      order: desc.order,
      registration: sourceRecord.registration,
      execution: sourceRecord.execution
    };
  });
}

// servertool-core bridge: planServertoolRegistryLookupActionWithNative
export function planServertoolRegistryLookupActionWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolRegistryLookupActionJson', [input]);
}

// servertool-core bridge: planServertoolRegistryProjectionWithNative
export function planServertoolRegistryProjectionWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolRegistryProjectionJson', [input]);
}

// servertool-core bridge: planServertoolHandlerMaterializationWithNative
export function planServertoolHandlerMaterializationWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolHandlerMaterializationJson', [input]);
}

// servertool-core bridge: planServertoolHandlerMaterializationForPlannedWithNative
export function planServertoolHandlerMaterializationForPlannedWithNative(
  planned: unknown,
  requestId: string
): unknown {
  const record =
    planned && typeof planned === 'object' && !Array.isArray(planned)
      ? planned as Record<string, unknown>
      : {};
  const execution =
    record.execution && typeof record.execution === 'object' && !Array.isArray(record.execution)
      ? record.execution as Record<string, unknown>
      : undefined;
  return planServertoolHandlerMaterializationWithNative({
    requestId,
    hasFinalizeFunction: typeof record.finalize === 'function',
    hasChatResponseObject: Boolean(record.chatResponse && typeof record.chatResponse === 'object' && !Array.isArray(record.chatResponse)),
    hasExecutionObject: Boolean(record.execution && typeof record.execution === 'object' && !Array.isArray(record.execution)),
    hasExecutionFlowId: typeof execution?.flowId === 'string',
    hasPlanMarkers: typeof record.flowId === 'string' || record.finalize !== undefined
  });
}

// servertool-core bridge: materializeServertoolHandlerResultWithNative
export function materializeServertoolHandlerResultWithNative(
  planned: unknown,
  requestId: string
): unknown {
  const plan = assertNativeObject(
    'planServertoolHandlerMaterializationForPlannedWithNative',
    planServertoolHandlerMaterializationForPlannedWithNative(planned, requestId)
  );
  if (plan.action === 'throw_handler_error') {
    throw createServertoolProviderProtocolErrorFromPlanWithNative(plan.errorPlan);
  }
  if (plan.action !== 'return_handler_result') {
    throw new Error('[servertool] invalid handler materialization plan result');
  }
  const record = assertNativeObject('materializeServertoolHandlerResultWithNative', planned);
  const execution = assertNativeObject('materializeServertoolHandlerResultWithNative.execution', record.execution);
  const result: Record<string, unknown> = {
    chatResponse: record.chatResponse,
    execution
  };
  if (record.metadataWritePlan != null) {
    result.metadataWritePlan = record.metadataWritePlan;
  }
  return result;
}

// servertool-core bridge: finalizeServertoolHandlerPlanWithNative
export async function finalizeServertoolHandlerPlanWithNative(
  planned: unknown,
  requestId: string
): Promise<unknown> {
  const plan = assertNativeObject(
    'planServertoolHandlerMaterializationForPlannedWithNative',
    planServertoolHandlerMaterializationForPlannedWithNative(planned, requestId)
  );
  if (plan.action === 'throw_handler_error') {
    throw createServertoolProviderProtocolErrorFromPlanWithNative(plan.errorPlan);
  }
  if (plan.action !== 'finalize_without_backend') {
    throw new Error('[servertool] invalid handler materialization plan without finalize');
  }
  const record = assertNativeObject('finalizeServertoolHandlerPlanWithNative', planned);
  if (typeof record.finalize !== 'function') {
    throw new Error('[servertool] invalid handler materialization plan without finalize');
  }
  return await (record.finalize as () => Promise<unknown>)();
}

// servertool-core bridge: materializeServertoolPlannedResultWithNative
export async function materializeServertoolPlannedResultWithNative(
  planned: unknown,
  options: { requestId: string }
): Promise<unknown> {
  const actionPlan = assertNativeObject(
    'planServertoolHandlerMaterializationForPlannedWithNative',
    planServertoolHandlerMaterializationForPlannedWithNative(planned, options.requestId)
  );
  switch (actionPlan.action) {
    case 'finalize_without_backend':
      return await finalizeServertoolHandlerPlanWithNative(planned, options.requestId);
    case 'throw_handler_error':
      throw createServertoolProviderProtocolErrorFromPlanWithNative(actionPlan.errorPlan);
    case 'return_handler_result':
      return materializeServertoolHandlerResultWithNative(planned, options.requestId);
    default:
      throw new Error('[servertool] invalid handler materialization action');
  }
}

// servertool-core bridge: planEngineSelectionStartWithNative
export function planEngineSelectionStartWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planEngineSelectionStartJson', [input]);
}

// servertool-core bridge: planEngineSelectionAfterRunWithNative
export function planEngineSelectionAfterRunWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planEngineSelectionAfterRunJson', [input]);
}

// servertool-core bridge: resolveEngineSelectionAfterRunWithNative
export function resolveEngineSelectionAfterRunWithNative(input: unknown): unknown {
  const plan = assertNativeObject(
    'resolveEngineSelectionAfterRunWithNative',
    planEngineSelectionAfterRunWithNative(input)
  );
  if (plan.action === 'rerun_excluding_primary_hooks') {
    return { rerunOverrides: plan.overrides };
  }
  if (plan.action === 'return_current') {
    return {};
  }
  throw new Error('[servertool] invalid engine selection action');
}

// servertool-core bridge: resolveServertoolTimeoutMsFromEnvCandidatesWithNative
export function resolveServertoolTimeoutMsFromEnvCandidatesWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveServertoolTimeoutMsFromEnvCandidatesJson', [input]);
}

// servertool-core bridge: planServertoolClientDisconnectedErrorWithNative
export function planServertoolClientDisconnectedErrorWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolClientDisconnectedErrorJson', [input]);
}

// servertool-core bridge: planServertoolTimeoutErrorWithNative
export function planServertoolTimeoutErrorWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolTimeoutErrorJson', [input]);
}

// servertool-core bridge: planServertoolStateLoadFailedErrorWithNative
export function planServertoolStateLoadFailedErrorWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolStateLoadFailedErrorJson', [input]);
}

// servertool-core bridge: planServertoolRequiredResponseHookEmptyErrorWithNative
export function planServertoolRequiredResponseHookEmptyErrorWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolRequiredResponseHookEmptyErrorJson', [input]);
}

// servertool-core bridge: planServertoolExecutionDispatchErrorWithNative
export function planServertoolExecutionDispatchErrorWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolExecutionDispatchErrorJson', [input]);
}

// servertool-core bridge: buildServertoolPostflightObservationSummaryWithNative
export function buildServertoolPostflightObservationSummaryWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildServertoolPostflightObservationSummaryJson', [input]);
}

// servertool-core bridge: resolveServertoolEngineMatchHitWithNative
export function resolveServertoolEngineMatchHitWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('resolveServertoolEngineMatchHitJson', [input]);
}

// servertool-core bridge: appendServertoolExecutedRecordWithNative
export function appendServertoolExecutedRecordWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('appendServertoolExecutedRecordJson', [input]);
}

// servertool-core bridge: hasStopMessageAutoCliResultInRequestWithNative
export function hasStopMessageAutoCliResultInRequestWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('hasStopMessageAutoCliResultInRequestJson', [input]);
}

// servertool-core bridge: extractServertoolCliResultRouteHintFromRequestWithNative
export function extractServertoolCliResultRouteHintFromRequestWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('extractServertoolCliResultRouteHintFromRequestJson', [input]);
}


export function planStopMessageAutoHandlerWithNative<TPlan extends Record<string, unknown>>(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planStopMessageAutoHandlerJson', [input]);
}



export function buildStopMessageTerminalVisiblePayloadWithNative<TPayload extends Record<string, unknown>>(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('buildStopMessageTerminalVisiblePayloadJson', [input]);
}

// ── servertool-core semantics bridge: invokeRouterHotpathJsonCapability wrappers ──
// These functions replace the readNativeFunction-based implementations in
// consistent error reporting and native binding discovery.
