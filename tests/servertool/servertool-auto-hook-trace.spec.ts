import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type {
  ServerSideToolEngineOptions,
  ServerToolAutoHookTraceEvent,
  ServerToolHandlerContext,
} from '../../sharedmodule/llmswitch-core/src/servertool/types.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import type { ServerToolExecutionDescriptor } from '../../sharedmodule/llmswitch-core/src/servertool/types.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const registryHooks: Array<{
  id: string;
  phase: string;
  priority: number;
  order: number;
  execution: ServerToolExecutionDescriptor & { __testHandler?: (ctx: ServerToolHandlerContext) => Promise<any> };
}> = [];

function normalizeMockAutoHookError(error: any): string {
  if (typeof error === 'string') {
    return error.trim() || 'unknown';
  }
  if (typeof error?.message === 'string') {
    return error.message.trim() || 'unknown';
  }
  return error === undefined ? '' : 'unknown';
}

const planAutoHookRuntimeAttemptWithNativeMock = jest.fn((input: any) => {
  const flowId =
    typeof input?.materializedFlowId === 'string' && input.materializedFlowId.trim()
      ? input.materializedFlowId.trim()
      : undefined;
  const errorMessage = normalizeMockAutoHookError(input?.error);
  const outcome = input?.error !== undefined
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
          ? errorMessage
          : outcome === 'planned_null'
            ? 'predicate_false'
            : 'empty_materialized_result'
    }
  };
});

const planAutoHookCallerFinalizationWithNativeMock = jest.fn((input: any) => {
  if (input?.resultPresent) {
    return { action: 'return_result', returnResult: true, continueNextQueue: false, returnNull: false };
  }
  if (Number(input?.queueIndex ?? 0) >= Number(input?.queueTotal ?? 0)) {
    return { action: 'return_null', returnResult: false, continueNextQueue: false, returnNull: true };
  }
  return { action: 'continue_next_queue', returnResult: false, continueNextQueue: true, returnNull: false };
});

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planAutoHookRuntimeAttemptWithNative: planAutoHookRuntimeAttemptWithNativeMock,
    planAutoHookCallerFinalizationWithNative: planAutoHookCallerFinalizationWithNativeMock,
    runStoplessBuiltinHandlerForRuntimeWithNative: jest.fn(async (input: any) => {
      const hook = registryHooks.find(
        (entry) => entry.id === input?.name && entry.execution.kind === 'builtin'
      );
      if (!hook || typeof hook.execution.__testHandler !== 'function') {
        throw new Error(`missing test builtin handler for ${String(input?.name ?? '')}`);
      }
      return await hook.execution.__testHandler({
        base: input?.base,
        requestId: input?.requestId,
        runtimeMetadata: input?.runtimeMetadata
      } as any);
    })
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.js',
  () => ({
    listAutoServerToolHooks: jest.fn(() => registryHooks)
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    planServertoolSkeletonDerivedConfigWithNative: jest.fn(() => ({
      autoHookQueueConfig: {
        optionalPrimaryOrder: [],
        mandatoryOrder: []
      }
    })),
    planServertoolAutoHookQueuesWithNative: jest.fn((input: any) => {
      const optionalQueue = [...(input?.hooks ?? [])].filter((hook: any) => hook.priority < 100);
      const mandatoryQueue = [...(input?.hooks ?? [])].filter((hook: any) => hook.priority >= 100);
      return {
        optionalQueue,
        mandatoryQueue,
        queueOrder: [
          { queue: 'A_optional', entries: optionalQueue },
          { queue: 'B_mandatory', entries: mandatoryQueue }
        ]
      };
    }),
    planServertoolAutoHookQueueItemsWithNative: jest.fn((input: any) => {
      const optionalQueue = [...(input?.hooks ?? [])].filter((hook: any) => hook.priority < 100);
      const mandatoryQueue = [...(input?.hooks ?? [])].filter((hook: any) => hook.priority >= 100);
      return {
        queueOrder: [
          { queue: 'A_optional', entries: optionalQueue },
          { queue: 'B_mandatory', entries: mandatoryQueue }
        ]
      };
    })
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.js',
  () => ({
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
    const errorMessage = normalizeMockAutoHookError(input?.error);
    const outcome = input?.error !== undefined
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
            ? errorMessage
            : outcome === 'planned_null'
              ? 'predicate_false'
              : 'empty_materialized_result'
      }
    };
  });
  planAutoHookCallerFinalizationWithNativeMock.mockImplementation((input: any) => {
    if (input?.resultPresent) {
      return { action: 'return_result', returnResult: true, continueNextQueue: false, returnNull: false };
    }
    if (Number(input?.queueIndex ?? 0) >= Number(input?.queueTotal ?? 0)) {
      return { action: 'return_null', returnResult: false, continueNextQueue: false, returnNull: true };
    }
    return { action: 'continue_next_queue', returnResult: false, continueNextQueue: true, returnNull: false };
  });
});

function createOptions(traces: ServerToolAutoHookTraceEvent[]): ServerSideToolEngineOptions {
  const adapterContext = {
    requestId: 'req-hook-trace',
    entryEndpoint: '/v1/responses'
  } as Record<string, unknown>;
  MetadataCenter.attach(adapterContext).writeRuntimeControl(
    'providerProtocol',
    'openai-responses',
    {
      module: 'tests/servertool/servertool-auto-hook-trace.spec.ts',
      symbol: 'createOptions',
      stage: 'test'
    }
  );
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
    adapterContext: adapterContext as any,
    entryEndpoint: '/v1/responses',
    requestId: 'req-hook-trace',
    onAutoHookTrace: (event) => traces.push(event)
  };
}

