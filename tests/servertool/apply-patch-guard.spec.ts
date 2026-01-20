import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

function makeCapturedChatRequest(): JsonObject {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        type: 'function',
        function: { name: 'apply_patch', description: 'patch', parameters: { type: 'object' } }
      }
    ]
  } as JsonObject;
}

function makeApplyPatchToolCallResponse(args: string): JsonObject {
  return {
    id: 'chatcmpl-tool-applypatch-1',
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
              id: 'call_apply_patch_1',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: args
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  } as JsonObject;
}

describe('apply_patch servertool guard', () => {
  test('does not fabricate tool_outputs or followups for invalid apply_patch args (client executes tool)', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-apply-patch-guard-noop',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      routeId: 'coding',
      capturedChatRequest: makeCapturedChatRequest()
    } as any;

    const invalidArgs = JSON.stringify({
      changes: [{ kind: 'delete_file', target: 'src/' }]
    });
    const chatResponse = makeApplyPatchToolCallResponse(invalidArgs);

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-guard-noop',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();

    const final = result.finalChatResponse as any;
    const tc = final?.choices?.[0]?.message?.tool_calls?.[0]?.function;
    expect(tc?.name).toBe('apply_patch');
    expect(tc?.arguments).toBe(invalidArgs);
    expect(final.tool_outputs).toBeUndefined();
  });
});

