import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import {
  buildResponsesResumeControlForContinuationContextForHttpFake,
  finalizeResponsesHandlerPayloadForHttpFake,
} from '../../providers/helpers/llmswitch-native-exports-fake.js';

const mockCaptureResponsesRequestContext = jest.fn(async () => undefined);
const mockRecordResponsesResponseForRequest = jest.fn(async () => undefined);
const mockResumeResponsesConversation = jest.fn();
const mockResumeLatestResponsesContinuationByScope = jest.fn();
const mockMaterializeLatestResponsesContinuationByScope = jest.fn();
let mockHubPipelineHandleId = 0;
const mockHubPipelineExecutors = new Map<string, (input: unknown) => unknown>();

function registerHubPipelineFixture(execute: (input: unknown) => unknown): string {
  const handle = `handler-request-executor-native-handle-${++mockHubPipelineHandleId}`;
  mockHubPipelineExecutors.set(handle, execute);
  return handle;
}

function materializeHubPipelineFixtureResult(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const record = result as Record<string, unknown>;
  const target = record.target && typeof record.target === 'object' && !Array.isArray(record.target)
    ? record.target as Record<string, unknown>
    : undefined;
  const providerProtocol = typeof target?.outboundProfile === 'string' ? target.outboundProfile : undefined;
  if (!providerProtocol) {
    return result;
  }
  const routingDecision = record.routingDecision && typeof record.routingDecision === 'object' && !Array.isArray(record.routingDecision)
    ? record.routingDecision as Record<string, unknown>
    : {};
  return {
    ...record,
    routingDecision: {
      ...routingDecision,
      providerProtocol
    }
  };
}

const TEST_RESPONSES_REQUEST_CONTEXT_KEY = '__test_responses_request_context';

function asPlainRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function resolveFixtureEntryProtocol(endpoint: unknown): string | undefined {
  const text = typeof endpoint === 'string' ? endpoint : '';
  if (text.includes('/v1/responses')) return 'openai-responses';
  if (text.includes('/v1/messages')) return 'anthropic-messages';
  if (text.includes('/v1/chat/completions')) return 'openai-chat';
  return undefined;
}

function buildResponsesRequestContextFixture(payload: Record<string, any>): Record<string, any> {
  return {
    payload,
    context: {
      input: Array.isArray(payload.input) ? payload.input : [],
      toolsRaw: Array.isArray(payload.tools) ? payload.tools : []
    }
  };
}

function attachResponsesRequestContextFixture(
  metadata: Record<string, any>,
  payload: Record<string, any>
): void {
  const fixture = buildResponsesRequestContextFixture(payload);
  Object.defineProperty(metadata, TEST_RESPONSES_REQUEST_CONTEXT_KEY, {
    configurable: true,
    enumerable: false,
    value: fixture,
    writable: true
  });
  metadata.contextSnapshot = fixture.context;
}

function materializeHubPipelineFixtureInput(input: unknown): unknown {
  const record = asPlainRecord(input);
  const metadata = asPlainRecord(record?.metadata);
  if (!record || !metadata) {
    return input;
  }
  const center = MetadataCenter.read(metadata) ?? MetadataCenter.attach(metadata);
  const runtimeControl = center?.readRuntimeControl() ?? {};
  const providerProtocol = runtimeControl.providerProtocol ?? resolveFixtureEntryProtocol(record.endpoint);
  if (providerProtocol && typeof metadata.providerProtocol !== 'string') {
    metadata.providerProtocol = providerProtocol;
  }
  delete metadata.__raw_request_body;
  if (providerProtocol === 'openai-responses') {
    const payload = asPlainRecord(record.payload);
    if (payload) {
      attachResponsesRequestContextFixture(metadata, payload);
    }
  }
  return input;
}

function normalizeHubPipelineInputForTest(input: unknown): unknown {
  const record = asPlainRecord(input);
  if (!record) {
    return input;
  }
  const sourceMetadata = asPlainRecord(record.metadata);
  const metadata = sourceMetadata ? { ...sourceMetadata } : undefined;
  if (sourceMetadata && metadata) {
    const center = MetadataCenter.read(sourceMetadata);
    if (center) {
      MetadataCenter.bind(metadata, center);
    }
  }
  const hasHubBody = Object.prototype.hasOwnProperty.call(record, 'hubBody');
  const body = hasHubBody ? record.hubBody : record.body;
  const normalized: Record<string, any> = hasHubBody
    ? { ...record, body, metadata }
    : { ...record, ...(metadata ? { metadata } : {}) };
  if (hasHubBody) {
    delete normalized.hubBody;
  }
  const providerProtocol =
    resolveFixtureEntryProtocol(record.entryEndpoint ?? record.endpoint)
    ?? (metadata ? MetadataCenter.read(metadata)?.readRuntimeControl().providerProtocol : undefined);
  const payload = asPlainRecord(body);
  if (providerProtocol === 'openai-responses' && metadata && payload) {
    attachResponsesRequestContextFixture(metadata, payload);
  }
  return normalized;
}

function buildJsonFixtureSseStream(body: unknown, entryEndpoint?: string): Readable {
  const event = entryEndpoint?.includes('/v1/responses')
    ? 'response.completed'
    : entryEndpoint?.includes('/v1/messages')
      ? 'message'
      : 'chat.completion';
  return Readable.from([
    `event: ${event}\n`,
    `data: ${JSON.stringify(body ?? {})}\n\n`,
    'data: [DONE]\n\n'
  ]);
}

function shouldMaterializeJsonFixtureSse(input: Record<string, any>): boolean {
  const headers = asPlainRecord(input.headers);
  const acceptsSse = typeof headers?.accept === 'string' && headers.accept.includes('text/event-stream');
  const body = asPlainRecord(input.body);
  const metadata = asPlainRecord(input.metadata);
  const streamIntent = metadata ? MetadataCenter.read(metadata)?.readRuntimeControl().streamIntent : undefined;
  return acceptsSse || body?.stream === true || streamIntent === 'stream';
}

async function executeHandlerPipelineFixture(
  execute: (input: any) => unknown,
  input: unknown
): Promise<unknown> {
  const normalized = normalizeHubPipelineInputForTest(input) as Record<string, any>;
  const result = await execute(normalized);
  const record = asPlainRecord(result);
  if (!record || record.sseStream !== undefined || !shouldMaterializeJsonFixtureSse(normalized)) {
    return result;
  }
  return {
    ...record,
    sseStream: buildJsonFixtureSseStream(record.body, normalized.entryEndpoint)
  };
}

async function executeRequestExecutorWithServerInput(executor: any, input: unknown): Promise<unknown> {
  return executor.execute(normalizeHubPipelineInputForTest(input) as any);
}

function extractTextFromProviderResponseBody(body: any): string {
  const data = body && typeof body === 'object' && body.data && typeof body.data === 'object'
    ? body.data
    : body;
  const content = Array.isArray(data?.content) ? data.content : [];
  const textItem = content.find((item: any) => item && typeof item === 'object' && typeof item.text === 'string');
  if (textItem?.text) return textItem.text;
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : undefined;
  const part = candidate?.content?.parts?.find((item: any) => item && typeof item.text === 'string');
  return typeof part?.text === 'string' ? part.text : '';
}

function extractPreviousResponseIdFromSemantics(semantics: any): string | undefined {
  const resumeFrom = semantics?.continuation?.resumeFrom;
  if (resumeFrom && typeof resumeFrom === 'object') {
    if (typeof resumeFrom.previousResponseId === 'string') return resumeFrom.previousResponseId;
    if (typeof resumeFrom.responseId === 'string') return resumeFrom.responseId;
  }
  return undefined;
}

function extractPreviousResponseIdFromOptions(options: any): string | undefined {
  if (options?.requestSemantics) {
    const fromSemantics = extractPreviousResponseIdFromSemantics(options.requestSemantics);
    if (fromSemantics) {
      return fromSemantics;
    }
  }
  if (typeof options?.entryOriginRequest?.previous_response_id === 'string') {
    return options.entryOriginRequest.previous_response_id;
  }
  if (typeof options?.entryOriginRequest?.response_id === 'string') {
    return options.entryOriginRequest.response_id;
  }
  const metadata = options?.pipelineMetadata;
  if (metadata) {
    const centerResume = MetadataCenter.read(metadata)?.readContinuationContext();
    if (centerResume?.previousResponseId) return centerResume.previousResponseId;
    if (centerResume?.responsesRequestContext?.payload) {
      const ctx = centerResume.responsesRequestContext.payload as Record<string, unknown>;
      if (typeof ctx.previous_response_id === 'string') return ctx.previous_response_id;
      if (typeof ctx.response_id === 'string') return ctx.response_id;
    }
  }
  return undefined;
}

function detectToolCallFinishReason(body: any): string | undefined {
  const data = body && typeof body === 'object' && (body as any).data && typeof (body as any).data === 'object'
    ? (body as any).data
    : body;
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  if (d.status === 'requires_action' && Array.isArray(d.output)) {
    const hasFunctionCall = d.output.some((item: any) => item && typeof item === 'object' && item.type === 'function_call');
    if (hasFunctionCall) return 'tool_calls';
  }
  if (d.required_action && typeof d.required_action === 'object') {
    const ra = (d.required_action as Record<string, unknown>).submit_tool_outputs;
    if (ra && typeof ra === 'object') return 'tool_calls';
  }
  return undefined;
}

const mockConvertProviderResponseIfNeeded = jest.fn(async (options: any) => {
  const entryEndpoint = String(options?.entryEndpoint || '');
  const response = options?.response ?? {};
  const withFixtureSseStream = (converted: Record<string, any>) =>
    options?.wantsStream === true && converted.sseStream === undefined
      ? {
          ...converted,
          sseStream: buildJsonFixtureSseStream(converted.body, entryEndpoint)
        }
      : converted;
  if (response.sseStream !== undefined) {
    return { ...response, sseStream: response.sseStream, continuationOwner: 'direct' };
  }
  const responseBody = response.body;
  const body = responseBody && typeof responseBody === 'object' ? responseBody : {};
  const data = (body as any).data && typeof (body as any).data === 'object' ? (body as any).data : body;
  if (entryEndpoint.includes('/v1/responses')) {
    if (typeof (data as any).id === 'string' && (data as any).object === 'response') {
      const previousId = extractPreviousResponseIdFromOptions(options);
      return withFixtureSseStream({
        ...response,
        status: 200,
        body: {
          ...(data as Record<string, unknown>),
          previous_response_id: previousId ?? null
        }
      });
    }
    const toolUse = Array.isArray((data as any).content)
      ? (data as any).content.find((item: any) => item && typeof item === 'object' && item.type === 'tool_use')
      : undefined;
    if (toolUse) {
      const command = toolUse.input?.cmd ?? toolUse.input?.command;
      const isBlockedCheckout = typeof command === 'string' && /git\s+checkout\s+--\s+\S+\/\s*$/.test(command);
      return withFixtureSseStream({
        ...response,
        status: 200,
        body: {
          object: 'response',
          id: 'resp_mock_tool_call_1',
          status: 'requires_action',
          output: [{
            type: 'function_call',
            call_id: toolUse.id,
            name: toolUse.name,
            arguments: JSON.stringify(isBlockedCheckout
              ? {
                  ...toolUse.input,
                  cmd: `blocked by exec_command guard: ${command}`
                }
              : (toolUse.input ?? {}))
          }]
        }
      });
    }
    return withFixtureSseStream({
      ...response,
      status: 200,
      body: {
        object: 'response',
        id: typeof (data as any).id === 'string' ? (data as any).id : 'resp_mock_converted_1',
        previous_response_id: extractPreviousResponseIdFromOptions(options) ?? null,
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: extractTextFromProviderResponseBody(data) }]
        }]
      }
    });
  }
  if (entryEndpoint.includes('/v1/chat/completions')) {
    return withFixtureSseStream({
      ...response,
      status: 200,
      body: {
        id: 'chatcmpl_mock_1',
        object: 'chat.completion',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: extractTextFromProviderResponseBody(responseBody) }
        }]
      }
    });
  }
  if (entryEndpoint.includes('/v1/messages')) {
    const text = extractTextFromProviderResponseBody(data);
    return withFixtureSseStream({
      ...response,
      status: 200,
      body: {
        id: typeof (data as any).id === 'string' ? (data as any).id : 'msg_mock_messages_1',
        type: 'message',
        role: 'assistant',
        model: typeof (data as any).model === 'string' ? (data as any).model : 'claude-sonnet-4-5',
        content: Array.isArray((data as any).content) ? (data as any).content : [{ type: 'text', text: text || '' }],
        stop_reason: typeof (data as any).stop_reason === 'string' ? (data as any).stop_reason : 'end_turn'
      }
    });
  }
  return response;
});

function defaultPlanResponsesHandlerEntry(payload: any, entryEndpoint?: string, responseIdFromPath?: string) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const responseId = typeof body.response_id === 'string'
    ? body.response_id
    : typeof body.previous_response_id === 'string'
      ? body.previous_response_id
      : responseIdFromPath;
  if (entryEndpoint === '/v1/responses.submit_tool_outputs' || (responseId && Array.isArray(body.tool_outputs))) {
    return { mode: 'submit_tool_outputs', responseId, payload: body };
  }
  if (Array.isArray(body.input) && body.input[0]?.type === 'function_call_output') {
    return { mode: 'scope_materialize', payload: body };
  }
  return { mode: 'none', payload: body };
}

