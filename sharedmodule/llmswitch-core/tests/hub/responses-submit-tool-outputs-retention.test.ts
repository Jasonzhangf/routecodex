import { describe, expect, test } from '@jest/globals';
import { convertProviderResponse } from '../../src/conversion/hub/response/provider-response.js';
import {
  captureResponsesRequestContext,
  resumeResponsesConversation
} from '../../src/conversion/shared/responses-conversation-store.js';
import type { AdapterContext } from '../../src/conversion/hub/types/chat-envelope.js';

describe('responses submit_tool_outputs retention', () => {
  test('retains requires_action function_call responses for submit_tool_outputs resume', async () => {
    const requestId = `req_retention_${Date.now()}`;
    const responseId = `resp_retention_${Date.now()}`;

    captureResponsesRequestContext({
      requestId,
      payload: {
        model: 'gpt-5.4-medium',
        stream: true,
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            description: 'Run a shell command',
            parameters: {
              type: 'object',
              properties: {
                cmd: { type: 'string' }
              },
              required: ['cmd']
            }
          }
        ]
      },
      context: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'run pwd' }]
          }
        ]
      }
    });

    const providerResponse = {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'requires_action',
      model: 'gpt-5.4-medium',
      output: [
        {
          id: 'fc_retention_1',
          type: 'function_call',
          status: 'in_progress',
          call_id: 'call_retention_1',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}'
        }
      ],
      required_action: {
        type: 'submit_tool_outputs',
        submit_tool_outputs: {
          tool_calls: [
            {
              id: 'call_retention_1',
              type: 'function',
              name: 'exec_command',
              arguments: '{"cmd":"pwd"}'
            }
          ]
        }
      }
    };

    const context: AdapterContext = {
      requestId,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    };

    const converted = await convertProviderResponse({
      providerProtocol: 'openai-responses',
      providerResponse,
      context,
      entryEndpoint: '/v1/responses',
      wantsStream: false
    });

    expect(converted.body?.status).toBe('requires_action');
    expect(converted.body?.output?.[0]?.type).toBe('function_call');

    const resumed = resumeResponsesConversation(
      responseId,
      {
        response_id: responseId,
        tool_outputs: [
          {
            tool_call_id: 'call_retention_1',
            output: '/Users/fanzhang/Documents/github/routecodex'
          }
        ]
      },
      { requestId: `req_resume_${Date.now()}` }
    );

    expect(resumed.payload.previous_response_id).toBe(responseId);
    expect(Array.isArray(resumed.payload.input)).toBe(true);
    expect(
      resumed.payload.input.some(
        (item: any) =>
          item &&
          typeof item === 'object' &&
          item.type === 'function_call_output' &&
          item.call_id === 'call_retention_1'
      )
    ).toBe(true);
  });
});
