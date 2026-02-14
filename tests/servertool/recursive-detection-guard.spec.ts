import '../../sharedmodule/llmswitch-core/src/servertool/handlers/recursive-detection-guard.js';
import { listAutoServerToolHandlers } from '../../sharedmodule/llmswitch-core/src/servertool/registry.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import type { ServerToolHandlerContext, ToolCall } from '../../sharedmodule/llmswitch-core/src/servertool/types.js';

function getHandler() {
  const entry = listAutoServerToolHandlers().find((h) => h.name === 'recursive_detection_guard');
  if (!entry) {
    throw new Error('recursive_detection_guard not registered');
  }
  return entry.handler;
}

function makeCtx(options: {
  sessionId: string;
  toolCall?: ToolCall;
  toolCalls?: ToolCall[];
  serverToolFollowup?: boolean;
}): ServerToolHandlerContext {
  const toolCall = options.toolCall;
  const toolCalls = options.toolCalls ?? (toolCall ? [toolCall] : []);

  const base: JsonObject = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: toolCall
            ? [
                {
                  id: toolCall.id,
                  type: 'function',
                  function: {
                    name: toolCall.name,
                    arguments: toolCall.arguments
                  }
                }
              ]
            : []
        }
      }
    ]
  };

  const adapterContext: AdapterContext = {
    requestId: 'req-test',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai',
    sessionId: options.sessionId,
    capturedChatRequest: {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }]
    },
    ...(options.serverToolFollowup ? { __rt: { serverToolFollowup: true } } : {})
  };

  return {
    base,
    toolCall,
    toolCalls,
    adapterContext,
    requestId: 'req-test',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai',
    capabilities: { reenterPipeline: true, providerInvoker: false }
  };
}

async function assertTriggered(ctx: ServerToolHandlerContext): Promise<any> {
  const handler = getHandler();
  const plan = await handler(ctx);
  expect(plan).not.toBeNull();
  const result = await plan!.finalize({});
  expect(result?.execution?.followup && 'injection' in result.execution.followup).toBe(true);
  const injection = (result!.execution.followup as { injection: { ops: Array<{ op: string }> } }).injection;
  expect(injection.ops.some((op) => op.op === 'inject_system_text')).toBe(true);
  return result;
}

