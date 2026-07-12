import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  buildResponsesResumeControlForContinuationContextForHttpFake,
  finalizeResponsesHandlerPayloadForHttpFake,
} from '../../../providers/helpers/responses-handler-host-fakes.js';

const mockRuntimeIntegrationsModule = {
  rebindResponsesConversationRequestId: jest.fn(async () => undefined),
  captureResponsesRequestContextForRequest: jest.fn(async () => undefined),
  clearResponsesConversationByRequestId: jest.fn(async () => undefined),
  writeSnapshotViaHooks: jest.fn(async () => undefined),
  preloadCriticalBridgeRuntimeModules: jest.fn(async () => ({ loaded: [] })),
  reportProviderErrorToRouterPolicy: jest.fn(async () => undefined),
  reportProviderSuccessToRouterPolicy: jest.fn(async () => undefined),
  resumeResponsesConversation: jest.fn(async () => ({ payload: {}, meta: {} })),
  resumeLatestResponsesContinuationByScope: jest.fn(async () => null),
};

const mockRoutingIntegrationsModule = {
  buildRequestStageRuntimeControlWritePlanNative: jest.fn(() => ({})),
  createHubPipelineNative: jest.fn(() => 'mock_hub_pipeline_handle'),
  executeHubPipelineNative: jest.fn(async () => ({ metadata: {} })),
  updateHubPipelineVirtualRouterConfigNative: jest.fn(),
  updateHubPipelineEngineDepsNative: jest.fn(),
  routeHubPipelineVirtualRouterNative: jest.fn(async () => ({ diagnostics: {} })),
  diagnoseHubPipelineVirtualRouterNative: jest.fn(async () => ({ diagnostics: {} })),
  getHubPipelineVirtualRouterStatusNative: jest.fn(async () => ({})),
  markHubPipelineVirtualRouterConcurrencyScopeBusyNative: jest.fn(),
  markHubPipelineVirtualRouterConcurrencyScopeIdleNative: jest.fn(),
  resolveRccPathNativeSync: jest.fn((segments?: unknown) => {
    const parts = Array.isArray(segments) ? segments.map(String) : [];
    return ['/tmp/routecodex-test', ...parts].join('/');
  }),
  resolveRccSnapshotsDirNativeSync: jest.fn(() => '/tmp/routecodex-test/codex-samples'),
  resolveRccUserDirNativeSync: jest.fn(() => '/tmp/routecodex-test'),
  resolveEntryProtocolFromEndpointNative: jest.fn(() => 'openai-responses'),
  disposeHubPipelineNative: jest.fn(),
};

