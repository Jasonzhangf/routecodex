import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import { buildServerToolFollowupChatPayloadFromInjection } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/followup-request-builder.js';
import { inspectOpenAiChatToolHistory } from '../../sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize-tool-history.js';

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

  test('blocks repeated apply_patch retry until a file read is observed, while preserving tools', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-apply-patch-read-before-retry',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      routeId: 'coding',
      capturedChatRequest: {
        ...makeCapturedChatRequest(),
        messages: [
          { role: 'user', content: 'edit AGENTS.md' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_apply_patch_prev',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ patch: '*** Begin Patch\n*** Update File: AGENTS.md\n@@\n-old\n+new\n*** End Patch' })
                }
              }
            ]
          },
          {
            role: 'tool',
            tool_call_id: 'call_apply_patch_prev',
            name: 'apply_patch',
            content: "apply_patch verification failed: Failed to find context '-1,1 +1,1 @@' in AGENTS.md"
          }
        ]
      } as any
    } as any;

    const nextArgs = JSON.stringify({
      patch: '*** Begin Patch\n*** Update File: AGENTS.md\n@@\n-older\n+newer\n*** End Patch'
    });
    const chatResponse = makeApplyPatchToolCallResponse(nextArgs);

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-read-before-retry',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    expect(result.mode).toBe('tool_flow');
    const outputs = ((result.finalChatResponse as any).tool_outputs ?? []) as Array<any>;
    expect(outputs).toHaveLength(1);
    const payload = JSON.parse(String(outputs[0].content || '{}'));
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('APPLY_PATCH_REQUIRES_READ_BEFORE_RETRY');
    expect(String(payload.message || '')).toContain('read the latest target file content');

    const followup = result.execution?.followup as any;
    expect(followup?.injection?.ops).toEqual(
      expect.arrayContaining([
        { op: 'preserve_tools' },
        { op: 'append_assistant_message', required: true },
        { op: 'append_tool_messages_from_tool_outputs', required: true },
        expect.objectContaining({ op: 'inject_system_text' })
      ])
    );
    expect(String(followup?.metadata?.clientInjectSource || '')).toBe(
      'servertool.apply_patch_read_before_retry'
    );
  });

  test('followup payload replays assistant tool_calls before tool result to avoid orphan_tool_result', async () => {
    const adapterContext: AdapterContext = {
      requestId: 'req-apply-patch-read-before-retry-shape',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      routeId: 'coding',
      capturedChatRequest: {
        ...makeCapturedChatRequest(),
        messages: [
          { role: 'user', content: 'edit AGENTS.md' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_apply_patch_prev',
                type: 'function',
                function: {
                  name: 'apply_patch',
                  arguments: JSON.stringify({ patch: '*** Begin Patch\n*** Update File: AGENTS.md\n@@\n-old\n+new\n*** End Patch' })
                }
              }
            ]
          },
          {
            role: 'tool',
            tool_call_id: 'call_apply_patch_prev',
            name: 'apply_patch',
            content: "apply_patch verification failed: Failed to find context '-1,1 +1,1 @@' in AGENTS.md"
          }
        ]
      } as any
    } as any;

    const chatResponse = makeApplyPatchToolCallResponse(
      JSON.stringify({
        patch: '*** Begin Patch\n*** Update File: AGENTS.md\n@@\n-older\n+newer\n*** End Patch'
      })
    );

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-apply-patch-read-before-retry-shape',
      providerProtocol: 'openai-chat'
    });

    const followup = result.execution?.followup as any;
    const payload = buildServerToolFollowupChatPayloadFromInjection({
      adapterContext,
      chatResponse: result.finalChatResponse as JsonObject,
      injection: followup?.injection
    });

    expect(payload).toBeTruthy();
    expect(Array.isArray((payload as any).messages)).toBe(true);
    const messages = ((payload as any).messages ?? []) as Array<any>;
    const assistantIndex = messages.findIndex(
      (entry) =>
        entry?.role === 'assistant' &&
        Array.isArray(entry?.tool_calls) &&
        entry.tool_calls.some((call: any) => call?.id === 'call_apply_patch_1')
    );
    const toolIndex = messages.findIndex(
      (entry) =>
        entry?.role === 'tool' &&
        entry?.tool_call_id === 'call_apply_patch_1' &&
        entry?.name === 'apply_patch'
    );
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(assistantIndex);
    expect(inspectOpenAiChatToolHistory(messages)).toBeNull();
  });
});
