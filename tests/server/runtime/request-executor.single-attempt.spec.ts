import { jest } from '@jest/globals';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../src/server/runtime/handlers/types.js';
import type { HubPipeline } from '../../../src/server/runtime/http-server/types.js';
import { HubRequestExecutor } from '../../../src/server/runtime/http-server/request-executor.js';
import type { ProviderRuntimeManager } from '../../../src/server/runtime/http-server/runtime-manager.js';
import type { ProviderHandle } from '../../../src/server/runtime/http-server/types.js';
import type { ModuleDependencies } from '../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import {
  __resetSnapshotLocalDiskGateForTests,
  canWriteSnapshotToLocalDisk
} from '../../../src/utils/snapshot-local-disk-gate.js';

function createRuntimeHandle(processImpl: () => Promise<unknown>): ProviderHandle {
  return {
    providerType: 'gemini',
    providerFamily: 'gemini',
    providerId: 'antigravity',
    instance: {
      processIncoming: jest.fn().mockImplementation(processImpl),
      cleanup: jest.fn()
    }
  } as unknown as ProviderHandle;
}

function createExecutor(pipelineResult: PipelineExecutionResult, handle: ProviderHandle) {
  const fakePipeline: HubPipeline = {
    execute: jest.fn().mockResolvedValue(pipelineResult)
  };

  const runtimeManager: ProviderRuntimeManager = {
    resolveRuntimeKey: jest.fn().mockReturnValue('runtime:key'),
    getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
    getHandleByProviderKey: jest.fn(),
    disposeAll: jest.fn(),
    initialize: jest.fn()
  } as unknown as ProviderRuntimeManager;

  const stats = {
    recordRequestStart: jest.fn(),
    recordCompletion: jest.fn(),
    bindProvider: jest.fn(),
    recordToolUsage: jest.fn()
  };

  const errorHandlingCenter = {
    handleError: jest.fn().mockResolvedValue({ success: true })
  };

  const deps = {
    runtimeManager,
    getHubPipeline: () => fakePipeline,
    getModuleDependencies: (): ModuleDependencies => ({
      errorHandlingCenter
    } as ModuleDependencies),
    logStage: jest.fn(),
    stats
  };

  const executor = new HubRequestExecutor(deps);

  const request: PipelineExecutionInput = {
    requestId: 'req_test',
    entryEndpoint: '/v1/responses',
    headers: {},
    body: { messages: [{ role: 'user', content: 'ping' }] },
    metadata: { stream: false, inboundStream: false }
  };

  return { executor, request, handle, runtimeManager, logStage: deps.logStage, stats };
}

