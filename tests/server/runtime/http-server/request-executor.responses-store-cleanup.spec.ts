import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../../src/server/runtime/handlers/types.js';
import type { HubPipeline, ProviderHandle } from '../../../../src/server/runtime/http-server/types.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { HubRequestExecutor } from '../../../../src/server/runtime/http-server/request-executor.js';
import {
  captureResponsesRequestContext,
  clearResponsesConversationByRequestId,
  responsesConversationStore,
  resumeLatestResponsesContinuationByScope,
} from '../../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js';

function createRuntimeHandle(processImpl: () => Promise<unknown>): ProviderHandle {
  return {
    providerType: 'openai',
    providerFamily: 'openai',
    providerId: 'dbittai-gpt',
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
    metadata: {},
  };

  const fakePipeline: HubPipeline = {
    execute: jest.fn().mockResolvedValue(pipelineResult),
  };

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

  afterEach(() => {
    clearResponsesConversationByRequestId(requestId);
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

    expect(responsesConversationStore.getDebugStats().requestMapSize).toBeGreaterThan(0);

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
    expect(responsesConversationStore.getDebugStats().requestMapSize).toBe(0);
    expect(responsesConversationStore.getDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
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
    expect(responsesConversationStore.getDebugStats().requestMapSize).toBe(0);
    expect(responsesConversationStore.getDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
  });



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

    responsesConversationStore.recordResponse({
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

    expect(responsesConversationStore.getDebugStats().requestMapSize).toBeGreaterThan(0);
    expect(responsesConversationStore.getDebugStats().requestEntriesWithoutLastResponseId).toBe(1);

    const handle = createRuntimeHandle(async () => {
      throw Object.assign(new Error('windsurf raw stream ended with no content'), {
        code: 'WINDSURF_SERVICE_UNREACHABLE',
        upstreamCode: 'WINDSURF_SERVICE_UNREACHABLE',
        status: 502,
        statusCode: 502,
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
      metadata: {},
    };

    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockResolvedValue(pipelineResult),
    };

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
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      statusCode: 502,
    });

    expect(responsesConversationStore.getDebugStats().requestMapSize).toBe(0);
    expect(responsesConversationStore.getDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
  });

});
