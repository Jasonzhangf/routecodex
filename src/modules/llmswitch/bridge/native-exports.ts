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
import { importCoreDist, requireCoreDist, type AnyRecord } from './module-loader.js';
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

type NativeSharedConversionSemantics = {
  mapChatToolsToBridgeWithNative?: (rawTools: unknown) => Array<Record<string, unknown>>;
  injectMcpToolsForChatWithNative?: (tools: unknown[] | undefined, discoveredServers: string[]) => unknown[];
  injectMcpToolsForResponsesWithNative?: (tools: unknown[] | undefined, discoveredServers: string[]) => unknown[];
  normalizeAssistantTextToToolCallsWithNative?: (
    message: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Record<string, unknown>;
  captureReqInboundResponsesContextSnapshotWithNative?: (input: {
    rawRequest: Record<string, unknown>;
    requestId?: string;
    toolCallIdStyle?: unknown;
  }) => Record<string, unknown>;
  planResponsesHandlerEntryWithNative?: (
    payload: unknown,
    entryEndpoint?: string,
    responseIdFromPath?: string
  ) => { mode: 'none' | 'submit_tool_outputs' | 'scope_materialize'; responseId?: string; payload: Record<string, unknown> };
  materializeProviderOwnedSubmitContextWithNative?: (
    payload: unknown
  ) => { payload: Record<string, unknown>; context: { input: unknown[] } } | null;
  planResponsesContinuationRequestActionWithNative?: (input: unknown) => Record<string, unknown>;
  stripResponsesStoredContextInputMediaWithNative?: (
    inputEntries: unknown,
    placeholderText?: string
  ) => { changed: boolean; messages: unknown[] };
};

type NativeServertoolCoreSemantics = Record<string, unknown>;

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

type NativeHubPipelineRespSemantics = {
  buildAnthropicResponseFromChatWithNative?: (
    chatResponse: unknown,
    aliasMap?: Record<string, string>
  ) => Record<string, unknown>;
};

type NativeHubBridgePolicySemantics = {
  sanitizeProviderOutboundPayloadWithNative?: (input: {
    protocol?: string;
    compatibilityProfile?: string;
    payload: Record<string, unknown>;
  }) => Record<string, unknown>;
  hasDeclaredApplyPatchToolWithNative?: (
    payload: unknown
  ) => boolean;
  evaluateResponsesDirectRouteDecisionWithNative?: (input: {
    payload: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    inboundProtocol: string;
    applyPatchMode?: string;
  }) => {
    providerWireValid: boolean;
    requiresHubRelay: boolean;
    reason?: string;
    hasDeclaredApplyPatchTool?: boolean;
  };
};

type NativeRouterHotpathJsonBinding = {
  // -- req_executor_pipeline_attempt batch #1 --
  normalizeExplicitRoutePoolJson?: (inputJson: string) => string;
  mergeObservedRoutePoolChainJson?: (existingJson: string | null, observedJson: string) => string | null;

  // -- hub_pipeline batch #6 --
  resolveEntryProtocolFromEndpointJson?: (entryEndpoint: string) => string;
  captureReqInboundResponsesContextSnapshotJson?: (inputJson: string) => string;

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
  validatePipelineNodeContractBoundaryWithNative?: (
    nodeId: string,
    before: unknown,
    after: unknown
  ) => AnyRecord;
};

let cachedSharedSemantics: NativeSharedConversionSemantics | null | undefined;
let cachedSharedSemanticsSync: NativeSharedConversionSemantics | null | undefined;
let cachedRespSemantics: NativeHubPipelineRespSemantics | null | undefined;
let cachedFailurePolicyModule: NativeFailurePolicyModule | null | undefined;
let cachedHubBridgePolicySemantics: NativeHubBridgePolicySemantics | null | undefined;
let cachedHubBridgePolicySemanticsSync: NativeHubBridgePolicySemantics | null | undefined;
let cachedNativeServertoolCoreSemantics: NativeServertoolCoreSemantics | null | undefined;
let cachedRouterHotpathJsonBindingSync: NativeRouterHotpathJsonBinding | null | undefined;
let cachedHubVrNodeContracts: NativeHubVrNodeContracts | null | undefined;
let sharedBindingsChecked: boolean | undefined;
let respBindingsChecked: boolean | undefined;

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
    cachedFailurePolicyModule = requireCoreDist<NativeFailurePolicyModule>(
      'native/router-hotpath/native-failure-policy'
    );
  } catch {
    try {
      cachedFailurePolicyModule = buildFailurePolicyModuleFromRouterHotpathBinding(
        getRouterHotpathJsonBindingSync()
      );
    } catch {
      cachedFailurePolicyModule = null;
    }
  }
  if (!cachedFailurePolicyModule) {
    throw new Error('[llmswitch-bridge] native-failure-policy not available');
  }
  return cachedFailurePolicyModule;
}

