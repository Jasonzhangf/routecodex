import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../../src/server/runtime/handlers/types.js';
import type { ProviderHandle } from '../../../../src/server/runtime/http-server/types.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import {
  captureResponsesRequestContext,
  clearAllResponsesConversationState,
  getResponsesConversationStoreDebugStats,
  recordResponsesResponse,
  resumeLatestResponsesContinuationByScope,
} from '../../../../src/modules/llmswitch/bridge/responses-conversation-store-host.js';

const mockExecuteHubPipelineNative = jest.fn();

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/routing-integrations.js', () => ({
  bootstrapVirtualRouterConfig: jest.fn(async (input: unknown) => ({ config: input, runtime: {}, targetRuntime: {} })),
  compileRouteCodexRuntimeManifest: jest.fn(async () => ({
    manifestVersion: 'routecodex.runtime-config.v1',
    virtualRouterBootstrapInput: {},
    pipelineRuntimeConfig: {},
  })),
  compileRouteCodexRuntimeManifestSync: jest.fn(() => ({
    manifestVersion: 'routecodex.runtime-config.v1',
    virtualRouterBootstrapInput: {},
    pipelineRuntimeConfig: {},
  })),
  collectRouteCodexV2ConfigSourceErrorsSync: jest.fn(() => []),
  normalizeRouteCodexV2RuntimeSourceSync: jest.fn((input: unknown) => input ?? {}),
  resolvePrimaryRouteCodexRoutingPolicyGroupSync: jest.fn(() => 'default'),
  extractRouteCodexMaterializedProviderConfigsSync: jest.fn(() => null),
  materializeRouteCodexUserConfigFromManifestSync: jest.fn((userConfig: unknown) => userConfig ?? {}),
  buildRouteCodexProviderProfilesSync: jest.fn(() => ({})),
  buildRouteCodexForwarderProfilesSync: jest.fn(() => ({})),
  parseRouteCodexTomlRecord: jest.fn(async () => ({})),
  parseRouteCodexTomlRecordSync: jest.fn(() => ({})),
  serializeRouteCodexTomlRecord: jest.fn(async () => ''),
  serializeRouteCodexTomlRecordSync: jest.fn(() => ''),
  updateRouteCodexTomlStringScalarInTable: jest.fn(async (input: any) => input?.raw ?? ''),
  updateRouteCodexTomlStringScalarInTableSync: jest.fn((input: any) => input?.raw ?? ''),
  decodeRouteCodexUserConfigTextSync: jest.fn(() => ({ format: 'toml', parsed: {} })),
  decodeRouteCodexProviderConfigTextSync: jest.fn(() => ({ format: 'toml', parsed: {} })),
  detectRouteCodexUserConfigFormatSync: jest.fn(() => 'toml'),
  detectRouteCodexProviderConfigFormatSync: jest.fn(() => 'toml'),
  writeRouteCodexUserConfigFileNativeSync: jest.fn((input: any) => ({
    path: input?.configPath ?? '',
    format: 'toml',
    raw: '',
    parsed: input?.parsed ?? {},
  })),
  writeRouteCodexProviderConfigFileNativeSync: jest.fn((input: any) => ({
    path: input?.configPath ?? '',
    format: 'toml',
    raw: '',
    parsed: input?.parsed ?? {},
  })),
  updateRouteCodexUserConfigStringScalarNativeSync: jest.fn((input: any) => ({
    path: input?.configPath ?? '',
    format: 'toml',
    raw: '',
    parsed: {},
  })),
  loadRouteCodexConfigNativeSync: jest.fn(() => ({ configPath: '', userConfig: {}, providerProfiles: {} })),
  coerceRouteCodexProviderConfigV2: jest.fn(async (parsed: unknown) => parsed ?? null),
  coerceRouteCodexProviderConfigV2Sync: jest.fn((parsed: unknown) => parsed ?? null),
  planRouteCodexProviderConfigV2FilesSync: jest.fn(() => ({ files: [] })),
  resolveRouteCodexProviderConfigV2IdentitySync: jest.fn((input: unknown) => input ?? {}),
  loadRouteCodexProviderConfigsV2FromRootSync: jest.fn(() => ({})),
  planAuthFileResolutionNativeSync: jest.fn((input: unknown) => input ?? {}),
  resolveAuthFileKeyNativeSync: jest.fn((input: any) => input?.key ?? ''),
  planProviderConfigRootNativeSync: jest.fn(() => ({ providerRoot: '' })),
  planRouteCodexConfigLoaderPathsNativeSync: jest.fn(() => ({ configPath: '' })),
  resolveRouteCodexConfigPathNativeSync: jest.fn(() => ''),
  resolveRccPathNativeSync: jest.fn((...parts: string[]) => parts.join('/')),
  resolveRccSnapshotsDirNativeSync: jest.fn(() => ''),
  resolveRccUserDirNativeSync: jest.fn(() => ''),
  createHubPipelineNative: jest.fn(() => 'mock_hub_pipeline_handle'),
  executeHubPipelineNative: mockExecuteHubPipelineNative,
  updateHubPipelineVirtualRouterConfigNative: jest.fn(),
  updateHubPipelineEngineDepsNative: jest.fn(),
  routeHubPipelineVirtualRouterNative: jest.fn(() => ({ diagnostics: {} })),
  diagnoseHubPipelineVirtualRouterNative: jest.fn(() => ({ diagnostics: {} })),
  getHubPipelineVirtualRouterStatusNative: jest.fn(() => ({})),
  markHubPipelineVirtualRouterConcurrencyScopeBusyNative: jest.fn(),
  markHubPipelineVirtualRouterConcurrencyScopeIdleNative: jest.fn(),
  disposeHubPipelineNative: jest.fn(),
}));

