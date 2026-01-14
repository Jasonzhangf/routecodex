import { jest } from '@jest/globals';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../src/server/runtime/handlers/types.js';
import type { HubPipeline } from '../../../src/server/runtime/http-server/types.js';
import { HubRequestExecutor } from '../../../src/server/runtime/http-server/request-executor.js';
import type { ProviderRuntimeManager } from '../../../src/server/runtime/http-server/runtime-manager.js';
import type { ProviderHandle } from '../../../src/server/runtime/http-server/types.js';
import type { ModuleDependencies } from '../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';

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

  return { executor, request, handle, runtimeManager };
}

describe('HubRequestExecutor single attempt behaviour', () => {
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

    const response = await executor.execute(request);

    expect(response).toBeDefined();
    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
  });

  it('retries retryable provider errors and re-runs pipeline', async () => {
    const retryable = Object.assign(new Error('HTTP 429'), { statusCode: 429, retryable: false });
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
});
