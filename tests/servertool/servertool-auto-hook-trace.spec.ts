import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type {
  ServerSideToolEngineOptions,
  ServerToolAutoHookTraceEvent,
  ServerToolHandlerContext,
} from '../../sharedmodule/llmswitch-core/src/servertool/types.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import type { ServerToolExecutionDescriptor } from '../../sharedmodule/llmswitch-core/src/servertool/registry-types.js';

const registryHooks: Array<{
  id: string;
  phase: string;
  priority: number;
  order: number;
  execution: ServerToolExecutionDescriptor & { __testHandler?: (ctx: ServerToolHandlerContext) => Promise<any> };
}> = [];

const planAutoHookRuntimeAttemptWithNativeMock = jest.fn((input: any) => {
  const flowId =
    typeof input?.materializedFlowId === 'string' && input.materializedFlowId.trim()
      ? input.materializedFlowId.trim()
      : undefined;
  const outcome = input?.message
    ? 'error'
    : input?.hasPlannedResult !== true
      ? 'planned_null'
      : input?.hasMaterializedResult === true
        ? 'materialized_match'
        : 'materialized_empty';
  if (outcome === 'materialized_match') {
    return {
      returnResult: true,
      continueQueue: false,
      rethrowError: false,
      traceEvent: {
        hookId: String(input?.hookId ?? ''),
        phase: String(input?.phase ?? ''),
        priority: Number(input?.priority ?? 0),
        queue: String(input?.queue ?? ''),
        queueIndex: Number(input?.queueIndex ?? 0),
        queueTotal: Number(input?.queueTotal ?? 0),
        result: 'match',
        reason: flowId ? 'matched' : 'matched_without_flow',
        ...(flowId ? { flowId } : {})
      }
    };
  }
  return {
    returnResult: false,
    continueQueue: outcome !== 'error',
    rethrowError: outcome === 'error',
    traceEvent: {
      hookId: String(input?.hookId ?? ''),
      phase: String(input?.phase ?? ''),
      priority: Number(input?.priority ?? 0),
      queue: String(input?.queue ?? ''),
      queueIndex: Number(input?.queueIndex ?? 0),
      queueTotal: Number(input?.queueTotal ?? 0),
      result: outcome === 'error' ? 'error' : 'miss',
      reason:
        outcome === 'error'
          ? String(input?.message ?? 'unknown')
          : outcome === 'planned_null'
            ? 'predicate_false'
            : 'empty_materialized_result'
    }
  };
});

