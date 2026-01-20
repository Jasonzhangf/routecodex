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
    ...(options.serverToolFollowup ? { serverToolFollowup: true } : {})
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

async function assertTriggered(ctx: ServerToolHandlerContext): Promise<void> {
  const handler = getHandler();
  const plan = await handler(ctx);
  expect(plan).not.toBeNull();
  const result = await plan!.finalize({});
  expect(result?.execution?.followup && 'injection' in result.execution.followup).toBe(true);
  const injection = (result!.execution.followup as { injection: { ops: Array<{ op: string }> } }).injection;
  expect(injection.ops.some((op) => op.op === 'inject_system_text')).toBe(true);
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
});

