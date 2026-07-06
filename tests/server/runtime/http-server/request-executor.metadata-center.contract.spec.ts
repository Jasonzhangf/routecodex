import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';

const mockBridgeModule = {
  loadRoutingInstructionStateSync: jest.fn(() => null),
  saveRoutingInstructionStateAsync: jest.fn(async () => undefined),
  saveRoutingInstructionStateSync: jest.fn(() => undefined),
  extractSessionIdentifiersFromMetadata: jest.fn(() => ({})),
  extractContinuationContextSessionIdentifiersFromMetadata: jest.fn(() => ({})),
  extractServertoolCliResultRouteHintFromRequestNative: jest.fn(() => undefined),
  rebindResponsesConversationRequestId: jest.fn(async () => undefined),
  captureResponsesRequestContextForRequest: jest.fn(async () => undefined),
  clearResponsesConversationByRequestId: jest.fn(async () => undefined),
  syncReasoningStopModeFromRequest: jest.fn(() => 'off'),
  sanitizeFollowupText: jest.fn(async (raw: unknown) => (typeof raw === 'string' ? raw : '')),
  createSnapshotRecorder: jest.fn(async () => ({ record: () => undefined })),
  convertProviderResponse: jest.fn(async () => ({ body: { ok: true } })),
  writeSnapshotViaHooks: jest.fn(async () => undefined),
  preloadCriticalBridgeRuntimeModules: jest.fn(async () => ({ loaded: [] })),
  resumeResponsesConversation: jest.fn(async () => ({ payload: {}, meta: {} })),
  resumeLatestResponsesContinuationByScope: jest.fn(async () => null),
  createResponsesSseToJsonConverter: jest.fn(async () => ({ convertSseToJson: async () => ({}) })),
  resolveRelayResponsesClientSseStreamForHttp: jest.fn(async () => undefined),
  reprojectDirectChatToolCallStreamForHttp: jest.fn(async () => undefined),
  reportProviderErrorToRouterPolicy: jest.fn(async (event: unknown) => event),
  reportProviderSuccessToRouterPolicy: jest.fn(async (event: unknown) => event),
  bootstrapVirtualRouterConfig: jest.fn(),
  getHubPipelineCtor: jest.fn(),
  getHubPipelineCtorForImpl: jest.fn(),
  resolveBaseDir: jest.fn(),
  mapChatToolsToBridgeJson: jest.fn(async () => []),
  buildAnthropicResponseFromChatJson: jest.fn(async () => ({})),
  injectMcpToolsForChatJson: jest.fn(async () => []),
  injectMcpToolsForResponsesJson: jest.fn(async () => []),
  deriveFinishReasonNative: jest.fn(() => undefined),
  importCoreDist: jest.fn(async () => ({}))
};

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => mockBridgeModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.ts', () => mockBridgeModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/native-exports.js', async () => {
  const actual = await import('../../../../src/modules/llmswitch/bridge/native-exports.ts');
  return {
    ...actual,
    getRouterHotpathJsonBindingSync: jest.fn(() => ({
      hasStoplessDirectiveInRequestPayloadJson: jest.fn(() => JSON.stringify({ result: false }))
    })),
    resolveProviderResponseRequestSemanticsNative: jest.fn(() => undefined),
    resolveEntryProtocolFromEndpointNative: jest.fn(() => 'openai-responses'),
    hasRequestedToolsInSemanticsNative: jest.fn(() => false),
    isRequiredToolCallTurnNative: jest.fn(() => false),
    isToolResultFollowupTurnNative: jest.fn(() => false),
    isProviderNativeResumeContinuationNative: jest.fn(() => false),
    evaluateSingletonRoutePoolExhaustionNative: jest.fn(() => undefined),
    planPrimaryExhaustedToDefaultPoolNative: jest.fn(() => undefined),
    normalizeExplicitRoutePoolNative: jest.fn((value: unknown) => (Array.isArray(value) ? value : [])),
    mergeObservedRoutePoolChainNative: jest.fn((current: unknown, explicit: unknown) => {
      const currentList = Array.isArray(current) ? current : [];
      const explicitList = Array.isArray(explicit) ? explicit : [];
      return currentList.length > 0 ? currentList : explicitList;
    }),
    resolveProviderRetryExecutionPolicyNative: jest.fn(() => undefined),
    extractServertoolCliResultRouteHintFromRequestNative: jest.fn(() => undefined)
  };
});

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
