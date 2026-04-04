import { describe, expect, it } from '@jest/globals';

import { buildClientPayloadForProtocol } from '../client-remap-protocol-switch.js';

describe('client-remap-protocol-switch', () => {
  it('remaps openai-chat tool call names back to client-declared names', () => {
    const payload = {
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'read',
                  arguments: '{"file_path":"/tmp/a.txt"}'
                }
              },
              {
                id: 'call_2',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: '{"cmd":"pwd"}'
                }
              }
            ]
          }
        }
      ]
    };

    const requestSemantics = {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: {
              name: 'Read',
              parameters: {
                type: 'object',
                properties: {
                  file_path: { type: 'string' }
                },
                required: ['file_path'],
                additionalProperties: false
              }
            }
          },
          {
            type: 'function',
            function: {
              name: 'Bash',
              parameters: {
                type: 'object',
                properties: {
                  cmd: { type: 'string' }
                },
                required: ['cmd'],
                additionalProperties: false
              }
            }
          }
        ]
      }
    };

    const result = buildClientPayloadForProtocol({
      payload: payload as any,
      clientProtocol: 'openai-chat',
      requestId: 'req-test-remap',
      requestSemantics: requestSemantics as any
    });

    const toolCalls = (result as any).choices[0].message.tool_calls;
    expect(toolCalls[0].function.name).toBe('Read');
    expect(toolCalls[0].function.arguments).toBe('{"file_path":"/tmp/a.txt"}');
    expect(toolCalls[1].function.name).toBe('Bash');
    expect(toolCalls[1].function.arguments).toBe('{"cmd":"pwd"}');
  });

  it('remaps normalized exec_command back to namespaced declared tool name', () => {
    const payload = {
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: '{"cmd":"pwd"}'
                }
              }
            ]
          }
        }
      ]
    };

    const requestSemantics = {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: {
              name: 'functions.exec_command',
              parameters: {
                type: 'object',
                properties: {
                  cmd: { type: 'string' }
                },
                required: ['cmd'],
                additionalProperties: false
              }
            }
          }
        ]
      }
    };

    const result = buildClientPayloadForProtocol({
      payload: payload as any,
      clientProtocol: 'openai-chat',
      requestId: 'req-test-remap-ns',
      requestSemantics: requestSemantics as any
    });

    const toolCalls = (result as any).choices[0].message.tool_calls;
    expect(toolCalls[0].function.name).toBe('functions.exec_command');
  });

  it('throws when tool names cannot be mapped into the current request tool list', () => {
    const payload = {
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'unknown_tool_name',
                  arguments: '{}'
                }
              }
            ]
          }
        }
      ]
    };

    const requestSemantics = {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: {
                type: 'object',
                properties: {
                  cmd: { type: 'string' }
                },
                required: ['cmd'],
                additionalProperties: false
              }
            }
          }
        ]
      }
    };

    expect(() => buildClientPayloadForProtocol({
      payload: payload as any,
      clientProtocol: 'openai-chat',
      requestId: 'req-test-remap-hard-check',
      requestSemantics: requestSemantics as any
    })).toThrow('tool name mismatch');
  });
});
