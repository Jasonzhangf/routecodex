import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../../src/server/runtime/handlers/types.js';
import type { HubPipeline, ProviderHandle } from '../../../../src/server/runtime/http-server/types.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { HubRequestExecutor } from '../../../../src/server/runtime/http-server/request-executor.js';
import {
  captureResponsesRequestContext,
  clearResponsesConversationByRequestId,
  responsesConversationStore,
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

  it('clears captured responses request when provider conversion returns client 400', async () => {
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
          code: 'HTTP_400',
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

    expect(result.status).toBe(400);
    expect(responsesConversationStore.getDebugStats().requestMapSize).toBe(0);
    expect(responsesConversationStore.getDebugStats().requestEntriesWithoutLastResponseId).toBe(0);
  });
});