const createNativeHostFunctionMocks = () => ({
  buildRequestStageRuntimeControlWritePlanNative: jest.fn(() => ({})),
  classifyEmptyResponseSignalNative: jest.fn(() => null),
  detectRetryableEmptyAssistantResponseNative: jest.fn(() => null),
  detectToolExecutionFailuresNative: jest.fn(() => []),
  classifyRuntimeErrorSignalNative: jest.fn(() => null),
  shouldLogClientToolErrorToConsoleNative: jest.fn(() => false),
  shouldLogRuntimeErrorSignalToConsoleNative: jest.fn(() => false),
  shouldWriteClientToolErrorsampleNative: jest.fn(() => true),
  resetSnapshotRecorderErrorsampleStateNative: jest.fn(() => undefined),
  appendSnapshotStageTraceNative: jest.fn(({ trace }: { trace?: unknown[] }) => trace ?? []),
  summarizeSnapshotStageTraceNative: jest.fn((trace: unknown[]) => trace),
  shouldInspectRuntimeErrorFastNative: jest.fn(() => false),
  shouldInspectToolFailuresNative: jest.fn(() => false),
  resolveRequestTailSummaryNative: jest.fn(() => null),
  summarizeClientToolObservationNative: jest.fn(() => ({
    topLevelKeys: [],
    failureCount: 0,
    toolMessageCount: 0,
    failures: [],
    toolMessages: [],
  })),
  deriveFinishReasonNative: jest.fn(() => undefined),
  evaluateSingletonRoutePoolExhaustionNative: jest.fn(() => undefined),
  extractServertoolCliResultRouteHintFromRequestNative: jest.fn(() => undefined),
  getRouterHotpathJsonBindingSync: jest.fn(() => ({
    asFlatRecordJson: jest.fn((inputJson: string) => inputJson),
    extractBridgeProviderResponsePayloadJson: jest.fn(() => null),
    extractContentTextForStoplessScanJson: jest.fn(() => ''),
    extractFirstBalancedJsonObjectJson: jest.fn(() => null),
    extractLatestUserTextForStoplessScanJson: jest.fn(() => ''),
    findNestedErrorMarkerJson: jest.fn(() => ''),
    findNestedRawStringJson: jest.fn(() => ''),
    hasStoplessDirectiveInRequestPayloadJson: jest.fn(() => JSON.stringify({ result: false })),
    isClientDisconnectLikeErrorJson: jest.fn(() => JSON.stringify({ result: false })),
    isContextLengthExceededErrorJson: jest.fn(() => JSON.stringify({ result: false })),
    isGenericBridgeResponseContractErrorJson: jest.fn(() => JSON.stringify({ result: false })),
    isRateLimitLikeErrorJson: jest.fn(() => JSON.stringify({ result: false })),
    isRetryableNetworkSseWrapperErrorJson: jest.fn(() => JSON.stringify({ result: false })),
    mergeObservedRoutePoolChainJson: jest.fn((currentJson: string | null, observedJson: string) => currentJson ?? observedJson),
    normalizeExplicitRoutePoolJson: jest.fn((inputJson: string) => JSON.stringify({ pool: Array.isArray(JSON.parse(inputJson)) ? JSON.parse(inputJson) : [] })),
    projectSseErrorEventPayloadJson: jest.fn((inputJson: string) => {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      return JSON.stringify({
        type: 'error',
        status: input.status,
        error: {
          message: input.message,
          code: input.code,
          request_id: input.requestId
        }
      });
    }),
    resolveEntryProtocolFromEndpointJson: jest.fn(() => 'openai-responses'),
    resolveSessionLogColorKeyJson: jest.fn((inputJson: string) => {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      return JSON.stringify({
        key: String(input.requestId ?? input.sessionId ?? input.conversationId ?? 'test-session')
      });
    }),
    tryParseJsonLikeStringJson: jest.fn(() => null),
    updateResponsesContractProbeFromSseChunkJson: jest.fn((_chunkJson: string, probeJson: string) => probeJson),
    updateResponsesSseTransportTerminalStateJson: jest.fn((_chunkJson: string, stateJson: string) => JSON.stringify({ state: JSON.parse(stateJson), sawTerminalEvent: false })),
    validateApplyPatchArgumentsJson: jest.fn(() => JSON.stringify({ ok: true })),
    validateCanonicalClientToolCallJson: jest.fn(() => JSON.stringify({ ok: true }))
  })),
  extractSessionIdentifiersFromMetadataNative: jest.fn(() => ({})),
  hasRequestedToolsInSemanticsNative: jest.fn(() => false),
  isProviderNativeResumeContinuationNative: jest.fn(() => false),
  isRequiredToolCallTurnNative: jest.fn(() => false),
  isToolResultFollowupTurnNative: jest.fn(() => false),
  mergeObservedRoutePoolChainNative: jest.fn((current: unknown, explicit: unknown) => {
    const currentList = Array.isArray(current) ? current : [];
    const explicitList = Array.isArray(explicit) ? explicit : [];
    return currentList.length > 0 ? currentList : explicitList;
  }),
  normalizeExplicitRoutePoolNative: jest.fn((value: unknown) => (Array.isArray(value) ? value : [])),
  planPrimaryExhaustedToDefaultPoolNative: jest.fn(() => undefined),
  buildResponsesConversationPortScopeForHttpNative: jest.fn(() => ({})),
  buildResponsesResumeControlForContinuationContextForHttpNative: jest.fn(
    buildResponsesResumeControlForContinuationContextForHttpFake
  ),
  finalizeResponsesHandlerPayloadForHttpNative: jest.fn(finalizeResponsesHandlerPayloadForHttpFake),
  planResponsesHandlerStreamForHttpNative: jest.fn((args: {
    payload?: Record<string, unknown>;
    forceStream?: boolean;
    acceptsSse: boolean;
    requestTimeoutMs?: number;
  }) => {
    const payload = args.payload ?? {};
    const hasExplicitStream = typeof payload.stream === 'boolean';
    const originalStream = payload.stream === true;
    const outboundStream = typeof args.forceStream === 'boolean'
      ? args.forceStream
      : (hasExplicitStream ? originalStream : args.acceptsSse);
    return {
      originalStream,
      outboundStream,
      inboundStream: outboundStream,
      acceptsSse: args.acceptsSse,
      requestStartMeta: {
        inboundStream: outboundStream,
        outboundStream,
        clientAcceptsSse: args.acceptsSse,
        originalStream,
        type: payload.type,
        timeoutMs: args.requestTimeoutMs,
      },
    };
  }),
  projectSseErrorEventPayloadNative: jest.fn((input: { requestId: string; status: number; message: string; code: string }) => ({
    type: 'error',
    status: input.status,
    error: {
      message: input.message,
      code: input.code,
      request_id: input.requestId
    }
  })),
  resolveEntryProtocolFromEndpointNative: jest.fn(() => 'openai-responses'),
  resolveErrorErr05RouteAvailabilityDecisionNative: jest.fn(() => ({ candidateExhausted: false, defaultPoolAvailable: true })),
  resolveProviderResponseRequestSemanticsNative: jest.fn(() => undefined),
  resolveProviderRetryExecutionPolicyNative: jest.fn(() => undefined),
  shouldRecordSnapshotsNative: jest.fn(() => false),
  writeSnapshotViaHooksNative: jest.fn(() => undefined)
});

