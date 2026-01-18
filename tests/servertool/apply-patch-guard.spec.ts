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

function makeInvalidApplyPatchToolCallResponse(args: string): JsonObject {
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

describe('apply_patch guard servertool (reenter)', () => {
  test('injects tool output + followup when apply_patch args are invalid', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-apply-patch-guard-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      routeId: 'coding',
      capturedChatRequest: makeCapturedChatRequest()
    } as any;

    const invalidArgs = JSON.stringify({
      changes: [{ kind: 'delete_file', target: 'src/' }]
    });
    const chatResponse = makeInvalidApplyPatchToolCallResponse(invalidArgs);

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-guard-1',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('apply_patch_guard');
    const followup = result.execution?.followup as any;
    expect(followup).toBeDefined();

    const payload = followup.payload as JsonObject;
    const messages = Array.isArray((payload as any).messages) ? (payload as any).messages : [];
    expect(messages.length).toBeGreaterThanOrEqual(3);
    const last = messages[messages.length - 1] as any;
    expect(last.role).toBe('tool');
    expect(last.tool_call_id).toBe('call_apply_patch_1');
    expect(last.name).toBe('apply_patch');

    const parsed = JSON.parse(last.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.tool).toBe('apply_patch');
    expect(parsed.reason).toBe('invalid_file');
    expect(String(parsed.guidance || '')).toContain('delete_file');
    expect(String(parsed.guidance || '')).toContain('rm -rf tmp web-container-manager');
  });

  test('builds entry-aware followup payload for /v1/responses', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-apply-patch-guard-resp',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      routeId: 'coding',
      capturedChatRequest: makeCapturedChatRequest()
    } as any;

    const invalidArgs = JSON.stringify({
      changes: [{ kind: 'delete_file', target: 'src/' }]
    });
    const chatResponse = makeInvalidApplyPatchToolCallResponse(invalidArgs);

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-apply-patch-guard-resp',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('apply_patch_guard');
    const followup = result.execution?.followup as any;
    expect(followup).toBeDefined();

    const payload = followup.payload as any;
    expect(Array.isArray(payload.input)).toBe(true);
    expect(payload.messages).toBeUndefined();
    expect(payload.stream).toBe(false);
    expect(payload.parameters?.stream).toBeUndefined();
  });

  test('does not attempt recovery for exec_command-shaped args (missing_changes)', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-apply-patch-guard-hardstop',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      routeId: 'coding',
      capturedChatRequest: makeCapturedChatRequest()
    } as any;

    const invalidArgs = JSON.stringify({
      command: "cat > /tmp/fix.patch << 'EOF'\nEOF"
    });
    const chatResponse = makeInvalidApplyPatchToolCallResponse(invalidArgs);

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-guard-hardstop',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('apply_patch_guard');
    expect(result.execution?.followup).toBeUndefined();

    const final = result.finalChatResponse as any;
    const msg = final?.choices?.[0]?.message;
    expect(msg?.tool_calls).toBeUndefined();
    expect(String(msg?.content || '')).toContain('exec_command');
    expect(final.tool_outputs).toBeUndefined();
  });
});
