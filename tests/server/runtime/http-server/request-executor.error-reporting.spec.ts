import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../../src/server/runtime/handlers/types.js';
import type { HubPipeline, ProviderHandle } from '../../../../src/server/runtime/http-server/types.js';
import type { ProviderRuntimeManager } from '../../../../src/server/runtime/http-server/runtime-manager.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import {
  saveRoutingInstructionStateSync
} from '../../../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-request-executor-error-reporting-sessions');

function createEmptyRoutingInstructionState() {
  return {
    forcedTarget: undefined,
    stickyTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set<string>(),
    disabledProviders: new Set<string>(),
    disabledKeys: new Map<string, Set<string | number>>(),
    disabledModels: new Map<string, Set<string>>(),
    stopMessageSource: undefined,
    stopMessageText: undefined,
    stopMessageMaxRepeats: undefined,
    stopMessageUsed: undefined,
    stopMessageUpdatedAt: undefined,
    stopMessageLastUsedAt: undefined,
    stopMessageStageMode: undefined,
    stopMessageAiMode: undefined,
    stopMessageAiSeedPrompt: undefined,
    stopMessageAiHistory: undefined,
    reasoningStopMode: undefined,
    reasoningStopArmed: undefined,
    reasoningStopSummary: undefined,
    reasoningStopUpdatedAt: undefined,
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined
  };
}

function seedStoplessSession(sessionId: string): void {
  const state = createEmptyRoutingInstructionState();
  state.reasoningStopMode = 'on';
  saveRoutingInstructionStateSync(`session:${sessionId}`, state);
}

const mockEmitProviderError = jest.fn();

jest.unstable_mockModule('../../../../src/providers/core/utils/provider-error-reporter.js', () => ({
  emitProviderError: mockEmitProviderError
}));

const { HubRequestExecutor } = await import('../../../../src/server/runtime/http-server/request-executor.js');

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
    mockEmitProviderError.mockReset();
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  it('reports convert-side servertool followup failures through provider error reporter', async () => {
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
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      upstreamCode: 'client_inject_failed'
    });

    expect(mockEmitProviderError).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'provider.followup',
        statusCode: 502,
        recoverable: false,
        affectsHealth: false,
        runtime: expect.objectContaining({
          requestId: 'req_test',
          providerKey: 'antigravity.alias'
        }),
        details: expect.objectContaining({
          source: 'provider.followup',
          upstreamCode: 'CLIENT_INJECT_FAILED'
        })
      })
    );
  });

  it('keeps generic provider.followup orchestration errors health-neutral', async () => {
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
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      statusCode: 502
    });

    expect(mockEmitProviderError).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'provider.followup',
        statusCode: 502,
        recoverable: false,
        affectsHealth: false,
        details: expect.objectContaining({
          source: 'provider.followup',
          reason: 'followup payload missing'
        })
      })
    );
  });

  it('reports special_400 as direct client error without provider health impact', async () => {
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

    expect(mockEmitProviderError).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'provider.send',
        statusCode: 400,
        recoverable: false,
        affectsHealth: false,
        details: expect.objectContaining({
          source: 'provider.send',
          errorClassification: 'special_400',
          errorCode: 'CONTEXT_LENGTH_EXCEEDED'
        })
      })
    );
  });

  it('prefers provider stage marker from error details when top-level marker is absent', async () => {
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
      code: 'INTERNAL_ERROR',
      statusCode: 502
    });

    expect(mockEmitProviderError).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'provider.followup',
        statusCode: 502,
        recoverable: false,
        affectsHealth: false,
        details: expect.objectContaining({
          source: 'provider.followup',
          errorCode: 'INTERNAL_ERROR'
        })
      })
    );
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
    expect(mockEmitProviderError).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'provider.followup',
        statusCode: 401,
        affectsHealth: false
      })
    );
  });

  it('reports converted retryable HTTP status only once through provider.http stage', async () => {
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

      expect(mockEmitProviderError).toHaveBeenCalledTimes(1);
      expect(mockEmitProviderError).toHaveBeenCalledWith(
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

  it('keeps stopless contract failures outside provider health reporting while preserving explicit stage', async () => {
    const previousMaxAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '1';
    try {
      const pipelineResult: PipelineExecutionResult = {
        providerPayload: { data: { messages: [] } },
        target: {
          providerKey: 'ali-coding-plan.key1.qwen3-coder-next',
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
      seedStoplessSession('session_stopless_contract_health_neutral');
      request.metadata = {
        ...request.metadata,
        sessionId: 'session_stopless_contract_health_neutral',
        reasoningStopMode: 'on'
      };
      jest
        .spyOn(executor as any, 'convertProviderResponseIfNeeded')
        .mockResolvedValue({
          status: 200,
          body: {
            status: 'completed',
            output_text: 'done without reasoning.stop'
          }
        });

      await expect(executor.execute(request)).rejects.toMatchObject({
        code: 'STOPLESS_FINALIZATION_MISSING',
        statusCode: 502,
        requestExecutorProviderErrorStage: 'host.stopless_contract'
      });

      expect(mockEmitProviderError).not.toHaveBeenCalled();
    } finally {
      if (previousMaxAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousMaxAttempts;
      }
    }
  });

  it('keeps host response contract failures outside provider health reporting', async () => {
    const previousMaxAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '1';
    try {
      const pipelineResult: PipelineExecutionResult = {
        providerPayload: { data: { messages: [] } },
        target: {
          providerKey: 'qwenchat.aliasA',
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

      expect(mockEmitProviderError).not.toHaveBeenCalled();
    } finally {
      if (previousMaxAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousMaxAttempts;
      }
    }
  });
});
