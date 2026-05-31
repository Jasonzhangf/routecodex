import { describe, expect, test } from '@jest/globals';

import { resolveRouteAwareResponsesContinuation } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.js';
import { ResponsesSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/responses-mapper.js';
import { buildAnthropicRequestFromOpenAIChat } from '../../sharedmodule/llmswitch-core/src/conversion/shared/anthropic-message-utils-openai-request.js';

describe('servertool followup anthropic tool schema regression', () => {
  test('preserves structured tool_use blocks that were stringified in chat history', () => {
    const anthropic = buildAnthropicRequestFromOpenAIChat({
      model: 'mimo-v2.5',
      messages: [
        {
          role: 'assistant',
          content: JSON.stringify([
            {
              id: 'call_stringified_tool_use_1',
              input: { cmd: 'pwd' },
              name: 'exec_command',
              type: 'tool_use',
            },
          ]),
        },
        {
          role: 'tool',
          tool_call_id: 'call_stringified_tool_use_1',
          content: 'ok',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
          },
        },
      ],
    } as any, { requestId: 'req_stringified_tool_use' }) as any;

    expect(anthropic.messages[0]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_stringified_tool_use_1',
          name: 'exec_command',
          input: { cmd: 'pwd' },
        },
      ],
    });
    expect(anthropic.messages[1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: 'ok',
          tool_use_id: 'call_stringified_tool_use_1',
        },
      ],
    });
  });

  test('preserves exec_command schema on plain followup create routed to anthropic provider', async () => {
    const request: Record<string, unknown> = {
      model: 'gpt-5.4',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续执行' }],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          parameters: {
            type: 'object',
            properties: {
              cmd: { type: 'string' },
              workdir: { type: 'string' },
            },
            required: ['cmd'],
            additionalProperties: false,
          },
        },
      ],
      stream: true,
    };

    const continued = resolveRouteAwareResponsesContinuation({
      request: request as any,
      rawRequest: request as any,
      normalizedMetadata: {
        sessionId: 'sess_followup_schema',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        __rt: {
          serverToolFollowup: true,
          clientInjectSource: 'stop_message_flow',
        },
      },
      requestId: 'req_followup_schema',
      entryProtocol: 'openai-responses',
      outboundProtocol: 'anthropic-messages',
    }) as Record<string, unknown>;

    const mapper = new ResponsesSemanticMapper();
    const chat = await mapper.toChat(
      { protocol: 'openai-responses', direction: 'request', payload: continued as any } as any,
      { requestId: 'req_followup_schema', entryEndpoint: '/v1/responses', providerProtocol: 'openai-responses' } as any,
    );

    const anthropic = buildAnthropicRequestFromOpenAIChat(chat as any, { requestId: 'req_followup_schema' }) as any;
    expect(anthropic.tools?.[0]).toEqual({
      name: 'exec_command',
      input_schema: {
        type: 'object',
        properties: {
          cmd: { type: 'string' },
          workdir: { type: 'string' },
        },
        required: ['cmd'],
        additionalProperties: false,
      },
    });
  });
});