describe('HubRequestExecutor single attempt behaviour', () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(() => {
    warnSpy.mockClear();
    __resetSnapshotLocalDiskGateForTests();
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  const pipelineResult: PipelineExecutionResult = {
    providerPayload: { data: { messages: [] } },
    target: {
      providerKey: 'antigravity.alias',
      providerType: 'gemini',
      outboundProfile: 'gemini-chat',
      runtimeKey: 'runtime:key',
      processMode: 'standard'
    },
    processMode: 'standard',
    metadata: {}
  };

  it('invokes provider only once on success', async () => {
    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const { executor, request } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValue({ status: 200, body: { output_text: 'ok' } });

    const response = await executor.execute(request);

    expect(response).toBeDefined();
    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
  });

  it('unlocks local snapshot gate before provider runtime starts writing snapshots', async () => {
    const handle = createRuntimeHandle(async () => {
      expect(canWriteSnapshotToLocalDisk('req_test')).toBe(true);
      return { ok: true };
    });
    const { executor, request } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValue({ status: 200, body: { output_text: 'ok' } });

    await executor.execute(request);

    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
  });

  it('falls back to derive finish_reason when stream finish marker is absent', async () => {
    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const { executor, request } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValue({
        status: 200,
        body: {
          status: 'completed',
          output_text: 'done'
        }
      });

    const response = await executor.execute(request);
    expect(response.usageLogInfo?.finishReason).toBe('stop');
  });

  it('derives finish_reason from nested data payload when stream marker is absent', async () => {
    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const { executor, request } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValue({
        status: 200,
        body: {
          data: {
            choices: [
              {
                finish_reason: 'tool_calls'
              }
            ]
          }
        }
      });

    const response = await executor.execute(request);
    expect(response.usageLogInfo?.finishReason).toBe('tool_calls');
  });

  it('falls back to provider normalized body for finish_reason when converted body lacks markers', async () => {
    const handle = createRuntimeHandle(async () => ({
      status: 200,
      data: {
        choices: [
          {
            finish_reason: 'stop'
          }
        ]
      }
    }));
    const { executor, request } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValue({
        status: 200,
        body: {
          id: 'converted_without_finish_reason'
        }
      });

    const response = await executor.execute(request);
    expect(response.usageLogInfo?.finishReason).toBe('stop');
  });

  it('keeps usage from provider response when converted payload has no usage', async () => {
    const handle = createRuntimeHandle(async () => ({
      status: 200,
      data: {
        id: 'raw_provider_payload',
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
          total_tokens: 17
        }
      }
    }));
    const { executor, request, stats } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValue({ status: 200, body: { id: 'converted_payload_without_usage' } });

    await executor.execute(request);

    const completionCalls = stats.recordCompletion.mock.calls;
    const successCall = completionCalls.find((call) => call[1] && call[1].error === false);
    expect(successCall).toBeDefined();
    expect(successCall?.[1]?.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17
    });
  });

  it('retries retryable provider errors and re-runs pipeline', async () => {
    const retryable = Object.assign(new Error('HTTP 429'), { statusCode: 429, retryable: true });
    const successHandle = createRuntimeHandle(async () => ({ ok: true }));
    const failingHandle = createRuntimeHandle(async () => {
      throw retryable;
    });
    const pipelineResultOne: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'antigravity.aliasA',
        providerType: 'gemini',
        outboundProfile: 'gemini-chat',
        runtimeKey: 'runtime:one',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const pipelineResultTwo: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'qwen.aliasB',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:two',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockResolvedValueOnce(pipelineResultOne).mockResolvedValueOnce(pipelineResultTwo)
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === 'runtime:one' ? failingHandle : successHandle
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage: jest.fn(),
      stats
    };
    const executor = new HubRequestExecutor(deps);
    const request: PipelineExecutionInput = {
      requestId: 'req_retry',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'retry me' }] },
      metadata: { stream: false, inboundStream: false }
    };

    const response = await executor.execute(request);

    expect(response).toBeDefined();
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    const secondCallMetadata = fakePipeline.execute.mock.calls[1][0]
      .metadata as Record<string, unknown>;
    expect(secondCallMetadata.excludedProviderKeys).toEqual(['antigravity.aliasA']);
  });

  it('reroutes when converted response is finish_reason=stop with empty assistant payload', async () => {
    const firstHandle = createRuntimeHandle(async () => ({ status: 200, data: { ok: true } }));
    const secondHandle = createRuntimeHandle(async () => ({ status: 200, data: { ok: true } }));
    const pipelineResultOne: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'qwenchat.aliasA',
        providerType: 'openai',
        outboundProfile: 'openai-chat',
        runtimeKey: 'runtime:one',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const pipelineResultTwo: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tab.aliasB',
        providerType: 'openai',
        outboundProfile: 'openai-chat',
        runtimeKey: 'runtime:two',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockResolvedValueOnce(pipelineResultOne).mockResolvedValueOnce(pipelineResultTwo)
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === 'runtime:one' ? firstHandle : secondHandle
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage: jest.fn(),
      stats
    };
    const executor = new HubRequestExecutor(deps);
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValueOnce({
        status: 200,
        body: { choices: [{ finish_reason: 'stop', message: { content: '' } }] }
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }
      });
    const request: PipelineExecutionInput = {
      requestId: 'req_empty_assistant_reroute',
      entryEndpoint: '/v1/chat/completions',
      headers: {},
      body: { messages: [{ role: 'user', content: 'retry me' }] },
      metadata: { stream: false, inboundStream: false }
    };

    const response = await executor.execute(request);

    expect(response).toBeDefined();
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    const secondCallMetadata = fakePipeline.execute.mock.calls[1][0]
      .metadata as Record<string, unknown>;
    expect(secondCallMetadata.excludedProviderKeys).toEqual(['qwenchat.aliasA']);
  });

  it('logs provider-switch status/code/upstreamCode parsed from raw error text', async () => {
    const retryable = Object.assign(
      new Error(
        'HTTP 429: {"error":{"code":"SSE_TO_JSON_ERROR","message":"decoder crashed","upstream_code":"EPIPE"}}'
      ),
      { statusCode: 429 }
    );
    const successHandle = createRuntimeHandle(async () => ({ ok: true }));
    const failingHandle = createRuntimeHandle(async () => {
      throw retryable;
    });

    const pipelineResultOne: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tab.key1',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:one',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const pipelineResultTwo: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tab.key2',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:two',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockResolvedValueOnce(pipelineResultOne).mockResolvedValueOnce(pipelineResultTwo)
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === 'runtime:one' ? failingHandle : successHandle
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage: jest.fn(),
      stats
    };
    const executor = new HubRequestExecutor(deps);
    const request: PipelineExecutionInput = {
      requestId: 'req_retry_log_fields',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'retry me' }] },
      metadata: { stream: false, inboundStream: false }
    };

    const response = await executor.execute(request);
    expect(response).toBeDefined();

    const warnLines = warnSpy.mock.calls.map(call => String(call[0] ?? ''));
    const switchLine = warnLines.find(line => line.includes('[provider-switch]'));
    expect(switchLine).toBeDefined();
    expect(switchLine).toContain('status=429');
    expect(switchLine).toContain('code=SSE_TO_JSON_ERROR');
    expect(switchLine).toContain('upstreamCode=EPIPE');
    expect(switchLine).toContain('reason="decoder crashed"');
  });

  it('retries and reroutes when converted response returns status 429 without error envelope', async () => {
    const rateLimitedHandle = createRuntimeHandle(async () => ({ data: { id: 'resp_429' }, status: 429 }));
    const successHandle = createRuntimeHandle(async () => ({ data: { id: 'resp_ok' }, status: 200 }));

    const pipelineResultOne: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tab.key1',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:one',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const pipelineResultTwo: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tab.key2',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:two',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };

    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockResolvedValueOnce(pipelineResultOne).mockResolvedValueOnce(pipelineResultTwo)
    };

    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === 'runtime:one' ? rateLimitedHandle : successHandle
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    } as unknown as ProviderRuntimeManager;

    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage: jest.fn(),
      stats
    };

    const executor = new HubRequestExecutor(deps);
    const convertSpy = jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValueOnce({ status: 429, body: { id: 'resp_429_without_error' } })
      .mockResolvedValueOnce({ status: 200, body: { id: 'resp_ok' } });

    const request: PipelineExecutionInput = {
      requestId: 'req_retry_429_wrapped',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'retry me' }] },
      metadata: { stream: false, inboundStream: false }
    };

    const response = await executor.execute(request);

    expect(response).toEqual(expect.objectContaining({ status: 200 }));
    expect(convertSpy).toHaveBeenCalledTimes(2);
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(rateLimitedHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    const secondCallMetadata = fakePipeline.execute.mock.calls[1][0]
      .metadata as Record<string, unknown>;
    expect(secondCallMetadata.excludedProviderKeys).toEqual(['tab.key1']);
  });

  it('reroutes when SSE wrapper carries Anthropic 1302 rate-limit error', async () => {
    const rateLimitedHandle = createRuntimeHandle(async () => ({
      status: 200,
      data: {
        mode: 'sse',
        error: 'Anthropic SSE error event [1302] 您的账户已达到速率限制，请您控制请求频率'
      }
    }));
    const successHandle = createRuntimeHandle(async () => ({ status: 200, data: { ok: true } }));

    const pipelineResultOne: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tab.key1',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:one',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const pipelineResultTwo: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tab.key2',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:two',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };

    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockResolvedValueOnce(pipelineResultOne).mockResolvedValueOnce(pipelineResultTwo)
    };

    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === 'runtime:one' ? rateLimitedHandle : successHandle
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    } as unknown as ProviderRuntimeManager;

    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage: jest.fn(),
      stats
    };

    const executor = new HubRequestExecutor(deps);
    const request: PipelineExecutionInput = {
      requestId: 'req_retry_1302',
      entryEndpoint: '/internal/test',
      headers: {},
      body: { messages: [{ role: 'user', content: 'retry me' }] },
      metadata: { stream: false, inboundStream: false }
    };

    const response = await executor.execute(request);

    expect(response).toEqual(expect.objectContaining({ status: 200 }));
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(rateLimitedHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    const secondCallMetadata = fakePipeline.execute.mock.calls[1][0]
      .metadata as Record<string, unknown>;
    expect(secondCallMetadata.excludedProviderKeys).toEqual(['tab.key1']);
  });

  it('reroutes when SSE wrapper carries Anthropic 500 upstream failure', async () => {
    const failingHandle = createRuntimeHandle(async () => ({
      status: 200,
      data: {
        mode: 'sse',
        error: 'Anthropic SSE error event [500] Operation failed (request_id=req500)'
      }
    }));
    const successHandle = createRuntimeHandle(async () => ({ status: 200, data: { ok: true } }));

    const firstResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tab.key1',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:one',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const secondResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tab.key2',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:two',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };

    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockResolvedValueOnce(firstResult).mockResolvedValueOnce(secondResult)
    };

    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === 'runtime:one' ? failingHandle : successHandle
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    } as unknown as ProviderRuntimeManager;

    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage: jest.fn(),
      stats
    };

    const executor = new HubRequestExecutor(deps);
    const request: PipelineExecutionInput = {
      requestId: 'req_retry_sse_500',
      entryEndpoint: '/internal/test',
      headers: {},
      body: { messages: [{ role: 'user', content: 'retry me' }] },
      metadata: { stream: false, inboundStream: false }
    };

    const response = await executor.execute(request);

    expect(response).toEqual(expect.objectContaining({ status: 200 }));
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    const secondCallMetadata = fakePipeline.execute.mock.calls[1][0]
      .metadata as Record<string, unknown>;
    expect(secondCallMetadata.excludedProviderKeys).toEqual(['tab.key1']);
  });

  it('prefers route-selected target compatibility profile for response conversion metadata', async () => {
    const handle = createRuntimeHandle(async () => ({ data: { id: 'resp_ok' }, status: 200 }));
    const pipelineResultDeepSeek: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'deepseek-web.3.deepseek-chat',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:deepseek',
        processMode: 'standard',
        compatibilityProfile: 'chat:deepseek-web'
      },
      processMode: 'standard',
      metadata: {}
    };
    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockResolvedValueOnce(pipelineResultDeepSeek)
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage: jest.fn(),
      stats
    };

    const executor = new HubRequestExecutor(deps);
    const convertSpy = jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockImplementation(async (options: any) => options.response);

    const request: PipelineExecutionInput = {
      requestId: 'req_profile_override',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'ping' }] },
      metadata: {
        stream: false,
        inboundStream: false,
        compatibilityProfile: 'chat:qwen',
        target: {
          providerKey: 'qwen.1.qwen3-coder-plus',
          compatibilityProfile: 'chat:qwen'
        }
      } as Record<string, unknown>
    };

    await executor.execute(request);

    expect(convertSpy).toHaveBeenCalledTimes(1);
    const convertOptions = convertSpy.mock.calls[0]?.[0] as { pipelineMetadata?: Record<string, unknown> };
    expect(convertOptions?.pipelineMetadata?.compatibilityProfile).toBe('chat:deepseek-web');
    expect((convertOptions?.pipelineMetadata?.target as Record<string, unknown>)?.providerKey).toBe(
      'deepseek-web.3.deepseek-chat'
    );
    expect((convertOptions?.pipelineMetadata?.target as Record<string, unknown>)?.compatibilityProfile).toBe(
      'chat:deepseek-web'
    );
  });

  it('drops inherited compatibility profile when route target has no compatibility profile', async () => {
    const handle = createRuntimeHandle(async () => ({ data: { id: 'resp_ok' }, status: 200 }));
    const pipelineResultNoCompat: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tabglm.key1.glm-5',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:tabglm',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockResolvedValueOnce(pipelineResultNoCompat)
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage: jest.fn(),
      stats
    };

    const executor = new HubRequestExecutor(deps);
    const convertSpy = jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockImplementation(async (options: any) => options.response);

    const request: PipelineExecutionInput = {
      requestId: 'req_profile_drop',
      entryEndpoint: '/v1/messages',
      headers: {},
      body: { messages: [{ role: 'user', content: 'ping' }] },
      metadata: {
        stream: false,
        inboundStream: false,
        compatibilityProfile: 'chat:glm',
        target: {
          providerKey: 'glm.1.glm-4.6',
          compatibilityProfile: 'chat:glm'
        }
      } as Record<string, unknown>
    };

    await executor.execute(request);

    expect(convertSpy).toHaveBeenCalledTimes(1);
    const convertOptions = convertSpy.mock.calls[0]?.[0] as { pipelineMetadata?: Record<string, unknown> };
    expect(convertOptions?.pipelineMetadata?.compatibilityProfile).toBeUndefined();
    expect((convertOptions?.pipelineMetadata?.target as Record<string, unknown>)?.providerKey).toBe(
      'tabglm.key1.glm-5'
    );
    expect((convertOptions?.pipelineMetadata?.target as Record<string, unknown>)?.compatibilityProfile).toBeUndefined();
  });

  it('preserves session scope metadata when pipeline metadata contains undefined fields', async () => {
    const handle = createRuntimeHandle(async () => ({ data: { id: 'resp_ok' }, status: 200 }));
    const pipelineResultWithUndefinedMetadata: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'iflow.3-138.kimi-k2.5',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:iflow',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        sessionId: undefined,
        tmuxSessionId: undefined,
        clientInjectReady: undefined
      }
    };
    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockResolvedValueOnce(pipelineResultWithUndefinedMetadata)
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage: jest.fn(),
      stats
    };
    const executor = new HubRequestExecutor(deps);
    const convertSpy = jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockImplementation(async (options: any) => options.response);

    const request: PipelineExecutionInput = {
      requestId: 'req_preserve_session_scope',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'ping' }] },
      metadata: {
        stream: false,
        inboundStream: false,
        sessionId: 'session-abc',
        tmuxSessionId: 'tmux-main-1',
        clientInjectReady: true
      } as Record<string, unknown>
    };

    await executor.execute(request);

    expect(convertSpy).toHaveBeenCalledTimes(1);
    const convertOptions = convertSpy.mock.calls[0]?.[0] as { pipelineMetadata?: Record<string, unknown> };
    expect(convertOptions?.pipelineMetadata?.sessionId).toBe('session-abc');
    expect(convertOptions?.pipelineMetadata?.tmuxSessionId).toBe('tmux-main-1');
    expect(convertOptions?.pipelineMetadata?.clientInjectReady).toBe(true);
  });

  it('does not retry unrecoverable provider errors', async () => {
    const fatal = Object.assign(new Error('HTTP 401'), { statusCode: 401, retryable: false });
    const handle = createRuntimeHandle(async () => {
      throw fatal;
    });
    const { executor, request, runtimeManager } = createExecutor(pipelineResult, handle);

    await expect(executor.execute(request)).rejects.toThrow('HTTP 401');
    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(runtimeManager.getHandleByRuntimeKey).toHaveBeenCalledTimes(1);
  });

  it('signals repeated identical antigravity errors to VirtualRouter via metadata.__rt', async () => {
    const agA = 'antigravity.aliasA';
    const agB = 'antigravity.aliasB';
    const other = 'tab.key1';

    const retryable403 = Object.assign(new Error('HTTP 403'), {
      statusCode: 403,
      upstreamCode: 'HTTP_403',
      retryable: true
    });

    const failingHandle = createRuntimeHandle(async () => {
      throw retryable403;
    });
    const successHandle = createRuntimeHandle(async () => ({ data: { ok: true } }));

    const pipelineResultA = {
      providerPayload: { messages: [{ role: 'user', content: 'retry me' }] },
      target: { providerKey: agA, runtimeKey: 'runtime:agA', outboundProfile: 'openai-chat' },
      processMode: 'chat'
    } as any;
    const pipelineResultB = {
      providerPayload: { messages: [{ role: 'user', content: 'retry me' }] },
      target: { providerKey: agB, runtimeKey: 'runtime:agB', outboundProfile: 'openai-chat' },
      processMode: 'chat'
    } as any;
    const pipelineResultOk = {
      providerPayload: { messages: [{ role: 'user', content: 'retry me' }] },
      target: { providerKey: other, runtimeKey: 'runtime:other', outboundProfile: 'openai-chat' },
      processMode: 'chat'
    } as any;

    const fakePipeline: HubPipeline = {
      execute: jest
        .fn()
        .mockResolvedValueOnce(pipelineResultA)
        .mockResolvedValueOnce(pipelineResultB)
        .mockResolvedValueOnce(pipelineResultOk)
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) => {
        if (runtimeKey === 'runtime:other') {
          return successHandle;
        }
        return failingHandle;
      }),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    } as unknown as ProviderRuntimeManager;

    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage: jest.fn(),
      stats
    };
    const executor = new HubRequestExecutor(deps);
    const request: PipelineExecutionInput = {
      requestId: 'req_retry_sig',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'retry me' }] },
      metadata: { stream: false, inboundStream: false }
    };

    const response = await executor.execute(request);
    expect(response).toBeDefined();
    expect(fakePipeline.execute).toHaveBeenCalledTimes(3);

    const thirdCallMetadata = fakePipeline.execute.mock.calls[2][0]
      .metadata as Record<string, unknown>;
    expect((thirdCallMetadata as any)?.__rt?.antigravityRetryErrorSignature).toBe('403:HTTP_403');
    expect((thirdCallMetadata as any)?.__rt?.antigravityRetryErrorConsecutive).toBe(2);
  });

  it('does not host-retry on HTTP 400 signature-invalid errors (handled by llmswitch-core servertool)', async () => {
    const invalidSig = Object.assign(new Error('HTTP 400: thinking.signature invalid'), {
      statusCode: 400,
      retryable: false,
      upstreamMessage: 'Bad Request: thinking.signature'
    });

    const handle = createRuntimeHandle(async () => {
      throw invalidSig;
    });

    const pipelineResultA: PipelineExecutionResult = {
      providerPayload: { metadata: { antigravitySessionId: 'sid-aaaaaaaaaaaaaaaa' }, data: { messages: [] } },
      target: {
        providerKey: 'antigravity.aliasRecover',
        providerType: 'gemini',
        outboundProfile: 'gemini-chat',
        runtimeKey: 'runtime:ag',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };

    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockResolvedValueOnce(pipelineResultA).mockResolvedValueOnce(pipelineResultA)
    };

    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    } as unknown as ProviderRuntimeManager;

    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage: jest.fn(),
      stats
    };
    const executor = new HubRequestExecutor(deps);
    const request: PipelineExecutionInput = {
      requestId: 'req_invalid_sig',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'retry me' }] },
      metadata: { stream: false, inboundStream: false }
    };

    await expect(executor.execute(request)).rejects.toThrow('thinking.signature');
    expect(fakePipeline.execute).toHaveBeenCalledTimes(1);
    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
  });

  it('excludes same-runtime provider keys together on PROVIDER_TRAFFIC_SATURATED retry', async () => {
    const saturatedError = Object.assign(new Error('provider traffic wait exceeded soft timeout'), {
      statusCode: 429,
      code: 'PROVIDER_TRAFFIC_SATURATED',
      retryable: true
    });
    const failingHandle = createRuntimeHandle(async () => {
      throw saturatedError;
    });
    const successHandle = createRuntimeHandle(async () => ({ ok: true }));

    const firstResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tab.key1',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:one',
        processMode: 'standard'
      },
      routingDecision: {
        routeName: 'tools',
        pool: ['tab.key1', 'tab.key1.alt', 'tab.key2']
      } as unknown as { routeName?: string },
      processMode: 'standard',
      metadata: {}
    };
    const secondResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tab.key2',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:two',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };

    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockResolvedValueOnce(firstResult).mockResolvedValueOnce(secondResult)
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn((providerKey?: string) => {
        if (providerKey === 'tab.key1' || providerKey === 'tab.key1.alt') {
          return 'runtime:one';
        }
        if (providerKey === 'tab.key2') {
          return 'runtime:two';
        }
        return undefined;
      }),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === 'runtime:one' ? failingHandle : successHandle
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    } as unknown as ProviderRuntimeManager;

    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage: jest.fn(),
      stats
    };
    const executor = new HubRequestExecutor(deps);
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValue({ status: 200, body: { output_text: 'ok' } });
    const request: PipelineExecutionInput = {
      requestId: 'req_runtime_scope_exclude',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'retry me' }] },
      metadata: { stream: false, inboundStream: false }
    };

    const response = await executor.execute(request);
    expect(response).toBeDefined();
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    const secondCallMetadata = fakePipeline.execute.mock.calls[1][0]
      .metadata as Record<string, unknown>;
    const excluded = Array.isArray(secondCallMetadata.excludedProviderKeys)
      ? secondCallMetadata.excludedProviderKeys as string[]
      : [];
    expect(excluded).toEqual(['tab.key1', 'tab.key1.alt']);
  });

  it('uses soft wait timeout only when route pool has cross-runtime alternatives', async () => {
    const acquireArgs: Array<Record<string, unknown>> = [];
    const trafficGovernor = {
      acquire: jest.fn(async (options: Record<string, unknown>) => {
        acquireArgs.push(options);
        return {
          permit: {
            runtimeKey: String(options.runtimeKey || ''),
            requestId: String(options.requestId || ''),
            leaseId: 'lease-1',
            stateKey: 'state-1'
          },
          policy: {
            concurrency: { maxInFlight: 2, acquireTimeoutMs: 60_000, staleLeaseMs: 300_000 },
            rpm: { requestsPerMinute: 120, acquireTimeoutMs: 60_000, windowMs: 60_000 }
          },
          waitedMs: 0,
          activeInFlight: 1,
          rpmInWindow: 1
        };
      }),
      release: jest.fn(async () => ({ released: true, activeInFlight: 0 }))
    };

    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const pipelineResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tab.key1',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:one',
        processMode: 'standard'
      },
      routingDecision: {
        routeName: 'tools',
        pool: ['tab.key1', 'tab.key1.alt']
      } as unknown as { routeName?: string },
      processMode: 'standard',
      metadata: {}
    };
    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockResolvedValue(pipelineResult)
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn((providerKey?: string) => {
        if (providerKey === 'tab.key1' || providerKey === 'tab.key1.alt') {
          return 'runtime:one';
        }
        if (providerKey === 'tab.key2') {
          return 'runtime:two';
        }
        return undefined;
      }),
      getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    };
    const deps = {
      runtimeManager,
      trafficGovernor,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage: jest.fn(),
      stats
    };
    const executor = new HubRequestExecutor(deps);
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValue({ status: 200, body: { output_text: 'ok' } });

    await executor.execute({
      requestId: 'req_soft_wait_same_runtime',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'same runtime pool' }] },
      metadata: { stream: false, inboundStream: false }
    });

    expect(acquireArgs[0]?.softWaitTimeoutMs).toBeUndefined();

    (fakePipeline.execute as jest.Mock).mockResolvedValueOnce({
      ...pipelineResult,
      routingDecision: {
        routeName: 'tools',
        pool: ['tab.key1', 'tab.key2']
      }
    });

    await executor.execute({
      requestId: 'req_soft_wait_cross_runtime',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'cross runtime pool' }] },
      metadata: { stream: false, inboundStream: false }
    });

    expect(acquireArgs[1]?.softWaitTimeoutMs).toBeUndefined();
  });

  it('bypasses provider traffic governor for servertool followup hops', async () => {
    const trafficGovernor = {
      acquire: jest.fn(async () => {
        throw new Error('traffic governor should be bypassed for servertool followup');
      }),
      release: jest.fn(async () => ({ released: true, activeInFlight: 0 })),
      observeOutcome: jest.fn(async () => undefined)
    };

    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const pipelineResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tab.key1',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:one',
        processMode: 'standard'
      },
      routingDecision: {
        routeName: 'tools',
        pool: ['tab.key1']
      } as unknown as { routeName?: string },
      processMode: 'standard',
      metadata: {}
    };
    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockResolvedValue(pipelineResult)
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn().mockReturnValue('runtime:one'),
      getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn()
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn()
    };
    const deps = {
      runtimeManager,
      trafficGovernor,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage: jest.fn(),
      stats
    };
    const executor = new HubRequestExecutor(deps);
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValue({ status: 200, body: { output_text: 'ok' } });

    const response = await executor.execute({
      requestId: 'req_followup_root:reasoning_stop_guard',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'continue' }] },
      metadata: {
        stream: false,
        inboundStream: false,
        __rt: {
          serverToolFollowup: true
        }
      }
    });

    expect(response.status).toBe(200);
    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(trafficGovernor.acquire).not.toHaveBeenCalled();
    expect(trafficGovernor.observeOutcome).not.toHaveBeenCalled();
    expect(trafficGovernor.release).not.toHaveBeenCalled();
  });
});