const planAutoHookCallerFinalizationWithNativeMock = jest.fn((input: any) => {
  if (input?.resultPresent) {
    return { returnResult: true, continueNextQueue: false, returnNull: false };
  }
  if (input?.finalQueue) {
    return { returnResult: false, continueNextQueue: false, returnNull: true };
  }
  return { returnResult: false, continueNextQueue: true, returnNull: false };
});

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planAutoHookRuntimeAttemptWithNative: planAutoHookRuntimeAttemptWithNativeMock,
    planAutoHookCallerFinalizationWithNative: planAutoHookCallerFinalizationWithNativeMock
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.js',
  () => ({
    listAutoServerToolHooks: jest.fn(() => registryHooks)
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/orchestration-blocks.js',
  () => ({
    buildAutoHookQueuesFromConfig: jest.fn((input: any) => ({
      optionalQueue: [...(input?.hooks ?? [])].filter((hook: any) => hook.priority < 100),
      mandatoryQueue: [...(input?.hooks ?? [])].filter((hook: any) => hook.priority >= 100)
    }))
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.js',
  () => ({
    runServertoolHandler: jest.fn(async (handler: any, context: any) => await handler(context)),
    executeBuiltinServerToolHandler: jest.fn(async ({ builtinName, ctx }: any) => {
      const hook = registryHooks.find(
        (entry) => entry.id === builtinName && entry.execution.kind === 'builtin'
      );
      if (!hook || typeof hook.execution.__testHandler !== 'function') {
        throw new Error(`missing test builtin handler for ${builtinName}`);
      }
      return await hook.execution.__testHandler(ctx);
    }),
    materializeServertoolPlannedResult: jest.fn(async (planned: any) => {
      if (!planned) {
        return null;
      }
      if (typeof planned.finalize === 'function') {
        return await planned.finalize();
      }
      return planned;
    })
  })
);

let runServertoolAutoHookCaller: typeof import('../../sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.js').runServertoolAutoHookCaller;

beforeAll(async () => {
  ({ runServertoolAutoHookCaller } = await import(
    '../../sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.js'
  ));
});

beforeEach(() => {
  registryHooks.length = 0;
  planAutoHookRuntimeAttemptWithNativeMock.mockClear();
  planAutoHookCallerFinalizationWithNativeMock.mockClear();
  planAutoHookRuntimeAttemptWithNativeMock.mockImplementation((input: any) => {
    const flowId =
      typeof input?.materializedFlowId === 'string' && input.materializedFlowId.trim()
        ? input.materializedFlowId.trim()
        : undefined;
    const outcome = input?.message
      ? 'error'
      : input?.hasPlannedResult !== true
        ? 'planned_null'
        : input?.hasMaterializedResult === true
          ? 'materialized_match'
          : 'materialized_empty';
    if (outcome === 'materialized_match') {
      return {
        returnResult: true,
        continueQueue: false,
        rethrowError: false,
        traceEvent: {
          hookId: String(input?.hookId ?? ''),
          phase: String(input?.phase ?? ''),
          priority: Number(input?.priority ?? 0),
          queue: String(input?.queue ?? ''),
          queueIndex: Number(input?.queueIndex ?? 0),
          queueTotal: Number(input?.queueTotal ?? 0),
          result: 'match',
          reason: flowId ? 'matched' : 'matched_without_flow',
          ...(flowId ? { flowId } : {})
        }
      };
    }
    return {
      returnResult: false,
      continueQueue: outcome !== 'error',
      rethrowError: outcome === 'error',
      traceEvent: {
        hookId: String(input?.hookId ?? ''),
        phase: String(input?.phase ?? ''),
        priority: Number(input?.priority ?? 0),
        queue: String(input?.queue ?? ''),
        queueIndex: Number(input?.queueIndex ?? 0),
        queueTotal: Number(input?.queueTotal ?? 0),
        result: outcome === 'error' ? 'error' : 'miss',
        reason:
          outcome === 'error'
            ? String(input?.message ?? 'unknown')
            : outcome === 'planned_null'
              ? 'predicate_false'
              : 'empty_materialized_result'
      }
    };
  });
  planAutoHookCallerFinalizationWithNativeMock.mockImplementation((input: any) => {
    if (input?.resultPresent) {
      return { returnResult: true, continueNextQueue: false, returnNull: false };
    }
    if (input?.finalQueue) {
      return { returnResult: false, continueNextQueue: false, returnNull: true };
    }
    return { returnResult: false, continueNextQueue: true, returnNull: false };
  });
});

function createOptions(traces: ServerToolAutoHookTraceEvent[]): ServerSideToolEngineOptions {
  return {
    chatResponse: {
      id: 'chatcmpl-hook-trace',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'done' },
          finish_reason: 'stop'
        }
      ]
    } as JsonObject,
    adapterContext: {
      requestId: 'req-hook-trace',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    } as any,
    entryEndpoint: '/v1/responses',
    requestId: 'req-hook-trace',
    providerProtocol: 'openai-responses',
    onAutoHookTrace: (event) => traces.push(event)
  };
}

function createContextBase(options: ServerSideToolEngineOptions): ServerToolHandlerContext {
  return {
    base: options.chatResponse,
    toolCalls: [],
    adapterContext: options.adapterContext,
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: options.providerProtocol
  };
}