describe('recursive_detection_guard servertool', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_RECURSIVE_DETECTION_ENABLED = 'true';
  });

  test('triggers after 10 consecutive identical tool name + args', async () => {
    const handler = getHandler();
    const sessionId = 'recursive-detection-session-1';
    const args = JSON.stringify({ cmd: 'echo hi' });

    for (let i = 1; i <= 9; i += 1) {
      const ctx = makeCtx({
        sessionId,
        toolCall: { id: `tc-${i}`, name: 'exec_command', arguments: args }
      });
      await expect(handler(ctx)).resolves.toBeNull();
    }

    await assertTriggered(
      makeCtx({
        sessionId,
        toolCall: { id: 'tc-10', name: 'exec_command', arguments: args }
      })
    );
  });

  test('resets after interruption (no tool call)', async () => {
    const handler = getHandler();
    const sessionId = 'recursive-detection-session-2';
    const args = JSON.stringify({ cmd: 'echo hi' });

    for (let i = 1; i <= 9; i += 1) {
      await expect(
        handler(
          makeCtx({
            sessionId,
            toolCall: { id: `tc-a-${i}`, name: 'exec_command', arguments: args }
          })
        )
      ).resolves.toBeNull();
    }

    // interruption
    await expect(handler(makeCtx({ sessionId, toolCalls: [] }))).resolves.toBeNull();

    for (let i = 1; i <= 9; i += 1) {
      await expect(
        handler(
          makeCtx({
            sessionId,
            toolCall: { id: `tc-b-${i}`, name: 'exec_command', arguments: args }
          })
        )
      ).resolves.toBeNull();
    }

    await assertTriggered(
      makeCtx({
        sessionId,
        toolCall: { id: 'tc-b-10', name: 'exec_command', arguments: args }
      })
    );
  });

  test('resets after interruption (serverToolFollowup hop)', async () => {
    const handler = getHandler();
    const sessionId = 'recursive-detection-session-3';
    const args = JSON.stringify({ cmd: 'echo hi' });

    for (let i = 1; i <= 9; i += 1) {
      await expect(
        handler(
          makeCtx({
            sessionId,
            toolCall: { id: `tc-a-${i}`, name: 'exec_command', arguments: args }
          })
        )
      ).resolves.toBeNull();
    }

    // followup hop: should clear ongoing streak without counting it
    await expect(
      handler(
        makeCtx({
          sessionId,
          toolCall: { id: 'tc-followup', name: 'exec_command', arguments: args },
          serverToolFollowup: true
        })
      )
    ).resolves.toBeNull();

    for (let i = 1; i <= 9; i += 1) {
      await expect(
        handler(
          makeCtx({
            sessionId,
            toolCall: { id: `tc-b-${i}`, name: 'exec_command', arguments: args }
          })
        )
      ).resolves.toBeNull();
    }

    await assertTriggered(
      makeCtx({
        sessionId,
        toolCall: { id: 'tc-b-10', name: 'exec_command', arguments: args }
      })
    );
  });

  test('does not trigger when args change (must be identical)', async () => {
    const handler = getHandler();
    const sessionId = 'recursive-detection-session-4';
    const argsA = JSON.stringify({ cmd: 'echo hi' });
    const argsB = JSON.stringify({ cmd: 'echo hi!', extra: 1 });

    for (let i = 1; i <= 9; i += 1) {
      await expect(
        handler(
          makeCtx({
            sessionId,
            toolCall: { id: `tc-a-${i}`, name: 'exec_command', arguments: argsA }
          })
        )
      ).resolves.toBeNull();
    }

    // args changed -> reset
    await expect(
      handler(
        makeCtx({
          sessionId,
          toolCall: { id: 'tc-diff', name: 'exec_command', arguments: argsB }
        })
      )
    ).resolves.toBeNull();

    for (let i = 1; i <= 9; i += 1) {
      await expect(
        handler(
          makeCtx({
            sessionId,
            toolCall: { id: `tc-b-${i}`, name: 'exec_command', arguments: argsA }
          })
        )
      ).resolves.toBeNull();
    }

    await assertTriggered(
      makeCtx({
        sessionId,
        toolCall: { id: 'tc-b-10', name: 'exec_command', arguments: argsA }
      })
    );
  });

  test('restores on next user turn after short-circuit (must not lock manual continuation)', async () => {
    const handler = getHandler();
    const sessionId = 'recursive-detection-session-restore-1';
    const args = JSON.stringify({ cmd: 'cat /tmp/server_part1.js' });

    // First burst triggers guard.
    for (let i = 1; i <= 9; i += 1) {
      await expect(
        handler(
          makeCtx({
            sessionId,
            toolCall: { id: `tc-a-${i}`, name: 'exec_command', arguments: args }
          })
        )
      ).resolves.toBeNull();
    }
    await assertTriggered(
      makeCtx({
        sessionId,
        toolCall: { id: 'tc-a-10', name: 'exec_command', arguments: args }
      })
    );

    // Internal followup hops should stay short-circuited.
    for (let i = 1; i <= 3; i += 1) {
      await expect(
        handler(
          makeCtx({
            sessionId,
            toolCall: { id: `tc-f-${i}`, name: 'exec_command', arguments: args },
            serverToolFollowup: true
          })
        )
      ).resolves.toBeNull();
    }

    // Next user turn should clear short-circuit and allow normal counting again.
    for (let i = 1; i <= 9; i += 1) {
      await expect(
        handler(
          makeCtx({
            sessionId,
            toolCall: { id: `tc-b-${i}`, name: 'exec_command', arguments: args }
          })
        )
      ).resolves.toBeNull();
    }

    await assertTriggered(
      makeCtx({
        sessionId,
        toolCall: { id: 'tc-b-10', name: 'exec_command', arguments: args }
      })
    );
  });

  test('first trigger only warns, second trigger escalates to stop same tool', async () => {
    const handler = getHandler();
    const sessionId = 'recursive-detection-session-escalate-1';
    const args = JSON.stringify({ cmd: 'cat /tmp/server_part1.js' });

    for (let i = 1; i <= 9; i += 1) {
      await expect(
        handler(
          makeCtx({
            sessionId,
            toolCall: { id: `tc-a-${i}`, name: 'exec_command', arguments: args }
          })
        )
      ).resolves.toBeNull();
    }
    const first = await assertTriggered(
      makeCtx({
        sessionId,
        toolCall: { id: 'tc-a-10', name: 'exec_command', arguments: args }
      })
    );
    const firstOps = ((first.execution.followup as any).injection.ops || []) as Array<{ op: string }>;
    expect(firstOps.some((op) => op.op === 'drop_tool_by_name')).toBe(false);

    for (let i = 1; i <= 9; i += 1) {
      await expect(
        handler(
          makeCtx({
            sessionId,
            toolCall: { id: `tc-b-${i}`, name: 'exec_command', arguments: args }
          })
        )
      ).resolves.toBeNull();
    }
    const second = await assertTriggered(
      makeCtx({
        sessionId,
        toolCall: { id: 'tc-b-10', name: 'exec_command', arguments: args }
      })
    );
    const secondOps = ((second.execution.followup as any).injection.ops || []) as Array<{ op: string }>;
    expect(secondOps.some((op) => op.op === 'drop_tool_by_name')).toBe(true);

    // After stop, state should be cleared: next cycle starts from warning tier again.
    for (let i = 1; i <= 9; i += 1) {
      await expect(
        handler(
          makeCtx({
            sessionId,
            toolCall: { id: `tc-c-${i}`, name: 'exec_command', arguments: args }
          })
        )
      ).resolves.toBeNull();
    }
    const third = await assertTriggered(
      makeCtx({
        sessionId,
        toolCall: { id: 'tc-c-10', name: 'exec_command', arguments: args }
      })
    );
    const thirdOps = ((third.execution.followup as any).injection.ops || []) as Array<{ op: string }>;
    expect(thirdOps.some((op) => op.op === 'drop_tool_by_name')).toBe(false);
  });
});