function createContextBase(options: ServerSideToolEngineOptions): ServerToolHandlerContext {
  return {
    base: options.chatResponse,
    toolCalls: [],
    adapterContext: options.adapterContext,
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint
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
          kind: 'builtin',
          builtinName: 'vision_auto',
          __testHandler: async () => null
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
          kind: 'builtin',
          builtinName: 'vision_auto',
          __testHandler: async () => null
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

  test('keeps impossible result-disposition guard in native wrapper instead of auto-hook caller', async () => {
    const [callerSource, nativeWrapperSource] = await Promise.all([
      import('node:fs/promises').then((fs) =>
        fs.readFile('sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts', 'utf8')
      ),
      import('node:fs/promises').then((fs) =>
        fs.readFile(
          'sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts',
          'utf8'
        )
      )
    ]);

    expect(callerSource).not.toContain('native auto-hook execution requested result but materialization was empty');
    expect(callerSource).not.toContain('native auto-hook queue progress requested result but queue result was empty');
    expect(callerSource).not.toContain('native auto-hook execution returned no materialized disposition');
    expect(callerSource).not.toContain('if (!result)');
    expect(callerSource).not.toContain('if (!queueResult)');
    expect(callerSource).not.toContain('Boolean(planned)');
    expect(callerSource).not.toContain('Boolean(result)');
    expect(callerSource).not.toContain('Boolean(queueResult)');
    expect(callerSource).toContain('hasPlannedResult: planned != null');
    expect(callerSource).toContain('const result = planned != null');
    expect(callerSource).toContain('switch (attemptPlan.returnResult)');
    expect(callerSource).not.toContain('if (planned) {');
    expect(callerSource).not.toContain('if (attemptPlan.returnResult)');
    expect(callerSource).toContain('hasMaterializedResult: result != null');
    expect(callerSource).toContain('resultPresent: queueResult != null');
    expect(callerSource).toContain('switch (finalizationPlan.action)');
    expect(callerSource).not.toContain('if (finalizationPlan.returnResult)');
    expect(callerSource).not.toContain('if (finalizationPlan.continueNextQueue)');
    expect(callerSource).not.toContain('if (finalizationPlan.returnNull)');
    expect(callerSource).not.toContain('...(args.includeAutoHookIds ? { includeAutoHookIds: [...args.includeAutoHookIds] } : {})');
    expect(callerSource).not.toContain('...(args.excludeAutoHookIds ? { excludeAutoHookIds: [...args.excludeAutoHookIds] } : {})');
    expect(callerSource).toContain('includeAutoHookIds: args.includeAutoHookIds != null ? [...args.includeAutoHookIds] : null');
    expect(callerSource).toContain('excludeAutoHookIds: args.excludeAutoHookIds != null ? [...args.excludeAutoHookIds] : null');
    expect(callerSource).not.toContain('error instanceof Error ? error.message');
    expect(callerSource).not.toContain("typeof error === 'string' ? error");
    expect(callerSource).toContain('error');
    expect(nativeWrapperSource).toContain(
      'planAutoHookRuntimeAttemptJson native returned result disposition without materialized result'
    );
    expect(nativeWrapperSource).toContain(
      'planAutoHookRuntimeAttemptJson native returned rethrow disposition without error input'
    );
    expect(nativeWrapperSource).toContain(
      'planAutoHookCallerFinalizationJson native returned result disposition without queue result'
    );
  });

  test('passes raw auto-hook handler errors to native attempt planning', async () => {
    const traces: ServerToolAutoHookTraceEvent[] = [];
    registryHooks.push({
      id: 'vision_auto',
      phase: 'default',
      priority: 20,
      order: 1,
      execution: {
        kind: 'builtin',
        builtinName: 'vision_auto',
        __testHandler: async () => {
          throw new Error('boom-from-auto-hook');
        }
      }
    });
    const options = createOptions(traces);

    await expect(
      runServertoolAutoHookCaller({
        options,
        contextBase: createContextBase(options),
        includeAutoHookIds: null,
        excludeAutoHookIds: null
      })
    ).rejects.toThrow('boom-from-auto-hook');

    expect(planAutoHookRuntimeAttemptWithNativeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hookId: 'vision_auto',
        error: expect.any(Error)
      })
    );
    expect(traces).toContainEqual(
      expect.objectContaining({
        hookId: 'vision_auto',
        result: 'error',
        reason: 'boom-from-auto-hook'
      })
    );
  });

  test('fails fast when auto-hook trace callback fails', async () => {
    registryHooks.push({
      id: 'vision_auto',
      phase: 'default',
      priority: 20,
      order: 1,
      execution: {
        kind: 'builtin',
        builtinName: 'vision_auto',
        __testHandler: async () => null
      }
    });
    const options = createOptions([]);
    options.onAutoHookTrace = () => {
      throw new Error('trace sink failed');
    };

    await expect(
      runServertoolAutoHookCaller({
        options,
        contextBase: createContextBase(options),
        includeAutoHookIds: null,
        excludeAutoHookIds: null
      })
    ).rejects.toThrow('trace sink failed');
  });
});
