import { describe, expect, it } from '@jest/globals';

import { convertProviderResponse } from '../../sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.js';

describe('anthropic client remap namespace fallback', () => {
  it('restores Bash alias from semantics.anthropic during client remap', async () => {
    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_anthropic_alias_ns_1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-5.3-codex',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'shell_command',
                    arguments: '{"command":"pwd"}'
                  }
                }
              ]
            }
          }
        ]
      } as any,
      context: {
        requestId: 'req_anthropic_alias_ns_1',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'openai-chat'
      } as any,
      entryEndpoint: '/v1/messages',
      wantsStream: false,
      requestSemantics: {
        anthropic: {
          toolNameAliasMap: {
            shell_command: 'Bash'
          },
          clientToolsRaw: [
            {
              name: 'Bash',
              input_schema: {
                type: 'object',
                properties: {
                  command: { type: 'string' }
                },
                required: ['command']
              }
            }
          ]
        }
      } as any
    });

    const content = (result.body as any)?.content as Array<Record<string, unknown>>;
    const toolUse = content.find((entry) => entry?.type === 'tool_use');

    expect(toolUse?.name).toBe('Bash');
    expect(toolUse?.input).toEqual({ command: 'pwd' });
  });

  it('can derive alias map from semantics.anthropic.clientToolsRaw when direct alias map is absent', async () => {
    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_anthropic_alias_ns_2',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-5.3-codex',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'shell_command',
                    arguments: '{"command":"pwd"}'
                  }
                }
              ]
            }
          }
        ]
      } as any,
      context: {
        requestId: 'req_anthropic_alias_ns_2',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'openai-chat'
      } as any,
      entryEndpoint: '/v1/messages',
      wantsStream: false,
      requestSemantics: {
        anthropic: {
          clientToolsRaw: [
            {
              name: 'Bash',
              input_schema: {
                type: 'object',
                properties: {
                  command: { type: 'string' }
                },
                required: ['command']
              }
            }
          ]
        }
      } as any
    });

    const content = (result.body as any)?.content as Array<Record<string, unknown>>;
    const toolUse = content.find((entry) => entry?.type === 'tool_use');

    expect(toolUse?.name).toBe('Bash');
    expect(toolUse?.input).toEqual({ command: 'pwd' });
  });
});
