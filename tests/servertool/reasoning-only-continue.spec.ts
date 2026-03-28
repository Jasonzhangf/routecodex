import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

function buildReasoningOnlyResponse(): JsonObject {
  return {
    id: 'chatcmpl_reasoning_only',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'Investigating headless mode mismatch'
        }
      }
    ]
  };
}

describe('servertool reasoning-only auto continue', () => {
  test('uses reenter followup when tmux session is unavailable', async () => {
    const chatResponse = buildReasoningOnlyResponse();
    const adapterContext = {} as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_only_1'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_only_continue_flow');
    const followup = result.execution?.followup as
      | {
          metadata?: Record<string, unknown>;
          injection?: { ops?: Array<Record<string, unknown>> };
        }
      | undefined;
    expect(followup?.metadata?.clientInjectOnly).toBeUndefined();
    expect(followup?.injection?.ops).toEqual([
      { op: 'append_assistant_message', required: false },
      { op: 'append_user_text', text: '继续执行' }
    ]);
  });

  test('keeps clientInjectOnly followup when tmux session is available', async () => {
    const chatResponse = buildReasoningOnlyResponse();
    const adapterContext = {
      clientTmuxSessionId: 'session-123',
      clientInjectReady: true
    } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_only_2'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_only_continue_flow');
    const followup = result.execution?.followup as { metadata?: Record<string, unknown> } | undefined;
    expect(followup?.metadata?.clientInjectOnly).toBe(true);
    expect(followup?.metadata?.clientInjectText).toBe('继续执行');
  });
});