const mockPlanResponsesHandlerEntry = jest.fn(async (payload: any, entryEndpoint?: string, responseIdFromPath?: string) =>
  defaultPlanResponsesHandlerEntry(payload, entryEndpoint, responseIdFromPath)
);

const mockRuntimeIntegrationsModule = () => ({
  captureResponsesRequestContextForRequest: mockCaptureResponsesRequestContext,
  clearResponsesConversationByRequestId: jest.fn(async () => undefined),
  finalizeResponsesConversationRequestRetention: jest.fn(async () => undefined),
  lookupResponsesContinuationByResponseId: jest.fn(async () => undefined),
  materializeLatestResponsesContinuationByScope: mockMaterializeLatestResponsesContinuationByScope,
  recordResponsesResponseForRequest: mockRecordResponsesResponseForRequest,
  resumeLatestResponsesContinuationByScope: mockResumeLatestResponsesContinuationByScope,
  resumeResponsesConversation: mockResumeResponsesConversation,
  clearResponsesConversationOnHandlerFailureForHttp: jest.fn(async () => undefined),
  writeSnapshotViaHooks: jest.fn(async () => undefined),
  preloadCriticalBridgeRuntimeModules: jest.fn(),
  rebindResponsesConversationRequestId: jest.fn(async () => undefined),
  clearAllResponsesConversationState: jest.fn(),
  resetResponsesConversationStateForRestartSimulation: jest.fn(),
  clearUnresolvedResponsesConversationRequests: jest.fn(),
  createResponsesSseToJsonConverter: jest.fn(),
  createResponsesJsonToSseConverter: jest.fn(),
  reportProviderErrorToRouterPolicy: jest.fn(async () => undefined),
  reportProviderSuccessToRouterPolicy: jest.fn(async () => undefined)
});

function mockLlmswitchBridgeHostModule(moduleName: string, factory: () => Record<string, unknown>): void {
  jest.unstable_mockModule(`../../../src/modules/llmswitch/bridge/${moduleName}.js`, factory);
  jest.unstable_mockModule(`../../../src/modules/llmswitch/bridge/${moduleName}.ts`, factory);
  jest.unstable_mockModule(`../../../src/modules/llmswitch/bridge/${moduleName}`, factory);
}

function mockLlmswitchBridgeHostExports(moduleName: string, exportNames: string[]): void {
  mockLlmswitchBridgeHostModule(moduleName, () => {
    const fixtures = createBridgeNativeFixtures() as Record<string, unknown>;
    return Object.fromEntries(exportNames.map((name) => [name, fixtures[name]]));
  });
}

const createBridgeNativeFixtures = () => ({
  getRouterHotpathJsonBindingSync: jest.fn(() => ({
    asFlatRecordJson: (inputJson: string) => inputJson,
    buildJsonFromSseJson: (inputJson: string) => inputJson,
    detectRetryableEmptyAssistantResponseJson: () => JSON.stringify({ retryable: false }),
    extractBridgeProviderResponsePayloadJson: (inputJson: string) => inputJson,
    extractContentTextForStoplessScanJson: () => '',
    extractFirstBalancedJsonObjectJson: () => '',
    extractLatestUserTextForStoplessScanJson: () => '',
    findNestedErrorMarkerJson: () => '',
    findNestedRawStringJson: () => '',
    hasStoplessDirectiveInRequestPayloadJson: () => false,
    isContextLengthExceededErrorJson: () => false,
    isGenericBridgeResponseContractErrorJson: () => false,
    isRetryableNetworkSseWrapperErrorJson: () => false,
    isToolCallContinuationResponseJson: () => false,
    mergeObservedRoutePoolChainJson: (_existingJson: string | null, observedJson: string) => observedJson,
    normalizeExplicitRoutePoolJson: (inputJson: string) => JSON.stringify({ pool: JSON.parse(inputJson) }),
    reportProviderErrorToRouterPolicyJson: (inputJson: string) => inputJson,
    reportProviderSuccessToRouterPolicyJson: (inputJson: string) => inputJson,
    trafficGovernorAcquireJson: (inputJson: string) => {
      const input = JSON.parse(inputJson || '{}') as Record<string, unknown>;
      return JSON.stringify({
        permit: {
          runtimeKey: input.runtimeKey,
          providerKey: input.providerKey,
          requestId: input.requestId,
          leaseId: 'test-lease',
          stateKey: 'test-state',
          scopeKey: input.scopeKey,
          maxInFlight: 1,
          pid: process.pid,
          serverId: 'test-server',
          startedAt: Date.now(),
          expiresAt: Date.now() + 60_000
        },
        policy: {
          maxInFlight: 1,
          acquireTimeoutMs: 0,
          staleLeaseMs: 60_000,
          requestsPerMinute: 60,
          rpmTimeoutMs: 0,
          rpmWindowMs: 60_000
        },
        waitedMs: 0,
        activeInFlight: 1,
        rpmInWindow: 1
      });
    },
    trafficGovernorReleaseJson: () => JSON.stringify({ released: true, activeInFlight: 0 }),
    trafficGovernorIsAtCapacityJson: () => false,
    trafficGovernorObserveOutcomeJson: () => undefined,
    resolveRccPathJson: (inputJson: string) => {
      const input = JSON.parse(inputJson || '{}') as { segments?: unknown[] };
      const parts = Array.isArray(input.segments) ? input.segments.map(String) : [];
      return JSON.stringify(['/tmp/routecodex-test', ...parts].join('/'));
    },
    resolveRccSnapshotsDirJson: () => JSON.stringify('/tmp/routecodex-test/codex-samples'),
    resolveRccUserDirJson: () => JSON.stringify('/tmp/routecodex-test'),
    resolveSessionColorStr: () => JSON.stringify(''),
    resolveSessionLogColorKeyJson: () => JSON.stringify('test-session-color'),
    resolveEntryProtocolFromEndpointJson: (entryEndpoint: string) =>
      entryEndpoint.includes('/v1/responses')
        ? 'openai-responses'
        : entryEndpoint.includes('/v1/messages')
          ? 'anthropic-messages'
          : 'openai-chat',
    tryParseJsonLikeStringJson: (inputJson: string) => inputJson
  })),
  getSnapshotHooksNativeBindingSync: jest.fn(() => createBridgeNativeFixtures().getRouterHotpathJsonBindingSync()),
  shouldRecordSnapshotsNative: jest.fn(() => false),
  writeSnapshotViaHooksNative: jest.fn(() => undefined),
  buildRequestStageRuntimeControlWritePlanNative: jest.fn(() => ({ runtimeControl: null })),
  resolveEntryProtocolFromEndpointNative: jest.fn((entryEndpoint: string) =>
    entryEndpoint.includes('/v1/responses')
      ? 'openai-responses'
      : entryEndpoint.includes('/v1/messages')
        ? 'anthropic-messages'
        : 'openai-chat'
  ),
  resolveErrorErr05RouteAvailabilityDecisionNative: jest.fn(() => ({ decision: 'available' })),
  projectSseErrorEventPayloadNative: jest.fn((args: any) => ({
    error: {
      message: args?.message,
      type: 'server_error',
      code: args?.code,
      status: args?.status,
      request_id: args?.requestId,
      ...(args?.error && typeof args.error === 'object' ? args.error : {})
    }
  })),
  hasRequestedToolsInSemanticsNative: jest.fn(() => false),
  isRequiredToolCallTurnNative: jest.fn(() => false),
  isToolResultFollowupTurnNative: jest.fn(() => false),
  isProviderNativeResumeContinuationNative: jest.fn(() => false),
  detectRetryableEmptyAssistantResponseNative: jest.fn(() => null),
  normalizeExplicitRoutePoolNative: jest.fn((value: unknown) => Array.isArray(value) ? value : []),
  mergeObservedRoutePoolChainNative: jest.fn((_existing: string[] | null, observed: string[]) => observed),
  materializeProviderOwnedSubmitContext: jest.fn(async ({ payload }: any) => ({
    payload: payload ?? {},
    context: { input: Array.isArray(payload?.input) ? payload.input : [] }
  })),
  planResponsesRequestContext: jest.fn(async ({ payload }: any) => ({
    kind: 'capture_request',
    payload: payload ?? {}
  })),
  planResponsesContinuationRequestAction: jest.fn(async (input: any) => ({
    ...(input?.plannedEntryMode === 'submit_tool_outputs'
      ? {
          action: 'relay_submit',
          responseId: input?.responseId ?? input?.previousResponseId,
          pipelineEntryEndpoint: '/v1/responses'
        }
      : input?.plannedEntryMode === 'scope_materialize'
        ? {
            action: input?.continuation?.continuationOwner === 'relay' ? 'relay_scope_materialize' : 'scope_materialize',
            responseId: input?.responseId ?? input?.previousResponseId,
            continuationOwner: input?.continuation?.continuationOwner
          }
        : input?.previousResponseId && input?.continuation?.continuationOwner === 'direct'
          ? {
              action: 'attach_resume_meta',
              responseId: input.previousResponseId,
              resumeMeta: {
                responseId: input.previousResponseId,
                previousResponseId: input.previousResponseId,
                continuationOwner: 'direct',
                providerKey: input.continuation.providerKey,
                restored: false
              }
            }
          : input?.previousResponseId && input?.continuation?.continuationOwner === 'relay'
            ? {
                action: 'relay_scope_materialize',
                responseId: input.previousResponseId,
                continuationOwner: 'relay',
                pipelineEntryEndpoint: '/v1/responses'
              }
            : {
                action: 'none',
                responseId: input?.responseId ?? input?.previousResponseId,
                payload: {}
              })
  })),
  planResponsesHandlerEntry: mockPlanResponsesHandlerEntry,
  captureReqInboundResponsesContextSnapshotJson: jest.fn((args: any) => ({
    input: Array.isArray(args?.rawRequest?.input) ? args.rawRequest.input : [],
    toolsRaw: Array.isArray(args?.rawRequest?.tools) ? args.rawRequest.tools : undefined
  })),
  extractServertoolCliResultRouteHintFromRequestNative: jest.fn((input: any) => {
    const adapterContext = input?.adapterContext && typeof input.adapterContext === 'object' && !Array.isArray(input.adapterContext)
      ? input.adapterContext
      : undefined;
    const rawRequestBody =
      adapterContext?.__raw_request_body && typeof adapterContext.__raw_request_body === 'object' && !Array.isArray(adapterContext.__raw_request_body)
        ? adapterContext.__raw_request_body
        : undefined;
    if (!rawRequestBody) {
      return undefined;
    }
    const readRouteHint = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
      }
      const record = value as Record<string, unknown>;
      return typeof record.routeHint === 'string' && record.routeHint.trim()
        ? record.routeHint.trim()
        : undefined;
    };
    for (const item of Array.isArray((rawRequestBody as Record<string, unknown>).tool_outputs)
      ? (rawRequestBody as Record<string, unknown>).tool_outputs as unknown[]
      : []) {
      const routeHint = readRouteHint(item);
      if (routeHint) return routeHint;
    }
    for (const item of Array.isArray((rawRequestBody as Record<string, unknown>).input)
      ? (rawRequestBody as Record<string, unknown>).input as unknown[]
      : []) {
      const routeHint = readRouteHint(item);
      if (routeHint) return routeHint;
    }
    return undefined;
  }),
  resolveProviderRetryExecutionPolicyNative: jest.fn((input: any) => ({
    excludeCurrentProvider: Boolean(input?.existingExclusion),
    reason: input?.existingExclusion ? 'existing_exclusion' : 'test_no_retry'
  })),
  sanitizeFollowupText: jest.fn(async (raw: unknown) => (typeof raw === 'string' ? raw : '')),
  classifyProviderFailure: jest.fn(() => 'non_recoverable'),
  deriveFinishReasonNative: jest.fn((body: any) => detectToolCallFinishReason(body)),
  extractSessionIdentifiersFromMetadataNative: jest.fn((metadata?: Record<string, unknown>) => {
    const nestedMetadata = asPlainRecord(metadata?.metadata);
    const clientMetadata = asPlainRecord(metadata?.client_metadata);
    return {
      sessionId:
        metadata?.sessionId
        ?? metadata?.session_id
        ?? nestedMetadata?.sessionId
        ?? nestedMetadata?.session_id
        ?? clientMetadata?.sessionId
        ?? clientMetadata?.session_id,
      conversationId:
        metadata?.conversationId
        ?? metadata?.conversation_id
        ?? nestedMetadata?.conversationId
        ?? nestedMetadata?.conversation_id
        ?? clientMetadata?.conversationId
        ?? clientMetadata?.conversation_id,
    };
  }),
  isToolCallContinuationResponseNative: jest.fn(() => false),
  resolveProviderResponseRequestSemanticsNative: jest.fn((_processed: unknown, standardized: unknown) => standardized ?? {}),
  evaluateSingletonRoutePoolExhaustionNative: jest.fn(() => ({ exhausted: false })),
  planPrimaryExhaustedToDefaultPoolNative: jest.fn(() => ({ status: 'none' })),
  planResponsesRequestBodyForHttpNative: jest.fn((payload: Record<string, unknown>) => ({
    pipelineBody: payload,
    requestBodyMetadata: asPlainRecord(payload?.metadata) ?? {}
  })),
  shouldManageResponsesConversationForHttpNative: jest.fn((entryEndpoint?: string) =>
    entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs'
  ),
  buildResponsesScopeContinuationExpiredErrorForHttpNative: jest.fn(() => ({
    error: {
      message: 'Responses continuation expired or not found for local scope materialization',
      type: 'invalid_request_error',
      code: 'responses_continuation_expired',
    },
  })),
  buildResponsesResumeClientErrorForHttpNative: jest.fn((args: {
    status?: number;
    code?: string;
    origin?: string;
    message?: string;
  } = {}) => ({
    status: typeof args.status === 'number' ? args.status : 422,
    body: {
      error: {
        message: typeof args.message === 'string' && args.message.trim()
          ? args.message
          : 'Unable to resume Responses conversation',
        type: 'invalid_request_error',
        code: typeof args.code === 'string' && args.code.trim()
          ? args.code
          : 'responses_resume_failed',
        origin: typeof args.origin === 'string' && args.origin.trim()
          ? args.origin
          : 'client',
      },
    },
  })),
  shouldProjectResponsesResumeClientErrorForHttpNative: jest.fn((origin?: string) =>
    typeof origin === 'string' && origin.trim() === 'client'
  ),
  buildResponsesResumeControlForContinuationContextForHttpNative: jest.fn(
    buildResponsesResumeControlForContinuationContextForHttpFake
  ),
  finalizeResponsesHandlerPayloadForHttpNative: jest.fn(finalizeResponsesHandlerPayloadForHttpFake),
  buildResponsesConversationPortScopeForHttpNative: jest.fn((portContext?: {
    matchedPort?: unknown;
    localPort?: unknown;
    routingPolicyGroup?: unknown;
  } | null) => ({
    ...(typeof portContext?.matchedPort === 'number'
      ? { matchedPort: portContext.matchedPort }
      : typeof portContext?.localPort === 'number'
        ? { matchedPort: portContext.localPort }
        : {}),
    ...(typeof portContext?.routingPolicyGroup === 'string' && portContext.routingPolicyGroup.trim()
      ? { routingPolicyGroup: portContext.routingPolicyGroup.trim() }
      : {})
  })),
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
  buildResponsesPayloadFromChatNative: jest.fn((payload: any) => payload),
  projectResponsesClientPayloadForClientNative: jest.fn((args: any) => args?.payload ?? args),
  planResponsesJsonClientDispatchNative: jest.fn(() => ({ action: 'direct_passthrough' })),
  projectResponsesSseFrameForClientNative: jest.fn((args: any) => ({
    emit: true,
    frame: args?.frame ?? '',
    state: args?.state ?? {},
  })),
  updateResponsesSseTransportTerminalStateNative: jest.fn((input: any) => ({
    state: input?.state ?? {},
    observedTerminal: String(input?.chunk ?? '').includes('response.completed') || String(input?.chunk ?? '').includes('response.done'),
  })),
  classifyEmptyResponseSignalNative: jest.fn(() => ({ isEmpty: false, empty: false })),
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
  convertResponsesRequestToChatNative: jest.fn(),
  normalizeAssistantTextToToolCallsJson: jest.fn(),
  sanitizeProviderOutboundPayload: jest.fn((payload: unknown) => payload)
});

