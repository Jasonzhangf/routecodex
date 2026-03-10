import { describe, expect, test } from '@jest/globals';

import { GeminiSemanticMapper } from '../../src/conversion/hub/operation-table/semantic-mappers/gemini-mapper.js';

describe('gemini mapper gemini-cli tool support', () => {
  test('includes tools for gemini-cli providers when tools are present', async () => {
    const mapper = new GeminiSemanticMapper();

    const ctx: any = {
      requestId: 'req_test',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      providerId: 'gemini-cli.any'
    };

    const chat: any = {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'request_user_input',
            description: 'Ask the user a question and return their answer.',
            parameters: {
              type: 'object',
              properties: {
                questions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      question: { type: 'string' }
                    },
                    required: ['id', 'question']
                  }
                }
              },
              required: ['questions']
            }
          }
        }
      ],
      parameters: {
        model: 'models/gemini-pro',
        tool_choice: 'auto'
      },
      metadata: { context: ctx }
    };

    const out = await mapper.fromChat(chat, ctx);
    const payload: any = out?.payload;

    expect(payload).toBeTruthy();
    expect(Array.isArray(payload.contents)).toBe(true);
    expect(payload.contents[0]?.role).toBe('user');

    expect(Array.isArray(payload.tools)).toBe(true);
    const decls = payload.tools?.[0]?.functionDeclarations;
    expect(Array.isArray(decls)).toBe(true);
    expect(decls).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'request_user_input' })]));
  });
});