function getHubVrNodeContracts(): NativeHubVrNodeContracts {
  if (cachedHubVrNodeContracts !== undefined) {
    if (!cachedHubVrNodeContracts) {
      throw new Error('[llmswitch-bridge] native-hub-vr-node-contracts not available');
    }
    return cachedHubVrNodeContracts;
  }
  try {
    cachedHubVrNodeContracts = requireCoreDist<NativeHubVrNodeContracts>(
      'native/router-hotpath/native-hub-vr-node-contracts'
    );
  } catch {
    cachedHubVrNodeContracts = null;
  }
  if (!cachedHubVrNodeContracts) {
    throw new Error('[llmswitch-bridge] native-hub-vr-node-contracts not available');
  }
  return cachedHubVrNodeContracts;
}

async function assertSharedBindings(): Promise<void> {
  if (sharedBindingsChecked) {
    return;
  }
  const shared = await getSharedConversionSemantics();
  const missing: string[] = [];
  if (typeof shared.mapChatToolsToBridgeWithNative !== 'function') {
    missing.push('mapChatToolsToBridgeJson');
  }
  if (typeof shared.injectMcpToolsForChatWithNative !== 'function') {
    missing.push('injectMcpToolsForChatJson');
  }
  if (typeof shared.injectMcpToolsForResponsesWithNative !== 'function') {
    missing.push('injectMcpToolsForResponsesJson');
  }
  if (typeof shared.normalizeAssistantTextToToolCallsWithNative !== 'function') {
    missing.push('normalizeAssistantTextToToolCallsJson');
  }
  if (typeof shared.captureReqInboundResponsesContextSnapshotWithNative !== 'function') {
    missing.push('captureReqInboundResponsesContextSnapshotJson');
  }
  if (typeof shared.planResponsesHandlerEntryWithNative !== 'function') {
    missing.push('planResponsesHandlerEntryJson');
  }
  if (typeof shared.materializeProviderOwnedSubmitContextWithNative !== 'function') {
    missing.push('materializeProviderOwnedSubmitContextJson');
  if (typeof shared.planResponsesContinuationRequestActionWithNative !== 'function') {
    missing.push('planResponsesContinuationRequestActionJson');
  }
  }
  if (missing.length > 0) {
    throw new Error(`[llmswitch-bridge] native shared bindings missing: ${missing.join(', ')}`);
  }
  sharedBindingsChecked = true;
}

async function assertRespBindings(): Promise<void> {
  if (respBindingsChecked) {
    return;
  }
  const resp = await getRespSemantics();
  const missing: string[] = [];
  if (typeof resp.buildAnthropicResponseFromChatWithNative !== 'function') {
    missing.push('buildAnthropicResponseFromChatJson');
  }
  if (missing.length > 0) {
    throw new Error(`[llmswitch-bridge] native resp bindings missing: ${missing.join(', ')}`);
  }
  respBindingsChecked = true;
}

async function getSharedConversionSemantics(): Promise<NativeSharedConversionSemantics> {
  if (cachedSharedSemantics !== undefined) {
    if (!cachedSharedSemantics) {
      throw new Error('[llmswitch-bridge] native-shared-conversion-semantics not available');
    }
    return cachedSharedSemantics;
  }
  try {
    cachedSharedSemantics = await importCoreDist<NativeSharedConversionSemantics>(
      'native/router-hotpath/native-shared-conversion-semantics'
    );
  } catch {
    cachedSharedSemantics = null;
  }
  if (!cachedSharedSemantics) {
    throw new Error('[llmswitch-bridge] native-shared-conversion-semantics not available');
  }
  return cachedSharedSemantics;
}

