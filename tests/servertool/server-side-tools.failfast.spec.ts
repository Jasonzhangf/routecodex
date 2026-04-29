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

describe('server-side-tools fail-fast', () => {
  test('throws on servertool handler failure instead of fabricating tool_outputs followup', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-servertool-failfast-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    } as any;

    await expect(
      runServerSideToolEngine({
        chatResponse: makeToolCallResponse(),
        adapterContext,
        entryEndpoint: '/v1/responses',
        requestId: 'req-servertool-failfast-1',
        providerProtocol: 'openai-responses'
      })
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_HANDLER_FAILED',
      status: 500
    });
  });
});