const mockConfigIntegrationsModule = () => ({
  buildRouteCodexForwarderProfilesSync: jest.fn(() => ({})),
  buildRouteCodexProviderProfilesSync: jest.fn(() => ({})),
  collectRouteCodexV2ConfigSourceErrorsSync: jest.fn(() => []),
  compileRouteCodexRuntimeManifest: jest.fn(async () => ({
    manifestVersion: 'routecodex.runtime-config.v1',
    virtualRouterBootstrapInput: {},
    pipelineRuntimeConfig: {},
    providerIds: [],
    forwarderIds: [],
  })),
  compileRouteCodexRuntimeManifestSync: jest.fn(() => ({
    manifestVersion: 'routecodex.runtime-config.v1',
    virtualRouterBootstrapInput: {},
    pipelineRuntimeConfig: {},
    providerIds: [],
    forwarderIds: [],
  })),
  coerceRouteCodexProviderConfigV2Sync: jest.fn((parsed: unknown) => parsed),
  decodeRouteCodexProviderConfigTextSync: jest.fn((input: { raw?: string }) => ({
    format: 'toml',
    parsed: input.raw ? { raw: input.raw } : {}
  })),
  decodeRouteCodexUserConfigTextSync: jest.fn((input: { raw?: string }) => ({
    format: 'toml',
    parsed: input.raw ? { raw: input.raw } : {}
  })),
  detectRouteCodexProviderConfigFormatSync: jest.fn(() => 'toml'),
  detectRouteCodexUserConfigFormatSync: jest.fn(() => 'toml'),
  extractRouteCodexMaterializedProviderConfigsSync: jest.fn(() => null),
  loadRouteCodexConfigNativeSync: jest.fn(() => ({
    configPath: '/tmp/routecodex-test/config.toml',
    userConfig: {},
    providerProfiles: {}
  })),
  loadRouteCodexProviderConfigsV2FromRootSync: jest.fn(() => ({})),
  materializeRouteCodexUserConfigFromManifestSync: jest.fn((userConfig: unknown) => userConfig ?? {}),
  normalizeRouteCodexV2RuntimeSourceSync: jest.fn((userConfig: unknown) => userConfig ?? {}),
  parseRouteCodexTomlRecordSync: jest.fn(() => ({})),
  planAuthFileResolutionNativeSync: jest.fn(() => ({ kind: 'literal', value: '' })),
  planProviderConfigRootNativeSync: jest.fn(() => ({})),
  planRouteCodexConfigLoaderPathsNativeSync: jest.fn(() => ({})),
  planRouteCodexProviderConfigV2FilesSync: jest.fn((fileNames: string[]) =>
    fileNames.map((fileName) => ({ fileName, isBaseFile: fileName === 'config.v2.toml' }))
  ),
  resolveAuthFileKeyNativeSync: jest.fn(() => ({ kind: 'literal', value: '' })),
  resolvePrimaryRouteCodexRoutingPolicyGroupSync: jest.fn(() => undefined),
  resolveRccPathNativeSync: (segments?: unknown) => {
    const parts = Array.isArray(segments) ? segments.map(String) : [];
    return ['/tmp/routecodex-test', ...parts].join('/');
  },
  resolveRccSnapshotsDirNativeSync: jest.fn(() => '/tmp/routecodex-test/codex-samples'),
  resolveRccUserDirNativeSync: jest.fn(() => '/tmp/routecodex-test'),
  resolveRouteCodexConfigPathNativeSync: jest.fn(() => '/tmp/routecodex-test/config.toml'),
  resolveRouteCodexProviderConfigV2IdentitySync: jest.fn((input: { provider?: unknown; dirId?: string }) => ({
    providerId: String(input.dirId ?? 'test'),
    provider: input.provider && typeof input.provider === 'object' ? input.provider : {}
  })),
  serializeRouteCodexTomlRecordSync: jest.fn((record: unknown) => JSON.stringify(record ?? {})),
  updateRouteCodexTomlStringScalarInTableSync: jest.fn((input: { raw?: string }) => String(input.raw ?? '')),
  updateRouteCodexUserConfigStringScalarNativeSync: jest.fn((input: { configPath?: string; value?: unknown }) => ({
    path: input.configPath ?? '/tmp/routecodex-test/config.toml',
    format: 'toml',
    raw: String(input.value ?? ''),
    parsed: {},
  })),
  writeRouteCodexProviderConfigFileNativeSync: jest.fn((input: { configPath?: string; parsed?: Record<string, unknown> }) => ({
    path: input.configPath ?? '/tmp/routecodex-test/provider/config.v2.toml',
    format: 'toml',
    raw: '',
    parsed: input.parsed ?? {},
  })),
  writeRouteCodexUserConfigFileNativeSync: jest.fn((input: { configPath?: string; parsed?: Record<string, unknown> }) => ({
    path: input.configPath ?? '/tmp/routecodex-test/config.toml',
    format: 'toml',
    raw: '',
    parsed: input.parsed ?? {},
  })),
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/runtime-integrations.js', mockRuntimeIntegrationsModule);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/runtime-integrations.ts', mockRuntimeIntegrationsModule);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/runtime-integrations', mockRuntimeIntegrationsModule);
mockLlmswitchBridgeHostModule('config-integrations', mockConfigIntegrationsModule);
mockLlmswitchBridgeHostExports('error-projection-host', ['projectSseErrorEventPayloadNative']);
mockLlmswitchBridgeHostExports('executor-metadata-host', [
  'extractServertoolCliResultRouteHintFromRequestNative',
  'extractSessionIdentifiersFromMetadataNative',
]);
mockLlmswitchBridgeHostExports('finish-reason-host', ['deriveFinishReasonNative']);
mockLlmswitchBridgeHostExports('mimoweb-tool-harvest-host', ['normalizeAssistantTextToToolCallsJson']);
mockLlmswitchBridgeHostExports('provider-outbound-sanitize-host', ['sanitizeProviderOutboundPayload']);
mockLlmswitchBridgeHostExports('request-executor-pipeline-attempt-host', [
  'mergeObservedRoutePoolChainNative',
  'normalizeExplicitRoutePoolNative',
]);
mockLlmswitchBridgeHostExports('responses-client-projection-host', [
  'buildResponsesPayloadFromChatNative',
  'planResponsesJsonClientDispatchNative',
  'projectResponsesClientPayloadForClientNative',
]);
mockLlmswitchBridgeHostExports('responses-request-handler-host', [
  'buildResponsesConversationPortScopeForHttpNative',
  'buildResponsesResumeClientErrorForHttpNative',
  'buildResponsesResumeControlForContinuationContextForHttpNative',
  'buildResponsesScopeContinuationExpiredErrorForHttpNative',
  'captureReqInboundResponsesContextSnapshotJson',
  'extractSessionIdentifiersFromMetadataNative',
  'finalizeResponsesHandlerPayloadForHttpNative',
  'materializeProviderOwnedSubmitContext',
  'planResponsesContinuationRequestAction',
  'planResponsesHandlerEntry',
  'planResponsesHandlerStreamForHttpNative',
  'planResponsesRequestBodyForHttpNative',
  'planResponsesRequestContext',
  'shouldManageResponsesConversationForHttpNative',
  'shouldProjectResponsesResumeClientErrorForHttpNative',
]);
mockLlmswitchBridgeHostExports('responses-to-chat-host', ['convertResponsesRequestToChatNative']);
mockLlmswitchBridgeHostExports('route-availability-host', [
  'evaluateSingletonRoutePoolExhaustionNative',
  'planPrimaryExhaustedToDefaultPoolNative',
  'resolveErrorErr05RouteAvailabilityDecisionNative',
]);
mockLlmswitchBridgeHostExports('snapshot-hooks-host', [
  'appendSnapshotStageTraceNative',
  'classifyRuntimeErrorSignalNative',
  'classifyEmptyResponseSignalNative',
  'detectToolExecutionFailuresNative',
  'getSnapshotHooksNativeBindingSync',
  'resetSnapshotRecorderErrorsampleStateNative',
  'resolveRequestTailSummaryNative',
  'shouldInspectRuntimeErrorFastNative',
  'shouldInspectToolFailuresNative',
  'shouldLogClientToolErrorToConsoleNative',
  'shouldLogRuntimeErrorSignalToConsoleNative',
  'shouldRecordSnapshotsNative',
  'shouldWriteClientToolErrorsampleNative',
  'summarizeSnapshotStageTraceNative',
  'summarizeClientToolObservationNative',
  'writeSnapshotViaHooksNative',
]);
mockLlmswitchBridgeHostExports('sse-projection-host', [
  'projectResponsesSseFrameForClientNative',
  'updateResponsesSseTransportTerminalStateNative',
]);
mockLlmswitchBridgeHostExports('traffic-governor-host', ['getRouterHotpathJsonBindingSync']);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/routing-integrations.js', () => ({
  executeHubPipelineNative: (handle: string, input: unknown) => {
    const execute = mockHubPipelineExecutors.get(handle);
    if (!execute) {
      throw new Error(`missing test Hub pipeline fixture for handle ${handle}`);
    }
    return materializeHubPipelineFixtureResult(execute(materializeHubPipelineFixtureInput(input)));
  },
  markHubPipelineVirtualRouterConcurrencyScopeBusyNative: jest.fn(),
  markHubPipelineVirtualRouterConcurrencyScopeIdleNative: jest.fn(),
  buildRequestStageRuntimeControlWritePlanNative: jest.fn(() => ({ runtimeControl: null })),
  resolveEntryProtocolFromEndpointNative: createBridgeNativeFixtures().resolveEntryProtocolFromEndpointNative,
  resolveRccPathNativeSync: (segments?: unknown) => {
    const parts = Array.isArray(segments) ? segments.map(String) : [];
    return ['/tmp/routecodex-test', ...parts].join('/');
  },
	  resolveRccSnapshotsDirNativeSync: () => '/tmp/routecodex-test/codex-samples',
	  resolveRccUserDirNativeSync: () => '/tmp/routecodex-test',
	  detectRouteCodexProviderConfigFormatSync: () => 'toml',
	  decodeRouteCodexProviderConfigTextSync: (input: { raw?: string }) => ({
	    format: 'toml',
	    parsed: input.raw ? { raw: input.raw } : {}
	  }),
	  coerceRouteCodexProviderConfigV2Sync: (parsed: unknown) => parsed,
	  parseRouteCodexTomlRecordSync: () => ({}),
	  serializeRouteCodexTomlRecordSync: (record: unknown) => JSON.stringify(record ?? {}),
	  updateRouteCodexTomlStringScalarInTableSync: (input: { raw?: string }) => String(input.raw ?? ''),
	  detectRouteCodexUserConfigFormatSync: () => 'toml',
	  decodeRouteCodexUserConfigTextSync: (input: { raw?: string }) => ({
	    format: 'toml',
	    parsed: input.raw ? { raw: input.raw } : {}
	  }),
	  writeRouteCodexUserConfigFileNativeSync: jest.fn(),
	  writeRouteCodexProviderConfigFileNativeSync: jest.fn(),
	  updateRouteCodexUserConfigStringScalarNativeSync: (input: { raw?: string }) => String(input.raw ?? ''),
	  loadRouteCodexConfigNativeSync: jest.fn(() => ({
	    configPath: '/tmp/routecodex-test/config.toml',
	    userConfig: {},
	    providerProfiles: {}
	  })),
	  resolveRouteCodexProviderConfigV2IdentitySync: (input: { provider?: unknown; dirId?: string }) => ({
	    providerId: String(input.dirId ?? 'test'),
	    provider: input.provider && typeof input.provider === 'object' ? input.provider : {}
	  }),
	  loadRouteCodexProviderConfigsV2FromRootSync: jest.fn(() => ({})),
	  planAuthFileResolutionNativeSync: jest.fn(() => ({ kind: 'literal', value: '' })),
	  planRouteCodexConfigLoaderPathsNativeSync: jest.fn(() => ({})),
	  planProviderConfigRootNativeSync: jest.fn(() => ({})),
	  resolveAuthFileKeyNativeSync: jest.fn(() => ''),
	  resolveRouteCodexConfigPathNativeSync: jest.fn(() => '/tmp/routecodex-test/config.toml'),
	  planRouteCodexProviderConfigV2FilesSync: (fileNames: string[]) =>
	    fileNames.map((fileName) => ({ fileName, isBaseFile: fileName === 'config.v2.toml' }))
	}));
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/routing-integrations.ts', () => ({
  executeHubPipelineNative: (handle: string, input: unknown) => {
    const execute = mockHubPipelineExecutors.get(handle);
    if (!execute) {
      throw new Error(`missing test Hub pipeline fixture for handle ${handle}`);
    }
    return materializeHubPipelineFixtureResult(execute(materializeHubPipelineFixtureInput(input)));
  },
  markHubPipelineVirtualRouterConcurrencyScopeBusyNative: jest.fn(),
  markHubPipelineVirtualRouterConcurrencyScopeIdleNative: jest.fn(),
  buildRequestStageRuntimeControlWritePlanNative: jest.fn(() => ({ runtimeControl: null })),
  resolveEntryProtocolFromEndpointNative: createBridgeNativeFixtures().resolveEntryProtocolFromEndpointNative,
  resolveRccPathNativeSync: (segments?: unknown) => {
    const parts = Array.isArray(segments) ? segments.map(String) : [];
    return ['/tmp/routecodex-test', ...parts].join('/');
  },
	  resolveRccSnapshotsDirNativeSync: () => '/tmp/routecodex-test/codex-samples',
	  resolveRccUserDirNativeSync: () => '/tmp/routecodex-test',
	  detectRouteCodexProviderConfigFormatSync: () => 'toml',
	  decodeRouteCodexProviderConfigTextSync: (input: { raw?: string }) => ({
	    format: 'toml',
	    parsed: input.raw ? { raw: input.raw } : {}
	  }),
	  coerceRouteCodexProviderConfigV2Sync: (parsed: unknown) => parsed,
	  parseRouteCodexTomlRecordSync: () => ({}),
	  serializeRouteCodexTomlRecordSync: (record: unknown) => JSON.stringify(record ?? {}),
	  updateRouteCodexTomlStringScalarInTableSync: (input: { raw?: string }) => String(input.raw ?? ''),
	  detectRouteCodexUserConfigFormatSync: () => 'toml',
	  decodeRouteCodexUserConfigTextSync: (input: { raw?: string }) => ({
	    format: 'toml',
	    parsed: input.raw ? { raw: input.raw } : {}
	  }),
	  writeRouteCodexUserConfigFileNativeSync: jest.fn(),
	  writeRouteCodexProviderConfigFileNativeSync: jest.fn(),
	  updateRouteCodexUserConfigStringScalarNativeSync: (input: { raw?: string }) => String(input.raw ?? ''),
	  loadRouteCodexConfigNativeSync: jest.fn(() => ({
	    configPath: '/tmp/routecodex-test/config.toml',
	    userConfig: {},
	    providerProfiles: {}
	  })),
	  resolveRouteCodexProviderConfigV2IdentitySync: (input: { provider?: unknown; dirId?: string }) => ({
	    providerId: String(input.dirId ?? 'test'),
	    provider: input.provider && typeof input.provider === 'object' ? input.provider : {}
	  }),
	  loadRouteCodexProviderConfigsV2FromRootSync: jest.fn(() => ({})),
	  planAuthFileResolutionNativeSync: jest.fn(() => ({ kind: 'literal', value: '' })),
	  planRouteCodexConfigLoaderPathsNativeSync: jest.fn(() => ({})),
	  planProviderConfigRootNativeSync: jest.fn(() => ({})),
	  resolveAuthFileKeyNativeSync: jest.fn(() => ''),
	  resolveRouteCodexConfigPathNativeSync: jest.fn(() => '/tmp/routecodex-test/config.toml'),
	  planRouteCodexProviderConfigV2FilesSync: (fileNames: string[]) =>
	    fileNames.map((fileName) => ({ fileName, isBaseFile: fileName === 'config.v2.toml' }))
	}));
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/routing-integrations', () => ({
  executeHubPipelineNative: (handle: string, input: unknown) => {
    const execute = mockHubPipelineExecutors.get(handle);
    if (!execute) {
      throw new Error(`missing test Hub pipeline fixture for handle ${handle}`);
    }
    return materializeHubPipelineFixtureResult(execute(materializeHubPipelineFixtureInput(input)));
  },
  markHubPipelineVirtualRouterConcurrencyScopeBusyNative: jest.fn(),
  markHubPipelineVirtualRouterConcurrencyScopeIdleNative: jest.fn(),
  buildRequestStageRuntimeControlWritePlanNative: jest.fn(() => ({ runtimeControl: null })),
  resolveEntryProtocolFromEndpointNative: createBridgeNativeFixtures().resolveEntryProtocolFromEndpointNative,
  resolveRccPathNativeSync: (segments?: unknown) => {
    const parts = Array.isArray(segments) ? segments.map(String) : [];
    return ['/tmp/routecodex-test', ...parts].join('/');
  },
	  resolveRccSnapshotsDirNativeSync: () => '/tmp/routecodex-test/codex-samples',
	  resolveRccUserDirNativeSync: () => '/tmp/routecodex-test',
	  detectRouteCodexProviderConfigFormatSync: () => 'toml',
	  decodeRouteCodexProviderConfigTextSync: (input: { raw?: string }) => ({
	    format: 'toml',
	    parsed: input.raw ? { raw: input.raw } : {}
	  }),
	  coerceRouteCodexProviderConfigV2Sync: (parsed: unknown) => parsed,
	  parseRouteCodexTomlRecordSync: () => ({}),
	  serializeRouteCodexTomlRecordSync: (record: unknown) => JSON.stringify(record ?? {}),
	  updateRouteCodexTomlStringScalarInTableSync: (input: { raw?: string }) => String(input.raw ?? ''),
	  detectRouteCodexUserConfigFormatSync: () => 'toml',
	  decodeRouteCodexUserConfigTextSync: (input: { raw?: string }) => ({
	    format: 'toml',
	    parsed: input.raw ? { raw: input.raw } : {}
	  }),
	  writeRouteCodexUserConfigFileNativeSync: jest.fn(),
	  writeRouteCodexProviderConfigFileNativeSync: jest.fn(),
	  updateRouteCodexUserConfigStringScalarNativeSync: (input: { raw?: string }) => String(input.raw ?? ''),
	  loadRouteCodexConfigNativeSync: jest.fn(() => ({
	    configPath: '/tmp/routecodex-test/config.toml',
	    userConfig: {},
	    providerProfiles: {}
	  })),
	  resolveRouteCodexProviderConfigV2IdentitySync: (input: { provider?: unknown; dirId?: string }) => ({
	    providerId: String(input.dirId ?? 'test'),
	    provider: input.provider && typeof input.provider === 'object' ? input.provider : {}
	  }),
	  loadRouteCodexProviderConfigsV2FromRootSync: jest.fn(() => ({})),
	  planAuthFileResolutionNativeSync: jest.fn(() => ({ kind: 'literal', value: '' })),
	  planRouteCodexConfigLoaderPathsNativeSync: jest.fn(() => ({})),
	  planProviderConfigRootNativeSync: jest.fn(() => ({})),
	  resolveAuthFileKeyNativeSync: jest.fn(() => ''),
	  resolveRouteCodexConfigPathNativeSync: jest.fn(() => '/tmp/routecodex-test/config.toml'),
	  planRouteCodexProviderConfigV2FilesSync: (fileNames: string[]) =>
	    fileNames.map((fileName) => ({ fileName, isBaseFile: fileName === 'config.v2.toml' }))
	}));