const mockNativeBridgeFunctions = createNativeHostFunctionMocks();

const asRecordOrUndefined = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const mockExecutorMetadataHostModule = () => ({
  extractServertoolCliResultRouteHintFromRequestNative:
    mockNativeBridgeFunctions.extractServertoolCliResultRouteHintFromRequestNative,
  extractSessionIdentifiersFromMetadataNative:
    mockNativeBridgeFunctions.extractSessionIdentifiersFromMetadataNative,
});

const mockRequestExecutorPipelineAttemptHostModule = () => ({
  mergeObservedRoutePoolChainNative: mockNativeBridgeFunctions.mergeObservedRoutePoolChainNative,
  normalizeExplicitRoutePoolNative: mockNativeBridgeFunctions.normalizeExplicitRoutePoolNative,
});

const mockRouteAvailabilityHostModule = () => ({
  evaluateSingletonRoutePoolExhaustionNative:
    mockNativeBridgeFunctions.evaluateSingletonRoutePoolExhaustionNative,
  planPrimaryExhaustedToDefaultPoolNative:
    mockNativeBridgeFunctions.planPrimaryExhaustedToDefaultPoolNative,
  resolveErrorErr05RouteAvailabilityDecisionNative:
    mockNativeBridgeFunctions.resolveErrorErr05RouteAvailabilityDecisionNative,
});

const mockErrorExecutionDecisionHostModule = () => ({
  isRateLimitLikeErrorNative: jest.fn(() => false),
  resolveErrorErr05RouteAvailabilityDecisionNative:
    mockNativeBridgeFunctions.resolveErrorErr05RouteAvailabilityDecisionNative,
  resolveProviderRetryExecutionPolicyNative:
    mockNativeBridgeFunctions.resolveProviderRetryExecutionPolicyNative,
});

const mockProviderResponseConverterHostModule = () => ({
  asFlatRecord: jest.fn(asRecordOrUndefined),
  containsBroadKillCommand: jest.fn(() => false),
  convertProviderResponse: jest.fn(async (args: { response?: unknown; body?: unknown }) => args.response ?? args.body ?? {}),
  detectRetryableEmptyAssistantResponseNative:
    mockNativeBridgeFunctions.detectRetryableEmptyAssistantResponseNative,
  detectToolExecutionFailuresNative:
    mockNativeBridgeFunctions.detectToolExecutionFailuresNative,
  extractBridgeProviderResponsePayload: jest.fn(asRecordOrUndefined),
  extractContentTextForStoplessScan: jest.fn(() => ''),
  extractFirstBalancedJsonObject: jest.fn(() => undefined),
  extractLatestUserTextForStoplessScan: jest.fn(() => ''),
  findNestedErrorMarker: jest.fn(() => ''),
  findNestedRawString: jest.fn(() => ''),
  hasInvalidShellWrapperShape: jest.fn(() => false),
  hasRequestedToolsInSemanticsNative: mockNativeBridgeFunctions.hasRequestedToolsInSemanticsNative,
  hasStoplessDirectiveInRequestPayload: jest.fn(() => false),
  isContextLengthExceededError: jest.fn(() => false),
  isGenericBridgeResponseContractError: jest.fn(() => false),
  isProviderNativeResumeContinuationNative:
    mockNativeBridgeFunctions.isProviderNativeResumeContinuationNative,
  isRequiredToolCallTurnNative: mockNativeBridgeFunctions.isRequiredToolCallTurnNative,
  isRetryableNetworkSseWrapperError: jest.fn(() => false),
  isToolCallContinuationResponseNative:
    mockNativeBridgeFunctions.isToolCallContinuationResponseNative,
  isToolResultFollowupTurnNative:
    mockNativeBridgeFunctions.isToolResultFollowupTurnNative,
  resolveProviderResponseRequestSemanticsNative:
    mockNativeBridgeFunctions.resolveProviderResponseRequestSemanticsNative,
  tryParseJsonLikeString: jest.fn((raw: string) => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }),
  validateCanonicalClientToolCall: jest.fn(() => ({ ok: true })),
});