function getSharedConversionSemanticsSync(): NativeSharedConversionSemantics {
  if (cachedSharedSemanticsSync !== undefined) {
    if (!cachedSharedSemanticsSync) {
      throw new Error('[llmswitch-bridge] native-shared-conversion-semantics not available');
    }
    return cachedSharedSemanticsSync;
  }
  try {
    cachedSharedSemanticsSync = requireCoreDist<NativeSharedConversionSemantics>(
      'native/router-hotpath/native-shared-conversion-semantics'
    );
  } catch {
    cachedSharedSemanticsSync = null;
  }
  if (!cachedSharedSemanticsSync) {
    throw new Error('[llmswitch-bridge] native-shared-conversion-semantics not available');
  }
  return cachedSharedSemanticsSync;
}

async function getRespSemantics(): Promise<NativeHubPipelineRespSemantics> {
  if (cachedRespSemantics !== undefined) {
    if (!cachedRespSemantics) {
      throw new Error('[llmswitch-bridge] native-hub-pipeline-resp-semantics not available');
    }
    return cachedRespSemantics;
  }
  try {
    cachedRespSemantics = await importCoreDist<NativeHubPipelineRespSemantics>(
      'native/router-hotpath/native-hub-pipeline-resp-semantics'
    );
  } catch {
    cachedRespSemantics = null;
  }
  if (!cachedRespSemantics) {
    throw new Error('[llmswitch-bridge] native-hub-pipeline-resp-semantics not available');
  }
  return cachedRespSemantics;
}

async function getHubBridgePolicySemantics(): Promise<NativeHubBridgePolicySemantics> {
  if (cachedHubBridgePolicySemantics !== undefined) {
    if (!cachedHubBridgePolicySemantics) {
      throw new Error('[llmswitch-bridge] native-hub-bridge-policy-semantics not available');
    }
    return cachedHubBridgePolicySemantics;
  }
  try {
    cachedHubBridgePolicySemantics = await importCoreDist<NativeHubBridgePolicySemantics>(
      'native/router-hotpath/native-hub-bridge-policy-semantics'
    );
  } catch {
    cachedHubBridgePolicySemantics = null;
  }
  if (!cachedHubBridgePolicySemantics) {
    throw new Error('[llmswitch-bridge] native-hub-bridge-policy-semantics not available');
  }
  return cachedHubBridgePolicySemantics;
}

function getHubBridgePolicySemanticsSync(): NativeHubBridgePolicySemantics {
  if (cachedHubBridgePolicySemanticsSync !== undefined) {
    if (!cachedHubBridgePolicySemanticsSync) {
      throw new Error('[llmswitch-bridge] native-hub-bridge-policy-semantics not available');
    }
    return cachedHubBridgePolicySemanticsSync;
  }
  try {
    cachedHubBridgePolicySemanticsSync = requireCoreDist<NativeHubBridgePolicySemantics>(
      'native/router-hotpath/native-hub-bridge-policy-semantics'
    );
  } catch {
    cachedHubBridgePolicySemanticsSync = null;
  }
  if (!cachedHubBridgePolicySemanticsSync) {
    throw new Error('[llmswitch-bridge] native-hub-bridge-policy-semantics not available');
  }
  return cachedHubBridgePolicySemanticsSync;
}

