import { describe, expect, it } from '@jest/globals';

import { buildClientPayloadForProtocol } from '../client-remap-protocol-switch.js';
import { buildOpenAIChatFromAnthropicMessage } from '../../../../../response/response-runtime-anthropic.js';

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
          { type: 'function', function: { name: 'continue_execution', parameters: { type: 'object' } } },
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
    expect(toolCalls[1].function.name).toBe('continue_execution');
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

  it('remaps flattened namespace child tools back to responses namespace shape', () => {
    const payload = {
      id: 'resp_ns_1',
      object: 'response',
      status: 'requires_action',
      output: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'mcp__computer_use__get_app_state',
          arguments: '{"app":"Chrome"}'
        }
      ],
      required_action: {
        type: 'submit_tool_outputs',
        submit_tool_outputs: {
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              name: 'mcp__computer_use__get_app_state',
              arguments: '{"app":"Chrome"}'
            }
          ]
        }
      }
    };

    const requestSemantics = {
      tools: {
        clientToolsRaw: [
          {
            type: 'namespace',
            name: 'mcp__computer_use__',
            tools: [
              {
                type: 'function',
                name: 'get_app_state',
                parameters: {
                  type: 'object',
                  properties: {
                    app: { type: 'string' }
                  }
                }
              }
            ]
          }
        ]
      }
    };

    const result = buildClientPayloadForProtocol({
      payload: payload as any,
      clientProtocol: 'openai-responses',
      requestId: 'req-test-remap-responses-namespace',
      requestSemantics: requestSemantics as any
    });

    expect((result as any).output[0].name).toBe('get_app_state');
    expect((result as any).output[0].namespace).toBe('mcp__computer_use__');
    expect((result as any).required_action.submit_tool_outputs.tool_calls[0].name).toBe('get_app_state');
    expect((result as any).required_action.submit_tool_outputs.tool_calls[0].namespace).toBe('mcp__computer_use__');
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

  it('maps wrapped anthropic data.tool_use payloads into responses requires_action', () => {
    const anthropicPayload = {
      data: {
        id: 'msg_wrapped_1',
        role: 'assistant',
        model: 'mimo-v2.5-pro',
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: '继续执行工具' },
          {
            type: 'tool_use',
            id: 'call_dd97d989154849fea9380e44',
            name: 'exec_command',
            input: { cmd: 'pwd' }
          }
        ]
      }
    };

    const chatPayload = buildOpenAIChatFromAnthropicMessage(
      anthropicPayload as any,
      { includeToolCallIds: true }
    );
    const result = buildClientPayloadForProtocol({
      payload: chatPayload as any,
      clientProtocol: 'openai-responses',
      requestId: 'req-test-wrapped-anthropic-tool-use'
    });

    expect((result as any).status).toBe('requires_action');
    expect((result as any).required_action?.submit_tool_outputs?.tool_calls).toHaveLength(1);
    expect((result as any).required_action.submit_tool_outputs.tool_calls[0]).toMatchObject({
      id: 'call_dd97d989154849fea9380e44',
      name: 'exec_command'
    });
    expect((result as any).output.filter((item: any) => item?.type === 'function_call')).toHaveLength(1);
  });

  it('maps anthropic tool_use payloads into responses requires_action for mimoweb-style calls', () => {
    const anthropicPayload = {
      id: 'msg_mimoweb_1',
      role: 'assistant',
      model: 'mimo-v2.5-pro',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'text',
          text: [
            '<think>The user wants me to:',
            '1. First implement auto-upgrade integrated with WebDAV',
            '2. Then implement retry mechanism for mobile WebDAV sync',
            '</think>Jason，明白。让我先读取项目 skill，然后深入看相关代码。'
          ].join('\n')
        },
        {
          type: 'tool_use',
          id: 'toolu_mimo_read_1',
          name: 'read',
          input: {
            filePath: '/Users/fanzhang/Documents/github/novelmobile/.agents/skills/novelmobile-dev/SKILL.md'
          }
        },
        {
          type: 'tool_use',
          id: 'toolu_mimo_read_2',
          name: 'read',
          input: {
            filePath: '/Users/fanzhang/Documents/github/novelmobile/apps/mobile-app/src/services/appUpdateService.ts'
          }
        },
        {
          type: 'tool_use',
          id: 'toolu_mimo_read_3',
          name: 'read',
          input: {
            filePath: '/Users/fanzhang/Documents/github/novelmobile/apps/mobile-app/src/services/mobileWebdavSync.ts'
          }
        }
      ]
    };

    const chatPayload = buildOpenAIChatFromAnthropicMessage(
      anthropicPayload as any,
      { includeToolCallIds: true }
    );
    const result = buildClientPayloadForProtocol({
      payload: chatPayload as any,
      clientProtocol: 'openai-responses',
      requestId: 'req-test-mimoweb-tool-use'
    });

    expect((result as any).status).toBe('requires_action');
    expect((result as any).required_action?.submit_tool_outputs?.tool_calls).toHaveLength(3);
    expect((result as any).output.filter((item: any) => item?.type === 'function_call')).toHaveLength(3);
    expect((result as any).output[0]?.type).toBe('message');
    expect((result as any).output[0]?.content?.[0]?.text).toContain('Jason，明白');
  });

  it('normalizes responses required_action exec_command arguments by declared client schema', () => {
    const payload = {
      id: 'resp_exec_args_1',
      status: 'requires_action',
      required_action: {
        type: 'submit_tool_outputs',
        submit_tool_outputs: {
          tool_calls: [
            {
              id: 'call_exec_args_1',
              type: 'function_call',
              name: 'Bash',
              arguments: '{"command":"pwd","workdir":"/"}'
            }
          ]
        }
      },
      output: [
        {
          id: 'fc_exec_args_1',
          type: 'function_call',
          call_id: 'call_exec_args_1',
          name: 'Bash',
          arguments: '{"command":"pwd","workdir":"/"}'
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
                  cmd: { type: 'string' },
                  workdir: { type: 'string' }
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
      clientProtocol: 'openai-responses',
      requestId: 'req-test-responses-exec-args-normalize',
      requestSemantics: requestSemantics as any
    });

    const requiredCall = (result as any).required_action.submit_tool_outputs.tool_calls[0];
    const outputCall = (result as any).output[0];
    expect(requiredCall.name).toBe('exec_command');
    expect(requiredCall.arguments).toBe('{"cmd":"pwd","workdir":"/"}');
    expect(requiredCall.input).toEqual({ cmd: 'pwd', workdir: '/' });
    expect(requiredCall.function).toMatchObject({
      name: 'exec_command',
      arguments: '{"cmd":"pwd","workdir":"/"}'
    });
    expect(outputCall.name).toBe('exec_command');
    expect(outputCall.arguments).toBe('{"cmd":"pwd","workdir":"/"}');
  });

  it('drops duplicate exec_command command alias when declared client schema is cmd-only', () => {
    const payload = {
      id: 'resp_exec_args_dedupe_1',
      status: 'requires_action',
      required_action: {
        type: 'submit_tool_outputs',
        submit_tool_outputs: {
          tool_calls: [
            {
              id: 'call_exec_args_dedupe_1',
              type: 'function_call',
              name: 'exec_command',
              arguments: '{"cmd":"bash -lc \\"pwd\\"","command":"bash -lc \\"pwd\\""}'
            }
          ]
        }
      },
      output: [
        {
          id: 'fc_exec_args_dedupe_1',
          type: 'function_call',
          call_id: 'call_exec_args_dedupe_1',
          name: 'exec_command',
          arguments: '{"cmd":"bash -lc \\"pwd\\"","command":"bash -lc \\"pwd\\""}'
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

    const result = buildClientPayloadForProtocol({
      payload: payload as any,
      clientProtocol: 'openai-responses',
      requestId: 'req-test-responses-exec-args-dedupe',
      requestSemantics: requestSemantics as any
    });

    const requiredCall = (result as any).required_action.submit_tool_outputs.tool_calls[0];
    const outputCall = (result as any).output[0];
    expect(requiredCall.arguments).toBe('{"cmd":"bash -lc \\"pwd\\""}');
    expect(requiredCall.input).toEqual({ cmd: 'bash -lc "pwd"' });
    expect(requiredCall.function).toMatchObject({
      name: 'exec_command',
      arguments: '{"cmd":"bash -lc \\"pwd\\""}'
    });
    expect(outputCall.arguments).toBe('{"cmd":"bash -lc \\"pwd\\""}');
  });
});
