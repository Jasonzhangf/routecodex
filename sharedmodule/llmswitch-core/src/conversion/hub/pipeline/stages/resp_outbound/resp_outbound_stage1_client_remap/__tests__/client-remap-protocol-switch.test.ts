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

    try {
      buildClientPayloadForProtocol({
        payload: payload as any,
        clientProtocol: 'openai-chat',
        requestId: 'req-test-remap-hard-check',
        requestSemantics: requestSemantics as any
      });
      throw new Error('expected mismatch error');
    } catch (error: any) {
      expect(String(error?.message || '')).toContain('tool name mismatch');
      expect(error?.code).toBe('CLIENT_TOOL_NAME_MISMATCH');
      expect(error?.statusCode).toBe(502);
      expect(error?.retryable).toBe(true);
    }
  });

  it('remaps separator variants (underscore/dot/hyphen) back to declared tool names', () => {
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
                  name: 'mailbox_status',
                  arguments: '{"target":"finger-system-agent"}'
                }
              },
              {
                id: 'call_2',
                type: 'function',
                function: {
                  name: 'reasoning_stop',
                  arguments: '{}'
                }
              },
              {
                id: 'call_3',
                type: 'function',
                function: {
                  name: 'context-ledger-memory',
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
          { type: 'function', function: { name: 'mailbox.status', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'reasoning.stop', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'context_ledger.memory', parameters: { type: 'object' } } }
        ]
      }
    };

    const result = buildClientPayloadForProtocol({
      payload: payload as any,
      clientProtocol: 'openai-chat',
      requestId: 'req-test-remap-separator-variants',
      requestSemantics: requestSemantics as any
    });

    const toolCalls = (result as any).choices[0].message.tool_calls;
    expect(toolCalls[0].function.name).toBe('mailbox.status');
    expect(toolCalls[1].function.name).toBe('reasoning.stop');
    expect(toolCalls[2].function.name).toBe('context_ledger.memory');
  });

  it('remaps responses function_call names with separator variants', () => {
    const payload = {
      id: 'resp_1',
      object: 'response',
      status: 'requires_action',
      output: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'mailbox_status',
          arguments: '{"target":"finger-system-agent"}'
        }
      ],
      required_action: {
        type: 'submit_tool_outputs',
        submit_tool_outputs: {
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              name: 'mailbox_status',
              arguments: '{"target":"finger-system-agent"}'
            }
          ]
        }
      }
    };

    const requestSemantics = {
      tools: {
        clientToolsRaw: [
          { type: 'function', function: { name: 'mailbox.status', parameters: { type: 'object' } } }
        ]
      }
    };

    const result = buildClientPayloadForProtocol({
      payload: payload as any,
      clientProtocol: 'openai-responses',
      requestId: 'req-test-remap-responses-separator',
      requestSemantics: requestSemantics as any
    });

    expect((result as any).output[0].name).toBe('mailbox.status');
    expect((result as any).required_action.submit_tool_outputs.tool_calls[0].name).toBe('mailbox.status');
  });

  it('throws when responses tool names cannot be mapped into the current request tool list', () => {
    const payload = {
      id: 'resp_2',
      object: 'response',
      status: 'requires_action',
      output: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'agent.dispatch',
          arguments: '{}'
        }
      ],
      required_action: {
        type: 'submit_tool_outputs',
        submit_tool_outputs: {
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              name: 'agent.dispatch',
              arguments: '{}'
            }
          ]
        }
      }
    };

    const requestSemantics = {
      tools: {
        clientToolsRaw: [
          { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'update_plan', parameters: { type: 'object' } } }
        ]
      }
    };

    try {
      buildClientPayloadForProtocol({
        payload: payload as any,
        clientProtocol: 'openai-responses',
        requestId: 'req-test-remap-responses-hard-check',
        requestSemantics: requestSemantics as any
      });
      throw new Error('expected mismatch error');
    } catch (error: any) {
      expect(String(error?.message || '')).toContain('tool name mismatch');
      expect(error?.code).toBe('CLIENT_TOOL_NAME_MISMATCH');
      expect(error?.statusCode).toBe(502);
      expect(error?.retryable).toBe(true);
    }
  });

  it('does not duplicate responses function_call when reasoning text also contains xml tool markup', () => {
    const payload = {
      id: 'chatcmpl_xml_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: [
              'I must call echo with AUTO-XML.',
              '```xml',
              '<function=echo>',
              '<parameter=text>',
              'AUTO-XML',
              '</parameter>',
              '</function>',
              '```'
            ].join('\n'),
            tool_calls: [
              {
                id: 'call_xml_1',
                type: 'function',
                function: {
                  name: 'echo',
                  arguments: '{"text":"AUTO-XML"}'
                }
              }
            ]
          }
        }
      ]
    };

    const result = buildClientPayloadForProtocol({
      payload: payload as any,
      clientProtocol: 'openai-responses',
      requestId: 'req-test-responses-no-dup-xml'
    });

    const functionCalls = (result as any).output.filter((item: any) => item?.type === 'function_call');
    const requiredCalls = (result as any).required_action.submit_tool_outputs.tool_calls;
    expect(functionCalls).toHaveLength(1);
    expect(requiredCalls).toHaveLength(1);
    expect(functionCalls[0].name).toBe('echo');
    expect(functionCalls[0].arguments).toBe('{"text":"AUTO-XML"}');
    expect(requiredCalls[0].name).toBe('echo');
    expect(requiredCalls[0].arguments ?? requiredCalls[0].function?.arguments).toBe('{"text":"AUTO-XML"}');
  });

  it('does not duplicate responses function_call when reasoning text also contains json tool markup', () => {
    const payload = {
      id: 'chatcmpl_json_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: [
              'I must call echo with AUTO-JSON.',
              '```json',
              '{',
              '  "name": "echo",',
              '  "arguments": {',
              '    "text": "AUTO-JSON"',
              '  }',
              '}',
              '```'
            ].join('\n'),
            tool_calls: [
              {
                id: 'call_json_1',
                type: 'function',
                function: {
                  name: 'echo',
                  arguments: '{"text":"AUTO-JSON"}'
                }
              }
            ]
          }
        }
      ]
    };

    const result = buildClientPayloadForProtocol({
      payload: payload as any,
      clientProtocol: 'openai-responses',
      requestId: 'req-test-responses-no-dup-json'
    });

    const functionCalls = (result as any).output.filter((item: any) => item?.type === 'function_call');
    const requiredCalls = (result as any).required_action.submit_tool_outputs.tool_calls;
    expect(functionCalls).toHaveLength(1);
    expect(requiredCalls).toHaveLength(1);
    expect(functionCalls[0].name).toBe('echo');
    expect(functionCalls[0].arguments).toBe('{"text":"AUTO-JSON"}');
    expect(requiredCalls[0].name).toBe('echo');
    expect(requiredCalls[0].arguments ?? requiredCalls[0].function?.arguments).toBe('{"text":"AUTO-JSON"}');
  });
});