const mockSnapshotHooksHostModule = () => ({
  appendSnapshotStageTraceNative: mockNativeBridgeFunctions.appendSnapshotStageTraceNative,
  classifyEmptyResponseSignalNative: mockNativeBridgeFunctions.classifyEmptyResponseSignalNative,
  classifyRuntimeErrorSignalNative: mockNativeBridgeFunctions.classifyRuntimeErrorSignalNative,
  detectToolExecutionFailuresNative: mockNativeBridgeFunctions.detectToolExecutionFailuresNative,
  getSnapshotHooksNativeBindingSync: jest.fn(() => ({})),
  resetSnapshotRecorderErrorsampleStateNative:
    mockNativeBridgeFunctions.resetSnapshotRecorderErrorsampleStateNative,
  resolveRequestTailSummaryNative: mockNativeBridgeFunctions.resolveRequestTailSummaryNative,
  shouldInspectRuntimeErrorFastNative:
    mockNativeBridgeFunctions.shouldInspectRuntimeErrorFastNative,
  shouldInspectToolFailuresNative: jest.fn(() => false),
  shouldLogClientToolErrorToConsoleNative:
    mockNativeBridgeFunctions.shouldLogClientToolErrorToConsoleNative,
  shouldLogRuntimeErrorSignalToConsoleNative:
    mockNativeBridgeFunctions.shouldLogRuntimeErrorSignalToConsoleNative,
  shouldRecordSnapshotsNative: mockNativeBridgeFunctions.shouldRecordSnapshotsNative,
  shouldWriteClientToolErrorsampleNative:
    mockNativeBridgeFunctions.shouldWriteClientToolErrorsampleNative,
  summarizeClientToolObservationNative:
    mockNativeBridgeFunctions.summarizeClientToolObservationNative,
  summarizeSnapshotStageTraceNative:
    mockNativeBridgeFunctions.summarizeSnapshotStageTraceNative,
  writeSnapshotViaHooksNative: mockNativeBridgeFunctions.writeSnapshotViaHooksNative,
});

const mockSessionLogColorHostModule = () => ({
  getSessionLogColorBinding: jest.fn(() => ({
    resolveSessionColorStr: jest.fn(() => JSON.stringify('\u001b[36m')),
    resolveSessionLogColorKeyJson: jest.fn((inputJson: string) => {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      return JSON.stringify(String(input.requestId ?? input.sessionId ?? input.conversationId ?? 'test-session'));
    }),
  })),
});

const mockTrafficGovernorHostModule = () => ({
  getRouterHotpathJsonBindingSync: jest.fn(() => ({
    trafficGovernorAcquireJson: jest.fn((inputJson: string) => {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      return JSON.stringify({
        permit: {
          runtimeKey: input.runtimeKey,
          providerKey: input.providerKey,
          requestId: input.requestId,
          leaseId: 'test-lease',
          stateKey: 'test-state',
          scopeKey: input.scopeKey,
          maxInFlight: input.maxInFlight ?? 1,
          pid: process.pid,
          serverId: 'test-server',
          startedAt: 1,
          expiresAt: 2,
        },
        policy: {
          maxInFlight: input.maxInFlight ?? 1,
          acquireTimeoutMs: input.acquireTimeoutMs ?? 0,
          staleLeaseMs: input.staleLeaseMs ?? 0,
          requestsPerMinute: input.requestsPerMinute ?? 0,
          rpmTimeoutMs: input.rpmTimeoutMs ?? 0,
          rpmWindowMs: 60_000,
        },
        waitedMs: 0,
        activeInFlight: 1,
        rpmInWindow: 1,
      });
    }),
    trafficGovernorIsAtCapacityJson: jest.fn(() => false),
    trafficGovernorObserveOutcomeJson: jest.fn(() => undefined),
    trafficGovernorReleaseJson: jest.fn(() => JSON.stringify({ released: true, activeInFlight: 0 })),
  })),
});

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => mockRuntimeIntegrationsModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/runtime-integrations', () => mockRuntimeIntegrationsModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/routing-integrations.js', () => mockRoutingIntegrationsModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/routing-integrations', () => mockRoutingIntegrationsModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/error-execution-decision-host.js', mockErrorExecutionDecisionHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/error-execution-decision-host', mockErrorExecutionDecisionHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/executor-metadata-host.js', mockExecutorMetadataHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/executor-metadata-host', mockExecutorMetadataHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/finish-reason-host.js', () => ({
  deriveFinishReasonNative: mockNativeBridgeFunctions.deriveFinishReasonNative,
}));
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/finish-reason-host', () => ({
  deriveFinishReasonNative: mockNativeBridgeFunctions.deriveFinishReasonNative,
}));
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/provider-response-converter-host.js', mockProviderResponseConverterHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/provider-response-converter-host', mockProviderResponseConverterHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/request-executor-pipeline-attempt-host.js', mockRequestExecutorPipelineAttemptHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/request-executor-pipeline-attempt-host', mockRequestExecutorPipelineAttemptHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/route-availability-host.js', mockRouteAvailabilityHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/route-availability-host', mockRouteAvailabilityHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/session-log-color-host.js', mockSessionLogColorHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/session-log-color-host', mockSessionLogColorHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/snapshot-hooks-host.js', mockSnapshotHooksHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/snapshot-hooks-host', mockSnapshotHooksHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/traffic-governor-host.js', mockTrafficGovernorHostModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/traffic-governor-host', mockTrafficGovernorHostModule);

