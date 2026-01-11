import { describe, it, expect } from '@jest/globals';
import type { AdapterContext, ChatEnvelope } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import { ResponsesSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/responses-mapper.js';

function createSubmitContext(overrides?: Partial<AdapterContext>): AdapterContext {
  return {
    requestId: 'req-submit-test',
    entryEndpoint: '/v1/responses.submit_tool_outputs',
    providerProtocol: 'openai-responses',
    responsesResume: {
      restoredFromResponseId: 'resp-test-id'
    },
    ...overrides
  };
}

function createChatEnvelope(ctx: AdapterContext, seed?: Partial<ChatEnvelope>): ChatEnvelope {
  return {
    messages: seed?.messages ?? [{ role: 'user', content: 'hello' }],
    parameters: seed?.parameters ?? { model: 'gpt-4o-mini', stream: true },
    metadata: {
      context: ctx,
      responsesContext: {
        metadata: {
          originalEndpoint: 'openai-responses'
        }
      }
    },
    ...seed
  };
}

describe('ResponsesSemanticMapper submit tool outputs', () => {
  it('builds submit payload from chat toolOutputs', async () => {
    const mapper = new ResponsesSemanticMapper();
    const ctx = createSubmitContext();
    const chat = createChatEnvelope(ctx, {
      toolOutputs: [
        {
          tool_call_id: 'tool-1',
          content: '{"ok":true}',
          name: 'shell_command'
        }
      ]
    });
    const envelope = await mapper.fromChat(chat, ctx);
    expect(envelope.payload).toMatchObject({
      response_id: 'resp-test-id',
      model: 'gpt-4o-mini',
      stream: true,
      metadata: {
        originalEndpoint: 'openai-responses'
      }
    });
    const outputs = (envelope.payload as Record<string, unknown>).tool_outputs as Array<Record<string, unknown>>;
    expect(Array.isArray(outputs)).toBe(true);
    expect(outputs[0]).toMatchObject({
      tool_call_id: 'tool-1',
      output: '{"ok":true}',
      name: 'shell_command'
    });
  });

  it('falls back to resume metadata when chat.toolOutputs missing', async () => {
    const mapper = new ResponsesSemanticMapper();
    const ctx = createSubmitContext({
      responsesResume: {
        restoredFromResponseId: 'resp-fallback',
        toolOutputsDetailed: [
          {
            callId: 'resume-1',
            outputText: 'fallback'
          }
        ]
      }
    });
    const chat = createChatEnvelope(ctx, {
      toolOutputs: undefined
    });
    const envelope = await mapper.fromChat(chat, ctx);
    expect(envelope.payload).toMatchObject({
      response_id: 'resp-fallback'
    });
    const outputs = (envelope.payload as Record<string, unknown>).tool_outputs as Array<Record<string, unknown>>;
    expect(outputs[0]).toMatchObject({
      tool_call_id: 'resume-1',
      output: 'fallback'
    });
  });
});
