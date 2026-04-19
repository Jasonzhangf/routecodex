import { describe, expect, it } from '@jest/globals';

import type { AdapterContext, ChatEnvelope } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import { ResponsesSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/responses-mapper.js';

function createResponsesContext(requestId: string): AdapterContext {
  return {
    requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses'
  };
}

function buildResponsesPayload() {
  return {
    model: 'gpt-5',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    response_format: {
      type: 'json_schema',
      name: 'reply_schema',
      schema: {
        type: 'object',
        properties: {
          answer: { type: 'string' }
        },
        required: ['answer']
      }
    },
    include: ['reasoning.encrypted_content'],
    store: true,
    prompt_cache_key: 'cache-1',
    tool_choice: 'required',
    parallel_tool_calls: true,
    reasoning: { effort: 'high' },
    text: { verbosity: 'high' },
    service_tier: 'priority',
    truncation: 'auto',
    modalities: ['text'],
    stream: true
  };
}

describe('responses semantics snapshot', () => {
  it('captures responses request fields into chat.semantics.responses', async () => {
    const mapper = new ResponsesSemanticMapper();
    const payload = buildResponsesPayload();

    const chat = await mapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload
      } as any,
      createResponsesContext('req-responses-semantics-inbound')
    );

    expect(chat.semantics?.responses).toMatchObject({
      requestParameters: {
        model: 'gpt-5',
        response_format: payload.response_format,
        include: payload.include,
        store: true,
        prompt_cache_key: 'cache-1',
        tool_choice: 'required',
        parallel_tool_calls: true,
        reasoning: payload.reasoning,
        text: payload.text,
        service_tier: 'priority',
        truncation: 'auto',
        modalities: ['text'],
        stream: true
      },
      responseFormat: payload.response_format,
      include: payload.include,
      store: true,
      promptCacheKey: 'cache-1',
      toolChoice: 'required',
      parallelToolCalls: true,
      reasoning: payload.reasoning,
      text: payload.text,
      serviceTier: 'priority',
      truncation: 'auto',
      modalities: ['text']
    });
  });

  it('restores responses request fields from semantics when chat.parameters is partially lost', async () => {
    const mapper = new ResponsesSemanticMapper();
    const payload = buildResponsesPayload();
    const chat = await mapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload
      } as any,
      createResponsesContext('req-responses-semantics-restore')
    );

    const degradedChat: ChatEnvelope = {
      ...chat,
      parameters: {},
      semantics: {
        ...(chat.semantics ?? {}),
        responses: {
          ...((chat.semantics?.responses as Record<string, unknown>) ?? {}),
          requestParameters: {
            model: payload.model
          }
        }
      }
    };

    const outbound = await mapper.fromChat(
      degradedChat,
      createResponsesContext('req-responses-semantics-restore-out')
    );

    expect(outbound.payload).toMatchObject({
      model: 'gpt-5',
      response_format: payload.response_format,
      include: payload.include,
      store: true,
      prompt_cache_key: 'cache-1',
      tool_choice: 'required',
      parallel_tool_calls: true,
      reasoning: payload.reasoning,
      text: payload.text,
      service_tier: 'priority',
      truncation: 'auto',
      modalities: ['text']
    });
  });
});