const {
  HubRequestExecutor,
  __requestExecutorTestables,
} = await import('../../../../src/server/runtime/http-server/request-executor.js');

function createRuntimeHandle(processImpl: () => Promise<unknown>): ProviderHandle {
  return {
    providerType: 'openai',
    providerFamily: 'openai',
    providerProtocol: 'openai-responses',
    providerId: 'dbittai-gpt',
    runtime: {
      runtimeKey: 'runtime:key',
      providerId: 'dbittai-gpt',
      providerKey: 'dbittai-gpt.key1.gpt-5.3-codex',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-responses',
      endpoint: 'https://example.invalid/v1',
      auth: { type: 'static', value: 'test-key' },
      outboundProfile: 'openai-responses',
      defaultModel: 'gpt-5.3-codex',
    },
    instance: {
      processIncoming: jest.fn().mockImplementation(processImpl),
      cleanup: jest.fn(),
    },
  } as unknown as ProviderHandle;
}

function createExecutor(converted: PipelineExecutionResult) {
  const handle = createRuntimeHandle(async () => ({
    status: 200,
    data: {
      id: 'upstream_resp_1',
      object: 'response',
      status: 'failed',
      error: { code: 'HTTP_400', message: 'bad request' },
    },
  }));

  const pipelineResult: PipelineExecutionResult = {
    providerPayload: {
      model: 'gpt-5.3-codex',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    },
    target: {
      providerKey: 'dbittai-gpt.key1.gpt-5.3-codex',
      providerType: 'openai',
      outboundProfile: 'openai-responses',
      runtimeKey: 'runtime:key',
      processMode: 'standard',
    },
    processMode: 'standard',
    routingDecision: {
      routeName: 'thinking',
      providerProtocol: 'openai-responses',
      pool: ['dbittai-gpt.key1.gpt-5.3-codex'],
    },
    metadata: {},
  };

  mockExecuteHubPipelineNative.mockReturnValue(pipelineResult);
  const fakePipeline = 'mock_hub_pipeline_handle';

  const deps = {
    runtimeManager: {
      resolveRuntimeKey: jest.fn().mockReturnValue('runtime:key'),
      getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    },
    getHubPipeline: () => fakePipeline,
    getModuleDependencies: (): ModuleDependencies =>
      ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true }),
        },
      }) as unknown as ModuleDependencies,
    logStage: jest.fn(),
    stats: {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    },
  };

  const executor = new HubRequestExecutor(deps as any);
  jest.spyOn(executor as any, 'convertProviderResponseIfNeeded').mockResolvedValue(converted);
  return { executor };
}

