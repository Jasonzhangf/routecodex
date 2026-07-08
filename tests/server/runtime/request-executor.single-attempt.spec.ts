import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { jest } from '@jest/globals';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../src/server/runtime/handlers/types.js';
import type { HubPipeline } from '../../../src/server/runtime/http-server/types.js';
import type { ProviderRuntimeManager } from '../../../src/server/runtime/http-server/runtime-manager.js';
import type { ProviderHandle } from '../../../src/server/runtime/http-server/types.js';
import type { ModuleDependencies } from '../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import {
  __resetSnapshotLocalDiskGateForTests,
  canWriteSnapshotToLocalDisk
} from '../../../src/utils/snapshot-local-disk-gate.js';
import { setRuntimeFlag, runtimeFlags } from '../../../src/runtime/runtime-flags.js';

const nodeRequire = createRequire(import.meta.url);

const {
  HubRequestExecutor,
  __requestExecutorTestables
} = await import('../../../src/server/runtime/http-server/request-executor.js');

function writeStopMessageState(sessionId: string, used: number): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SESSION_DIR, `session-${sessionId}.json`),
    JSON.stringify({
      version: 1,
      state: {
        stopMessageSource: 'default',
        stopMessageText: '继续执行',
        stopMessageMaxRepeats: 3,
        stopMessageUsed: used,
        stopMessageStageMode: 'on',
        stopMessageAiMode: 'off'
      }
    }),
    'utf8'
  );
}

function readStopMessageUsed(sessionId: string): number | undefined {
  const filepath = path.join(SESSION_DIR, `session-${sessionId}.json`);
  if (!fs.existsSync(filepath)) {
    return undefined;
  }
  const payload = JSON.parse(fs.readFileSync(filepath, 'utf8')) as { state?: { stopMessageUsed?: number } };
  return payload.state?.stopMessageUsed;
}

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-request-executor-single-attempt-sessions');
const LEGACY_ROUTE_CODEX_PREFIX = '__routecodex';
const LEGACY_ROUTE_CODEX_FINISH_REASON_KEY = `${LEGACY_ROUTE_CODEX_PREFIX}_finish_reason`;
const LEGACY_ROUTE_CODEX_STREAM_PROBE_KEY = `${LEGACY_ROUTE_CODEX_PREFIX}_stream_contract_probe_body`;

function createRuntimeHandle(processImpl: () => Promise<unknown>): ProviderHandle {
  return {
    providerType: 'gemini',
    providerFamily: 'gemini',
    providerId: 'gemini',
    instance: {
      processIncoming: jest.fn().mockImplementation(processImpl),
      cleanup: jest.fn()
    }
  } as unknown as ProviderHandle;
}

