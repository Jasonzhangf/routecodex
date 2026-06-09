import { describe, expect, test } from '@jest/globals';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import { registerServerToolHandler } from '../../sharedmodule/llmswitch-core/src/servertool/registry.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

const TOOL_NAME = 'failfast_test_tool';

registerServerToolHandler(TOOL_NAME, async () => {
  throw new Error('boom-from-test-handler');
});

function makeToolCallResponse(): JsonObject {
  return {
    id: 'chatcmpl-servertool-failfast',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_failfast_1',
              type: 'function',
              function: {
                name: TOOL_NAME,
                arguments: '{}'
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  } as JsonObject;
}

describe('server-side-tools tool-error closed loop', () => {
  test('fails fast through native client-disconnect policy before servertool execution', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-servertool-disconnected-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      clientDisconnected: ' true '
    } as any;

    await expect(
      runServerSideToolEngine({
        chatResponse: makeToolCallResponse(),
        adapterContext,
        entryEndpoint: '/v1/responses',
        requestId: 'req-servertool-disconnected-1',
        providerProtocol: 'openai-responses'
      })
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_CLIENT_DISCONNECTED',
      details: { requestId: 'req-servertool-disconnected-1' }
    });
  });

  test('returns retryable tool error output on servertool handler failure instead of aborting the whole request', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-servertool-failfast-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse: makeToolCallResponse(),
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-servertool-failfast-1',
      providerProtocol: 'openai-responses'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.followup).toBeTruthy();
    expect(result.execution?.flowId).toBe(`${TOOL_NAME}_error`);
    const outputs = Array.isArray((result.finalChatResponse as any).tool_outputs)
      ? ((result.finalChatResponse as any).tool_outputs as any[])
      : [];
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      tool_call_id: 'call_failfast_1',
      name: TOOL_NAME
    });
    const parsed = JSON.parse(String(outputs[0].content));
    expect(parsed).toMatchObject({
      ok: false,
      tool: TOOL_NAME,
      retryable: true
    });
    expect(String(parsed.message || '')).toContain('boom-from-test-handler');
  });
});