const ROOT = process.cwd();
const REQUEST_EXECUTOR_PATH = path.join(ROOT, 'src/server/runtime/http-server/request-executor.ts');
const RESPONSES_HANDLER_PATH = path.join(ROOT, 'src/server/handlers/responses-handler.ts');
let MetadataCenter: any;
let writeProviderProtocolRuntimeControl: any;
let resolveResponsesConversationRequestCaptureArgsForChatProcessEntry: any;
let buildRequestMetadata: any;
let decorateMetadataForAttempt: any;
let resolveRequestExecutorPipelineAttempt: any;
let __requestExecutorTestables: any;

beforeAll(async () => {
  ({ MetadataCenter } = await import(
    '../../../../src/server/runtime/http-server/metadata-center/metadata-center.ts'
  ));
  ({
    writeProviderProtocolRuntimeControl,
    resolveResponsesConversationRequestCaptureArgsForChatProcessEntry,
    __requestExecutorTestables
  } = await import('../../../../src/server/runtime/http-server/request-executor.ts'));
  ({ resolveRequestExecutorPipelineAttempt } = __requestExecutorTestables);
  ({ buildRequestMetadata, decorateMetadataForAttempt } = await import(
    '../../../../src/server/runtime/http-server/executor-metadata.ts'
  ));
});