function createRuntimeHandleWithProtocol(
  processImpl: () => Promise<unknown>,
  providerProtocol: string
): ProviderHandle {
  return {
    providerType: 'openai',
    providerFamily: 'openai',
    providerId: 'mini27',
    providerProtocol,
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
  let convertProviderResponseSpy: ReturnType<typeof jest.spyOn> | null = null;
  const originalSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
  const originalCompatSnapshotDir = process.env.RCC_SNAPSHOT_DIR;
  const originalSnapshotsEnabled = runtimeFlags.snapshotsEnabled;

  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    warnSpy.mockClear();
    convertProviderResponseSpy?.mockRestore();
    convertProviderResponseSpy = null;
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
    __resetSnapshotLocalDiskGateForTests();
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  afterAll(() => {
    convertProviderResponseSpy?.mockRestore();
    convertProviderResponseSpy = null;
    if (originalSnapshotDir === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_DIR = originalSnapshotDir;
    }
    if (originalCompatSnapshotDir === undefined) {
      delete process.env.RCC_SNAPSHOT_DIR;
    } else {
      process.env.RCC_SNAPSHOT_DIR = originalCompatSnapshotDir;
    }
    setRuntimeFlag('snapshotsEnabled', originalSnapshotsEnabled);
    warnSpy.mockRestore();
  });

  const pipelineResult: PipelineExecutionResult = {
    providerPayload: { data: { messages: [] } },
    target: {
      providerKey: 'gemini.primary',
      providerType: 'gemini',
      outboundProfile: 'gemini-chat',
      runtimeKey: 'runtime:key',
      processMode: 'standard'
    },
    processMode: 'standard',
    metadata: {}
  };

  function stubConvertProviderResponse(
    converted: PipelineExecutionResult = { status: 200, body: { output_text: 'ok' } }
  ) {
    convertProviderResponseSpy?.mockRestore();
    convertProviderResponseSpy = jest
      .spyOn(HubRequestExecutor.prototype as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValue(converted);
    return convertProviderResponseSpy;
  }

  it('invokes provider only once on success', async () => {
    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const { executor, request } = createExecutor(pipelineResult, handle);
    stubConvertProviderResponse();

    const response = await executor.execute(request);

    expect(response).toBeDefined();
    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
  });

  it('projects stopless as visible exec_command CLI call for openai-responses relay provider stop response', async () => {
    const providerResponse = {
      status: 200,
      data: {
        id: 'chatcmpl-minimax-stopless-red',
        object: 'chat.completion',
        model: 'MiniMax-M2.7',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'stopped'
            }
          }
        ]
      }
    };
    const handle = createRuntimeHandleWithProtocol(async () => providerResponse, 'openai-responses');
    const relayPipelineResult: PipelineExecutionResult = {
      providerPayload: { model: 'MiniMax-M2.7', messages: [] },
      target: {
        providerKey: 'mini27.key1-MiniMax-M2.7',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:key',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        routeName: 'coding',
        routecodexLocalPort: 10000,
        routecodexPortMode: 'router',
        routecodexRoutingPolicyGroup: 'gateway_coding_10000'
      }
    } as PipelineExecutionResult;
    const nested = jest.fn(async () => ({
      status: 200,
      body: {
        id: 'resp-stopless-reentered',
        object: 'response',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'continued' }] }]
      }
    }));
    const { executor, request } = createExecutor(relayPipelineResult, handle);
    (executor as any).deps.executeNestedInput = nested;

    const response = await executor.execute({
      ...request,
      requestId: 'req_executor_minimax_relay_stopless_red',
      entryEndpoint: '/v1/responses',
      body: { model: 'gpt-5.4', input: 'continue', stream: true },
      metadata: {
        stream: true,
        inboundStream: true,
        routecodexLocalPort: 10000,
        routecodexPortMode: 'router',
        routecodexRoutingPolicyGroup: 'gateway_coding_10000'
      }
    });

    expect(nested).toHaveBeenCalledTimes(0);
    expect(response.status).toBe(200);
    const responseBody = response.body as Record<string, unknown>;
    expect(responseBody[LEGACY_ROUTE_CODEX_FINISH_REASON_KEY]).toBeUndefined();
    expect(responseBody[LEGACY_ROUTE_CODEX_STREAM_PROBE_KEY]).toBeUndefined();
    const output = (responseBody.output ?? []) as Array<Record<string, unknown>>;
    const toolCall = output.find((item) => item.type === 'function_call') as Record<string, unknown> | undefined;
    expect(toolCall?.name).toBe('exec_command');
    expect(String(toolCall?.arguments)).toContain('routecodex servertool run stop_message_auto');
    expect(String(toolCall?.arguments)).toContain('当前用户目标');
  });

  it('does not bypass stopless for openai-responses prebuilt SSE stop response', async () => {
    const responseId = 'resp_prebuilt_sse_stopless_red';
    const providerResponse = {
      status: 200,
      body: {
        __sse_responses: Readable.from([
          'event: response.created\n',
          `data: ${JSON.stringify({
            type: 'response.created',
            response: {
              id: responseId,
              object: 'response',
              status: 'in_progress',
              model: 'gpt-5.5',
              output: []
            }
          })}\n\n`,
          'event: response.output_item.done\n',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'msg_prebuilt_sse_stopless_red',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'stopped' }]
            }
          })}\n\n`,
          'event: response.completed\n',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: responseId,
              object: 'response',
              status: 'completed',
              model: 'gpt-5.5',
              output: [
                {
                  id: 'msg_prebuilt_sse_stopless_red',
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'stopped' }]
                }
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            }
          })}\n\n`,
          'event: response.done\n',
          `data: ${JSON.stringify({
            type: 'response.done',
            response: {
              id: responseId,
              object: 'response',
              status: 'completed',
              output: [
                {
                  id: 'msg_prebuilt_sse_stopless_red',
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'stopped' }]
                }
              ]
            }
          })}\n\n`,
          'data: [DONE]\n\n'
        ])
      }
    };
    const handle = createRuntimeHandleWithProtocol(async () => providerResponse, 'openai-responses');
    const relayPipelineResult: PipelineExecutionResult = {
      providerPayload: { model: 'MiniMax-M2.7', messages: [] },
      target: {
        providerKey: 'mini27.key1-MiniMax-M2.7',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:key',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        routeName: 'longcontext',
        routecodexLocalPort: 5555,
        routecodexPortMode: 'router',
        routecodexRoutingPolicyGroup: 'gateway-priority-5555-weighted-longcontext'
      }
    } as PipelineExecutionResult;
    const { executor, request } = createExecutor(relayPipelineResult, handle);

    const response = await executor.execute({
      ...request,
      requestId: 'req_executor_prebuilt_sse_stopless_red',
      entryEndpoint: '/v1/responses',
      body: { model: 'gpt-5.5', input: 'continue', stream: true },
      metadata: {
        stream: true,
        inboundStream: true,
        routecodexLocalPort: 5555,
        routecodexPortMode: 'router',
        routecodexRoutingPolicyGroup: 'gateway-priority-5555-weighted-longcontext'
      }
    });

    expect(response.status).toBe(200);
    const responseBody = response.body as Record<string, unknown>;
    expect(responseBody[LEGACY_ROUTE_CODEX_FINISH_REASON_KEY]).toBeUndefined();
    expect(responseBody[LEGACY_ROUTE_CODEX_STREAM_PROBE_KEY]).toBeUndefined();
    const output = (responseBody.output ?? []) as Array<Record<string, unknown>>;
    const toolCall = output.find((item) => item.type === 'function_call') as Record<string, unknown> | undefined;
    expect(toolCall?.name).toBe('exec_command');
    expect(String(toolCall?.arguments)).toContain('routecodex servertool run stop_message_auto');
  });

  it('resets stopless default budget after openai-responses relay tool_calls response', async () => {
    const sessionId = 'executor-relay-tool-calls-reset';
    writeStopMessageState(sessionId, 3);
    const providerResponse = {
      status: 200,
      data: {
        id: 'chatcmpl-minimax-tool-calls-reset',
        object: 'chat.completion',
        model: 'MiniMax-M2.7',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_reset_budget',
                  type: 'function',
                  function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
                }
              ]
            }
          }
        ]
      }
    };
    const handle = createRuntimeHandleWithProtocol(async () => providerResponse, 'openai-responses');
    const relayPipelineResult: PipelineExecutionResult = {
      providerPayload: { model: 'MiniMax-M2.7', messages: [] },
      target: {
        providerKey: 'mini27.key1-MiniMax-M2.7',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:key',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        sessionId,
        routeName: 'coding',
        routecodexLocalPort: 10000,
        routecodexPortMode: 'router',
        routecodexRoutingPolicyGroup: 'gateway_coding_10000'
      }
    } as PipelineExecutionResult;
    const { executor, request } = createExecutor(relayPipelineResult, handle);

    try {
      await executor.execute({
        ...request,
        requestId: 'req_executor_minimax_relay_tool_calls_reset',
        entryEndpoint: '/v1/responses',
        body: { model: 'gpt-5.4', input: 'continue', stream: true },
        metadata: {
          stream: true,
          inboundStream: true,
          sessionId,
          routecodexLocalPort: 10000,
          routecodexPortMode: 'router',
          routecodexRoutingPolicyGroup: 'gateway_coding_10000'
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      if (!message.includes('Must use import to load ES Module')) {
        throw error;
      }
    }

    expect(readStopMessageUsed(sessionId)).toBe(0);
  });

  it('does not finalize responses conversation retention inside executor after successful tool_calls response', async () => {
    const finalizeSpy = jest.fn();
    const globalStoreKey = '__rccResponsesConversationStore';
    const previousStore = (globalThis as Record<string, unknown>)[globalStoreKey];
    (globalThis as Record<string, unknown>)[globalStoreKey] = {
      finalizeResponsesConversationRequestRetention: finalizeSpy
    };
    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const { executor, request } = createExecutor(pipelineResult, handle);
    stubConvertProviderResponse({
      status: 200,
      body: {
        id: 'resp_retention_tool_calls',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            name: 'exec_command',
            arguments: '{"cmd":"pwd"}',
            call_id: 'call_retention_tool'
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: { tool_calls: [] }
        },
        finish_reason: 'tool_calls'
      }
    });

    try {
      await executor.execute({
        ...request,
        requestId: 'req_executor_responses_retention_tool_calls',
        entryEndpoint: '/v1/responses',
        body: { model: 'gpt-5.4', input: 'call a tool' }
      });

      expect(finalizeSpy).not.toHaveBeenCalled();
    } finally {
      if (previousStore === undefined) {
        delete (globalThis as Record<string, unknown>)[globalStoreKey];
      } else {
        (globalThis as Record<string, unknown>)[globalStoreKey] = previousStore;
      }
    }
  });

  it('writes payload-contract-error errorsample for empty provider request payload by default', async () => {
    const errorsDir = fs.mkdtempSync(
      path.join(process.cwd(), 'tmp', 'jest-request-executor-errorsamples-empty-request-')
    );
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsDir;
    const { __resetErrorsampleQueueForTests, __flushErrorsampleQueueForTests } = await import(
      '../../../src/utils/errorsamples.js'
    );
    __resetErrorsampleQueueForTests();
    try {
      const handle = createRuntimeHandle(async () => ({ ok: true }));
      const { executor, request } = createExecutor(pipelineResult, handle);
      stubConvertProviderResponse();

      await executor.execute(request);
      await __flushErrorsampleQueueForTests();

      const groupDir = path.join(errorsDir, 'payload-contract-error');
      const files = fs.readdirSync(groupDir);
      expect(files.length).toBeGreaterThan(0);
      const payload = JSON.parse(fs.readFileSync(path.join(groupDir, files[0]), 'utf8'));
      expect(payload.phase).toBe('provider-request');
      expect(payload.marker).toBe('provider_request_empty_messages');
    } finally {
      __resetErrorsampleQueueForTests();
      delete process.env.ROUTECODEX_ERRORSAMPLES_DIR;
      fs.rmSync(errorsDir, { recursive: true, force: true });
    }
  });

  it('unlocks local snapshot gate before provider runtime starts writing snapshots', async () => {
    const handle = createRuntimeHandle(async () => {
      expect(canWriteSnapshotToLocalDisk('req_test')).toBe(true);
      return { ok: true };
    });
    const { executor, request } = createExecutor(pipelineResult, handle);
    stubConvertProviderResponse();

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
        providerKey: 'gemini.primary',
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
        providerKey: 'provider-a.aliasB',
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
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValue({ status: 200, body: { output_text: 'ok' } });

    const response = await executor.execute(request);

    expect(response).toBeDefined();
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    const secondCallMetadata = fakePipeline.execute.mock.calls[1][0]
      .metadata as Record<string, unknown>;
    expect(secondCallMetadata.retryAttempt).toBe(2);
  });

  it('fails fast without excluding provider when converted response is finish_reason=stop with empty assistant payload', async () => {
    const firstHandle = createRuntimeHandle(async () => ({ status: 200, data: { ok: true } }));
    const secondHandle = createRuntimeHandle(async () => ({ status: 200, data: { ok: true } }));
    const pipelineResultOne: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'provider-a.aliasA',
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

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'EMPTY_ASSISTANT_RESPONSE',
      statusCode: 502,
      requestExecutorProviderErrorStage: 'host.response_contract'
    });

    expect(fakePipeline.execute).toHaveBeenCalledTimes(1);
    expect(firstHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(secondHandle.instance.processIncoming).toHaveBeenCalledTimes(0);
  });

  it('writes payload-contract-error errorsample for empty assistant response by default', async () => {
    const errorsDir = fs.mkdtempSync(
      path.join(process.cwd(), 'tmp', 'jest-request-executor-errorsamples-empty-response-')
    );
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsDir;
    const { __resetErrorsampleQueueForTests, __flushErrorsampleQueueForTests } = await import(
      '../../../src/utils/errorsamples.js'
    );
    __resetErrorsampleQueueForTests();
    try {
      const handle = createRuntimeHandle(async () => ({ status: 200, data: { ok: true } }));
      const pipelineResult: PipelineExecutionResult = {
        providerPayload: { data: { messages: [{ role: 'user', content: 'retry me' }] } },
        target: {
          providerKey: 'provider-a.aliasA',
          providerType: 'openai',
          outboundProfile: 'openai-chat',
          runtimeKey: 'runtime:one',
          processMode: 'standard'
        },
        processMode: 'standard',
        metadata: {}
      };
      const { executor } = createExecutor(pipelineResult, handle);
      jest
        .spyOn(executor as any, 'convertProviderResponseIfNeeded')
        .mockResolvedValue({
          status: 200,
          body: { choices: [{ finish_reason: 'stop', message: { content: '' } }] }
        });

      await expect(executor.execute({
        requestId: 'req_empty_assistant_errorsample',
        entryEndpoint: '/v1/chat/completions',
        headers: {},
        body: { messages: [{ role: 'user', content: 'retry me' }] },
        metadata: { stream: false, inboundStream: false }
      })).rejects.toThrow('Upstream returned empty assistant payload');
      await __flushErrorsampleQueueForTests();

      const groupDir = path.join(errorsDir, 'payload-contract-error');
      const files = fs.readdirSync(groupDir);
      const payloads = files.map((file) =>
        JSON.parse(fs.readFileSync(path.join(groupDir, file), 'utf8'))
      );
      expect(
        payloads.some((payload) =>
          payload.phase === 'provider-response' && payload.marker === 'chat_empty_assistant'
        )
      ).toBe(true);
    } finally {
      __resetErrorsampleQueueForTests();
      delete process.env.ROUTECODEX_ERRORSAMPLES_DIR;
      fs.rmSync(errorsDir, { recursive: true, force: true });
    }
  });

  it('writes payload-contract-error errorsample when assistant response was repaired by sanitize placeholder', async () => {
    const errorsDir = fs.mkdtempSync(
      path.join(process.cwd(), 'tmp', 'jest-request-executor-errorsamples-sanitized-placeholder-')
    );
    const snapshotDir = fs.mkdtempSync(
      path.join(process.cwd(), 'tmp', 'jest-request-executor-snapshots-sanitized-placeholder-')
    );
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsDir;
    process.env.ROUTECODEX_SNAPSHOT_DIR = snapshotDir;
    process.env.RCC_SNAPSHOT_DIR = snapshotDir;
    setRuntimeFlag('snapshotsEnabled', false);
    const { __resetErrorsampleQueueForTests, __flushErrorsampleQueueForTests } = await import(
      '../../../src/utils/errorsamples.js'
    );
    __resetErrorsampleQueueForTests();
    const { __flushProviderSnapshotQueueForTests } = await import(
      '../../../src/providers/core/utils/snapshot-writer.js'
    );
    try {
      const handle = createRuntimeHandle(async () => ({ status: 200, data: { ok: true } }));
      const pipelineResult: PipelineExecutionResult = {
        providerPayload: { data: { messages: [{ role: 'user', content: 'retry me' }] } },
        target: {
          providerKey: 'provider-a.aliasA',
          providerType: 'openai',
          outboundProfile: 'openai-chat',
          runtimeKey: 'runtime:one',
          processMode: 'standard'
        },
        processMode: 'standard',
        metadata: {}
      };
      const { executor } = createExecutor(pipelineResult, handle);
      jest
        .spyOn(executor as any, 'convertProviderResponseIfNeeded')
        .mockResolvedValue({
          status: 200,
          body: {
            choices: [{
              finish_reason: 'stop',
              message: {
                content: '[RouteCodex] assistant response became empty after response sanitization.'
              }
            }]
          }
        });

      await expect(executor.execute({
        requestId: 'req_sanitized_placeholder_errorsample',
        entryEndpoint: '/v1/chat/completions',
        headers: {},
        body: { messages: [{ role: 'user', content: 'retry me' }] },
        metadata: { stream: false, inboundStream: false }
      })).rejects.toMatchObject({
        code: 'EMPTY_ASSISTANT_RESPONSE',
        statusCode: 502,
        requestExecutorProviderErrorStage: 'host.response_contract'
      });
      await __flushErrorsampleQueueForTests();
      await __flushProviderSnapshotQueueForTests();

      const groupDir = path.join(errorsDir, 'payload-contract-error');
      const files = fs.readdirSync(groupDir);
      const payloads = files.map((file) =>
        JSON.parse(fs.readFileSync(path.join(groupDir, file), 'utf8'))
      );
      expect(
        payloads.some((payload) =>
          payload.phase === 'provider-response' && payload.marker === 'assistant_sanitized_empty_placeholder'
        )
      ).toBe(true);
      const snapshotRequestDir = path.join(
        snapshotDir,
        'openai-chat',
        'provider-a.aliasA',
        'req_sanitized_placeholder_errorsample'
      );
      expect(fs.existsSync(path.join(snapshotRequestDir, 'provider-request-contract.json'))).toBe(true);
      expect(fs.existsSync(path.join(snapshotRequestDir, 'provider-response-contract.json'))).toBe(true);
      const providerResponsePayload = JSON.parse(
        fs.readFileSync(path.join(snapshotRequestDir, 'provider-response-contract.json'), 'utf8')
      ) as { body?: Record<string, unknown> };
      expect(providerResponsePayload.body).toMatchObject({
        payloadContractSignal: {
          marker: 'assistant_sanitized_empty_placeholder'
        }
      });
    } finally {
      __resetErrorsampleQueueForTests();
      delete process.env.ROUTECODEX_ERRORSAMPLES_DIR;
      delete process.env.ROUTECODEX_SNAPSHOT_DIR;
      delete process.env.RCC_SNAPSHOT_DIR;
      setRuntimeFlag('snapshotsEnabled', originalSnapshotsEnabled);
      fs.rmSync(errorsDir, { recursive: true, force: true });
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  });

  it('allows non-empty reasoning-only payload without forcing missing required tool call', async () => {
    const handle = createRuntimeHandle(async () => ({ status: 200, data: { ok: true } }));
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
      providerPayload: { data: { messages: [{ role: 'user', content: 'retry me' }] } },
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
        runtimeKey: 'runtime:one',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {}
    };
    const { executor } = createExecutor(pipelineResult, handle);
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

    const response = await executor.execute({
      requestId: 'req_reasoning_only_missing_tool_call',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: {
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }],
        tools: declaredTools
      },
      metadata: { stream: false, inboundStream: false }
    });
    expect(response).toMatchObject({
      status: 200,
      body: {
        status: 'completed'
      }
    });
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
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValue({ status: 200, body: { output_text: 'ok' } });

    const response = await executor.execute(request);
    expect(response).toBeDefined();

    const warnLines = warnSpy.mock.calls.map(call => String(call[0] ?? ''));
    const switchLine = warnLines.find(line => line.includes('[provider-switch]'));
    expect(switchLine).toBeDefined();
    expect(switchLine).toContain('status=429');
    expect(switchLine).toContain('code=SSE_TO_JSON_ERROR');
    expect(switchLine).toContain('upstreamCode=EPIPE');
    expect(switchLine).not.toContain('reason=');
  });

  it('does not same-provider retry streaming pre-response failures when provider payload omits stream flag', async () => {
    const retryable = Object.assign(new Error('HTTP 525: upstream ssl handshake failed'), {
      statusCode: 525,
      code: 'HTTP_525',
      upstreamCode: 'HTTP_525',
      retryable: true
    });
    const failingHandle = createRuntimeHandleWithProtocol(async () => {
      throw retryable;
    }, 'openai-responses');
    const successHandle = createRuntimeHandleWithProtocol(async () => ({ ok: true }), 'openai-responses');

    const pipelineResultOne: PipelineExecutionResult = {
      providerPayload: { model: 'gpt-5.5', input: 'tool request' },
      target: {
        providerKey: 'asxs.crsa.gpt-5.5',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:one',
        processMode: 'standard'
      },
      routingDecision: {
        routeName: 'longcontext',
        pool: ['asxs.crsa.gpt-5.5']
      } as unknown as { routeName?: string },
      processMode: 'standard',
      metadata: {}
    };
    const pipelineResultTwo: PipelineExecutionResult = {
      providerPayload: { model: 'gpt-5.5', input: 'tool request' },
      target: {
        providerKey: 'backup.crsa.gpt-5.5',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:two',
        processMode: 'standard'
      },
      routingDecision: {
        routeName: 'longcontext',
        pool: ['backup.crsa.gpt-5.5']
      } as unknown as { routeName?: string },
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
    jest
      .spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValue({ status: 200, body: { output_text: 'ok' } });

    const response = await executor.execute({
      requestId: 'req_stream_metadata_payload_no_stream_reroute',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { model: 'gpt-5.5', input: 'tool request', stream: true },
      metadata: { stream: true, inboundStream: true }
    });

    expect(response.status).toBe(200);
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    const secondCallMetadata = fakePipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
    expect(secondCallMetadata.retryAttempt).toBe(2);
    const excluded = Array.isArray(secondCallMetadata.excludedProviderKeys)
      ? secondCallMetadata.excludedProviderKeys as string[]
      : [];
    expect(excluded).toEqual(['asxs.crsa.gpt-5.5']);
    expect(secondCallMetadata.retryProviderKey).toBeUndefined();
    expect(secondCallMetadata.__routecodexRetryProviderKey).toBeUndefined();
    const providerSendStart = (deps.logStage as jest.Mock).mock.calls.find(([stage]) => stage === 'provider.send.start');
    expect(providerSendStart?.[2]).toMatchObject({
      providerRequestedStream: true,
      providerPayloadRequestedStream: undefined,
      inboundStream: true
    });
    const warnLines = warnSpy.mock.calls.map(call => String(call[0] ?? ''));
    const switchLine = warnLines.find(line =>
      line.includes('[provider-switch]')
      && line.includes('req_stream_metadata_payload_no_stream_reroute')
    );
    expect(switchLine).toContain('switch=exclude_and_reroute');
    expect(switchLine).toContain('policy=streaming_recoverable_pre_response');
    expect(switchLine).not.toContain('switch=retry_same_provider_once');
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
    expect(convertSpy).toHaveBeenCalledTimes(1);
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(rateLimitedHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    const secondCallMetadata = fakePipeline.execute.mock.calls[1][0]
      .metadata as Record<string, unknown>;
    expect(secondCallMetadata.retryAttempt).toBe(2);
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

    await expect(executor.execute(request)).rejects.toThrow('Upstream SSE error event [1302]');
    expect(fakePipeline.execute).toHaveBeenCalledTimes(1);
    expect(rateLimitedHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(0);
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

    await expect(executor.execute(request)).rejects.toThrow('Upstream SSE error event [500]');
    expect(fakePipeline.execute).toHaveBeenCalledTimes(1);
    expect(failingHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(0);
  });

  it('prefers route-selected target compatibility profile for response conversion metadata', async () => {
    const handle = createRuntimeHandle(async () => ({ data: { id: 'resp_ok' }, status: 200 }));
    const pipelineResultDeepSeek: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'provider-a.3.model-a',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:deepseek',
        processMode: 'standard',
        compatibilityProfile: 'chat:provider-a'
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
        compatibilityProfile: 'compat:passthrough',
        target: {
          providerKey: 'provider-b.1.coder-model',
          compatibilityProfile: 'compat:passthrough'
        }
      } as Record<string, unknown>
    };

    await executor.execute(request);

    expect(convertSpy).toHaveBeenCalledTimes(1);
    const convertOptions = convertSpy.mock.calls[0]?.[0] as { pipelineMetadata?: Record<string, unknown> };
    expect(convertOptions?.pipelineMetadata?.compatibilityProfile).toBe('chat:provider-a');
    expect((convertOptions?.pipelineMetadata?.target as Record<string, unknown>)?.providerKey).toBe(
      'provider-a.3.model-a'
    );
    expect((convertOptions?.pipelineMetadata?.target as Record<string, unknown>)?.compatibilityProfile).toBe(
      'chat:provider-a'
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
        providerKey: 'glm.3-138.kimi-k2.5',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:glm',
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

  it('does not retry DeepSeek file upload failures across same-runtime aliases', async () => {
    const fatal = Object.assign(new Error('DeepSeek file upload returned non-JSON payload'), {
      statusCode: 502,
      code: 'DEEPSEEK_FILE_UPLOAD_FAILED',
      upstreamCode: 'DEEPSEEK_FILE_UPLOAD_FAILED',
      retryable: true
    });
    const handle = createRuntimeHandle(async () => {
      throw fatal;
    });
    const pipelineResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'provider-a.berg.model-c',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'provider-a.berg',
        processMode: 'standard'
      },
      routingDecision: {
        routeName: 'coding',
        pool: [
          'provider-a.berg.model-c',
          'provider-a.spence.model-c',
          'provider-a.sargent.model-c'
        ]
      } as unknown as { routeName?: string },
      processMode: 'standard',
      metadata: {}
    };
    const { executor, request, runtimeManager } = createExecutor(pipelineResult, handle);
    runtimeManager.resolveRuntimeKey = jest.fn((providerKey?: string) => {
      if (providerKey === 'provider-a.berg.model-c') return 'provider-a.berg';
      if (providerKey === 'provider-a.spence.model-c') return 'provider-a.spence';
      if (providerKey === 'provider-a.sargent.model-c') return 'provider-a.sargent';
      return undefined;
    }) as unknown as ProviderRuntimeManager['resolveRuntimeKey'];

    await expect(executor.execute(request)).rejects.toThrow('DeepSeek file upload returned non-JSON payload');
    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(runtimeManager.getHandleByRuntimeKey).toHaveBeenCalledTimes(1);
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
      providerPayload: { metadata: { requestTag: 'sig-invalid' }, data: { messages: [] } },
      target: {
        providerKey: 'gemini.models/gemini-2.5-pro',
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

  it('excludes only the current provider on PROVIDER_TRAFFIC_SATURATED retry', async () => {
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
    stubConvertProviderResponse();
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
    expect(excluded).toEqual(['tab.key1']);
  });

  it('switches to the alternative provider immediately for a transport recoverable error', async () => {
    const transientError = Object.assign(new Error('socket reset'), {
      code: 'ECONNRESET',
      retryable: true
    });
    const providerACalls: number[] = [];
    const providerBCalls: number[] = [];
    const providerAHandle = createRuntimeHandle(async () => {
      providerACalls.push(providerACalls.length + 1);
      throw transientError;
    });
    const providerBHandle = createRuntimeHandle(async () => {
      providerBCalls.push(providerBCalls.length + 1);
      return { ok: true };
    });
    const providerAResult: PipelineExecutionResult = {
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
        pool: ['tab.key1', 'tab.key2']
      } as unknown as { routeName?: string },
      processMode: 'standard',
      metadata: {}
    };
    const providerBResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: 'tab.key2',
        providerType: 'responses',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:two',
        processMode: 'standard'
      },
      routingDecision: {
        routeName: 'tools',
        pool: ['tab.key1', 'tab.key2']
      } as unknown as { routeName?: string },
      processMode: 'standard',
      metadata: {}
    };
    const fakePipeline: HubPipeline = {
      execute: jest.fn(async (input: PipelineExecutionInput) => {
        const metadata = input.metadata && typeof input.metadata === 'object'
          ? input.metadata as Record<string, unknown>
          : {};
        if (metadata.__routecodexRetryProviderKey === 'tab.key1') {
          return providerAResult;
        }
        const excluded = Array.isArray(metadata.excludedProviderKeys)
          ? metadata.excludedProviderKeys
          : [];
        return excluded.includes('tab.key1') ? providerBResult : providerAResult;
      })
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn((providerKey?: string) => {
        if (providerKey === 'tab.key1') return 'runtime:one';
        if (providerKey === 'tab.key2') return 'runtime:two';
        return undefined;
      }),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === 'runtime:one' ? providerAHandle : providerBHandle
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
    const logStage = jest.fn();
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as ModuleDependencies),
      logStage,
      stats
    };
    const executor = new HubRequestExecutor(deps);
    stubConvertProviderResponse();
    const request: PipelineExecutionInput = {
      requestId: 'req_switch_immediately_on_alternative',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'retry me' }] },
      metadata: { stream: false, inboundStream: false }
    };

    const response = await executor.execute(request);

    expect(response).toBeDefined();
    expect(providerACalls).toHaveLength(1);
    expect(providerBCalls).toHaveLength(1);
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect((fakePipeline.execute as jest.Mock).mock.calls[1][0].metadata).toEqual(expect.objectContaining({
      excludedProviderKeys: ['tab.key1']
    }));
    const stages = logStage.mock.calls.map((call) => call[0]);
    const secondPipelineStartIndex = stages.findIndex((stage, index) => index > 0 && stage === 'hub.start');
    expect(stages.slice(0, secondPipelineStartIndex)).not.toContain('provider.transport_backoff_wait');
    expect(stages).not.toContain('provider.transport_backoff_wait');
    expect(stages).toContain('provider.transport_backoff.recorded');
    expect(stages).not.toContain('server.global_error_backoff_wait');
  });

  it('does not pass legacy soft-wait options to provider traffic acquire', async () => {
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
        compatibilityProfile: 'chat:provider-a',
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
    stubConvertProviderResponse();

    await executor.execute({
      requestId: 'req_soft_wait_same_runtime',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'same runtime pool' }] },
      metadata: { stream: false, inboundStream: false }
    });

    expect(acquireArgs[0]).not.toHaveProperty('softWaitTimeoutMs');

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

    expect(acquireArgs[1]).not.toHaveProperty('softWaitTimeoutMs');
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
    stubConvertProviderResponse();

    const response = await executor.execute({
      requestId: 'req_stopmessage_disabled_single_attempt',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { messages: [{ role: 'user', content: 'continue' }] },
      metadata: {
        stream: false,
        inboundStream: false,
        stopMessageEnabled: false
      }
    });

    expect(response.status).toBe(200);
    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(trafficGovernor.acquire).not.toHaveBeenCalled();
    expect(trafficGovernor.observeOutcome).not.toHaveBeenCalled();
    expect(trafficGovernor.release).not.toHaveBeenCalled();
  });
});
