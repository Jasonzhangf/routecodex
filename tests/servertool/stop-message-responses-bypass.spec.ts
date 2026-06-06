import { describe, expect, test } from '@jest/globals';

import { shouldBypassProviderResponseConversion } from '../../src/server/runtime/http-server/executor/request-executor-runtime-blocks.js';

describe('responses stopless conversion bypass gate', () => {
  test('/v1/responses completed response must not bypass conversion when servertool is enabled', () => {
    const bypass = shouldBypassProviderResponseConversion(
      {
        status: 200,
        body: {
          id: 'resp_stopless_bypass_red',
          object: 'response',
          status: 'completed',
          output: [
            {
              id: 'msg_stopless_bypass_red',
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'done'
                }
              ]
            }
          ]
        }
      } as any,
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        serverToolsEnabled: true
      }
    );

    expect(bypass).toBe(false);
  });

  test('/v1/responses relay chat.completion wrapper must not bypass conversion when servertool is enabled', () => {
    const bypass = shouldBypassProviderResponseConversion(
      {
        status: 200,
        body: {
          data: {
            id: 'chatcmpl_stopless_relay_wrapper_red',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: 'done'
                }
              }
            ]
          },
          status: 200,
          headers: {}
        }
      } as any,
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        serverToolsEnabled: true
      }
    );

    expect(bypass).toBe(false);
  });

  test('/v1/responses provider error status bypasses stopless conversion even when servertool is enabled', () => {
    const bypass = shouldBypassProviderResponseConversion(
      {
        status: 429,
        body: {
          error: {
            code: 'HTTP_429',
            message: 'Rate limited by upstream provider'
          }
        }
      } as any,
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        serverToolsEnabled: true
      }
    );

    expect(bypass).toBe(true);
  });
});