describe('request-executor metadata center contract', () => {
  it('reuses mergedMetadata instead of cloning when building conversionPipelineMetadata', () => {
    const source = fs.readFileSync(REQUEST_EXECUTOR_PATH, 'utf8');

    expect(source).not.toContain('function cloneMetadataPreservingBoundCenter(');
    expect(source).toContain('mergedMetadata.routeName = pipelineRouteName;');
    expect(source).toContain('mergedMetadata.responseSemantics = responseSemantics;');
    expect(source).toContain('const conversionPipelineMetadata = mergedMetadata;');
  });

  it('writes providerProtocol into the bound MetadataCenter runtime control', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);

    writeProviderProtocolRuntimeControl(metadata, 'openai-responses');

    expect(center.readRuntimeControl().providerProtocol).toBe('openai-responses');
    expect(metadata.providerProtocol).toBeUndefined();
  });

  it('allows the request-route owner to replace providerProtocol across provider reroute attempts', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);

    writeProviderProtocolRuntimeControl(metadata, 'openai-chat');
    writeProviderProtocolRuntimeControl(metadata, 'anthropic-messages');

    expect(center.readRuntimeControl().providerProtocol).toBe('anthropic-messages');
    expect(metadata.providerProtocol).toBeUndefined();
  });

  it('fails fast when a non-owner prewrites conflicting providerProtocol', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeRuntimeControl(
      'providerProtocol',
      'openai-chat',
      {
        module: 'test',
        symbol: 'fails fast when a non-owner prewrites conflicting providerProtocol',
        stage: 'test'
      },
      'seed conflicting provider protocol'
    );

    expect(() => writeProviderProtocolRuntimeControl(metadata, 'anthropic-messages')).toThrow(
      'MetadataCenter runtime_control.providerProtocol conflict: existing=openai-chat selected=anthropic-messages'
    );
  });

  it('keeps providerProtocol available for retry Hub entry after preselectedRoute release', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    writeProviderProtocolRuntimeControl(metadata, 'openai-responses');

    const retryMetadata = decorateMetadataForAttempt(metadata, 2, new Set(['provider.previous']));

    expect(center.readRuntimeControl().providerProtocol).toBe('openai-responses');
    expect(() => writeProviderProtocolRuntimeControl(retryMetadata, 'openai-chat')).not.toThrow();
    expect(center.readRuntimeControl().providerProtocol).toBe('openai-chat');
  });

  it('commits selected target observation and providerProtocol atomically for the current attempt', () => {
    const metadataForAttempt: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadataForAttempt);
    center.writeRuntimeControl(
      'providerProtocol',
      'openai-responses',
      {
        module: 'test',
        symbol: 'commits selected target observation and providerProtocol atomically for the current attempt',
        stage: 'previous_attempt_route_owner'
      },
      'seed previous attempt provider protocol'
    );
    const retryMetadata = decorateMetadataForAttempt(
      metadataForAttempt,
      2,
      new Set(['previous.key.gpt-5.5'])
    );

    const resolved = resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-selection-atomic-1',
      providerRequestId: 'req-selection-atomic-1',
      attempt: 2,
      metadataForAttempt: retryMetadata,
      pipelineResult: {
        routingDecision: {
          routeName: 'longcontext',
          routeId: 'gateway-priority-5555-priority-longcontext',
          providerProtocol: 'openai-chat',
          routePool: ['orangeai.key1.glm-5.2']
        },
        providerPayload: { model: 'glm-5.2', messages: [] },
        target: {
          providerKey: 'orangeai.key1.glm-5.2',
          runtimeKey: 'orangeai.key1',
          outboundProfile: 'openai-chat',
          providerType: 'openai',
          modelId: 'glm-5.2',
          clientModelId: 'gpt-5.5'
        },
        metadata: retryMetadata
      },
      clientHeadersForAttempt: undefined,
      clientRequestId: 'client-selection-atomic-1',
      clientAbortSignal: undefined,
      initialRoutePool: ['previous.key.gpt-5.5', 'orangeai.key1.glm-5.2'],
      excludedProviderKeys: new Set(['previous.key.gpt-5.5']),
      lastError: Object.assign(new Error('HTTP 502'), { status: 502, code: 'HTTP_502' }),
      throwIfClientAbortSignalAborted: () => undefined,
      logStage: () => undefined,
      extractRetryErrorSnapshot: () => ({ code: 'HTTP_502', status: 502 }),
      hubStartedAtMs: Date.now() - 1,
      pipelineLabel: 'hub'
    });

    expect(resolved.kind).toBe('resolved');
    expect(center.readProviderObservation()).toMatchObject({
      providerKey: 'orangeai.key1.glm-5.2',
      modelId: 'glm-5.2',
      clientModelId: 'gpt-5.5'
    });
    expect(center.readRuntimeControl()).toMatchObject({
      providerProtocol: 'openai-chat',
      routeName: 'longcontext',
      routeId: 'gateway-priority-5555-priority-longcontext'
    });
  });

  it('rejects non-atomic selection when decision providerProtocol is missing', () => {
    const metadataForAttempt: Record<string, unknown> = {};
    MetadataCenter.attach(metadataForAttempt);

    expect(() => resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-selection-missing-protocol',
      providerRequestId: 'req-selection-missing-protocol',
      attempt: 1,
      metadataForAttempt,
      pipelineResult: {
        routingDecision: {
          routeName: 'thinking',
          routeId: 'gateway-priority-5555-priority-thinking',
          routePool: ['ykk.ykk.gpt-5.4-mini']
        },
        providerPayload: { model: 'gpt-5.4-mini', messages: [] },
        target: {
          providerKey: 'ykk.ykk.gpt-5.4-mini',
          runtimeKey: 'ykk.ykk',
          outboundProfile: 'openai-responses',
          providerType: 'responses',
          modelId: 'gpt-5.4-mini',
          clientModelId: 'gpt-5.5'
        },
        metadata: metadataForAttempt
      },
      clientHeadersForAttempt: undefined,
      clientRequestId: 'client-selection-missing-protocol',
      clientAbortSignal: undefined,
      initialRoutePool: null,
      excludedProviderKeys: new Set(),
      lastError: undefined,
      throwIfClientAbortSignalAborted: () => undefined,
      logStage: () => undefined,
      extractRetryErrorSnapshot: () => ({}),
      hubStartedAtMs: Date.now() - 1,
      pipelineLabel: 'hub'
    })).toThrow('Virtual router selection missing providerProtocol');
  });

  it('captures Responses request context from Chat Process snapshot instead of handler-owned capture', () => {
    const metadata: Record<string, unknown> = {
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      portScope: '5555',
      contextSnapshot: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        toolsRaw: [{ type: 'function', name: 'exec_command' }]
      }
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'portScope',
      '4444',
      {
        module: 'test',
        symbol: 'captures Responses request context from Chat Process snapshot instead of handler-owned capture',
        stage: 'test'
      },
      'test conflicting port scope'
    );
    center.writeRequestTruth(
      'requestId',
      'req_chatprocess_capture_1',
      {
        module: 'test',
        symbol: 'captures Responses request context from Chat Process snapshot instead of handler-owned capture',
        stage: 'test'
      },
      'test request id'
    );
    center.writeRequestTruth(
      'sessionId',
      'sess_chatprocess_capture_1',
      {
        module: 'test',
        symbol: 'captures Responses request context from Chat Process snapshot instead of handler-owned capture',
        stage: 'test'
      },
      'test session id'
    );
    center.writeRequestTruth(
      'conversationId',
      'conv_chatprocess_capture_1',
      {
        module: 'test',
        symbol: 'captures Responses request context from Chat Process snapshot instead of handler-owned capture',
        stage: 'test'
      },
      'test conversation id'
    );

    const args = resolveResponsesConversationRequestCaptureArgsForChatProcessEntry({
      input: {
        entryEndpoint: '/v1/responses',
        requestId: 'req_chatprocess_capture_1',
        body: {
          model: 'gpt-5.5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
        }
      },
      metadata,
      providerKey: 'provider.key.model'
    });

    expect(args).toMatchObject({
      requestId: 'req_chatprocess_capture_1',
      payload: expect.objectContaining({ model: 'gpt-5.5' }),
      context: metadata.contextSnapshot,
      sessionId: 'sess_chatprocess_capture_1',
      conversationId: 'conv_chatprocess_capture_1',
      providerKey: 'provider.key.model',
      entryKind: 'responses',
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    });

    const executorSource = fs.readFileSync(REQUEST_EXECUTOR_PATH, 'utf8');
    expect(executorSource).toContain('captureResponsesConversationRequestContextAtChatProcessEntry');
    expect(executorSource).toContain('await captureResponsesRequestContextForRequest(captureArgs);');
    const handlerSource = fs.readFileSync(RESPONSES_HANDLER_PATH, 'utf8');
    expect(handlerSource).not.toContain(['captureResponsesPipeline', 'RequestContextForHttp'].join(''));
  });

  it('captures Responses request context from original request payload when no debug context snapshot exists', () => {
    const metadata: Record<string, unknown> = {
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      portScope: '5555'
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'requestId',
      'req_payload_capture_1',
      {
        module: 'test',
        symbol: 'captures Responses request context from original request payload when no debug context snapshot exists',
        stage: 'test'
      },
      'test request id'
    );
    center.writeRequestTruth(
      'sessionId',
      'sess_payload_capture_1',
      {
        module: 'test',
        symbol: 'captures Responses request context from original request payload when no debug context snapshot exists',
        stage: 'test'
      },
      'test session id'
    );

    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];
    const tools = [{ type: 'function', name: 'exec_command' }];
    const args = resolveResponsesConversationRequestCaptureArgsForChatProcessEntry({
      input: {
        entryEndpoint: '/v1/responses',
        requestId: 'req_payload_capture_1',
        body: {
          model: 'gpt-5.5',
          input,
          tools
        }
      },
      metadata,
      providerKey: 'provider.key.model'
    });

    expect(args).toMatchObject({
      requestId: 'req_payload_capture_1',
      payload: expect.objectContaining({ model: 'gpt-5.5' }),
      context: {
        input,
        toolsRaw: tools
      },
      sessionId: 'sess_payload_capture_1',
      matchedPort: 5555,
      providerKey: 'provider.key.model',
      entryKind: 'responses',
      routingPolicyGroup: 'gateway_priority_5555'
    });
  });

  it('preserves raw Responses request body in executor metadata before Hub rewrites provider payload', () => {
    const inputBody = {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      tools: [{ type: 'function', name: 'exec_command' }]
    };

    const metadata = decorateMetadataForAttempt(
      buildRequestMetadata({
        entryEndpoint: '/v1/responses',
        requestId: 'openai-responses-router-gpt-5.5-20260706T215738702-469861-1397',
        body: inputBody,
        metadata: {
          routecodexRoutingPolicyGroup: 'gateway_priority_5555',
          portScope: '5555'
        }
      }),
      1,
      new Set()
    );

    const args = resolveResponsesConversationRequestCaptureArgsForChatProcessEntry({
      input: {
        entryEndpoint: '/v1/responses',
        requestId: 'openai-responses-orangeai.key1-glm-5.2-20260706T215738702-469861-1397',
        body: {
          data: {
            model: 'glm-5.2',
            messages: [{ role: 'user', content: 'hi' }]
          }
        }
      },
      metadata,
      providerKey: 'orangeai.key1.glm-5.2'
    });

    expect(args).toMatchObject({
      requestId: 'openai-responses-orangeai.key1-glm-5.2-20260706T215738702-469861-1397',
      payload: inputBody,
      context: {
        input: inputBody.input,
        toolsRaw: inputBody.tools
      },
      providerKey: 'orangeai.key1.glm-5.2',
      entryKind: 'responses'
    });
  });

  it('captures Responses request context from raw entry payload after Hub rewrites body to provider wire shape', () => {
    const rawInput = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
    ];
    const rawTools = [{ type: 'function', name: 'exec_command' }];
    const metadata: Record<string, unknown> = {
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      portScope: '5555',
      __raw_request_body: {
        model: 'gpt-5.5',
        input: rawInput,
        tools: rawTools
      }
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'requestId',
      'req_wire_shape_capture_1',
      {
        module: 'test',
        symbol: 'captures Responses request context from raw entry payload after Hub rewrites body to provider wire shape',
        stage: 'test'
      },
      'test request id'
    );
    center.writeRequestTruth(
      'sessionId',
      'sess_wire_shape_capture_1',
      {
        module: 'test',
        symbol: 'captures Responses request context from raw entry payload after Hub rewrites body to provider wire shape',
        stage: 'test'
      },
      'test session id'
    );

    const args = resolveResponsesConversationRequestCaptureArgsForChatProcessEntry({
      input: {
        entryEndpoint: '/v1/responses',
        requestId: 'req_wire_shape_capture_1',
        body: {
          data: {
            model: 'glm-5.2',
            messages: [{ role: 'user', content: 'continue' }]
          }
        }
      },
      metadata,
      providerKey: 'orangeai.key1.glm-5.2'
    });

    expect(args).toMatchObject({
      requestId: 'req_wire_shape_capture_1',
      payload: expect.objectContaining({ model: 'gpt-5.5' }),
      context: {
        input: rawInput,
        toolsRaw: rawTools
      },
      sessionId: 'sess_wire_shape_capture_1',
      matchedPort: 5555,
      providerKey: 'orangeai.key1.glm-5.2',
      entryKind: 'responses',
      routingPolicyGroup: 'gateway_priority_5555'
    });
  });

  it('fails before provider send when Responses raw entry payload is already missing after provider wire rewrite', () => {
    const metadata: Record<string, unknown> = {
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      portScope: '5555'
    };

    expect(() => resolveResponsesConversationRequestCaptureArgsForChatProcessEntry({
      input: {
        entryEndpoint: '/v1/responses',
        requestId: 'req_missing_raw_capture_1',
        body: {
          data: {
            model: 'glm-5.2',
            messages: [{ role: 'user', content: 'continue' }]
          }
        }
      },
      metadata,
      providerKey: 'orangeai.key1.glm-5.2'
    })).toThrow('RESPONSES_STORE_MISSING_REQUEST_CONTEXT');
  });

  it('captures Responses request context with active provider request id after provider request id enhancement', () => {
    const metadata: Record<string, unknown> = {
      routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      portScope: '5555',
      __raw_request_body: {
        model: 'gpt-5.5',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        tools: [{ type: 'function', name: 'exec_command' }]
      }
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'requestId',
      'openai-responses-router-gpt-5.5-20260703T120957051-453706-103',
      {
        module: 'test',
        symbol: 'captures Responses request context with active provider request id after provider request id enhancement',
        stage: 'test'
      },
      'test request id'
    );
    center.writeRequestTruth(
      'sessionId',
      'sess_provider_enhanced_capture_1',
      {
        module: 'test',
        symbol: 'captures Responses request context with active provider request id after provider request id enhancement',
        stage: 'test'
      },
      'test session id'
    );

    const args = resolveResponsesConversationRequestCaptureArgsForChatProcessEntry({
      input: {
        entryEndpoint: '/v1/responses',
        requestId: 'openai-responses-orangeai.key1-glm-5.2-20260703T120957051-453706-103',
        body: {
          data: {
            model: 'glm-5.2',
            messages: [{ role: 'user', content: 'hi' }]
          }
        }
      },
      metadata,
      providerKey: 'orangeai.key1.glm-5.2'
    });

    expect(args).toMatchObject({
      requestId: 'openai-responses-orangeai.key1-glm-5.2-20260703T120957051-453706-103',
      payload: expect.objectContaining({ model: 'gpt-5.5' }),
      context: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        toolsRaw: [{ type: 'function', name: 'exec_command' }]
      },
      sessionId: 'sess_provider_enhanced_capture_1',
      matchedPort: 5555,
      providerKey: 'orangeai.key1.glm-5.2',
      entryKind: 'responses',
      routingPolicyGroup: 'gateway_priority_5555'
    });
  });

  it('reads matchedPort from raw metadata port fields instead of MetadataCenter request truth', () => {
    const metadata: Record<string, unknown> = {
      entryPort: 5555,
      matchedPort: 5555,
      routecodexLocalPort: 5555,
      localPort: 5555,
      routecodexRoutingPolicyGroup: 'gateway_priority_5555'
    };
    const center = MetadataCenter.attach(metadata);
    center.writeRequestTruth(
      'requestId',
      'req_no_port_scope_capture_1',
      {
        module: 'test',
        symbol: 'ignores flat metadata port fields when requestTruth.portScope is absent',
        stage: 'test'
      },
      'test request id'
    );
    center.writeRequestTruth(
      'portScope',
      '4444',
      {
        module: 'test',
        symbol: 'reads matchedPort from raw metadata port fields instead of MetadataCenter request truth',
        stage: 'test'
      },
      'test conflicting port scope'
    );
    center.writeRequestTruth(
      'sessionId',
      'sess_no_port_scope_capture_1',
      {
        module: 'test',
        symbol: 'reads matchedPort from raw metadata port fields instead of MetadataCenter request truth',
        stage: 'test'
      },
      'test session id'
    );

    const args = resolveResponsesConversationRequestCaptureArgsForChatProcessEntry({
      input: {
        entryEndpoint: '/v1/responses',
        requestId: 'req_no_port_scope_capture_1',
        body: {
          model: 'gpt-5.5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
        }
      },
      metadata,
      providerKey: 'provider.key.model'
    });

    expect(args).toMatchObject({
      requestId: 'req_no_port_scope_capture_1',
      sessionId: 'sess_no_port_scope_capture_1',
      matchedPort: 5555,
      providerKey: 'provider.key.model',
      entryKind: 'responses',
      routingPolicyGroup: 'gateway_priority_5555'
    });
  });
});
