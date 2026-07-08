import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../../src/server/runtime/handlers/types.js';
import type { HubPipeline, ProviderHandle } from '../../../../src/server/runtime/http-server/types.js';
import type { ProviderRuntimeManager } from '../../../../src/server/runtime/http-server/runtime-manager.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-request-executor-error-reporting-sessions');

const mockEmitProviderErrorAndWait = jest.fn();

jest.unstable_mockModule('../../../../src/providers/core/utils/provider-error-reporter.js', () => ({
  emitProviderErrorAndWait: mockEmitProviderErrorAndWait
}));

const {
  HubRequestExecutor,
  __requestExecutorTestables
} = await import('../../../../src/server/runtime/http-server/request-executor.js');

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

  return { executor, request, pipeline: fakePipeline };
}

describe('HubRequestExecutor provider error reporting', () => {
  beforeEach(() => {
    mockEmitProviderErrorAndWait.mockReset();
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  it('normalizes convert-side servertool followup failures to HTTP_502 without provider reporter', async () => {
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
    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const { executor, request } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockRejectedValue(
        Object.assign(new Error('followup client inject failed'), {
          code: 'SERVERTOOL_FOLLOWUP_FAILED',
          upstreamCode: 'client_inject_failed',
          status: 502,
          statusCode: 502,
          retryable: false,
          details: {
            upstreamCode: 'client_inject_failed',
            reason: 'client_inject_failed'
          }
        })
      );

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'HTTP_502',
      upstreamCode: 'client_inject_failed',
      statusCode: 502
    });

    expect(mockEmitProviderErrorAndWait).not.toHaveBeenCalled();
  });

  it('normalizes generic provider.followup orchestration failures to HTTP_502 without provider reporter', async () => {
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
    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const { executor, request } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockRejectedValue(
        Object.assign(new Error('followup payload missing'), {
          code: 'SERVERTOOL_FOLLOWUP_FAILED',
          status: 502,
          statusCode: 502,
          retryable: false,
          category: 'INTERNAL_ERROR',
          details: {
            reason: 'followup_payload_missing',
            flowId: 'clock_error'
          }
        })
      );

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'HTTP_502',
      statusCode: 502
    });

    expect(mockEmitProviderErrorAndWait).not.toHaveBeenCalled();
  });

  it('does not invoke provider reporter for convert-side context overflow failures', async () => {
    const pipelineResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'crs.key2.gpt-5.3-codex',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:key',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const { executor, request } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockRejectedValue(
        Object.assign(new Error('Your input exceeds the context window of this model.'), {
          code: 'CONTEXT_LENGTH_EXCEEDED',
          status: 400,
          statusCode: 400,
          retryable: false,
          details: {
            reason: 'context_length_exceeded'
          }
        })
      );

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'CONTEXT_LENGTH_EXCEEDED',
      statusCode: 400
    });

    expect(mockEmitProviderErrorAndWait).not.toHaveBeenCalled();
  });

  it('reports provider.send network transport failures as health-affecting recoverable errors', async () => {
    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '1';
    const pipelineResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'deepseek.key1.deepseek-v4-pro',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:key',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const handle = createRuntimeHandle(async () => {
      throw Object.assign(new Error('fetch failed'), {
        code: 'HTTP_502',
        status: 502,
        statusCode: 502,
        retryable: true
      });
    });
    const { executor, request } = createExecutor(pipelineResult, handle);

    try {
      await expect(executor.execute(request)).rejects.toMatchObject({
        code: 'HTTP_502',
        statusCode: 502
      });

      expect(mockEmitProviderErrorAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'provider.send',
          statusCode: 502,
          recoverable: true,
          affectsHealth: true,
          details: expect.objectContaining({
            source: 'provider.send',
            errorClassification: 'recoverable',
            errorCode: 'HTTP_502',
            reason: 'fetch failed'
          })
        })
      );
    } finally {
      if (previousAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
      }
    }
  });

  it('reports provider.send SQLITE_BUSY failures as health-affecting recoverable errors', async () => {
    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '1';
    const pipelineResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'deepseek.key1.deepseek-v4-pro',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:key',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const handle = createRuntimeHandle(async () => {
      throw Object.assign(new Error('database is locked (5) (SQLITE_BUSY)'), {
        code: 'new_api_error',
        upstreamCode: 'new_api_error',
        status: 500,
        statusCode: 500,
        retryable: true
      });
    });
    const { executor, request } = createExecutor(pipelineResult, handle);

    try {
      await expect(executor.execute(request)).rejects.toMatchObject({
        code: 'new_api_error',
        upstreamCode: 'new_api_error',
        statusCode: 500
      });

      expect(mockEmitProviderErrorAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'provider.send',
          statusCode: 500,
          recoverable: true,
          affectsHealth: true,
          details: expect.objectContaining({
            source: 'provider.send',
            errorClassification: 'recoverable',
            errorCode: 'NEW_API_ERROR',
            upstreamCode: 'NEW_API_ERROR',
            reason: 'database is locked (5) (SQLITE_BUSY)'
          })
        })
      );
    } finally {
      if (previousAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
      }
    }
  });

  it('normalizes absent top-level followup stage marker to HTTP_502 without provider reporter', async () => {
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
    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const { executor, request } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockRejectedValue(
        Object.assign(new Error('client inject followup failed'), {
          code: 'INTERNAL_ERROR',
          status: 502,
          statusCode: 502,
          retryable: false,
          details: {
            requestExecutorProviderErrorStage: 'provider.followup',
            reason: 'client_inject_failed'
          }
        })
      );

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'HTTP_502',
      statusCode: 502
    });

    expect(mockEmitProviderErrorAndWait).not.toHaveBeenCalled();
  });

  it('does not outer-retry when convert-side followup fails with provider.followup stage', async () => {
    const pipelineResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'ali-coding-plan.key1.kimi-k2.5',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:key',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const { executor, request, pipeline } = createExecutor(pipelineResult, handle);
    const convertSpy = jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockRejectedValue(
        Object.assign(new Error('followup invalid api key'), {
          code: 'SERVERTOOL_FOLLOWUP_FAILED',
          upstreamCode: 'invalid_api_key',
          status: 401,
          statusCode: 401,
          retryable: false,
          requestExecutorProviderErrorStage: 'provider.followup',
          details: {
            requestExecutorProviderErrorStage: 'provider.followup',
            reason: 'HTTP_401',
            flowId: 'reasoning_stop_continue_flow'
          }
        })
      );

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      upstreamCode: 'invalid_api_key',
      statusCode: 401
    });

    expect(convertSpy).toHaveBeenCalledTimes(1);
    expect((pipeline.execute as jest.Mock).mock.calls.length).toBe(1);
    expect((handle.instance.processIncoming as jest.Mock).mock.calls.length).toBe(1);
    expect(mockEmitProviderErrorAndWait).not.toHaveBeenCalled();
  });

  it('reports converted retryable HTTP status once through provider.http as health-affecting', async () => {
    const previousMaxAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '1';
    try {
      const pipelineResult: PipelineExecutionResult = {
        providerPayload: { data: { messages: [] } },
        target: {
          providerKey: 'tabglm.key1.glm-5.1',
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: 'runtime:key',
          processMode: 'standard'
        },
        processMode: 'standard',
        metadata: {}
      };
      const handle = createRuntimeHandle(async () => ({ ok: true }));
      const { executor, request } = createExecutor(pipelineResult, handle);
      jest
        .spyOn(executor as any, 'convertProviderResponseIfNeeded')
        .mockResolvedValue({
          status: 429,
          body: {
            error: {
              code: 'HTTP_429',
              message: 'rate limited'
            }
          }
        });

      await expect(executor.execute(request)).rejects.toMatchObject({
        statusCode: 429
      });

      expect(mockEmitProviderErrorAndWait).toHaveBeenCalledTimes(1);
      expect(mockEmitProviderErrorAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'provider.http',
          statusCode: 429,
          recoverable: true,
          affectsHealth: true,
          runtime: expect.objectContaining({
            requestId: 'req_test',
            providerKey: 'tabglm.key1.glm-5.1'
          })
        })
      );
    } finally {
      if (previousMaxAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousMaxAttempts;
      }
    }
  });

  it('reports host response contract failures through provider reporter as health-affecting recoverable errors', async () => {
    const previousMaxAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '1';
    try {
      const declaredTools = [{
        type: 'function',
        function: {
          name: 'exec_command',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd']
          }
        }
      }];
      const pipelineResult: PipelineExecutionResult = {
        providerPayload: { data: { messages: [] } },
        processedRequest: {
          model: 'test-model',
          messages: [{ role: 'user', content: '继续执行' }],
          tools: declaredTools,
          metadata: {}
        } as any,
        target: {
          providerKey: 'provider-a.aliasA',
          providerType: 'openai',
          outboundProfile: 'openai-chat',
          runtimeKey: 'runtime:key',
          processMode: 'standard'
        },
        processMode: 'standard',
        metadata: {}
      };
      const handle = createRuntimeHandle(async () => ({ ok: true }));
      const { executor, request } = createExecutor(pipelineResult, handle);
      jest
        .spyOn(executor as any, 'convertProviderResponseIfNeeded')
        .mockResolvedValue({
          status: 200,
          body: {
            choices: [{ finish_reason: 'stop', message: { content: '' } }]
          }
        });

      await expect(executor.execute(request)).rejects.toMatchObject({
        code: 'EMPTY_ASSISTANT_RESPONSE',
        statusCode: 502,
        requestExecutorProviderErrorStage: 'host.response_contract'
      });

      expect(mockEmitProviderErrorAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'host.response_contract',
          statusCode: 502,
          recoverable: true,
          affectsHealth: true,
          details: expect.objectContaining({
            source: 'host.response_contract',
            errorClassification: 'recoverable',
            errorCode: 'EMPTY_ASSISTANT_RESPONSE'
          })
        })
      );
    } finally {
      if (previousMaxAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousMaxAttempts;
      }
    }
  });

  it('currently resolves responses reasoning-only payloads without missing-tool reporter errors', async () => {
    const previousMaxAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '1';
    try {
      const declaredTools = [{
        type: 'function',
        function: {
          name: 'exec_command',
          description: 'run shell command',
          parameters: {
            type: 'object',
            properties: {
              cmd: { type: 'string' }
            },
            required: ['cmd']
          }
        }
      }];
      const pipelineResult: PipelineExecutionResult = {
        providerPayload: { data: { messages: [] } },
        processedRequest: {
          tools: declaredTools
        },
        target: {
          providerKey: 'provider-a.aliasA',
          providerType: 'openai',
          outboundProfile: 'openai-chat',
          runtimeKey: 'runtime:key',
          processMode: 'standard'
        },
        processMode: 'standard',
        metadata: {}
      };
      const handle = createRuntimeHandle(async () => ({ ok: true }));
      const { executor, request } = createExecutor(pipelineResult, handle);
      jest
        .spyOn(executor as any, 'convertProviderResponseIfNeeded')
        .mockResolvedValue({
          status: 200,
          body: {
            status: 'completed',
            output_text: '',
            output: [
              {
                type: 'reasoning',
                summary: [
                  {
                    type: 'summary_text',
                    text: 'I have all the information I need. Let me create the hook file now.'
                  }
                ]
              }
            ]
          }
        });

      await expect(executor.execute({
        ...request,
        body: {
          input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }],
          tools: declaredTools
        }
      })).resolves.toMatchObject({
        status: 200,
        body: expect.objectContaining({
          status: 'completed',
          output_text: ''
        })
      });

      expect(mockEmitProviderErrorAndWait).not.toHaveBeenCalled();
    } finally {
      if (previousMaxAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousMaxAttempts;
      }
    }
  });
});
