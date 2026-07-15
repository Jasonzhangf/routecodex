import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

import { describe, expect, jest, test } from '@jest/globals';
import { buildLlmswitchRuntimeIntegrationsFake } from '../helpers/llmswitch-runtime-integrations-fake.js';

const normalizeResponsesDirectCurrentRequestPayloadMock = jest.fn((payload: Record<string, unknown>) => ({
  changed: false,
  payload
}));
const sanitizeProviderOutboundPayloadMock = jest.fn(async (input: { payload: Record<string, unknown> }) =>
  JSON.parse(JSON.stringify(input.payload)) as Record<string, unknown>
);

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/provider-outbound-sanitize-host.js', () => ({
  normalizeResponsesDirectCurrentRequestPayload: normalizeResponsesDirectCurrentRequestPayloadMock,
  sanitizeProviderOutboundPayload: sanitizeProviderOutboundPayloadMock,
}), { virtual: true });

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/responses-to-chat-host.js', () => ({
  convertResponsesRequestToChatNative: (payload: Record<string, unknown>) => ({
    request: {
      model: payload.model,
      messages: payload.messages ?? [],
      tools: payload.tools
    }
  }),
}), { virtual: true });

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/runtime-integrations.js', () => ({
  ...buildLlmswitchRuntimeIntegrationsFake({
  buildResponsesJsonFromSseStreamWithNative: async () => ({ status: 'completed', output: [] }),
  reportProviderErrorToRouterPolicy: async () => {},
  reportProviderSuccessToRouterPolicy: async () => {},
  }),
}), { virtual: true });

import type { OpenAIStandardConfig } from '../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { attachProviderRuntimeMetadata } from '../../../src/providers/core/runtime/provider-runtime-metadata.js';
import { createProviderContext } from '../../../src/providers/core/runtime/base-provider-runtime-helpers.js';
import { MetadataCenter } from '../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const writeProviderSnapshot = jest.fn(async () => undefined);
const attachProviderSseSnapshotStream = jest.fn((stream: NodeJS.ReadableStream) => stream);
let captureProviderSseSnapshots = false;

jest.unstable_mockModule('../../../src/providers/core/utils/snapshot-writer.js', () => ({
  writeProviderSnapshot,
  attachProviderSseSnapshotStream,
  shouldCaptureProviderStreamSnapshots: () => captureProviderSseSnapshots
}));

const { attachPipelineDryRunControl } = await import('../../../src/debug/pipeline-dry-run.js');
const { ResponsesProvider } = await import('../../../src/providers/core/runtime/responses-provider.js');

const emptyDeps: ModuleDependencies = {
  logger: {
    logModule: () => {},
    logProviderRequest: () => {}
  } as any
} as ModuleDependencies;