describe('HubRequestExecutor responses conversation retention cleanup', () => {
  const requestId = 'req_responses_store_cleanup_400';
  let previousStoreFile: string | undefined;
  let storeTempDir: string | undefined;

  beforeEach(() => {
    previousStoreFile = process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE;
    storeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-responses-store-cleanup-'));
    process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE = path.join(storeTempDir, 'store.json');
    clearAllResponsesConversationState();
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
    mockExecuteHubPipelineNative.mockReset();
  });

  afterEach(() => {
    clearAllResponsesConversationState();
    if (previousStoreFile === undefined) {
      delete process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE;
    } else {
      process.env.ROUTECODEX_RESPONSES_CONVERSATION_STORE = previousStoreFile;
    }
    if (storeTempDir) {
      fs.rmSync(storeTempDir, { recursive: true, force: true });
    }
    previousStoreFile = undefined;
    storeTempDir = undefined;
  });

  it('clears captured responses request when malformed responses continuation shape converts into client-side 400 contract', async () => {
    captureResponsesRequestContext({
      requestId,
      sessionId: 'sess-cleanup-400',
      payload: {
        model: 'gpt-5.3-codex',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
    });

    expect(getResponsesConversationStoreDebugStats().requestMapSize).toBeGreaterThan(0);

    const { executor } = createExecutor({
      status: 400,
      body: {
        error: {
          code: 'MALFORMED_REQUEST',
          message: 'previous_response_id is only supported on Responses WebSocket v2',
        },
      },
    });

    const result = await executor.execute({
      requestId,
      entryEndpoint: '/v1/responses',
      headers: {},
      body: {
        model: 'gpt-5.3-codex',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
      metadata: { stream: false, inboundStream: false },
    } as PipelineExecutionInput);

    expect(result).toBeTruthy();
    expect(getResponsesConversationStoreDebugStats().requestMapSize).toBe(0);
    expect(getResponsesConversationStoreDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
  });

  it('does not allow same-session continuation restore after malformed responses continuation shape was converted into error contract', async () => {
    captureResponsesRequestContext({
      requestId,
      sessionId: 'sess-cleanup-restore-block',
      payload: {
        model: 'gpt-5.3-codex',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
    });

    const { executor } = createExecutor({
      status: 400,
      body: {
        error: {
          code: 'MALFORMED_REQUEST',
          message: 'previous_response_id is only supported on Responses WebSocket v2',
        },
      },
    });

    await executor.execute({
      requestId,
      entryEndpoint: '/v1/responses',
      headers: {},
      body: {
        model: 'gpt-5.3-codex',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
      metadata: { stream: false, inboundStream: false },
    } as PipelineExecutionInput);

    const resumed = resumeLatestResponsesContinuationByScope({
      requestId: 'req_after_error_contract_restore_attempt',
      sessionId: 'sess-cleanup-restore-block',
      payload: {
        model: 'gpt-5.3-codex',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'bad prior assistant that must not exist' }],
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'next turn' }],
          },
        ],
      },
    });

    expect(resumed).toBeNull();
    expect(getResponsesConversationStoreDebugStats().requestMapSize).toBe(0);
    expect(getResponsesConversationStoreDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
  });

  it('clears captured responses request on provider 502 error responses to avoid orphan pending entries', async () => {
    const previousMaxAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    const previousLogicalLimit = process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '1';
    process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT = '1';
    captureResponsesRequestContext({
      requestId,
      sessionId: 'sess-cleanup-502',
      payload: {
        model: 'gpt-5.3-codex',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
    });

    expect(getResponsesConversationStoreDebugStats().requestMapSize).toBeGreaterThan(0);

    const { executor } = createExecutor({
      status: 502,
      body: {
        error: {
          code: 'HTTP_502',
          message: 'Upstream request failed',
        },
      },
    });

    try {
      const result = await executor.execute({
        requestId,
        entryEndpoint: '/v1/responses',
        headers: {},
        body: {
          model: 'gpt-5.3-codex',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        },
        metadata: { stream: false, inboundStream: false },
      } as PipelineExecutionInput);
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(getResponsesConversationStoreDebugStats().requestMapSize).toBe(0);
      expect(getResponsesConversationStoreDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
    } finally {
      if (previousMaxAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousMaxAttempts;
      }
      if (previousLogicalLimit === undefined) {
        delete process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT;
      } else {
        process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT = previousLogicalLimit;
      }
    }
  }, 15000);



  it('RED: does not auto-restore same-session continuation for a plain create request after prior tool-call state exists', async () => {
    captureResponsesRequestContext({
      requestId,
      sessionId: 'sess-plain-create-no-auto-resume',
      payload: {
        model: 'gpt-5.3-codex',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '先调用工具' }] }],
        tools: [{ type: 'function', name: 'exec_command' }],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '先调用工具' }],
          },
        ],
        toolsRaw: [{ type: 'function', name: 'exec_command' }],
      },
    });

    recordResponsesResponse({
      requestId,
      sessionId: 'sess-plain-create-no-auto-resume',
      response: {
        id: 'resp_plain_create_no_auto_resume_1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
            call_id: 'call_plain_create_no_auto_resume_1',
          },
        ],
      },
    } as any);

    const resumed = resumeLatestResponsesContinuationByScope({
      requestId: 'req_plain_create_no_auto_resume_attempt',
      sessionId: 'sess-plain-create-no-auto-resume',
      payload: {
        model: 'gpt-5.3-codex',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '这是普通 create，不该自动 continuation' }] }],
      },
    });

    expect(resumed).toBeNull();
  });

  it('clears captured responses request when provider send fails before any response is recorded', async () => {
    captureResponsesRequestContext({
      requestId,
      sessionId: 'sess-cleanup-send-fail',
      payload: {
        model: 'gpt-5.3-codex',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
    });

    expect(getResponsesConversationStoreDebugStats().requestMapSize).toBeGreaterThan(0);
    expect(getResponsesConversationStoreDebugStats().requestEntriesWithoutLastResponseId).toBe(1);

    const handle = createRuntimeHandle(async () => {
      throw Object.assign(new Error('provider raw stream ended with no content'), {
        code: 'MALFORMED_REQUEST',
        upstreamCode: 'MALFORMED_REQUEST',
        status: 400,
        statusCode: 400,
        retryable: false,
      });
    });

    const pipelineResult: PipelineExecutionResult = {
      providerPayload: {
        model: 'gpt-5.3-codex',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
      target: {
        providerKey: 'dbittai-gpt.key1.gpt-5.3-codex',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:key',
        processMode: 'standard',
      },
      processMode: 'standard',
      routingDecision: {
        routeName: 'thinking',
        providerProtocol: 'openai-responses',
        pool: ['dbittai-gpt.key1.gpt-5.3-codex'],
      },
      metadata: {},
    };

    mockExecuteHubPipelineNative.mockReturnValue(pipelineResult);
    const fakePipeline = 'mock_hub_pipeline_handle';

    const deps = {
      runtimeManager: {
        resolveRuntimeKey: jest.fn().mockReturnValue('runtime:key'),
        getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
        getHandleByProviderKey: jest.fn(),
        disposeAll: jest.fn(),
        initialize: jest.fn(),
      },
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockResolvedValue({ success: true }),
          },
        }) as unknown as ModuleDependencies,
      logStage: jest.fn(),
      stats: {
        recordRequestStart: jest.fn(),
        recordCompletion: jest.fn(),
        bindProvider: jest.fn(),
        recordToolUsage: jest.fn(),
      },
    };

    const executor = new HubRequestExecutor(deps as any);

    await expect(executor.execute({
      requestId,
      entryEndpoint: '/v1/responses',
      headers: {},
      body: {
        model: 'gpt-5.3-codex',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      },
      metadata: { stream: false, inboundStream: false },
    } as PipelineExecutionInput)).rejects.toMatchObject({
      code: 'MALFORMED_REQUEST',
      statusCode: 400,
    });

    expect(getResponsesConversationStoreDebugStats().requestMapSize).toBe(0);
    expect(getResponsesConversationStoreDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
  });

});