export function getRouterHotpathJsonBindingSync(): NativeRouterHotpathJsonBinding {
  if (cachedRouterHotpathJsonBindingSync !== undefined) {
    if (!cachedRouterHotpathJsonBindingSync) {
      throw new Error('[llmswitch-bridge] router_hotpath_napi native binding not available');
    }
    return cachedRouterHotpathJsonBindingSync;
  }

  try {
    const packageDir = resolveCorePackageDir('ts');
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

function assertNativeObject(capability: string, value: unknown): AnyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[llmswitch-bridge] ${String(capability)} returned invalid payload`);
  }
  return value as AnyRecord;
}

function getNativeServertoolCoreSemantics(): NativeServertoolCoreSemantics {
  if (cachedNativeServertoolCoreSemantics !== undefined) {
    if (!cachedNativeServertoolCoreSemantics) {
      throw new Error('[llmswitch-bridge] native-servertool-core-semantics not available');
    }
    return cachedNativeServertoolCoreSemantics;
  }
  try {
    const packageDir = resolveCorePackageDir('ts');
    const modulePath = path.join(
      packageDir,
      'dist',
      'native',
      'router-hotpath',
      'native-servertool-core-semantics.js'
    );
    cachedNativeServertoolCoreSemantics = createRequire(path.join(packageDir, 'package.json'))(
      modulePath
    ) as NativeServertoolCoreSemantics;
  } catch {
    cachedNativeServertoolCoreSemantics = null;
  }
  if (!cachedNativeServertoolCoreSemantics) {
    throw new Error('[llmswitch-bridge] native-servertool-core-semantics not available');
  }
  return cachedNativeServertoolCoreSemantics;
}

function invokeNativeServertoolCoreSemanticsExport(name: string, args: unknown[]): unknown {
  const module = getNativeServertoolCoreSemantics();
  const fn = module[name];
  if (typeof fn !== 'function') {
    throw new Error(`[llmswitch-bridge] native-servertool-core-semantics missing ${name}`);
  }
  return (fn as (...callArgs: unknown[]) => unknown)(...args);
}

function getChatProcessNodeResultSemantics(): NativeChatProcessNodeResultSemantics {
  return getRouterHotpathJsonBindingSync() as NativeChatProcessNodeResultSemantics;
}

export async function mapChatToolsToBridgeJson(rawTools: unknown): Promise<AnyRecord[]> {
  await assertSharedBindings();
  const mod = await getSharedConversionSemantics();
  const fn = mod.mapChatToolsToBridgeWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] mapChatToolsToBridgeJson not available');
  }
  return fn(rawTools) as AnyRecord[];
}

export async function injectMcpToolsForChatJson(
  tools: unknown[] | undefined,
  discoveredServers: string[]
): Promise<AnyRecord[]> {
  await assertSharedBindings();
  const mod = await getSharedConversionSemantics();
  const fn = mod.injectMcpToolsForChatWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] injectMcpToolsForChatJson not available');
  }
  return fn(Array.isArray(tools) ? tools : [], Array.isArray(discoveredServers) ? discoveredServers : []) as AnyRecord[];
}

export async function injectMcpToolsForResponsesJson(
  tools: unknown[] | undefined,
  discoveredServers: string[]
): Promise<AnyRecord[]> {
  await assertSharedBindings();
  const mod = await getSharedConversionSemantics();
  const fn = mod.injectMcpToolsForResponsesWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] injectMcpToolsForResponsesJson not available');
  }
  return fn(Array.isArray(tools) ? tools : [], Array.isArray(discoveredServers) ? discoveredServers : []) as AnyRecord[];
}

export async function normalizeAssistantTextToToolCallsJson(
  message: Record<string, unknown>,
  options?: Record<string, unknown>
): Promise<AnyRecord> {
  await assertSharedBindings();
  const mod = await getSharedConversionSemantics();
  const fn = mod.normalizeAssistantTextToToolCallsWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] normalizeAssistantTextToToolCallsJson not available');
  }
  return fn(message, options) as AnyRecord;
}

export function captureReqInboundResponsesContextSnapshotJson(input: {
  rawRequest: Record<string, unknown>;
  requestId?: string;
  toolCallIdStyle?: unknown;
}): AnyRecord {
  const mod = getSharedConversionSemanticsSync();
  const fn = mod.captureReqInboundResponsesContextSnapshotWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] captureReqInboundResponsesContextSnapshotJson not available');
  }
  return fn(input) as AnyRecord;
}

export function stripResponsesStoredContextInputMediaNative(
  inputEntries: unknown,
  placeholderText = '[Image omitted]'
): { changed: boolean; messages: unknown[] } {
  const mod = getSharedConversionSemanticsSync();
  const fn = mod.stripResponsesStoredContextInputMediaWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] stripResponsesStoredContextInputMediaNative not available');
  }
  return fn(inputEntries, placeholderText);
}

export async function captureReqInboundResponsesContextSnapshot(input: {
  rawRequest: Record<string, unknown>;
  requestId?: string;
  toolCallIdStyle?: unknown;
}): Promise<AnyRecord> {
  await assertSharedBindings();
  const mod = await getSharedConversionSemantics();
  const fn = mod.captureReqInboundResponsesContextSnapshotWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] captureReqInboundResponsesContextSnapshotJson not available');
  }
  return fn(input) as AnyRecord;
}

export async function planResponsesHandlerEntry(
  payload: unknown,
  entryEndpoint?: string,
  responseIdFromPath?: string
): Promise<{ mode: 'none' | 'submit_tool_outputs' | 'scope_materialize'; responseId?: string; payload: AnyRecord }> {
  await assertSharedBindings();
  const mod = await getSharedConversionSemantics();
  const fn = mod.planResponsesHandlerEntryWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] planResponsesHandlerEntryJson not available');
  }
  return fn(payload, entryEndpoint, responseIdFromPath) as { mode: 'none' | 'submit_tool_outputs' | 'scope_materialize'; responseId?: string; payload: AnyRecord };
}

export async function materializeProviderOwnedSubmitContext(input: {
  payload: Record<string, unknown>;
}): Promise<{ payload: AnyRecord; context: { input: unknown[] } } | null> {
  await assertSharedBindings();
  const mod = await getSharedConversionSemantics();
  const fn = mod.materializeProviderOwnedSubmitContextWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] materializeProviderOwnedSubmitContextJson not available');
  }
  return fn(input.payload) as { payload: AnyRecord; context: { input: unknown[] } } | null;
}
export async function planResponsesContinuationRequestAction(input: {
  plannedEntryMode: 'none' | 'submit_tool_outputs' | 'scope_materialize';
  entryEndpoint: string;
  responseId?: string;
  previousResponseId?: string;
  continuation?: Record<string, unknown> | null;
}): Promise<AnyRecord> {
  await assertSharedBindings();
  const mod = await getSharedConversionSemantics();
  const fn = mod.planResponsesContinuationRequestActionWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] planResponsesContinuationRequestActionJson not available');
  }
  return fn(input) as AnyRecord;
}


export async function buildAnthropicResponseFromChatJson(
  chatResponse: unknown,
  aliasMap?: Record<string, string>
): Promise<AnyRecord> {
  await assertRespBindings();
  const mod = await getRespSemantics();
  const fn = mod.buildAnthropicResponseFromChatWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] buildAnthropicResponseFromChatJson not available');
  }
  return fn(chatResponse, aliasMap) as AnyRecord;
}

export async function sanitizeProviderOutboundPayload(input: {
  protocol?: string;
  compatibilityProfile?: string;
  enforceLayout?: boolean;
  payload: Record<string, unknown>;
}): Promise<AnyRecord> {
  const mod = await getHubBridgePolicySemantics();
  const fn = mod.sanitizeProviderOutboundPayloadWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] sanitizeProviderOutboundPayloadWithNative not available');
  }
  return fn(input) as AnyRecord;
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

export function describeVirtualRouterContractsNative(): AnyRecord {
  const fn = getHubVrNodeContracts().describeVirtualRouterContractsWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] describeVirtualRouterContractsWithNative not available');
  }
  return fn();
}

export function describeMetaCarrierContractsNative(): AnyRecord {
  const fn = getHubVrNodeContracts().describeMetaCarrierContractsWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] describeMetaCarrierContractsWithNative not available');
  }
  return fn();
}

export function describePipelineContractNative(nodeId: string): AnyRecord {
  const fn = getHubVrNodeContracts().describePipelineContractWithNative;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] describePipelineContractWithNative not available');
  }
  return fn(nodeId);
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
  const raw = fn(payloadJson, requestId);
  return JSON.parse(raw);
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

export function planServertoolNoopOutcomeWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolNoopOutcomeJson', [input]);
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

// Types re-exported from native-router-hotpath-analysis

// === SERVERTOOL CORE BRIDGE WRAPPERS (Phase 4) ===
// 50 wrappers: inline native-only functions from native-servertool-core-semantics.ts

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
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolEnginePostflightPayloadWithNative', [input]);
}

// servertool-core bridge: planAutoHookRuntimeAttemptWithNative
export function planAutoHookRuntimeAttemptWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planAutoHookRuntimeAttemptJson', [input]);
}

// servertool-core bridge: resolveAutoHookRuntimeAttemptDecisionWithNative
export function resolveAutoHookRuntimeAttemptDecisionWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveAutoHookRuntimeAttemptDecisionWithNative', [input]);
}

// servertool-core bridge: planAutoHookCallerFinalizationWithNative
export function planAutoHookCallerFinalizationWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planAutoHookCallerFinalizationJson', [input]);
}

// servertool-core bridge: resolveAutoHookCallerFinalizationDecisionWithNative
export function resolveAutoHookCallerFinalizationDecisionWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveAutoHookCallerFinalizationDecisionWithNative', [input]);
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
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolPreExecutionBranchDecisionWithNative', [input]);
}

// servertool-core bridge: resolveServertoolPostExecutionBranchDecisionWithNative
export function resolveServertoolPostExecutionBranchDecisionWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolPostExecutionBranchDecisionWithNative', [input]);
}

// servertool-core bridge: planServertoolEnginePreflightWithNative
export function planServertoolEnginePreflightWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolEnginePreflightJson', [input]);
}

// servertool-core bridge: resolveServertoolEnginePreflightDecisionWithNative
export function resolveServertoolEnginePreflightDecisionWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolEnginePreflightDecisionWithNative', [input]);
}

// servertool-core bridge: planServertoolEngineOrchestrationPreflightActionWithNative
export function planServertoolEngineOrchestrationPreflightActionWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolEngineOrchestrationPreflightActionJson', [input]);
}

// servertool-core bridge: resolveServertoolEngineOrchestrationPreflightDecisionWithNative
export function resolveServertoolEngineOrchestrationPreflightDecisionWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolEngineOrchestrationPreflightDecisionWithNative', [input]);
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
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolEngineSkipDecisionWithNative', [input]);
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
  return invokeNativeServertoolCoreSemanticsExport('materializeNativeToolCallExecutionOutcomeWithNative', [input]);
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
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolExecutionLoopInitialDecisionWithNative', [input]);
}

// servertool-core bridge: resolveServertoolExecutionLoopResultDecisionWithNative
export function resolveServertoolExecutionLoopResultDecisionWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolExecutionLoopResultDecisionWithNative', [input]);
}

// servertool-core bridge: applyServertoolExecutionLoopInitialDecisionWithNative
export function applyServertoolExecutionLoopInitialDecisionWithNative<T>(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('applyServertoolExecutionLoopInitialDecisionWithNative', [input]);
}

// servertool-core bridge: applyServertoolExecutionLoopResultDecisionWithNative
export function applyServertoolExecutionLoopResultDecisionWithNative<T>(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('applyServertoolExecutionLoopResultDecisionWithNative', [input]);
}

// servertool-core bridge: planServertoolExecutionLoopEffectWithNative
export function planServertoolExecutionLoopEffectWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolExecutionLoopEffectJson', [input]);
}

// servertool-core bridge: planServertoolExecutionLoopEffectWithNative

// servertool-core bridge: planServertoolExecutionLoopEffectWithNative

// servertool-core bridge: planServertoolHandlerErrorExecutionLoopEffectWithNative
export function planServertoolHandlerErrorExecutionLoopEffectWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('planServertoolHandlerErrorExecutionLoopEffectWithNative', [input]);
}

// servertool-core bridge: planServertoolNoopExecutionLoopEffectWithNative
export function planServertoolNoopExecutionLoopEffectWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('planServertoolNoopExecutionLoopEffectWithNative', [input]);
}

// servertool-core bridge: planServertoolResponseStageRuntimeActionWithNative
export function planServertoolResponseStageRuntimeActionWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolResponseStageRuntimeActionJson', [input]);
}

// servertool-core bridge: resolveServertoolResponseStagePrepassInitialDecisionWithNative
export function resolveServertoolResponseStagePrepassInitialDecisionWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolResponseStagePrepassInitialDecisionWithNative', [input]);
}

// servertool-core bridge: resolveServertoolResponseStagePrepassInitialApplicationWithNative
export function resolveServertoolResponseStagePrepassInitialApplicationWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolResponseStagePrepassInitialApplicationWithNative', [input]);
}

// servertool-core bridge: resolveServertoolResponseStageOrchestrationGateApplicationWithNative
export function resolveServertoolResponseStageOrchestrationGateApplicationWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolResponseStageOrchestrationGateApplicationWithNative', [input]);
}

// servertool-core bridge: resolveServertoolResponseStagePrepassAfterAutoHookWithNative
export function resolveServertoolResponseStagePrepassAfterAutoHookWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolResponseStagePrepassAfterAutoHookWithNative', [input]);
}

// servertool-core bridge: finalizeServertoolResponseStageWithNative
export function finalizeServertoolResponseStageWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('finalizeServertoolResponseStageWithNative', [input]);
}

// servertool-core bridge: resolveServertoolResponseStageAutoHookPreDecisionWithNative
export function resolveServertoolResponseStageAutoHookPreDecisionWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolResponseStageAutoHookPreDecisionWithNative', [input]);
}

// servertool-core bridge: resolveServertoolResponseStageAutoHookPreApplicationWithNative
export function resolveServertoolResponseStageAutoHookPreApplicationWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolResponseStageAutoHookPreApplicationWithNative', [input]);
}

// servertool-core bridge: resolveServertoolResponseStageAutoHookPostDecisionWithNative
export function resolveServertoolResponseStageAutoHookPostDecisionWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolResponseStageAutoHookPostDecisionWithNative', [input]);
}

// servertool-core bridge: resolveServertoolResponseStageAutoHookPostApplicationWithNative
export function resolveServertoolResponseStageAutoHookPostApplicationWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolResponseStageAutoHookPostApplicationWithNative', [input]);
}

// servertool-core bridge: materializeServertoolResponseStageOrchestrationOutputWithNative
export function materializeServertoolResponseStageOrchestrationOutputWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('materializeServertoolResponseStageOrchestrationOutputJson', [input]);
}

// servertool-core bridge: extractServertoolResponseStageOrchestrationShellResultWithNative
export function extractServertoolResponseStageOrchestrationShellResultWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('extractServertoolResponseStageOrchestrationShellResultWithNative', [input]);
}

// servertool-core bridge: planServertoolEntryPreflightWithNative
export function planServertoolEntryPreflightWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolEntryPreflightJson', [input]);
}

// servertool-core bridge: readServertoolEntryBaseObjectWithNative
export function readServertoolEntryBaseObjectWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('readServertoolEntryBaseObjectWithNative', [input]);
}

// servertool-core bridge: resolveServertoolEntryPreflightWithNative
export function resolveServertoolEntryPreflightWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolEntryPreflightWithNative', [input]);
}

// servertool-core bridge: resolveServertoolEntryPreflightApplicationWithNative
export function resolveServertoolEntryPreflightApplicationWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolEntryPreflightApplicationWithNative', [input]);
}

// servertool-core bridge: resolveServertoolRunEngineEntryPreflightDecisionWithNative
export function resolveServertoolRunEngineEntryPreflightDecisionWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolRunEngineEntryPreflightDecisionWithNative', [input]);
}

// servertool-core bridge: resolveServertoolRunEngineEntryPreflightApplicationWithNative
export function resolveServertoolRunEngineEntryPreflightApplicationWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolRunEngineEntryPreflightApplicationWithNative', [input]);
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
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolRunEnginePrepassDecisionWithNative', [input]);
}

// servertool-core bridge: resolveServertoolRunEnginePrepassApplicationWithNative
export function resolveServertoolRunEnginePrepassApplicationWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('resolveServertoolRunEnginePrepassApplicationWithNative', [input]);
}

// servertool-core bridge: planServertoolRegistryAutoHookDescriptorsWithNative
export function planServertoolRegistryAutoHookDescriptorsWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolRegistryAutoHookDescriptorsJson', [input]);
}

// servertool-core bridge: planServertoolRegistryBuiltinAutoHookEntriesWithNative
export function planServertoolRegistryBuiltinAutoHookEntriesWithNative(input: unknown): unknown {
  return invokeNativeServertoolCoreSemanticsExport('planServertoolRegistryBuiltinAutoHookEntriesWithNative', [input]);
}

// servertool-core bridge: planServertoolRegistryLookupActionWithNative
export function planServertoolRegistryLookupActionWithNative(input: unknown): unknown {
  return invokeRouterHotpathJsonCapability('planServertoolRegistryLookupActionJson', [input]);
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
  return invokeNativeServertoolCoreSemanticsExport('resolveEngineSelectionAfterRunWithNative', [input]);
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
// native-servertool-core-semantics.ts. Routing through the unified loader ensures
// consistent error reporting and native binding discovery.