jest.unstable_mockModule('../../../src/server/runtime/http-server/executor/provider-response-converter.js', () => ({
  convertProviderResponseIfNeeded: mockConvertProviderResponseIfNeeded
}));
jest.unstable_mockModule('../../../src/server/runtime/http-server/executor/provider-response-converter.ts', () => ({
  convertProviderResponseIfNeeded: mockConvertProviderResponseIfNeeded
}));

jest.unstable_mockModule('../../../src/server/runtime/http-server/servertool-admin-state.js', () => ({
  getServerToolRuntimeState: () => ({ enabled: false }),
  isServerToolEnabled: () => false,
  logServerToolFiring: jest.fn(),
  readServerToolStatsSnapshot: jest.fn(() => ({})),
  setServerToolEnabled: jest.fn(() => ({ enabled: false }))
}));
jest.unstable_mockModule('../../../src/server/runtime/http-server/servertool-admin-state.ts', () => ({
  getServerToolRuntimeState: () => ({ enabled: false }),
  isServerToolEnabled: () => false,
  logServerToolFiring: jest.fn(),
  readServerToolStatsSnapshot: jest.fn(() => ({})),
  setServerToolEnabled: jest.fn(() => ({ enabled: false }))
}));

const { createRequestExecutor, __requestExecutorTestables } = await import(
  '../../../src/server/runtime/http-server/request-executor.js'
);
const { StatsManager } = await import('../../../src/server/runtime/http-server/stats-manager.js');
const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');
const { handleChatCompletions } = await import('../../../src/server/handlers/chat-handler.js');
const { handleMessages } = await import('../../../src/server/handlers/messages-handler.js');
const { MetadataCenter } = await import('../../../src/server/runtime/http-server/metadata-center/metadata-center.js');

function readStreamIntent(metadata: Record<string, unknown> | undefined): string | undefined {
  return MetadataCenter.read(metadata)?.readRuntimeControl().streamIntent;
}

