import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import type {
  ServerSideToolEngineOptions,
  ServerToolAutoHookTraceEvent,
  ServerToolHandlerContext,
} from '../../sharedmodule/llmswitch-core/src/servertool/types.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

const planAutoHookRuntimeAttemptWithNativeMock = jest.fn((input: any) => ({
  returnResult: false,
  continueQueue: !input?.message,
  rethrowError: Boolean(input?.message),
  traceEvent: {
    hookId: String(input?.hookId ?? ''),
    phase: String(input?.phase ?? ''),
    priority: Number(input?.priority ?? 0),
    queue: String(input?.queue ?? ''),
    queueIndex: Number(input?.queueIndex ?? 0),
    queueTotal: Number(input?.queueTotal ?? 0),
    result: input?.message ? 'error' : 'miss',
    reason: input?.message ? String(input?.message ?? 'unknown') : 'predicate_false'
  }
}));

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planAutoHookRuntimeAttemptWithNative: planAutoHookRuntimeAttemptWithNativeMock,
    planAutoHookCallerFinalizationWithNative: jest.fn(() => ({
      returnResult: false,
      continueNextQueue: false,
      returnNull: true
    })),
    planServertoolRegistryAutoHookDescriptorsWithNative: jest.fn(() => []),
    planServertoolHookScheduleWithNative: jest.fn((input: any) => ({
      events: (input?.hooks ?? []).map((hook: any) => ({
        hookId: hook.id,
        status: 'scheduled',
        effectKind: hook.effectKind,
        requiredness: hook.requiredness,
        noOp: false
      })),
      projection: {
        direction: 'response',
        phase: 'ServertoolRespHook01Intercepted',
        inputNode: 'HubRespChatProcess03Governed',
        outputNode: 'ServertoolRespHook01Intercepted',
        hookIds: (input?.hooks ?? []).map((hook: any) => hook.id),
        effectKinds: (input?.hooks ?? []).map((hook: any) => hook.effectKind)
      }
    }))
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
  '../../sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.js',
  () => ({
    listAutoServerToolHooks: jest.fn(() => [])
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.js',
  () => ({
    executeBuiltinServerToolHandler: jest.fn(async () => {
      throw new Error('optional-hook-boom');
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

let runAutoHookExecutionQueue: typeof import('../../sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.js').runAutoHookExecutionQueue;

beforeAll(async () => {
  ({ runAutoHookExecutionQueue } = await import(
    '../../sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.js'
  ));
});

describe('execution-shell auto hook failfast', () => {
  test('does not swallow optional auto-hook errors during primary attempt', async () => {
    const traces: ServerToolAutoHookTraceEvent[] = [];
    const options: ServerSideToolEngineOptions = {
      chatResponse: {
        id: 'chatcmpl-auto-hook-failfast',
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
        requestId: 'req-auto-hook-failfast',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-auto-hook-failfast',
      providerProtocol: 'openai-responses',
      primaryAutoHookAttempt: true,
      onAutoHookTrace: (event) => traces.push(event)
    };

  const contextBase: ServerToolHandlerContext = {
    base: options.chatResponse,
    toolCalls: [],
    adapterContext: options.adapterContext,
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: options.providerProtocol
  };

    await expect(
      runAutoHookExecutionQueue({
        queueName: 'A_optional',
        hooks: [
          {
            id: 'failing_primary_optional_hook',
            phase: 'default',
            priority: 1,
            execution: {
              kind: 'builtin',
              builtinName: 'failing_primary_optional_hook'
            }
          }
        ],
        options,
        contextBase
      })
    ).rejects.toThrow('optional-hook-boom');

    expect(planAutoHookRuntimeAttemptWithNativeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hookId: 'failing_primary_optional_hook',
        queue: 'A_optional',
        message: 'optional-hook-boom'
      })
    );
    expect(traces).toContainEqual(
      expect.objectContaining({
        hookId: 'failing_primary_optional_hook',
        queue: 'A_optional',
        result: 'error',
        reason: expect.stringContaining('optional-hook-boom')
      })
    );
  });
});
