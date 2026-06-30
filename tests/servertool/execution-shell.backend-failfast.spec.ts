import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import type { ServerSideToolEngineOptions } from '../../sharedmodule/llmswitch-core/src/servertool/types.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    appendServertoolExecutedRecordWithNative: jest.fn((input: any) => input?.state ?? {}),
    planServertoolExecutionDispatchErrorWithNative: jest.fn(() => ({
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: '[servertool] dispatch failed',
      details: {}
    })),
    planServertoolExecutionOutcomeRuntimeActionWithNative: jest.fn(() => ({
      action: 'return_tool_flow',
      executionFlowId: 'flow-test',
      reuseLastExecutionEnvelope: false
    })),
    createServertoolExecutionLoopStateWithNative: jest.fn(() => ({ executedRecords: [] })),
    runStoplessBuiltinHandlerForRuntimeWithNative: jest.fn(() => null),
    planServertoolHookScheduleWithNative: jest.fn(() => ({ action: 'skip' })),
    isAdapterClientDisconnectedWithNative: jest.fn(() => false),
    planClientDisconnectWatcherWithNative: jest.fn(() => ({ intervalMs: 1000 })),
    planServertoolClientDisconnectedErrorWithNative: jest.fn(() => ({
      code: 'SERVERTOOL_CLIENT_DISCONNECTED',
      category: 'INTERNAL_ERROR',
      status: 499,
      message: '[servertool] client disconnected',
      details: {}
    })),
    planServertoolRequiredResponseHookEmptyErrorWithNative: jest.fn(() => ({
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: '[servertool] required response hook returned empty result',
      details: {}
    })),
    planServertoolStateLoadFailedErrorWithNative: jest.fn(() => ({
      code: 'SERVERTOOL_STATE_LOAD_FAILED',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: '[servertool] state load failed',
      details: {}
    })),
    planServertoolTimeoutErrorWithNative: jest.fn(() => ({
      code: 'SERVERTOOL_TIMEOUT',
      category: 'TIMEOUT',
      status: 504,
      message: '[servertool] timeout',
      details: {}
    })),
    planServertoolTimeoutWatcherWithNative: jest.fn(() => ({ armed: false, timeoutMs: 0 })),
    planStopMessageFetchFailedErrorWithNative: jest.fn(() => ({
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      status: 502,
      message: 'fetch failed',
      details: {}
    })),
    planServertoolHandlerRuntimeActionForPlannedWithNative: jest.fn((planned: any) => {
      const execution = planned?.execution;
      if (typeof planned?.finalize === 'function') {
        return { action: 'finalize_without_backend' };
      }
      if (
        planned?.chatResponse &&
        typeof planned.chatResponse === 'object' &&
        !Array.isArray(planned.chatResponse) &&
        execution &&
        typeof execution === 'object' &&
        !Array.isArray(execution) &&
        typeof execution.flowId === 'string'
      ) {
        return { action: 'return_handler_result' };
      }
      if (typeof planned?.flowId === 'string' || planned?.finalize !== undefined) {
        return { action: 'invalid_plan_missing_finalize' };
      }
      return { action: 'invalid_plan_result' };
    }),
    planServertoolMaterializationProgressWithNative: jest.fn((input: any) => {
      if (input?.hasFinalizeFunction) {
        return { action: 'finalize_without_backend' };
      }
      if (input?.hasChatResponseObject && input?.hasExecutionObject && input?.hasExecutionFlowId) {
        return { action: 'return_handler_result' };
      }
      if (input?.hasPlanMarkers) {
        return { action: 'invalid_plan_missing_finalize' };
      }
      return { action: 'invalid_plan_result' };
    }),
    planServertoolHandlerContractErrorWithNative: jest.fn((input: any) => {
      const kind = String(input?.kind ?? '').trim();
      if (kind === 'handler_failed') {
        return {
          code: 'SERVERTOOL_HANDLER_FAILED',
          category: 'INTERNAL_ERROR',
          status: 500,
          message: `[servertool] handler failed: ${String(input?.toolName ?? '')}: ${String(input?.error ?? '')}`,
          details: {
            toolName: String(input?.toolName ?? ''),
            requestId: String(input?.requestId ?? ''),
            entryEndpoint: String(input?.entryEndpoint ?? ''),
            providerProtocol: String(input?.providerProtocol ?? ''),
            error: String(input?.error ?? '')
          }
        };
      }
      if (kind === 'invalid_handler_plan_missing_finalize') {
        return {
          code: 'SERVERTOOL_HANDLER_FAILED',
          category: 'INTERNAL_ERROR',
          status: 500,
          message: '[servertool] invalid handler plan contract: missing finalize',
          details: { requestId: String(input?.requestId ?? '') }
        };
      }
      return {
        code: 'SERVERTOOL_HANDLER_FAILED',
        category: 'INTERNAL_ERROR',
        status: 500,
        message: '[servertool] invalid handler plan/result contract',
        details: { requestId: String(input?.requestId ?? '') }
      };
    })
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/conversion/provider-protocol-error.js',
  () => ({
    ProviderProtocolError: class ProviderProtocolError extends Error {
      code: string;
      category: string;
      details: Record<string, unknown>;
      status?: number;
      constructor(message: string, options: any = {}) {
        super(message);
        this.name = 'ProviderProtocolError';
        this.code = String(options?.code ?? '');
        this.category = String(options?.category ?? '');
        this.details = (options?.details ?? {}) as Record<string, unknown>;
      }
    }
  })
);

let materializeServertoolPlannedResult: typeof import('../../sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.js').materializeServertoolPlannedResult;

function buildOptions(overrides: Partial<ServerSideToolEngineOptions> = {}): ServerSideToolEngineOptions {
  return {
    chatResponse: {
      id: 'chatcmpl-handler-materialization',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'tool_calls' }]
    } as JsonObject,
    adapterContext: {
      requestId: 'req-handler-materialization',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    } as any,
    entryEndpoint: '/v1/responses',
    requestId: 'req-handler-materialization',
    providerProtocol: 'openai-responses',
    ...overrides
  };
}

beforeAll(async () => {
  ({
    materializeServertoolPlannedResult
  } = await import('../../sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.js'));
});

describe('execution-shell handler materialization', () => {
  test('handler plan without finalize fails fast instead of being treated as a materialized result', async () => {
    await expect(
      materializeServertoolPlannedResult(
        {
          flowId: 'broken_plan_without_finalize'
        } as any,
        buildOptions()
      )
    ).rejects.toThrow('[servertool] invalid handler plan contract: missing finalize');
  });

  test('handler plan with finalize materializes without any backend plan carrier', async () => {
    await expect(
      materializeServertoolPlannedResult(
        {
          flowId: 'finalize_only_plan',
          finalize: async () => ({
            chatResponse: {
              id: 'chatcmpl-backend-finalize',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
            } as JsonObject,
            execution: { flowId: 'finalize_only_plan' }
          })
        } as any,
        buildOptions()
      )
    ).resolves.toMatchObject({
      execution: { flowId: 'finalize_only_plan' }
    });
  });
});