function readResponsesResume(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const value = MetadataCenter.read(metadata)?.readContinuationContext().responsesResume;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readResponsesRequestContext(metadata: Record<string, unknown> | undefined): Record<string, any> | undefined {
  const testProjected = asPlainRecord((metadata as Record<string, any> | undefined)?.[TEST_RESPONSES_REQUEST_CONTEXT_KEY]);
  if (testProjected) {
    return testProjected;
  }
  const value = (MetadataCenter.read(metadata)?.readContinuationContext() as Record<string, unknown> | undefined)?.responsesRequestContext;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function readRequestTruth(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const value = MetadataCenter.read(metadata)?.readRequestTruth();
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readRuntimeControl(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const value = MetadataCenter.read(metadata)?.readRuntimeControl();
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function listenApp(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function closeServer(server?: http.Server): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fetchJson(baseUrl: string, routePath: string, body: unknown): Promise<{ status: number; payload: any; text: string; headers: Headers }> {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    payload: text ? JSON.parse(text) : null,
    text,
    headers: response.headers
  };
}

function createSingleHandleRuntimeManager(handle: ReturnType<typeof createProviderHandle>) {
  return {
    resolveRuntimeKey: (providerKey?: string, fallback?: string) => {
      if (!providerKey && fallback) {
        return fallback;
      }
      if (providerKey === handle.providerKey || providerKey === handle.providerId || providerKey === handle.runtimeKey) {
        return handle.runtimeKey;
      }
      return fallback;
    },
    getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey === handle.runtimeKey ? handle : undefined)
  };
}

async function waitForMockCalls(mock: { mock: { calls: unknown[] } }, minCalls: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (mock.mock.calls.length < minCalls && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fetchText(baseUrl: string, routePath: string, options: {
  body: string;
  headers: Record<string, string>;
}): Promise<{ status: number; body: string; headers: Headers }> {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method: 'POST',
    headers: options.headers,
    body: options.body
  });
  return {
    status: response.status,
    body: await response.text(),
    headers: response.headers
  };
}

function createProviderHandle(args: {
  runtimeKey: string;
  providerKey: string;
  providerType: 'anthropic' | 'gemini';
  providerProtocol: 'anthropic-messages' | 'gemini-chat';
  processIncoming: (payload: Record<string, unknown>) => Promise<unknown>;
}) {
  return {
    runtimeKey: args.runtimeKey,
    providerId: args.providerKey,
    providerKey: args.providerKey,
    providerType: args.providerType,
    providerFamily: args.providerType,
    providerProtocol: args.providerProtocol,
    runtime: {
      runtimeKey: args.runtimeKey,
      providerId: args.providerKey,
      keyAlias: args.providerKey,
      providerType: args.providerType,
      endpoint: `mock://${args.providerType}`,
      auth: { type: 'apiKey', value: 'mock' },
      outboundProfile: args.providerProtocol
    },
    instance: {
      initialize: async () => {},
      cleanup: async () => {},
      processIncoming: args.processIncoming
    }
  } as any;
}

describe('HTTP handler -> request-executor unified semantics E2E', () => {
  jest.setTimeout(20_000);

function buildComputerUseNamespaceTools(): Array<Record<string, unknown>> {
  const functionTool = (name: string) => ({
    type: 'function',
    name,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  });

  return [
    functionTool('exec_command'),
    functionTool('write_stdin'),
    functionTool('apply_patch'),
    functionTool('update_plan'),
    {
      type: 'namespace',
      name: 'mcp__computer_use__',
      description: 'Computer Use tools',
      tools: [
        {
          type: 'function',
          name: 'get_app_state',
          defer_loading: true,
          parameters: {
            type: 'object',
            properties: {
              app: { type: 'string' }
            },
            required: ['app'],
            additionalProperties: false
          }
        },
        {
          type: 'function',
          name: 'click',
          parameters: {
            type: 'object',
            properties: {
              app: { type: 'string' },
              element_index: { type: 'string' }
            },
            required: ['app'],
            additionalProperties: false
          }
        }
      ]
    }
  ];
}

  beforeEach(() => {
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
    mockCaptureResponsesRequestContext.mockClear();
    mockRecordResponsesResponseForRequest.mockClear();
    mockResumeResponsesConversation.mockReset();
    mockResumeLatestResponsesContinuationByScope.mockReset();
    mockMaterializeLatestResponsesContinuationByScope.mockReset();
    mockPlanResponsesHandlerEntry.mockReset();
    mockPlanResponsesHandlerEntry.mockImplementation(async (payload: any, entryEndpoint?: string, responseIdFromPath?: string) =>
      defaultPlanResponsesHandlerEntry(payload, entryEndpoint, responseIdFromPath)
    );
  });

  afterEach(async () => {
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
  });

  it('keeps responses endpoint inbound payload intact and restores previous_response_id at final HTTP response', async () => {
    const pipelineExecute = jest.fn((input: any) => ({
      providerPayload: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 responses handler 整链验证' }]
      },
      standardizedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 responses handler 整链验证' }]
      },
      processedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 responses handler 整链验证' }],
        semantics: {
          continuation: {
            chainId: 'req_chain_http_responses_1',
            stickyScope: 'request_chain',
            stateOrigin: 'openai-responses',
            resumeFrom: {
              protocol: 'openai-responses',
              requestId: 'req_chain_http_responses_1',
              previousResponseId: 'resp_prev_http_responses_1'
            }
          },
          audit: {
            protocolMapping: {
              unsupported: [
                {
                  field: 'response_format',
                  disposition: 'unsupported',
                  sourceProtocol: 'openai-responses',
                  targetProtocol: 'anthropic-messages',
                  reason: 'structured_output_not_supported',
                  source: 'chat.parameters'
                }
              ]
            }
          }
        }
      },
      target: {
        providerKey: 'mock.anthropic.responses',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:anthropic:responses',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: '继续执行 responses handler 整链验证' }]
        }
      }
    }));

    const processIncoming = jest.fn(async (payload: Record<string, unknown>) => ({
      status: 200,
      data: {
        id: 'msg_http_responses_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: `responses handler 整链响应: ${JSON.stringify(payload)}` }],
        stop_reason: 'end_turn'
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:anthropic:responses',
      providerKey: 'mock.anthropic.responses',
      providerType: 'anthropic',
      providerProtocol: 'anthropic-messages',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: createSingleHandleRuntimeManager(handle),
      getHubPipeline: () => registerHubPipelineFixture(pipelineExecute) as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses', (req, res) => {
      void handleResponses(req as any, res as any, {
        executePipeline: (input) => executeRequestExecutorWithServerInput(executor, input),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/responses', {
        model: 'claude-sonnet-4-5',
        stream: false,
        previous_response_id: 'resp_prev_http_responses_1',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '继续执行 responses handler 整链验证' }]
          }
        ],
        response_format: { type: 'json_object' }
      });

      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({
        object: 'response',
        previous_response_id: 'resp_prev_http_responses_1',
        status: 'completed'
      });
      expect(JSON.stringify(result.payload)).toContain('responses handler 整链响应');

      expect(pipelineExecute).toHaveBeenCalledTimes(1);
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.endpoint).toBe('/v1/responses');
      expect(pipelineInput.metadata?.providerProtocol).toBe('openai-responses');
      expect(pipelineInput.payload?.previous_response_id).toBe('resp_prev_http_responses_1');
      expect(pipelineInput.payload?.response_format).toEqual({ type: 'json_object' });
      expect(readResponsesRequestContext(pipelineInput.metadata)?.payload?.previous_response_id).toBe('resp_prev_http_responses_1');

      expect(processIncoming).toHaveBeenCalledTimes(1);
      expect(processIncoming).toHaveBeenCalledWith(expect.objectContaining({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 responses handler 整链验证' }]
      }));
    } finally {
      await closeServer(server);
    }
  });

  it('RED: plain /v1/responses previous_response_id must lookup continuation owner and mark direct remote continuation for same-protocol routing', async () => {
    const mockLookupResponsesContinuationByResponseId =
      (await import('../../../src/modules/llmswitch/bridge/runtime-integrations.js'))
        .lookupResponsesContinuationByResponseId as jest.Mock;
    mockLookupResponsesContinuationByResponseId.mockResolvedValueOnce({
      responseId: 'resp_prev_http_direct_1',
      providerKey: 'dibittai.crsa.gpt-5.4',
      continuationOwner: 'direct',
      entryKind: 'responses',
      requestId: 'req_prev_http_direct_1',
    });

    const pipelineExecute = jest.fn((input: any) => ({
      providerPayload: {
        model: 'gpt-5.4',
        previous_response_id: input?.payload?.previous_response_id ?? null,
        input: input?.payload?.input ?? [],
      },
      standardizedRequest: {
        model: 'gpt-5.4',
        previous_response_id: input?.payload?.previous_response_id ?? null,
        input: input?.payload?.input ?? [],
      },
      processedRequest: {
        model: 'gpt-5.4',
        previous_response_id: input?.payload?.previous_response_id ?? null,
        input: input?.payload?.input ?? [],
      },
      target: {
        providerKey: 'dibittai.crsa.gpt-5.4',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:openai:responses',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'gpt-5.4',
          input: input?.payload?.input ?? [],
        }
      }
    }));

    const processIncoming = jest.fn(async (_payload: Record<string, unknown>) => ({
      status: 200,
      data: {
        id: 'resp_prev_http_direct_1_next',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'plain previous_response_id direct continuation' }]
          }
        ]
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:openai:responses',
      providerKey: 'dibittai.crsa.gpt-5.4',
      providerType: 'openai',
      providerProtocol: 'openai-responses',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: createSingleHandleRuntimeManager(handle),
      getHubPipeline: () => registerHubPipelineFixture(pipelineExecute) as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses', (req, res) => {
      void handleResponses(req as any, res as any, {
        executePipeline: (input) => executeRequestExecutorWithServerInput(executor, input),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/responses', {
        model: 'gpt-5.4',
        stream: false,
        previous_response_id: 'resp_prev_http_direct_1',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '继续 direct continuation' }]
          }
        ]
      });

      expect(result.status).toBe(200);
      expect(pipelineExecute).toHaveBeenCalledTimes(1);
      expect(mockLookupResponsesContinuationByResponseId).toHaveBeenCalledWith(
        'resp_prev_http_direct_1',
        expect.objectContaining({ entryKind: 'responses' }),
      );
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(readResponsesResume(pipelineInput.metadata)).toMatchObject({
        responseId: 'resp_prev_http_direct_1',
        continuationOwner: 'direct',
        providerKey: 'dibittai.crsa.gpt-5.4',
        restored: false,
      });
    } finally {
      await closeServer(server);
    }
  });

  it('RED: plain /v1/responses previous_response_id with relay owner must materialize local full input and skip direct remote continuation', async () => {
    const mockLookupResponsesContinuationByResponseId =
      (await import('../../../src/modules/llmswitch/bridge/runtime-integrations.js'))
        .lookupResponsesContinuationByResponseId as jest.Mock;
    mockLookupResponsesContinuationByResponseId.mockResolvedValueOnce({
      responseId: 'resp_prev_http_relay_1',
      providerKey: 'minimonth.key1.MiniMax-M2.7',
      continuationOwner: 'relay',
      entryKind: 'responses',
      requestId: 'req_prev_http_relay_1',
    });
    mockMaterializeLatestResponsesContinuationByScope.mockResolvedValueOnce({
      payload: {
        model: 'gpt-5.5',
        input: [
          {
            type: 'function_call',
            id: 'fc_prev_http_relay_1',
            call_id: 'call_prev_http_relay_1',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
          },
          {
            type: 'function_call_output',
            id: 'fc_prev_http_relay_1',
            call_id: 'call_prev_http_relay_1',
            output: '/tmp',
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: '继续 relay continuation' }],
          },
        ],
        tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
      },
      meta: {
        restoredFromResponseId: 'resp_prev_http_relay_1',
        previousRequestId: 'req_prev_http_relay_1',
        providerKey: 'minimonth.key1.MiniMax-M2.7',
        continuationOwner: 'relay',
        materialized: true,
        materializedMode: 'local_full_input',
      }
    });

    const pipelineExecute = jest.fn((input: any) => {
      const firstInput = input?.payload?.input?.[0];
      if (firstInput?.type === 'function_call_output') {
        throw new Error('orphan_tool_result: first item must not start with output-only replay');
      }
      return {
        providerPayload: {
          model: 'gpt-5.5',
          input: input?.payload?.input ?? [],
        },
        standardizedRequest: {
          model: 'gpt-5.5',
          input: input?.payload?.input ?? [],
        },
        processedRequest: {
          model: 'gpt-5.5',
          input: input?.payload?.input ?? [],
        },
        target: {
          providerKey: 'minimonth.key1.MiniMax-M2.7',
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: 'runtime:openai:responses',
          processMode: 'standard'
        },
        processMode: 'standard',
        metadata: {
          capturedChatRequest: {
            model: 'gpt-5.5',
            input: input?.payload?.input ?? [],
          }
        }
      };
    });

    const processIncoming = jest.fn(async (_payload: Record<string, unknown>) => ({
      status: 200,
      data: {
        id: 'resp_prev_http_relay_1_next',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'plain previous_response_id relay continuation' }]
          }
        ]
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:openai:responses',
      providerKey: 'minimonth.key1.MiniMax-M2.7',
      providerType: 'openai',
      providerProtocol: 'openai-responses',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: createSingleHandleRuntimeManager(handle),
      getHubPipeline: () => registerHubPipelineFixture(pipelineExecute) as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses', (req, res) => {
      void handleResponses(req as any, res as any, {
        executePipeline: (input) => executeRequestExecutorWithServerInput(executor, input),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/responses', {
        model: 'gpt-5.5',
        stream: false,
        previous_response_id: 'resp_prev_http_relay_1',
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_prev_http_relay_1',
            output: '/tmp',
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: '继续 relay continuation' }],
          }
        ]
      });

      expect(result.status).toBe(200);
      expect(mockLookupResponsesContinuationByResponseId).toHaveBeenCalledWith(
        'resp_prev_http_relay_1',
        expect.objectContaining({ entryKind: 'responses' }),
      );
      expect(mockMaterializeLatestResponsesContinuationByScope).toHaveBeenCalledTimes(1);
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.payload?.previous_response_id).toBeUndefined();
      expect(pipelineInput.payload?.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'function_call', call_id: 'call_prev_http_relay_1' }),
          expect.objectContaining({ type: 'function_call_output', call_id: 'call_prev_http_relay_1', output: '/tmp' }),
          expect.objectContaining({ role: 'user' }),
        ]),
      );
      expect(readResponsesResume(pipelineInput.metadata)).toMatchObject({
        restoredFromResponseId: 'resp_prev_http_relay_1',
        continuationOwner: 'relay',
        materialized: true,
        materializedMode: 'local_full_input',
      });
      expect(readResponsesResume(pipelineInput.metadata)).not.toHaveProperty('providerKey');
    } finally {
      await closeServer(server);
    }
  });

  it('returns visible blocked exec_command feedback from HTTP /v1/responses for directory git checkout', async () => {
    const pipelineExecute = jest.fn(() => ({
      providerPayload: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'restore src dir' }] },
      standardizedRequest: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'restore src dir' }] },
      processedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'restore src dir' }],
        semantics: {
          tools: {
            clientToolsRaw: [
              {
                type: 'function',
                function: {
                  name: 'exec_command',
                  parameters: {
                    type: 'object',
                    properties: { cmd: { type: 'string' }, workdir: { type: 'string' } },
                    required: ['cmd'],
                    additionalProperties: false
                  }
                }
              }
            ]
          }
        }
      },
      target: {
        providerKey: 'mock.anthropic.responses',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:anthropic:responses',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    }));

    const processIncoming = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'msg_http_blocked_checkout_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [
          {
            type: 'tool_use',
            id: 'call_blocked_checkout_1',
            name: 'exec_command',
            input: {
              cmd: 'git checkout -- sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/',
              workdir: '/workspace'
            }
          }
        ],
        stop_reason: 'tool_use'
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:anthropic:responses',
      providerKey: 'mock.anthropic.responses',
      providerType: 'anthropic',
      providerProtocol: 'anthropic-messages',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: createSingleHandleRuntimeManager(handle),
      getHubPipeline: () => registerHubPipelineFixture(pipelineExecute) as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: { handleError: jest.fn(async () => ({ success: true })) }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses', (req, res) => {
      void handleResponses(req as any, res as any, {
        executePipeline: (input) => executeRequestExecutorWithServerInput(executor, input),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/responses', {
        model: 'claude-sonnet-4-5',
        stream: false,
        input: 'restore src dir',
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' }, workdir: { type: 'string' } },
              required: ['cmd'],
              additionalProperties: false
            }
          }
        ]
      });

      expect(result.status).toBe(200);
      const functionCall = result.payload?.output?.find((item: any) => item?.type === 'function_call');
      const args = JSON.parse(String(functionCall?.arguments || '{}'));
      expect(functionCall?.name).toBe('exec_command');
      expect(String(args.cmd || '')).toContain('blocked by exec_command guard');
      expect(String(args.cmd || '')).toContain('git checkout');
      expect(String(args.cmd || '')).not.toContain('RESTORED');
      expect(args.workdir).toBe('/workspace');
    } finally {
      await closeServer(server);
    }
  });




  it('keeps responses stream requests compatible when client does not advertise SSE accept', async () => {
    const pipelineExecute = jest.fn((_input: any) => ({
      providerPayload: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 responses handler 非 SSE accept 流式整链验证' }]
      },
      standardizedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 responses handler 非 SSE accept 流式整链验证' }]
      },
      processedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 responses handler 非 SSE accept 流式整链验证' }]
      },
      target: {
        providerKey: 'mock.anthropic.responses.stream',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:anthropic:responses:stream',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: '继续执行 responses handler 非 SSE accept 流式整链验证' }]
        }
      }
    }));

    const processIncoming = jest.fn(async (payload: Record<string, unknown>) => ({
      status: 200,
      data: {
        sseStream: Readable.from([
          'event: response.output_text.delta\n',
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'responses handler 非 SSE accept 流式整链响应' })}\n\n`,
          'event: response.completed\n',
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_stream_no_accept_1', object: 'response', status: 'completed' } })}\n\n`,
          'data: [DONE]\n\n'
        ])
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:anthropic:responses:stream',
      providerKey: 'mock.anthropic.responses.stream',
      providerType: 'anthropic',
      providerProtocol: 'anthropic-messages',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: createSingleHandleRuntimeManager(handle),
      getHubPipeline: () => registerHubPipelineFixture(pipelineExecute) as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses', (req, res) => {
      void handleResponses(req as any, res as any, {
        executePipeline: (input) => executeRequestExecutorWithServerInput(executor, input),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          stream: true,
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: '继续执行 responses handler 非 SSE accept 流式整链验证' }]
            }
          ]
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('event: response.output_text.delta');
      expect(text).toContain('responses handler 非 SSE accept 流式整链响应');
      expect(text).toContain('event: response.completed');
      expect(text).toContain('[DONE]');

      expect(pipelineExecute).toHaveBeenCalledTimes(1);
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.endpoint).toBe('/v1/responses');
      expect(pipelineInput.metadata?.providerProtocol).toBe('openai-responses');
      expect(readStreamIntent(pipelineInput.metadata)).toBe('stream');
      expect(pipelineInput.metadata?.inboundStream).toBeUndefined();
      expect(pipelineInput.metadata?.outboundStream).toBeUndefined();
      expect(pipelineInput.metadata?.clientStream).toBeUndefined();
      expect(pipelineInput.payload?.stream).toBe(true);

      expect(processIncoming).toHaveBeenCalledTimes(1);
      expect(processIncoming).toHaveBeenCalledWith(expect.objectContaining({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 responses handler 非 SSE accept 流式整链验证' }]
      }));
    } finally {
      await closeServer(server);
    }
  });

  it('keeps /v1/responses.submit_tool_outputs as a resumed synthetic pipeline request and preserves response continuity', async () => {
    mockResumeResponsesConversation.mockResolvedValue({
      payload: {
        model: 'claude-sonnet-4-5',
        previous_response_id: 'resp_submit_prev_1',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行 submit_tool_outputs 整链验证' }] }],
        tool_outputs: [{ tool_call_id: 'call_submit_1', output: 'ok' }]
      },
      meta: {
        previousRequestId: 'req_chain_submit_1',
        restoredFromResponseId: 'resp_submit_prev_1',
        routeHint: 'thinking'
      }
    });

    const pipelineExecute = jest.fn((_input: any) => ({
      providerPayload: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 submit_tool_outputs 整链验证' }]
      },
      standardizedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 submit_tool_outputs 整链验证' }]
      },
      processedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 submit_tool_outputs 整链验证' }],
        semantics: {
          continuation: {
            chainId: 'req_chain_submit_1',
            stickyScope: 'request_chain',
            stateOrigin: 'openai-responses',
            resumeFrom: {
              protocol: 'openai-responses',
              requestId: 'req_chain_submit_1',
              responseId: 'resp_submit_prev_1',
              previousResponseId: 'resp_submit_prev_1'
            },
            toolContinuation: {
              mode: 'submit_tool_outputs',
              submittedToolCallIds: ['call_submit_1']
            }
          }
        }
      },
      target: {
        providerKey: 'mock.anthropic.submit',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:anthropic:submit',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: '继续执行 submit_tool_outputs 整链验证' }]
        }
      }
    }));

    const processIncoming = jest.fn(async (payload: Record<string, unknown>) => ({
      status: 200,
      data: {
        id: 'msg_http_submit_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: `submit_tool_outputs 整链响应: ${JSON.stringify(payload)}` }],
        stop_reason: 'end_turn'
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:anthropic:submit',
      providerKey: 'mock.anthropic.submit',
      providerType: 'anthropic',
      providerProtocol: 'anthropic-messages',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: createSingleHandleRuntimeManager(handle),
      getHubPipeline: () => registerHubPipelineFixture(pipelineExecute) as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses/:id/submit_tool_outputs', (req, res) => {
      void handleResponses(
        req as any,
        res as any,
        {
          executePipeline: (input: any) => executeRequestExecutorWithServerInput(executor, input),
          errorHandling: null
        },
        {
          entryEndpoint: '/v1/responses.submit_tool_outputs',
          responseIdFromPath: (req as any).params.id
        }
      );
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/responses/resp_submit_prev_1/submit_tool_outputs', {
        stream: false,
        tool_outputs: [{ tool_call_id: 'call_submit_1', output: 'ok' }]
      });

      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({
        object: 'response',
        previous_response_id: 'resp_submit_prev_1',
        status: 'completed'
      });
      expect(JSON.stringify(result.payload)).toContain('submit_tool_outputs 整链响应');

      expect(mockResumeResponsesConversation).toHaveBeenCalledTimes(1);
      expect(mockResumeResponsesConversation).toHaveBeenCalledWith(
        'resp_submit_prev_1',
        {
          response_id: 'resp_submit_prev_1',
          stream: false,
          tool_outputs: [{ tool_call_id: 'call_submit_1', output: 'ok' }]
        },
        expect.objectContaining({ requestId: expect.any(String) })
      );

      expect(pipelineExecute).toHaveBeenCalledTimes(1);
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.endpoint).toBe('/v1/responses');
      expect(pipelineInput.metadata?.providerProtocol).toBe('openai-responses');
      expect(readStreamIntent(pipelineInput.metadata)).toBe('non_stream');
      expect(readRequestTruth(pipelineInput.metadata)).toMatchObject({
        entryEndpoint: '/v1/responses',
        requestId: expect.stringContaining('openai-responses-router-request-')
      });
      expect(pipelineInput.metadata?.inboundStream).toBeUndefined();
      expect(readResponsesResume(pipelineInput.metadata)).toEqual({
        previousRequestId: 'req_chain_submit_1',
        restoredFromResponseId: 'resp_submit_prev_1'
      });
      expect(readRuntimeControl(pipelineInput.metadata)).toMatchObject({
        streamIntent: 'non_stream'
      });
      expect(readRuntimeControl(pipelineInput.metadata)?.routeHint).toBeUndefined();
      expect(pipelineInput.metadata?.entryEndpoint).toBe('/v1/responses');
      expect(pipelineInput.payload?.previous_response_id).toBe('resp_submit_prev_1');
      expect(pipelineInput.payload?.tool_outputs).toEqual([{ tool_call_id: 'call_submit_1', output: 'ok' }]);
      expect(readResponsesRequestContext(pipelineInput.metadata)?.payload).toMatchObject({
        previous_response_id: 'resp_submit_prev_1',
        tool_outputs: [{ tool_call_id: 'call_submit_1', output: 'ok' }]
      });

      expect(processIncoming).toHaveBeenCalledTimes(1);
      expect(processIncoming).toHaveBeenCalledWith(expect.objectContaining({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 submit_tool_outputs 整链验证' }]
      }));
    } finally {
      await closeServer(server);
    }
  });

  it('preserves resumed relay session scope and provider pin through request executor before hub pipeline', async () => {
    mockResumeResponsesConversation.mockResolvedValue({
      payload: {
        model: 'gpt-5.5',
        previous_response_id: 'resp_submit_truth_1',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行 submit truth 整链验证' }] }],
        tool_outputs: [{ tool_call_id: 'call_submit_truth_1', output: 'ok' }]
      },
      meta: {
        previousRequestId: 'req_chain_submit_truth_1',
        restoredFromResponseId: 'resp_submit_truth_1',
        routeHint: 'search/gateway-priority-5555-priority-search',
        providerKey: 'minimonth.key1.MiniMax-M2.7',
        sessionId: 'sess-submit-truth-1',
        conversationId: 'conv-submit-truth-1',
        continuationOwner: 'relay'
      }
    });

    const pipelineExecute = jest.fn((_input: any) => ({
      providerPayload: {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: '继续执行 submit truth 整链验证' }]
      },
      standardizedRequest: {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: '继续执行 submit truth 整链验证' }]
      },
      processedRequest: {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: '继续执行 submit truth 整链验证' }]
      },
      target: {
        providerKey: 'minimonth.key1.MiniMax-M2.7',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:openai:responses',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: '继续执行 submit truth 整链验证' }]
        }
      }
    }));

    const processIncoming = jest.fn(async (payload: Record<string, unknown>) => ({
      status: 200,
      data: {
        id: 'msg_http_submit_truth_1',
        type: 'message',
        role: 'assistant',
        model: 'gpt-5.5',
        content: [{ type: 'text', text: `submit truth 响应: ${JSON.stringify(payload)}` }],
        stop_reason: 'end_turn'
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:openai:responses',
      providerKey: 'minimonth.key1.MiniMax-M2.7',
      providerType: 'openai',
      providerProtocol: 'openai-responses',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: createSingleHandleRuntimeManager(handle),
      getHubPipeline: () => registerHubPipelineFixture(pipelineExecute) as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses/:id/submit_tool_outputs', (req, res) => {
      void handleResponses(
        req as any,
        res as any,
        {
          executePipeline: (input: any) => executeRequestExecutorWithServerInput(executor, input),
          errorHandling: null
        },
        {
          entryEndpoint: '/v1/responses.submit_tool_outputs',
          responseIdFromPath: (req as any).params.id
        }
      );
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/responses/resp_submit_truth_1/submit_tool_outputs', {
        stream: false,
        tool_outputs: [{ tool_call_id: 'call_submit_truth_1', output: 'ok' }]
      });

      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({
        object: 'response',
        previous_response_id: 'resp_submit_truth_1',
        status: 'completed'
      });

      expect(pipelineExecute).toHaveBeenCalledTimes(1);
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.endpoint).toBe('/v1/responses');
      expect(readRequestTruth(pipelineInput.metadata)).toMatchObject({
        entryEndpoint: '/v1/responses',
        requestId: expect.stringContaining('openai-responses-router-request-')
      });
      expect(readResponsesResume(pipelineInput.metadata)).toMatchObject({
        previousRequestId: 'req_chain_submit_truth_1',
        restoredFromResponseId: 'resp_submit_truth_1',
        continuationOwner: 'relay'
      });
      expect(readRuntimeControl(pipelineInput.metadata)).toMatchObject({
        streamIntent: 'non_stream'
      });
      expect(readRuntimeControl(pipelineInput.metadata)?.routeHint).toBeUndefined();
      expect(readRuntimeControl(pipelineInput.metadata)?.retryProviderKey).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it('captures /v1/responses request context before returning tool_calls so submit_tool_outputs can resume', async () => {
    const pipelineExecute = jest.fn((_input: any) => ({
      status: 200,
      body: {
        id: 'resp_capture_tool_1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            call_id: 'call_capture_shell_1',
            name: 'shell_command',
            arguments: JSON.stringify({ command: 'pwd' })
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: { tool_calls: [] }
        }
      },
      usageLogInfo: {
        finishReason: 'tool_calls',
        routeName: 'thinking/gateway-priority-5520-thinking',
        sessionId: 'rcc-routecodex-capture'
      }
    }));

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses', (req, res) => {
      void handleResponses(req as any, res as any, {
        executePipeline: (input) => executeHandlerPipelineFixture(pipelineExecute, input),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const payload = {
        model: 'gpt-5.3-codex',
        stream: false,
        store: true,
        metadata: { session_id: 'rcc-routecodex-capture' },
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'call shell_command' }] }],
        tools: [{ type: 'function', name: 'shell_command', parameters: { type: 'object' } }]
      };

      const result = await fetchJson(baseUrl, '/v1/responses', payload);

      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({ id: 'resp_capture_tool_1', status: 'requires_action' });
      await waitForMockCalls(mockCaptureResponsesRequestContext, 1);
      expect(mockCaptureResponsesRequestContext).toHaveBeenCalledWith(expect.objectContaining({
        requestId: expect.stringContaining('openai-responses-router-gpt-5.3-codex-'),
        payload: expect.objectContaining({ model: 'gpt-5.3-codex' }),
        context: expect.objectContaining({
          input: payload.input,
          toolsRaw: payload.tools
        }),
        sessionId: 'rcc-routecodex-capture'
      }));
      expect(mockRecordResponsesResponseForRequest).toHaveBeenCalledWith(expect.objectContaining({
        requestId: expect.stringContaining('openai-responses-router-gpt-5.3-codex-'),
        response: expect.objectContaining({ id: 'resp_capture_tool_1' }),
        sessionId: 'rcc-routecodex-capture',
        routeHint: 'thinking/gateway-priority-5520-thinking'
      }));
    } finally {
      await closeServer(server);
    }
  });

  it('blackbox keeps streamed tool_call continuation context under response id without missing request context', async () => {
    const pipelineExecute = jest.fn((_input: any) => ({
      status: 200,
      body: {
        id: 'resp_stream_capture_tool_1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            call_id: 'call_stream_shell_1',
            name: 'shell_command',
            arguments: JSON.stringify({ command: 'pwd' })
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: { tool_calls: [] }
        }
      },
      usageLogInfo: {
        finishReason: 'tool_calls',
        routeName: 'coding/gateway-priority-5555-coding',
        providerKey: 'mimo.pool.mimo-v2.5-pro',
        timingRequestIds: ['openai-responses-mimo.pool-mimo-v2.5-pro-20260528T153512919-230769-357'],
        sessionId: 'rcc-zterm'
      }
    }));

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses', (req, res) => {
      void handleResponses(req as any, res as any, {
        executePipeline: (input) => executeHandlerPipelineFixture(pipelineExecute, input),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const payload = {
        model: 'gpt-5.4',
        stream: true,
        store: true,
        metadata: { session_id: 'rcc-zterm' },
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'call shell_command' }] }],
        tools: [{ type: 'function', name: 'shell_command', parameters: { type: 'object' } }]
      };

      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(payload)
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('resp_stream_capture_tool_1');
      await waitForMockCalls(mockCaptureResponsesRequestContext, 1);
      await waitForMockCalls(mockRecordResponsesResponseForRequest, 1);
      expect(mockCaptureResponsesRequestContext).toHaveBeenCalledWith(expect.objectContaining({
        requestId: expect.stringContaining('openai-responses-router-gpt-5.4-'),
        payload: expect.objectContaining({ model: 'gpt-5.4', store: true }),
        sessionId: 'rcc-zterm',
        providerKey: 'mimo.pool.mimo-v2.5-pro'
      }));
      expect(mockRecordResponsesResponseForRequest).toHaveBeenCalledWith(expect.objectContaining({
        requestId: expect.stringContaining('openai-responses-router-gpt-5.4-'),
        response: expect.objectContaining({ id: 'resp_stream_capture_tool_1' }),
        sessionId: 'rcc-zterm',
        providerKey: 'mimo.pool.mimo-v2.5-pro'
      }));
    } finally {
      await closeServer(server);
    }
  });


  it('auto-detects submit_tool_outputs payload posted to /v1/responses and resumes the conversation', async () => {
    mockPlanResponsesHandlerEntry.mockImplementationOnce(async (payload: any) => ({
      mode: 'submit_tool_outputs',
      responseId: 'resp_submit_prev_auto_1',
      payload
    }));
    mockResumeResponsesConversation.mockResolvedValue({
      payload: {
        model: 'claude-sonnet-4-5',
        previous_response_id: 'resp_submit_prev_auto_1',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行 auto submit_tool_outputs 整链验证' }] }],
        tool_outputs: [{ tool_call_id: 'call_submit_auto_1', output: 'ok' }]
      },
      meta: {
        previousRequestId: 'req_chain_submit_auto_1',
        restoredFromResponseId: 'resp_submit_prev_auto_1'
      }
    });

    const pipelineExecute = jest.fn((_input: any) => ({
      providerPayload: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 auto submit_tool_outputs 整链验证' }]
      },
      standardizedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 auto submit_tool_outputs 整链验证' }]
      },
      processedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 auto submit_tool_outputs 整链验证' }]
      },
      target: {
        providerKey: 'mock.anthropic.submit.auto',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:anthropic:submit:auto',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: '继续执行 auto submit_tool_outputs 整链验证' }]
        }
      }
    }));

    const processIncoming = jest.fn(async (payload: Record<string, unknown>) => ({
      status: 200,
      data: {
        id: 'msg_http_submit_auto_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: `auto submit_tool_outputs 整链响应: ${JSON.stringify(payload)}` }],
        stop_reason: 'end_turn'
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:anthropic:submit:auto',
      providerKey: 'mock.anthropic.submit.auto',
      providerType: 'anthropic',
      providerProtocol: 'anthropic-messages',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: createSingleHandleRuntimeManager(handle),
      getHubPipeline: () => registerHubPipelineFixture(pipelineExecute) as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses', (req, res) => {
      void handleResponses(req as any, res as any, {
        executePipeline: (input: any) => executeRequestExecutorWithServerInput(executor, input),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/responses', {
        stream: false,
        response_id: 'resp_submit_prev_auto_1',
        tool_outputs: [{ tool_call_id: 'call_submit_auto_1', output: 'ok' }]
      });

      expect(result.status).toBe(200);
      expect(JSON.stringify(result.payload)).toContain('auto submit_tool_outputs 整链响应');

      expect(mockResumeResponsesConversation).toHaveBeenCalledTimes(1);
      expect(mockResumeResponsesConversation).toHaveBeenCalledWith(
        'resp_submit_prev_auto_1',
        {
          response_id: 'resp_submit_prev_auto_1',
          stream: false,
          tool_outputs: [{ tool_call_id: 'call_submit_auto_1', output: 'ok' }]
        },
        expect.objectContaining({ requestId: expect.any(String) })
      );

      expect(pipelineExecute).toHaveBeenCalledTimes(1);
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.endpoint).toBe('/v1/responses');
      expect(pipelineInput.payload?.previous_response_id).toBe('resp_submit_prev_auto_1');
      expect(readResponsesResume(pipelineInput.metadata)).toEqual({
        previousRequestId: 'req_chain_submit_auto_1',
        restoredFromResponseId: 'resp_submit_prev_auto_1'
      });
    } finally {
      await closeServer(server);
    }
  });


  it('keeps namespace tools intact at /v1/responses handler boundary before pipeline routing', async () => {
    const pipelineExecute = jest.fn((_input: any) => ({
      providerPayload: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'check Chrome state' }]
      },
      standardizedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'check Chrome state' }]
      },
      processedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'check Chrome state' }]
      },
      target: {
        providerKey: 'mock.anthropic.namespace',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:anthropic:namespace',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'check Chrome state' }]
        }
      }
    }));

    const processIncoming = jest.fn(async (payload: Record<string, unknown>) => ({
      status: 200,
      data: {
        id: 'msg_http_namespace_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: `namespace boundary ok: ${JSON.stringify(payload)}` }],
        stop_reason: 'end_turn'
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:anthropic:namespace',
      providerKey: 'mock.anthropic.namespace',
      providerType: 'anthropic',
      providerProtocol: 'anthropic-messages',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: createSingleHandleRuntimeManager(handle),
      getHubPipeline: () => registerHubPipelineFixture(pipelineExecute) as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses', (req, res) => {
      void handleResponses(
        req as any,
        res as any,
        {
          executePipeline: (input: any) => executeRequestExecutorWithServerInput(executor, input),
          errorHandling: null
        },
        {
          entryEndpoint: '/v1/responses'
        }
      );
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const tools = buildComputerUseNamespaceTools();
      const result = await fetchJson(baseUrl, '/v1/responses', {
        model: 'claude-sonnet-4-5',
        stream: false,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'check Chrome state' }]
          }
        ],
        tools
      });

      expect(result.status).toBe(200);
      expect(JSON.stringify(result.payload)).toContain('namespace boundary ok');
      expect(pipelineExecute).toHaveBeenCalledTimes(1);

      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.endpoint).toBe('/v1/responses');
      expect(pipelineInput.payload?.tools).toEqual(tools);
      expect(readResponsesRequestContext(pipelineInput.metadata)?.payload?.tools).toEqual(tools);
    } finally {
      await closeServer(server);
    }
  });

  it('keeps ordinary /v1/responses payload untouched at handler boundary so continuation can be resolved after routing', async () => {
    const pipelineExecute = jest.fn((input: any) => ({
      status: 200,
      body: {
        object: 'response',
        id: 'resp_restored_scope_1',
        status: 'completed',
        previous_response_id: input.body?.previous_response_id ?? null,
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ordinary continuation restored' }]
          }
        ]
      }
    }));

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses', (req, res) => {
      void handleResponses(req as any, res as any, {
        executePipeline: (input) => executeHandlerPipelineFixture(pipelineExecute, input),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/responses', {
        model: 'gpt-5.3-codex',
        stream: false,
        metadata: {
          session_id: 'sess-1'
        },
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '历史 user' }]
          },
          {
            role: 'assistant',
            content: [{ type: 'output_text', text: '历史 assistant' }]
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: '只发送本轮 delta' }]
          }
        ]
      });

      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({
        previous_response_id: null,
        status: 'completed'
      });
      expect(mockResumeLatestResponsesContinuationByScope).not.toHaveBeenCalled();

      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.body?.previous_response_id).toBeUndefined();
      expect(pipelineInput.body?.input).toEqual([
        {
          role: 'user',
          content: [{ type: 'input_text', text: '历史 user' }]
        },
        {
          role: 'assistant',
          content: [{ type: 'output_text', text: '历史 assistant' }]
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: '只发送本轮 delta' }]
        }
      ]);
      expect(readResponsesResume(pipelineInput.metadata)).toBeUndefined();
      expect(readResponsesRequestContext(pipelineInput.metadata)?.payload?.input).toHaveLength(3);
      expect(readRequestTruth(pipelineInput.metadata)).toMatchObject({
        requestId: expect.stringContaining('openai-responses-router-gpt-5.3-codex-')
      });
      expect(pipelineInput.metadata?.__shadowCompareForcedProviderKey).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it('materializes local scope continuation before Hub context capture when input starts with tool output', async () => {
    mockPlanResponsesHandlerEntry.mockImplementationOnce(async (payload: any) => ({
      mode: 'scope_materialize',
      payload
    }));
    mockMaterializeLatestResponsesContinuationByScope.mockResolvedValueOnce({
      payload: {
        model: 'gpt-5.5',
        input: [
          { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
          { type: 'function_call_output', call_id: 'call_1', output: '/tmp' },
          { role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }
        ],
        tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }]
      },
      meta: {
        restoredFromResponseId: 'resp_local_scope_1',
        previousRequestId: 'req_prev_scope_1',
        providerKey: 'cc.key1.gpt-5.5',
        materialized: true,
        materializedMode: 'local_full_input'
      }
    });

    const pipelineExecute = jest.fn((input: any) => {
      const firstInput = input.body?.input?.[0];
      if (firstInput?.type === 'function_call_output') {
        throw new Error('orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id: call_1');
      }
      return {
        status: 200,
        body: {
          object: 'response',
          id: 'resp_after_local_scope_1',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
        }
      };
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses', (req, res) => {
      void handleResponses(req as any, res as any, {
        executePipeline: (input) => executeHandlerPipelineFixture(pipelineExecute, input),
        errorHandling: null,
        portContext: { matchedPort: 5555 }
      } as any);
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/responses', {
        model: 'gpt-5.5',
        stream: false,
        metadata: { session_id: 'rcc-zterm' },
        input: [
          { type: 'function_call_output', call_id: 'call_1', output: '/tmp' },
          { role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }
        ]
      });

      expect(result.status).toBe(200);
      expect(mockMaterializeLatestResponsesContinuationByScope).toHaveBeenCalledTimes(1);
      expect(mockMaterializeLatestResponsesContinuationByScope).toHaveBeenCalledWith(expect.objectContaining({
        requestId: expect.stringContaining('openai-responses-router-gpt-5.5-'),
        matchedPort: 5555,
        sessionId: 'rcc-zterm'
      }));
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.body.input[0]).toMatchObject({ type: 'function_call', call_id: 'call_1' });
      expect(pipelineInput.body.input[1]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
      expect(readResponsesResume(pipelineInput.metadata)).toMatchObject({
        materialized: true
      });
      expect(readResponsesRequestContext(pipelineInput.metadata)?.payload?.input?.[0]).toMatchObject({
        type: 'function_call',
        call_id: 'call_1'
      });
    } finally {
      await closeServer(server);
    }
  });

  it('keeps chat endpoint inbound mapping at handler boundary and returns final chat completion through executor/converter chain', async () => {
    const pipelineExecute = jest.fn((input: any) => ({
      providerPayload: {
        model: 'gemini-2.5-pro',
        contents: [{ role: 'user', parts: [{ text: '继续执行 chat handler 整链验证' }] }]
      },
      standardizedRequest: {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: '继续执行 chat handler 整链验证' }]
      },
      processedRequest: {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: '继续执行 chat handler 整链验证' }],
        semantics: {
          continuation: {
            chainId: 'session_http_chat_1',
            stickyScope: 'session',
            stateOrigin: 'openai-chat',
            resumeFrom: {
              protocol: 'openai-chat'
            }
          }
        }
      },
      target: {
        providerKey: 'mock.gemini.chat',
        providerType: 'gemini',
        outboundProfile: 'gemini-chat',
        runtimeKey: 'runtime:gemini:chat',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', content: '继续执行 chat handler 整链验证' }]
        }
      }
    }));

    const processIncoming = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'gem_http_chat_1',
        model: 'gemini-2.5-pro',
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              role: 'model',
              parts: [{ text: 'chat handler 整链响应完成' }]
            }
          }
        ]
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:gemini:chat',
      providerKey: 'mock.gemini.chat',
      providerType: 'gemini',
      providerProtocol: 'gemini-chat',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: createSingleHandleRuntimeManager(handle),
      getHubPipeline: () => registerHubPipelineFixture(pipelineExecute) as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/chat/completions', (req, res) => {
      void handleChatCompletions(req as any, res as any, {
        executePipeline: (input) => executeRequestExecutorWithServerInput(executor, input),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/chat/completions', {
        model: 'gemini-2.5-pro',
        metadata: {
          session_id: 'chat-sess-1'
        },
        messages: [{ role: 'user', content: '继续执行 chat handler 整链验证' }]
      });

      expect(result.status).toBe(200);
      expect(result.payload?.object).toBe('chat.completion');
      expect(result.payload?.choices?.[0]?.message?.content).toBe('chat handler 整链响应完成');

      expect(pipelineExecute).toHaveBeenCalledTimes(1);
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.endpoint).toBe('/v1/chat/completions');
      expect(pipelineInput.metadata?.providerProtocol).toBe('openai-chat');
      expect(pipelineInput.payload?.messages).toEqual([{ role: 'user', content: '继续执行 chat handler 整链验证' }]);
      expect(pipelineInput.metadata?.__raw_request_body).toBeUndefined();
      expect(pipelineInput.metadata?.session_id).toBe('chat-sess-1');
      expect(pipelineInput.metadata?.__shadowCompareForcedProviderKey).toBeUndefined();

      expect(processIncoming).toHaveBeenCalledTimes(1);
      expect(processIncoming).toHaveBeenCalledWith(expect.objectContaining({
        model: 'gemini-2.5-pro',
        contents: [{ role: 'user', parts: [{ text: '继续执行 chat handler 整链验证' }] }]
      }));
    } finally {
      await closeServer(server);
    }
  });




  it('parses /v1/messages SSE request body and preserves the last JSON event into the unified pipeline', async () => {
    const pipelineExecute = jest.fn((_input: any) => ({
      providerPayload: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler SSE 整链验证（第二帧）' }]
      },
      standardizedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler SSE 整链验证（第二帧）' }]
      },
      processedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler SSE 整链验证（第二帧）' }],
        semantics: {
          continuation: {
            chainId: 'conversation_http_messages_sse_1',
            stickyScope: 'conversation',
            stateOrigin: 'anthropic-messages',
            resumeFrom: {
              protocol: 'anthropic-messages',
              turnId: 'conversation_http_messages_sse_1'
            }
          }
        }
      },
      target: {
        providerKey: 'mock.anthropic.messages.sse',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:anthropic:messages:sse',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: '继续执行 messages handler SSE 整链验证（第二帧）' }]
        }
      }
    }));

    const processIncoming = jest.fn(async (payload: Record<string, unknown>) => ({
      status: 200,
      data: {
        id: 'msg_http_messages_sse_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: `messages handler SSE 整链响应: ${JSON.stringify(payload)}` }],
        stop_reason: 'end_turn'
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:anthropic:messages:sse',
      providerKey: 'mock.anthropic.messages.sse',
      providerType: 'anthropic',
      providerProtocol: 'anthropic-messages',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: createSingleHandleRuntimeManager(handle),
      getHubPipeline: () => registerHubPipelineFixture(pipelineExecute) as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/messages', (req, res) => {
      void handleMessages(req as any, res as any, {
        executePipeline: (input) => executeRequestExecutorWithServerInput(executor, input),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    const sseRequestBody = [
      'event: message',
      'data: {"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"继续执行 messages handler SSE 整链验证（第一帧）"}]}',
      '',
      'event: message',
      'data: {"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"继续执行 messages handler SSE 整链验证（第二帧）"}]}',
      '',
    ].join('\n');

    try {
      const result = await fetchText(baseUrl, '/v1/messages', {
        headers: {
          'content-type': 'text/event-stream',
          accept: 'text/event-stream'
        },
        body: sseRequestBody
      });

      expect(result.status).toBe(200);
      expect(result.headers.get('content-type')).toContain('text/event-stream');
      expect(result.body).toContain('messages handler SSE 整链响应');
      expect(result.body).toContain('第二帧');
      expect(result.body).toContain('event:');

      expect(pipelineExecute).toHaveBeenCalledTimes(1);
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.endpoint).toBe('/v1/messages');
      expect(pipelineInput.metadata?.providerProtocol).toBe('anthropic-messages');
      expect(readStreamIntent(pipelineInput.metadata)).toBe('stream');
      expect(pipelineInput.metadata?.inboundStream).toBeUndefined();
      expect(pipelineInput.metadata?.outboundStream).toBeUndefined();
      expect(pipelineInput.payload?.messages).toEqual([
        { role: 'user', content: '继续执行 messages handler SSE 整链验证（第二帧）' }
      ]);
      expect(pipelineInput.metadata?.__raw_request_body).toBeUndefined();

      expect(processIncoming).toHaveBeenCalledTimes(1);
      expect(processIncoming).toHaveBeenCalledWith(expect.objectContaining({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler SSE 整链验证（第二帧）' }]
      }));
    } finally {
      await closeServer(server);
    }
  });
  it('keeps messages endpoint inbound payload intact and returns anthropic message body through executor/converter chain', async () => {
    const pipelineExecute = jest.fn((_input: any) => ({
      providerPayload: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler 整链验证' }]
      },
      standardizedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler 整链验证' }]
      },
      processedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler 整链验证' }],
        semantics: {
          continuation: {
            chainId: 'conversation_http_messages_1',
            stickyScope: 'conversation',
            stateOrigin: 'anthropic-messages',
            resumeFrom: {
              protocol: 'anthropic-messages',
              turnId: 'conversation_http_messages_1'
            }
          },
          audit: {
            protocolMapping: {
              preserved: [
                {
                  field: 'messages',
                  disposition: 'preserved',
                  sourceProtocol: 'anthropic-messages',
                  targetProtocol: 'anthropic-messages',
                  reason: 'protocol_identity',
                  source: 'chat.messages'
                }
              ]
            }
          }
        }
      },
      target: {
        providerKey: 'mock.anthropic.messages',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:anthropic:messages',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: '继续执行 messages handler 整链验证' }]
        }
      }
    }));

    const processIncoming = jest.fn(async (payload: Record<string, unknown>) => ({
      status: 200,
      data: {
        id: 'msg_http_messages_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: `messages handler 整链响应: ${JSON.stringify(payload)}` }],
        stop_reason: 'end_turn'
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:anthropic:messages',
      providerKey: 'mock.anthropic.messages',
      providerType: 'anthropic',
      providerProtocol: 'anthropic-messages',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: createSingleHandleRuntimeManager(handle),
      getHubPipeline: () => registerHubPipelineFixture(pipelineExecute) as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/messages', (req, res) => {
      void handleMessages(req as any, res as any, {
        executePipeline: (input) => executeRequestExecutorWithServerInput(executor, input),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/messages', {
        model: 'claude-sonnet-4-5',
        metadata: {
          session_id: 'msg-sess-1'
        },
        messages: [{ role: 'user', content: '继续执行 messages handler 整链验证' }]
      });

      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({
        id: 'msg_http_messages_1',
        type: 'message',
        role: 'assistant',
        stop_reason: 'end_turn'
      });
      expect(JSON.stringify(result.payload)).toContain('messages handler 整链响应');

      expect(pipelineExecute).toHaveBeenCalledTimes(1);
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.endpoint).toBe('/v1/messages');
      expect(pipelineInput.metadata?.providerProtocol).toBe('anthropic-messages');
      expect(pipelineInput.payload?.messages).toEqual([{ role: 'user', content: '继续执行 messages handler 整链验证' }]);
      expect(pipelineInput.metadata?.__raw_request_body).toBeUndefined();
      expect(pipelineInput.metadata?.session_id).toBe('msg-sess-1');
      expect(pipelineInput.metadata?.__shadowCompareForcedProviderKey).toBeUndefined();

      expect(processIncoming).toHaveBeenCalledTimes(1);
      expect(processIncoming).toHaveBeenCalledWith(expect.objectContaining({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler 整链验证' }]
      }));
    } finally {
      await closeServer(server);
    }
  });

  it('captures resumed submit_tool_outputs request context before returning another tool_call', async () => {
    mockResumeResponsesConversation.mockResolvedValue({
      payload: {
        model: 'gpt-5.3-codex',
        previous_response_id: 'resp_submit_prev_capture_1',
        input: [
          { type: 'function_call', call_id: 'call_submit_capture_1', name: 'shell_command', arguments: '{"cmd":"printf ok"}' },
          { type: 'function_call_output', call_id: 'call_submit_capture_1', output: 'ok' }
        ],
        tools: [{ type: 'function', name: 'shell_command', parameters: { type: 'object' } }]
      },
      meta: {
        previousRequestId: 'req_chain_submit_capture_1',
        restoredFromResponseId: 'resp_submit_prev_capture_1',
        routeHint: 'thinking/gateway-priority-5520-thinking'
      }
    });

    const pipelineExecute = jest.fn((_input: any) => ({
      status: 200,
      body: {
        id: 'resp_submit_capture_next_1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            call_id: 'call_submit_capture_2',
            name: 'shell_command',
            arguments: JSON.stringify({ cmd: 'printf again' })
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: { tool_calls: [] }
        }
      },
      usageLogInfo: {
        finishReason: 'tool_calls',
        routeName: 'thinking/gateway-priority-5520-thinking'
      }
    }));

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses/:id/submit_tool_outputs', (req, res) => {
      void handleResponses(
        req as any,
        res as any,
        { executePipeline: (input) => executeHandlerPipelineFixture(pipelineExecute, input), errorHandling: null },
        {
          entryEndpoint: '/v1/responses.submit_tool_outputs',
          responseIdFromPath: (req as any).params.id
        }
      );
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/responses/resp_submit_prev_capture_1/submit_tool_outputs', {
        stream: false,
        tool_outputs: [{ tool_call_id: 'call_submit_capture_1', output: 'ok' }]
      });

      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({ id: 'resp_submit_capture_next_1', status: 'requires_action' });
      await waitForMockCalls(mockCaptureResponsesRequestContext, 3);
      const resumedCaptureCall = mockCaptureResponsesRequestContext.mock.calls
        .map(([arg]) => arg)
        .find((arg) => arg?.payload?.previous_response_id === 'resp_submit_prev_capture_1');
      expect(resumedCaptureCall).toEqual(expect.objectContaining({
        requestId: expect.any(String),
        payload: expect.objectContaining({ previous_response_id: 'resp_submit_prev_capture_1' }),
        context: expect.objectContaining({
          input: expect.arrayContaining([
            expect.objectContaining({ type: 'function_call_output', call_id: 'call_submit_capture_1', output: 'ok' })
          ]),
          toolsRaw: [{ type: 'function', name: 'shell_command', parameters: { type: 'object' } }]
        }),
        sessionId: undefined
      }));
      expect(mockRecordResponsesResponseForRequest).toHaveBeenCalledWith(expect.objectContaining({
        requestId: expect.stringContaining('openai-responses-router-request-'),
        response: expect.objectContaining({ id: 'resp_submit_capture_next_1' }),
        routeHint: 'thinking/gateway-priority-5520-thinking'
      }));
    } finally {
      await closeServer(server);
    }
  });

});