describe('ResponsesProvider direct passthrough', () => {
  beforeEach(() => {
    writeProviderSnapshot.mockClear();
    attachProviderSseSnapshotStream.mockClear();
    normalizeResponsesDirectCurrentRequestPayloadMock.mockClear();
    normalizeResponsesDirectCurrentRequestPayloadMock.mockImplementation((payload: Record<string, unknown>) => ({
      changed: false,
      payload
    }));
    sanitizeProviderOutboundPayloadMock.mockClear();
    captureProviderSseSnapshots = false;
  });

  test('direct JSON provider-request dry-run stops before upstream send', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-json-dry-run',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    const post = jest.fn(async () => {
      throw new Error('SHOULD_NOT_SEND');
    });
    provider.httpClient = {
      post
    };

    const metadata: Record<string, unknown> = {
      entryEndpoint: '/v1/responses',
      __responsesDirectPassthrough: true,
      entryPort: 5520
    };
    attachPipelineDryRunControl(metadata, {
      enabled: true,
      kind: 'provider_request',
      source: 'sample_replay',
      requestedAtMs: 1
    });
    const inbound = {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: false
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      requestId: 'dry_run_direct_json',
      providerId: 'test',
      providerKey: 'test.key1.gpt-5.5',
      providerType: 'responses',
      providerFamily: 'test',
      providerProtocol: 'openai-responses',
      metadata
    } as any);

    const response = await provider.processIncomingDirect(inbound) as any;

    expect(post).not.toHaveBeenCalled();
    expect(writeProviderSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'provider-request',
      requestId: 'dry_run_direct_json',
      entryEndpoint: '/v1/responses',
      url: 'https://example.invalid/v1/responses'
    }));
    expect(response.body).toMatchObject({
      object: 'routecodex.pipeline_dry_run',
      kind: 'provider_request',
      dryRun: true,
      entryPort: 5520,
      providerRequest: {
        method: 'POST',
        endpoint: '/responses',
        url: 'https://example.invalid/v1/responses',
        wantsSse: false,
        body: {
          model: 'gpt-5.5',
          stream: false
        }
      },
      evidence: {
        stoppedBeforeProviderSend: true,
        providerRequestSnapshotWritten: true
      }
    });
    expect(response.body.providerRequest.headers.Authorization).toBe('[REDACTED]');
  });

  test('direct SSE provider-request dry-run stops before upstream send', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-sse-dry-run',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    const postStreamOrResponse = jest.fn(async () => {
      throw new Error('SHOULD_NOT_SEND');
    });
    const postStream = jest.fn(async () => {
      throw new Error('SHOULD_NOT_SEND');
    });
    provider.httpClient = {
      postStreamOrResponse,
      postStream
    };

    const metadata: Record<string, unknown> = {
      entryEndpoint: '/v1/responses',
      __responsesDirectPassthrough: true,
      entryPort: 5520
    };
    attachPipelineDryRunControl(metadata, {
      enabled: true,
      kind: 'provider_request',
      source: 'sample_replay',
      requestedAtMs: 1
    });
    const inbound = {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      requestId: 'dry_run_direct_sse',
      providerId: 'test',
      providerKey: 'test.key1.gpt-5.5',
      providerType: 'responses',
      providerFamily: 'test',
      providerProtocol: 'openai-responses',
      metadata
    } as any);

    const response = await provider.processIncomingDirect(inbound) as any;

    expect(postStreamOrResponse).not.toHaveBeenCalled();
    expect(postStream).not.toHaveBeenCalled();
    expect(writeProviderSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'provider-request',
      requestId: 'dry_run_direct_sse',
      entryEndpoint: '/v1/responses',
      url: 'https://example.invalid/v1/responses'
    }));
    expect(response.body).toMatchObject({
      object: 'routecodex.pipeline_dry_run',
      kind: 'provider_request',
      dryRun: true,
      providerRequest: {
        endpoint: '/responses',
        url: 'https://example.invalid/v1/responses',
        wantsSse: true,
        body: {
          model: 'gpt-5.5',
          stream: true
        }
      },
      evidence: {
        stoppedBeforeProviderSend: true,
        providerRequestSnapshotWritten: true
      }
    });
  });

  test('direct SSE does not inherit provider-request dry-run from previous provider runtime metadata', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-sse-dry-run-isolation',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    const postStreamOrResponse = jest.fn(async () => {
      throw new Error('SHOULD_NOT_SEND_DURING_DRY_RUN');
    });
    provider.httpClient = {
      postStreamOrResponse,
      postStream: jest.fn()
    };

    const dryRunMetadata: Record<string, unknown> = {
      entryEndpoint: '/v1/responses',
      __responsesDirectPassthrough: true,
      entryPort: 5520
    };
    attachPipelineDryRunControl(dryRunMetadata, {
      enabled: true,
      kind: 'provider_request',
      source: 'sample_replay',
      requestedAtMs: 1
    });
    const dryRunInbound = {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'dry run' }] }],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(dryRunInbound, {
      requestId: 'dry_run_previous_turn',
      providerId: 'test',
      providerKey: 'test.key1.gpt-5.5',
      providerType: 'responses',
      providerFamily: 'test',
      providerProtocol: 'openai-responses',
      metadata: dryRunMetadata
    } as any);

    const dryRunResponse = await provider.processIncoming(dryRunInbound) as any;
    expect(dryRunResponse.data).toBeUndefined();
    expect(dryRunResponse.body).toMatchObject({
      object: 'routecodex.pipeline_dry_run',
      kind: 'provider_request',
      dryRun: true
    });
    expect(postStreamOrResponse).not.toHaveBeenCalled();

    const liveStream = Readable.from([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_live"}}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_live","status":"completed"}}\n\n'
    ]);
    postStreamOrResponse.mockImplementationOnce(async () => ({
      kind: 'stream',
      stream: liveStream
    }));
    const liveInbound = {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'live' }] }],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(liveInbound, {
      requestId: 'live_direct_sse_after_dry_run',
      providerId: 'test',
      providerKey: 'test.key1.gpt-5.5',
      providerType: 'responses',
      providerFamily: 'test',
      providerProtocol: 'openai-responses',
      metadata: {
        entryEndpoint: '/v1/responses',
        __responsesDirectPassthrough: true,
        entryPort: 5520
      }
    } as any);

    const liveResponse = await provider.processIncomingDirect(liveInbound) as any;

    expect(postStreamOrResponse).toHaveBeenCalledTimes(1);
    expect(liveResponse.body).toBeUndefined();
    expect(liveResponse.sseStream).toBeDefined();
    expect(writeProviderSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'provider-response',
      requestId: 'live_direct_sse_after_dry_run',
      entryEndpoint: '/v1/responses'
    }));
  });

  test('grok direct request applies wire compat and matching model headers before upstream send', async () => {
    const refreshCredentials = jest.fn(async () => undefined);
    const config: OpenAIStandardConfig = {
      id: 'test-grok-direct-wire-compat',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'grok',
        auth: { type: 'apikey', apiKey: 'grok-token-file-mode' },
        overrides: { baseUrl: 'https://cli-chat-proxy.grok.com/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.authProvider = {
      refreshCredentials,
      buildHeaders: () => ({
        Authorization: 'Bearer grok-access-token',
        'X-XAI-Token-Auth': 'xai-grok-cli'
      })
    };

    let capturedUrl: string | undefined;
    let capturedBody: any;
    let capturedHeaders: Record<string, string> | undefined;
    provider.httpClient = {
      postStream: async (url: string, body: any, headers: Record<string, string>) => {
        capturedUrl = url;
        capturedBody = body;
        capturedHeaders = headers;
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    const inbound = {
      model: 'grok-build',
      stream: true,
      client_metadata: { session_id: 'must-not-leak' },
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'high' },
      tools: [
        { type: 'custom', name: 'apply_patch', parameters: { type: 'object', properties: {} } },
        { type: 'web_search' }
      ],
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_patch', input: '*** Begin Patch' },
        { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'ok' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'kept summary' }] }
      ]
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      providerId: 'grok',
      providerKey: 'grok.key1.grok-build',
      providerType: 'responses',
      providerFamily: 'grok',
      target: { modelId: 'gpt-5.5' },
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    } as any);

    await expect(provider.processIncomingDirect(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');

    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toBe('https://cli-chat-proxy.grok.com/v1/responses');
    expect(capturedHeaders).toMatchObject({
      Authorization: 'Bearer grok-access-token',
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-grok-model-override': 'grok-build',
      'x-grok-client-surface': 'grok-build',
      'x-grok-client-version': '0.2.93',
      Accept: 'text/event-stream'
    });
    expect(capturedBody.model).toBe('grok-build');
    expect(capturedBody.client_metadata).toBeUndefined();
    expect(capturedBody.include).toBeUndefined();
    expect(capturedBody.reasoning).toBeUndefined();
    expect(capturedBody.tools).toEqual([
      { type: 'function', name: 'apply_patch', parameters: { type: 'object', properties: {} } }
    ]);
    expect(capturedBody.input.map((item: any) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call_output',
      'message'
    ]);
    expect(capturedBody.input[1]).toMatchObject({
      type: 'function_call',
      name: 'apply_patch',
      call_id: 'call_patch'
    });
    expect(sanitizeProviderOutboundPayloadMock).not.toHaveBeenCalled();
  });

  test('sends direct request as provider wire body with protocol metadata payload fields', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-metadata-boundary',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'cc',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    let capturedBody: any;
    provider.httpClient = {
      postStream: async (_url: string, body: any) => {
        capturedBody = body;
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };
    const inbound = {
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true,
      metadata: { __responsesDirectPassthrough: true, sessionId: 'must-not-leak' },
      client_metadata: { session_id: 'must-not-leak' }
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: { __responsesDirectPassthrough: true }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedBody).toBe(inbound);
    expect(sanitizeProviderOutboundPayloadMock).not.toHaveBeenCalled();
    expect(capturedBody).toEqual({
      model: 'gpt-5.5',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true,
      metadata: { __responsesDirectPassthrough: true, sessionId: 'must-not-leak' },
      client_metadata: { session_id: 'must-not-leak' }
    });
  });

  test('preserves reasoning content on direct provider path before sending upstream', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-reasoning-filter',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'cc',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;

    let capturedBody: any;
    provider.httpClient = {
      postStream: async (_url: string, body: any) => {
        capturedBody = body;
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'must not reach provider runtime' }],
          encrypted_content: null,
          summary: [{ type: 'summary_text', text: 'summary stays' }]
        }
      ],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedBody).toBe(inbound);
    expect(sanitizeProviderOutboundPayloadMock).not.toHaveBeenCalled();
    expect(capturedBody.input[1].type).toBe('reasoning');
    expect(capturedBody.input[1].content).toEqual([
      { type: 'reasoning_text', text: 'must not reach provider runtime' },
    ]);
    expect(capturedBody.input[1].encrypted_content).toBeNull();
    expect(capturedBody.input[1].summary).toEqual([{ type: 'summary_text', text: 'summary stays' }]);
  });

  test('sends Rust-normalized current direct request when tool output precedes matching call', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-current-request-normalization',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'cc',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;

    let capturedBody: any;
    provider.httpClient = {
      post: async (_url: string, body: any) => {
        capturedBody = body;
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    const inbound = {
      model: 'gpt-5.4',
      stream: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
        { type: 'function_call_output', id: 'out_late', call_id: 'call_late_order', output: 'stderr: permission denied' },
        { type: 'function_call', id: 'call_late_order', call_id: 'call_late_order', name: 'exec_command', arguments: '{"cmd":"pwd"}' }
      ]
    } as any;
    const normalized = {
      ...inbound,
      input: [inbound.input[0], inbound.input[2], inbound.input[1]]
    };
    normalizeResponsesDirectCurrentRequestPayloadMock.mockReturnValueOnce({
      changed: true,
      payload: normalized
    });
    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(normalizeResponsesDirectCurrentRequestPayloadMock).toHaveBeenCalledWith(inbound);
    expect(capturedBody).toBe(normalized);
    expect(capturedBody.input.map((item: any) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call_output'
    ]);
    expect(sanitizeProviderOutboundPayloadMock).not.toHaveBeenCalled();
  });

  test('preserves inbound responses payload without rebuilding input/history/model', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;

    let capturedBody: any;
    let capturedHeaders: Record<string, string> | undefined;
    provider.httpClient = {
      postStream: async (_url: string, body: any, headers: Record<string, string>) => {
        capturedBody = body;
        capturedHeaders = headers;
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    const inbound = {
      model: 'gpt-5.4',
      previous_response_id: 'resp_prev_turn',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      tools: [
        { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } },
        {
          type: 'custom',
          name: 'apply_patch',
          format: {
            type: 'grammar',
            syntax: 'lark',
            definition:
              'start: begin_patch hunk+ end_patch\n'
              + 'begin_patch: "*** Begin Patch" LF\n'
              + 'end_patch: "*** End Patch" LF?\n'
          },
        },
      ],
      tool_choice: 'auto',
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'high' },
      store: false,
      stream: true,
      prompt_cache_key: 'cache-key-1',
      instructions: 'keep-original-instructions'
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });
    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedHeaders?.Accept).toBe('text/event-stream');
    expect(capturedBody).toBe(inbound);
    expect(sanitizeProviderOutboundPayloadMock).not.toHaveBeenCalled();
    expect(capturedBody.model).toBe('gpt-5.4');
    expect(capturedBody.previous_response_id).toBe('resp_prev_turn');
    expect(capturedBody.input).toEqual(inbound.input);
    expect(capturedBody.prompt_cache_key).toBe('cache-key-1');
    expect(capturedBody.tools).toEqual(inbound.tools);
    expect(capturedBody.tool_choice).toBe('auto');
    expect(capturedBody.instructions).toBe('keep-original-instructions');
    expect(capturedBody.metadata).toBeUndefined();
  });

  test('does not copy request metadata port hints into provider context control metadata', () => {
    const inbound = {
      model: 'gpt-5.4',
      metadata: {
        entryPort: 5520,
        portContext: {
          localPort: 5520
        },
        existingFlag: true
      },
      stream: false
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: {
        requestScope: 'keep-me'
      }
    });

    const { context } = createProviderContext({
      request: inbound,
      providerType: 'responses',
      runtimeProfile: {
        runtimeKey: 'test-runtime',
        providerId: 'test',
        providerType: 'responses',
        endpoint: 'https://example.invalid/v1',
        auth: { type: 'apikey' }
      }
    });

    expect(context.metadata).toMatchObject({ requestScope: 'keep-me' });
    expect(context.metadata).not.toHaveProperty('entryPort');
    expect(context.metadata).not.toHaveProperty('portContext');
    expect(context.metadata).not.toHaveProperty('existingFlag');
  });

  test('binds direct SSE provider snapshot requestId and entryPort from runtime carrier', async () => {
    captureProviderSseSnapshots = true;
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-sse-snapshot-entry-port',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      postStream: async () => Readable.from([
        'event: response.created\n',
        `data: ${JSON.stringify({
          type: 'response.created',
          response: { id: 'resp_snapshot', object: 'response', status: 'in_progress', output: [] }
        })}\n\n`,
        'event: response.completed\n',
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: { id: 'resp_snapshot', object: 'response', status: 'completed', output: [] }
        })}\n\n`,
        'event: response.done\n',
        `data: ${JSON.stringify({
          type: 'response.done',
          response: { id: 'resp_snapshot', object: 'response', status: 'completed', output: [] }
        })}\n\n`
      ])
    };

    const runtimeCarrier = {
      entryEndpoint: '/v1/responses',
      __responsesDirectPassthrough: true
    } as Record<string, unknown>;
    MetadataCenter.attach(runtimeCarrier).writeRequestTruth(
      'portScope',
      '5520',
      {
        module: 'tests/providers/runtime/responses-provider.direct-passthrough.spec.ts',
        symbol: 'binds direct SSE provider snapshot requestId and entryPort from runtime carrier',
        stage: 'ServerReqInbound01ClientRaw'
      }
    );

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true,
      metadata: {
        entryPort: 9999
      }
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      requestId: 'openai-responses-router-gpt-5.4-20260702T124533719-448200-562',
      providerId: 'cc',
      providerKey: 'cc.key1.gpt-5.5',
      metadata: runtimeCarrier
    });

    const result = await provider.sendRequestInternal(inbound) as { sseStream: NodeJS.ReadableStream };
    for await (const _chunk of result.sseStream as AsyncIterable<Buffer | string>) {
      // drain stream so direct passthrough lifecycle completes in the test
    }

    expect(attachProviderSseSnapshotStream).toHaveBeenCalledTimes(1);
    expect(attachProviderSseSnapshotStream.mock.calls[0]?.[1]).toMatchObject({
      requestId: 'openai-responses-router-gpt-5.4-20260702T124533719-448200-562',
      entryEndpoint: '/v1/responses',
      entryPort: 5520,
      providerKey: 'cc.key1.gpt-5.5',
      providerId: 'cc'
    });
    expect(attachProviderSseSnapshotStream.mock.calls[0]?.[1]).not.toMatchObject({
      entryPort: 9999
    });
    expect(writeProviderSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'provider-response',
      requestId: 'openai-responses-router-gpt-5.4-20260702T124533719-448200-562',
      entryPort: 5520
    }));
  });

  test('direct submit_tool_outputs hits native upstream submit endpoint instead of plain /responses', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-submit-tool-outputs-endpoint',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;

    let capturedUrl: string | undefined;
    let capturedBody: any;
    let capturedHeaders: Record<string, string> | undefined;
    provider.httpClient = {
      postStream: async (url: string, body: any, headers: Record<string, string>) => {
        capturedUrl = url;
        capturedBody = body;
        capturedHeaders = headers;
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    const inbound = {
      response_id: 'resp_submit_direct_1',
      tool_outputs: [{ call_id: 'call_submit_direct_1', output: 'ok' }],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: {
        entryEndpoint: '/v1/responses.submit_tool_outputs',
        __responsesDirectPassthrough: true
      }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(sanitizeProviderOutboundPayloadMock).not.toHaveBeenCalled();
    expect(capturedUrl).toBe('https://example.invalid/v1/responses/resp_submit_direct_1/submit_tool_outputs');
    expect(capturedHeaders?.Accept).toBe('text/event-stream');
    expect(capturedBody).toEqual({
      tool_outputs: [{ call_id: 'call_submit_direct_1', output: 'ok' }],
      stream: true
    });
    expect(capturedBody.response_id).toBeUndefined();
  });

  test('keeps direct Responses transport idle watchdog behind semantic stream watchdogs', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-provider-idle-timeout',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;

    let capturedStreamConfig: { idleTimeoutMs?: number; headersTimeoutMs?: number } | undefined;
    provider.httpClient = {
      postStream: async (_url: string, _body: any, _headers: Record<string, string>, streamConfig?: { idleTimeoutMs?: number; headersTimeoutMs?: number }) => {
        capturedStreamConfig = streamConfig;
        throw new Error('STOP_AFTER_CAPTURE');
      }
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: {
        entryEndpoint: '/v1/responses',
        __responsesDirectPassthrough: true,
        providerStreamNoContentTimeoutMs: 75,
        providerStreamContentIdleTimeoutMs: 150,
        providerStreamHeadersTimeoutMs: 240_000
      }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toThrow('STOP_AFTER_CAPTURE');
    expect(capturedStreamConfig).toEqual({ idleTimeoutMs: 5_150, headersTimeoutMs: 240_000 });
  });

  test('direct passthrough no-content timeout ignores keepalive-only SSE traffic', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-semantic-no-content-timeout',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;

    provider.httpClient = {
      postStream: async () => {
        const stream = new PassThrough();
        const interval = setInterval(() => {
          stream.write(': keepalive\n\n');
        }, 5);
        interval.unref?.();
        stream.on('close', () => clearInterval(interval));
        stream.on('error', () => clearInterval(interval));
        return stream;
      }
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: {
        entryEndpoint: '/v1/responses',
        __responsesDirectPassthrough: true,
        providerStreamNoContentTimeoutMs: 40
      }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toMatchObject({
      code: 'UPSTREAM_STREAM_NO_CONTENT_TIMEOUT'
    });
  });

  test('direct passthrough content-idle timeout ignores keepalive after first semantic frame', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-semantic-content-idle-timeout',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;

    provider.httpClient = {
      postStream: async () => {
        const stream = new PassThrough();
        queueMicrotask(() => {
          stream.write('event: response.created\n');
          stream.write(`data: ${JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_1', object: 'response', status: 'in_progress', output: [] }
          })}\n\n`);
          stream.write('event: response.output_item.added\n');
          stream.write(`data: ${JSON.stringify({
            type: 'response.output_item.added',
            item: { id: 'rs_1', type: 'reasoning', content: [], summary: [] },
            output_index: 0
          })}\n\n`);
        });
        const interval = setInterval(() => {
          stream.write(': keepalive\n\n');
        }, 5);
        interval.unref?.();
        stream.on('close', () => clearInterval(interval));
        stream.on('error', () => clearInterval(interval));
        return stream;
      }
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: {
        entryEndpoint: '/v1/responses',
        __responsesDirectPassthrough: true,
        providerStreamNoContentTimeoutMs: 40,
        providerStreamContentIdleTimeoutMs: 40
      }
    });

    const result = await provider.sendRequestInternal(inbound) as { sseStream: NodeJS.ReadableStream };
    const drain = async () => {
      for await (const _chunk of result.sseStream as AsyncIterable<Buffer | string>) {
        // drain stream so the async passthrough watchdog can surface the idle error
      }
    };
    await expect(drain()).rejects.toMatchObject({
      code: 'UPSTREAM_STREAM_CONTENT_IDLE_TIMEOUT'
    });
  });

  test('direct passthrough semantic frames reset content-idle timer and allow terminal completion', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-semantic-idle-control',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;

    provider.httpClient = {
      postStream: async () => {
        const stream = new PassThrough();
        setTimeout(() => {
          stream.write('event: response.created\n');
          stream.write(`data: ${JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_ok', object: 'response', status: 'in_progress', output: [] }
          })}\n\n`);
        }, 0);
        setTimeout(() => {
          stream.write('event: response.output_item.added\n');
          stream.write(`data: ${JSON.stringify({
            type: 'response.output_item.added',
            item: { id: 'msg_ok', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
            output_index: 0
          })}\n\n`);
        }, 10);
        setTimeout(() => {
          stream.write('event: response.output_text.delta\n');
          stream.write(`data: ${JSON.stringify({
            type: 'response.output_text.delta',
            item_id: 'msg_ok',
            content_index: 0,
            delta: 'hello'
          })}\n\n`);
        }, 20);
        setTimeout(() => {
          stream.write('event: response.completed\n');
          stream.write(`data: ${JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_ok', object: 'response', status: 'completed', output: [] }
          })}\n\n`);
        }, 30);
        setTimeout(() => {
          stream.write('event: response.done\n');
          stream.write(`data: ${JSON.stringify({
            type: 'response.done',
            response: { id: 'resp_ok', object: 'response', status: 'completed', output: [] }
          })}\n\n`);
          stream.end();
        }, 30);
        return stream;
      }
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true
    } as any;
    attachProviderRuntimeMetadata(inbound, {
      metadata: {
        entryEndpoint: '/v1/responses',
        __responsesDirectPassthrough: true,
        providerStreamNoContentTimeoutMs: 60,
        providerStreamContentIdleTimeoutMs: 60
      }
    });

    const result = await provider.sendRequestInternal(inbound) as { sseStream: NodeJS.ReadableStream };
    const passthrough = result.sseStream;
    let text = '';
    for await (const chunk of passthrough as AsyncIterable<Buffer | string>) {
      text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    }
    expect(text).toContain('event: response.completed');
    expect(text).toContain('event: response.done');
  });

  test('maps direct HTTP 200 SSE response.failed concurrency to retryable provider error', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-200-sse-rate-limit',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      postStream: async () => Readable.from([
        'event: response.failed\n',
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: {
            status: 'failed',
            error: {
              code: 'rate_limit_error',
              message: 'Concurrency limit exceeded for user, please retry later'
            }
          }
        })}\n\n`
      ])
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      stream: true
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toMatchObject({
      statusCode: 429,
      status: 429,
      code: 'PROVIDER_TRAFFIC_SATURATED',
      upstreamCode: 'rate_limit_error',
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.http'
    });
  });

  test('maps direct HTTP 200 SSE response.failed billing exhaustion to retryable provider error', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-200-sse-billing-exhausted',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      postStream: async () => Readable.from([
        'event: response.failed\n',
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: {
            status: 'failed',
            error: {
              code: 'insufficient_quota',
              message: 'Your account has insufficient quota',
              status: 402
            }
          }
        })}\n\n`
      ])
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      stream: true
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toMatchObject({
      statusCode: 402,
      status: 402,
      code: 'HTTP_402',
      upstreamCode: 'insufficient_quota',
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.http'
    });
  });

  test('maps CRLF direct HTTP 200 SSE response.failed concurrency to retryable provider error', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-200-sse-rate-limit-crlf',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      postStream: async () => Readable.from([
        'event: response.failed\r\n',
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: {
            status: 'failed',
            error: {
              code: 'rate_limit_error',
              message: 'Concurrency limit exceeded for user, please retry later'
            }
          }
        })}\r\n\r\n`
      ])
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      stream: true
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toMatchObject({
      statusCode: 429,
      status: 429,
      code: 'PROVIDER_TRAFFIC_SATURATED',
      upstreamCode: 'rate_limit_error',
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.http'
    });
  });

  test('maps direct HTTP 200 text/html streaming fallback to malformed provider error before SSE bridge', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-200-text-html-fallback',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      postStreamOrResponse: async () => ({
        kind: 'response',
        responseKind: 'text',
        response: {
          data: '<!doctype html><html><body>wrong upstream</body></html>',
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/html; charset=utf-8' },
          url: 'https://example.invalid/v1/responses'
        }
      })
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      stream: true
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toMatchObject({
      statusCode: 200,
      status: 200,
      code: 'MALFORMED_RESPONSE'
    });
  });

  test('maps direct HTTP 200 SSE codex.rate_limits limit_reached to retryable provider error', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-200-sse-codex-rate-limits',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      postStream: async () => Readable.from([
        'event: codex.rate_limits\n',
        `data: ${JSON.stringify({ type: 'codex.rate_limits', limit_reached: true })}\n\n`,
        'event: response.created\n',
        `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_after_limit', status: 'in_progress' } })}\n\n`
      ])
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      stream: true
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    await expect(provider.sendRequestInternal(inbound)).rejects.toMatchObject({
      statusCode: 429,
      status: 429,
      code: 'PROVIDER_TRAFFIC_SATURATED',
      upstreamCode: 'codex.rate_limits',
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.http'
    });
  });

  test('applies provider-configured error mapping before throwing direct SSE upstream errors', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-configured-error-mapping',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'XLC',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://xlapis.com/v1', endpoint: '/responses' },
        extensions: {
          errorMapping: {
            rules: [
              {
                origin: {
                  status: 400,
                  error: {
                    type: 'server_error',
                    messageContains: 'All available accounts exhausted'
                  }
                },
                to: {
                  status: 429,
                  code: 'HTTP_429',
                  message: 'All available accounts exhausted'
                }
              }
            ]
          }
        }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      postStream: async () => {
        const error = Object.assign(
          new Error('HTTP 400: {"error":{"message":"All available accounts exhausted","type":"server_error","param":"","code":null}}'),
          {
            status: 400,
            statusCode: 400,
            code: 'HTTP_400',
            response: {
              data: {
                error: {
                  code: 'HTTP_400',
                  status: 400
                }
              }
            }
          }
        );
        throw error;
      }
    };

    const inbound = {
      model: 'deepseek-v4-pro',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      stream: true
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      providerId: 'XLC',
      providerKey: 'XLC.key2.deepseek-v4-pro',
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true },
      extensions: config.config.extensions
    } as any);

    await expect(provider.sendRequestInternal(inbound)).rejects.toMatchObject({
      statusCode: 429,
      status: 429,
      code: 'HTTP_429',
      message: 'All available accounts exhausted',
      response: {
        data: {
          error: {
            code: 'HTTP_429',
            status: 429,
            message: 'All available accounts exhausted'
          }
        }
      }
    });
  });

  test('replays direct HTTP 200 SSE normal frames without filtering advisory codex rate-limit frames', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-200-sse-normal',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      postStream: async () => Readable.from([
        'event: codex.rate_limits\n',
        `data: ${JSON.stringify({ type: 'codex.rate_limits', limit_reached: false })}\n\n`,
        'event: response.created\n',
        `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_ok', status: 'in_progress' } })}\n\n`,
        'event: response.completed\n',
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_ok', status: 'completed' } })}\n\n`
      ])
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      stream: true
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    const result = await provider.sendRequestInternal(inbound);
    const chunks: Buffer[] = [];
    for await (const chunk of result.sseStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toContain('event: codex.rate_limits');
    expect(text).toContain('"limit_reached":false');
    expect(text).toContain('event: response.created');
    expect(text).toContain('event: response.completed');
    expect(text).toContain('resp_ok');
  });

  test('passes data-only direct Responses SSE frames through without synthesizing event names', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-data-only-sse-event-names',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      postStream: async () => Readable.from([
        `data: ${JSON.stringify({
          type: 'response.created',
          response: { id: 'resp_data_only', object: 'response', status: 'in_progress', output: [] }
        })}\n\n`,
        `data: ${JSON.stringify({
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            id: 'fc_apply_patch_data_only',
            type: 'function_call',
            call_id: 'call_apply_patch_data_only',
            name: 'apply_patch',
            arguments: '',
            status: 'in_progress'
          }
        })}\n\n`,
        `data: ${JSON.stringify({
          type: 'response.function_call_arguments.done',
          output_index: 0,
          item_id: 'fc_apply_patch_data_only',
          call_id: 'call_apply_patch_data_only',
          name: 'apply_patch',
          arguments: '{"patch":"*** Begin Patch\\n*** Add File: tmp/direct-data-only.txt\\n+ok\\n*** End Patch"}'
        })}\n\n`,
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: { id: 'resp_data_only', object: 'response', status: 'completed', output: [] }
        })}\n\n`,
        `data: ${JSON.stringify({
          type: 'response.done',
          response: { id: 'resp_data_only', object: 'response', status: 'completed', output: [] }
        })}\n\n`
      ])
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      stream: true
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    const result = await provider.sendRequestInternal(inbound);
    const chunks: Buffer[] = [];
    for await (const chunk of result.sseStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).not.toContain('event: response.created');
    expect(text).not.toContain('event: response.output_item.added');
    expect(text).not.toContain('event: response.function_call_arguments.done');
    expect(text).not.toContain('event: response.completed');
    expect(text).not.toContain('event: response.done');
    expect(text).toContain('"type":"response.created"');
    expect(text).toContain('"type":"response.output_item.added"');
    expect(text).toContain('"type":"response.function_call_arguments.done"');
    expect(text).toContain('"type":"response.completed"');
    expect(text).toContain('"type":"response.done"');
    expect(text).toContain('call_apply_patch_data_only');
    expect(text).toContain('tmp/direct-data-only.txt');
    expect(text).not.toContain('event: message');
  });

  test('does not append a direct Responses SSE done token when upstream omits it', async () => {
    const config: OpenAIStandardConfig = {
      id: 'test-responses-direct-completed-needs-done-token',
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'test',
        auth: { type: 'apikey', apiKey: 'test-key-1234567890' },
        overrides: { baseUrl: 'https://example.invalid/v1', endpoint: '/responses' }
      }
    } as unknown as OpenAIStandardConfig;

    const provider = new ResponsesProvider(config, emptyDeps) as any;
    provider.isInitialized = true;
    provider.snapshotPhase = async () => {};
    provider.buildRequestHeaders = async () => ({ Authorization: 'Bearer test-key-1234567890' });
    provider.finalizeRequestHeaders = async (headers: Record<string, string>) => headers;
    provider.httpClient = {
      postStream: async () => Readable.from([
        `data: ${JSON.stringify({
          type: 'response.created',
          response: { id: 'resp_completed_only', object: 'response', status: 'in_progress', output: [] }
        })}\n\n`,
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: { id: 'resp_completed_only', object: 'response', status: 'completed', output: [] }
        })}\n\n`
      ])
    };

    const inbound = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello direct' }] }],
      stream: true
    } as any;

    attachProviderRuntimeMetadata(inbound, {
      metadata: { entryEndpoint: '/v1/responses', __responsesDirectPassthrough: true }
    });

    const result = await provider.sendRequestInternal(inbound);
    const chunks: Buffer[] = [];
    for await (const chunk of result.sseStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toContain('"type":"response.completed"');
    expect(text).not.toContain('event: response.completed');
    expect(text).not.toContain('data: [DONE]');
    expect(text).not.toContain('event: response.done');
  });
});