describe('servertool auto hook trace', () => {
  test('emits match trace for default stopless stop_message_auto hook', async () => {
    const traces: ServerToolAutoHookTraceEvent[] = [];
    registryHooks.push({
      id: 'stop_message_auto',
      phase: 'default',
      priority: 40,
      order: 2,
      execution: {
        kind: 'builtin',
        builtinName: 'stop_message_auto',
        __testHandler: async () => ({
          chatResponse: { ok: true } as JsonObject,
          execution: {
            flowId: 'stop_message_flow'
          }
        })
      }
    });

    const options = createOptions(traces);
  const result = await runServertoolAutoHookCaller({
      options,
      contextBase: createContextBase(options),
      includeAutoHookIds: null,
      excludeAutoHookIds: null
    });

    expect(result?.mode).toBe('tool_flow');
    expect(result?.execution?.flowId).toBe('stop_message_flow');
    const match = traces.find((event) => event.hookId === 'stop_message_auto' && event.result === 'match');
    expect(match).toBeDefined();
    expect(match?.flowId).toBe('stop_message_flow');
  });

  test('empty assistant stop does not use deleted empty-reply hook', async () => {
    const traces: ServerToolAutoHookTraceEvent[] = [];
    registryHooks.push(
      {
        id: 'vision_auto',
        phase: 'default',
        priority: 20,
        order: 1,
        execution: {
          kind: 'adhoc',
          handler: async () => null
        }
      },
      {
        id: 'stop_message_auto',
        phase: 'default',
        priority: 40,
        order: 2,
        execution: {
          kind: 'builtin',
          builtinName: 'stop_message_auto',
          __testHandler: async () => ({
            chatResponse: { ok: true } as JsonObject,
            execution: {
              flowId: 'stop_message_flow'
            }
          })
        }
      }
    );

    const options = createOptions(traces);
  const result = await runServertoolAutoHookCaller({
      options,
      contextBase: createContextBase(options),
      includeAutoHookIds: null,
      excludeAutoHookIds: null
    });

    expect(result?.mode).toBe('tool_flow');
    expect(result?.execution?.flowId).toBe('stop_message_flow');
    expect(traces.some((event) => event.hookId === 'empty_reply_continue')).toBe(false);
    const match = traces.find((event) => event.hookId === 'stop_message_auto' && event.result === 'match');
    expect(match).toBeDefined();
    expect(match?.queue).toBe('A_optional');
    expect(match?.phase).toBe('default');
    expect(match?.priority).toBe(40);
  });

  test('keeps optional primary hooks in empty -> stop order', async () => {
    const traces: ServerToolAutoHookTraceEvent[] = [];
    registryHooks.push(
      {
        id: 'vision_auto',
        phase: 'default',
        priority: 20,
        order: 1,
        execution: {
          kind: 'adhoc',
          handler: async () => null
        }
      },
      {
        id: 'stop_message_auto',
        phase: 'default',
        priority: 40,
        order: 2,
        execution: {
          kind: 'builtin',
          builtinName: 'stop_message_auto',
          __testHandler: async () => ({
            chatResponse: { ok: true } as JsonObject,
            execution: {
              flowId: 'stop_message_flow'
            }
          })
        }
      }
    );

    const options = createOptions(traces);
  await runServertoolAutoHookCaller({
      options,
      contextBase: createContextBase(options),
      includeAutoHookIds: null,
      excludeAutoHookIds: null
    });

    const optionalTraceIds = traces
      .filter((event) => event.queue === 'A_optional')
      .map((event) => event.hookId);
    expect(optionalTraceIds).toEqual(['vision_auto', 'stop_message_auto']);
  });

  test('fails fast when native requests result but materialization is empty', async () => {
    const traces: ServerToolAutoHookTraceEvent[] = [];
    registryHooks.push({
      id: 'stop_message_auto',
      phase: 'default',
      priority: 40,
      order: 1,
      execution: {
        kind: 'builtin',
        builtinName: 'stop_message_auto',
        __testHandler: async () => null
      }
    });
    planAutoHookRuntimeAttemptWithNativeMock.mockImplementationOnce((input: any) => ({
      returnResult: true,
      continueQueue: false,
      rethrowError: false,
      traceEvent: {
        hookId: String(input?.hookId ?? ''),
        phase: String(input?.phase ?? ''),
        priority: Number(input?.priority ?? 0),
        queue: String(input?.queue ?? ''),
        queueIndex: Number(input?.queueIndex ?? 0),
        queueTotal: Number(input?.queueTotal ?? 0),
        result: 'match',
        reason: 'matched_without_flow'
      }
    }));

    const options = createOptions(traces);
    await expect(
  runServertoolAutoHookCaller({
        options,
        contextBase: createContextBase(options),
        includeAutoHookIds: null,
        excludeAutoHookIds: null
      })
    ).rejects.toThrow('native auto-hook execution requested result but materialization was empty');
  });
});
