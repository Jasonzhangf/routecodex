import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildChatRequestFromResponses,
  buildResponsesPayloadFromChat,
  buildResponsesRequestFromChat
} from '../../src/conversion/responses/responses-openai-bridge.js';

function createTempPng(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmswitch-local-image-jest-'));
  const file = path.join(dir, 'sample.png');
  const pngBytes = Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C6360000002000154A2B0C50000000049454E44AE426082',
    'hex'
  );
  fs.writeFileSync(file, pngBytes);
  return file;
}

describe('responses-openai-bridge history seed normalization', () => {
  test('filters empty system messages and preserves multimodal content order', () => {
    const chatPayload = {
      model: 'glm-4.7',
      messages: [
        { role: 'user', content: 'hello' }
      ]
    };

    const ctx = {
      requestId: 'bridge-seed-spec'
    } as any;

    const result = buildResponsesRequestFromChat(chatPayload, ctx, {
      bridgeHistory: {
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: ' alpha ' },
              { type: 'input_image', image_url: 'https://x/y.png', detail: 'high' },
              { type: 'input_text', text: ' beta ' }
            ]
          }
        ],
        combinedSystemInstruction: '  sys keep  ',
        latestUserInstruction: '  user keep  ',
        originalSystemMessages: ['  first  ', '   ', '', ' second ']
      }
    });

    expect(result.originalSystemMessages).toEqual(['first', 'second']);
    expect(result.request.instructions).toBe('sys keep');
    expect(result.request.input[0].content).toEqual([
      { type: 'input_text', text: ' alpha ' },
      { type: 'input_image', image_url: 'https://x/y.png', detail: 'high' },
      { type: 'input_text', text: ' beta ' }
    ]);
  });

  test('preserves builtin web_search and injects it for server-side web_search tools', () => {
    const chatPayloadWithBuiltin = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          type: 'function',
          function: { name: 'exec_command', parameters: { type: 'object', properties: {} } }
        }
      ]
    };

    const ctxWithBuiltin = {
      requestId: 'bridge-tools-builtin',
      toolsRaw: [{ type: 'web_search' }]
    } as any;

    const withBuiltin = buildResponsesRequestFromChat(chatPayloadWithBuiltin, ctxWithBuiltin);
    expect(withBuiltin.request.tools).toEqual([
      {
        type: 'function',
        name: 'exec_command',
        function: { name: 'exec_command', parameters: { type: 'object', properties: {} } },
        parameters: { type: 'object', properties: {} }
      },
      { type: 'web_search' }
    ]);

    const chatPayloadWithServerSideWebSearch = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'search this' }],
      tools: [
        {
          type: 'function',
          function: { name: 'web_search', parameters: { type: 'object', properties: {} } }
        },
        {
          type: 'function',
          function: { name: 'exec_command', parameters: { type: 'object', properties: {} } }
        }
      ]
    };

    const withoutBuiltin = buildResponsesRequestFromChat(chatPayloadWithServerSideWebSearch, {
      requestId: 'bridge-tools-inject'
    } as any);

    expect(withoutBuiltin.request.tools).toEqual([
      {
        type: 'function',
        name: 'exec_command',
        function: { name: 'exec_command', parameters: { type: 'object', properties: {} } },
        parameters: { type: 'object', properties: {} }
      },
      { type: 'web_search' }
    ]);
  });

  test('does not inject builtin web_search when chat tools never declared web_search', () => {
    const chatPayload = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'list files' }],
      tools: [
        {
          type: 'function',
          function: { name: 'exec_command', parameters: { type: 'object', properties: {} } }
        },
        {
          type: 'function',
          function: { name: 'write_stdin', parameters: { type: 'object', properties: {} } }
        }
      ]
    };

    const result = buildResponsesRequestFromChat(chatPayload, {
      requestId: 'bridge-tools-no-web-search'
    } as any);

    expect(result.request.tools).toEqual([
      {
        type: 'function',
        name: 'exec_command',
        function: { name: 'exec_command', parameters: { type: 'object', properties: {} } },
        parameters: { type: 'object', properties: {} }
      },
      {
        type: 'function',
        name: 'write_stdin',
        function: { name: 'write_stdin', parameters: { type: 'object', properties: {} } },
        parameters: { type: 'object', properties: {} }
      }
    ]);
  });

  test('combines reasoning instruction segments before system instruction and marks instructions as raw', () => {
    const chatPayload = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'hello' }]
    };

    const ctx = {
      requestId: 'bridge-reasoning-instructions',
      systemInstruction: ' ctx keep ',
      __rcc_reasoning_instructions_segments: ['  step one  ', 'step two']
    } as any;

    const result = buildResponsesRequestFromChat(chatPayload, ctx, {
      systemInstruction: 'extra ignored',
      bridgeHistory: {
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        combinedSystemInstruction: 'history ignored',
        originalSystemMessages: []
      } as any
    });

    expect(result.request.instructions).toBe('step one\nstep two\nctx keep');
    expect(result.request.instructions_is_raw).toBe(true);
  });

  test('flattens parameters into top-level responses fields without forwarding parameters object', () => {
    const chatPayload = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'hello' }],
      parameters: {
        max_tokens: 321,
        prompt_cache_key: 'chat-cache',
        stream: true,
        ignored_field: 'drop-me'
      }
    };

    const ctx = {
      requestId: 'bridge-parameters-flatten',
      parameters: {
        response_format: { type: 'json_schema', json_schema: { name: 'payload' } },
        max_tokens: 123,
        stream: false,
        include: ['reasoning.encrypted_content']
      }
    } as any;

    const result = buildResponsesRequestFromChat(chatPayload, ctx);

    expect(result.request.max_output_tokens).toBe(123);
    expect(result.request.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'payload' } });
    expect(result.request.include).toEqual(['reasoning.encrypted_content']);
    expect(result.request.stream).toBe(true);
    expect(result.request.prompt_cache_key).toBe('chat-cache');
    expect((result.request as any).parameters).toBeUndefined();
    expect((result.request as any).ignored_field).toBeUndefined();
  });

  test('prefers ctx over metadata and chat.parameters for envelope fields and defaults store to false', () => {
    const chatPayload = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      parameters: {
        stream: true,
        response_format: { type: 'chat-params' },
        parallel_tool_calls: false
      },
      metadata: {
        extraFields: {
          stream: true,
          include: ['meta-include'],
          tool_choice: 'auto',
          parallel_tool_calls: false,
          response_format: { type: 'meta-format' },
          service_tier: 'flex',
          truncation: 'disabled',
          metadata: { meta: true }
        }
      }
    };

    const ctx = {
      requestId: 'bridge-envelope-priority',
      stream: false,
      include: ['ctx-include'],
      toolChoice: 'required',
      parallelToolCalls: true,
      responseFormat: { type: 'ctx-format' },
      serviceTier: 'priority',
      truncation: 'auto',
      metadata: { ctx: true }
    } as any;

    const result = buildResponsesRequestFromChat(chatPayload, ctx);

    expect(result.request.stream).toBe(false);
    expect(result.request.include).toEqual(['ctx-include']);
    expect(result.request.store).toBe(false);
    expect(result.request.tool_choice).toBe('required');
    expect(result.request.parallel_tool_calls).toBe(true);
    expect(result.request.response_format).toEqual({ type: 'ctx-format' });
    expect(result.request.service_tier).toBe('priority');
    expect(result.request.truncation).toBe('auto');
    expect(result.request.metadata).toEqual({ ctx: true });
  });

  test('restores builtin web_search and preserves passthrough fields without TS fallback merging', () => {
    const chatPayload = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'search this' }],
      temperature: 0.4,
      top_p: 0.8,
      seed: 7,
      prompt_cache_key: 'cache-key',
      tools: [
        {
          type: 'function',
          function: { name: 'web_search', parameters: { type: 'object', properties: {} } }
        },
        {
          type: 'function',
          function: { name: 'exec_command', parameters: { type: 'object', properties: {} } }
        }
      ]
    };

    const result = buildResponsesRequestFromChat(chatPayload, {
      requestId: 'bridge-web-search-passthrough',
      toolsRaw: [{ type: 'web_search' }]
    } as any);

    expect(result.request.tools).toEqual([
      {
        type: 'function',
        name: 'exec_command',
        function: { name: 'exec_command', parameters: { type: 'object', properties: {} } },
        parameters: { type: 'object', properties: {} }
      },
      { type: 'web_search' }
    ]);
    expect(result.request.temperature).toBe(0.4);
    expect(result.request.top_p).toBe(0.8);
    expect(result.request.seed).toBe(7);
    expect(result.request.prompt_cache_key).toBe('cache-key');
  });

  test('uses route toolCallIdStyle over context and skips builtin web_search when forceWebSearch is enabled', () => {
    const chatPayload = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'search this' }],
      metadata: {
        toolCallIdStyle: 'fc'
      },
      tools: [
        {
          type: 'function',
          function: { name: 'web_search', parameters: { type: 'object', properties: {} } }
        },
        {
          type: 'function',
          function: { name: 'exec_command', parameters: { type: 'object', properties: {} } }
        }
      ]
    };

    const result = buildResponsesRequestFromChat(chatPayload, {
      requestId: 'bridge-force-web-search-style',
      toolCallIdStyle: 'preserve',
      metadata: {
        toolCallIdStyle: 'preserve',
        __rt: {
          forceWebSearch: true,
          webSearch: { force: true }
        }
      },
      input: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'assistant history' }]
        },
        {
          type: 'function_call',
          id: 'legacy-item',
          call_id: 'legacy-call',
          name: 'exec_command',
          arguments: '{}'
        },
        {
          type: 'function_call_output',
          id: 'legacy-output',
          call_id: 'legacy-call',
          output: '{"ok":true}'
        }
      ],
      originalSystemMessages: []
    } as any);

    expect(result.request.tools).toEqual([
      {
        type: 'function',
        name: 'web_search',
        function: { name: 'web_search', parameters: { type: 'object', properties: {} } },
        parameters: { type: 'object', properties: {} }
      },
      {
        type: 'function',
        name: 'exec_command',
        function: { name: 'exec_command', parameters: { type: 'object', properties: {} } },
        parameters: { type: 'object', properties: {} }
      }
    ]);
    expect(result.request.input[1]).toMatchObject({
      type: 'function_call',
      id: 'fc_legacy-item',
      call_id: 'call_legacy-call'
    });
    expect(result.request.input[2]).toMatchObject({
      type: 'function_call_output',
      id: 'fc_legacy-call',
      call_id: 'call_legacy-call'
    });
  });

  test('keeps roundtrip tool definition count stable when original responses tools already included builtin web_search', () => {
    const chatPayload = {
      model: 'glm-4.7',
      stream: false,
      messages: [
        { role: 'system', content: 'You are Codex, a local coding agent.' },
        { role: 'user', content: '列出 workspace 根目录文件' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_demo_exec',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: '{"cmd":"ls -la","workdir":"/Users/example/project"}'
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_demo_exec',
          content: 'total 8\n-rw-r--r--  focus.md\n-rw-r--r--  README.md'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            description: 'Runs a shell command inside the workspace.',
            parameters: {
              type: 'object',
              properties: {
                cmd: { type: 'string' },
                workdir: { type: 'string' }
              },
              required: ['cmd']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'write_stdin',
            description: 'Writes incremental input to an existing PTY session.',
            parameters: {
              type: 'object',
              properties: {
                chars: { type: 'string' },
                session_id: { type: 'number' }
              },
              required: ['session_id']
            }
          }
        }
      ]
    } as any;

    const responses = buildResponsesRequestFromChat(chatPayload, {
      requestId: 'chat-json-bridge',
      toolsRaw: [{ type: 'web_search' }]
    } as any);

    expect(responses.request.tools).toHaveLength(3);

    const roundtrip = buildChatRequestFromResponses(
      responses.request as Record<string, unknown>,
      {
        requestId: 'chat-json-bridge',
        input: responses.request.input,
        toolsRaw: responses.request.tools,
        toolsNormalized: chatPayload.tools
      } as any
    );

    expect(roundtrip.request.tools).toHaveLength(2);
    expect(roundtrip.request.tools).toEqual(chatPayload.tools);
  });

  test('shape-repairs malformed tool-session turns without dropping earlier context', () => {
    const chatPayload = {
      model: 'glm-4.7',
      stream: false,
      messages: [
        { role: 'system', content: 'You are Codex.' },
        { role: 'user', content: 'first question' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              function: { name: 'toolA', arguments: '{}' }
            },
            {
              id: 'call_b',
              type: 'function',
              function: { name: 'toolB', arguments: '{}' }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_b',
          content: 'ok-b'
        },
        { role: 'user', content: 'second question' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'toolA',
            parameters: { type: 'object', properties: {} }
          }
        },
        {
          type: 'function',
          function: {
            name: 'toolB',
            parameters: { type: 'object', properties: {} }
          }
        }
      ]
    } as any;

    const result = buildResponsesRequestFromChat(chatPayload, {
      requestId: 'bridge-shape-repair-malformed-tool-session'
    } as any);

    const input = Array.isArray(result.request.input) ? (result.request.input as Array<Record<string, unknown>>) : [];
    const functionCalls = input.filter((item) => item.type === 'function_call');
    const functionCallOutputs = input.filter((item) => item.type === 'function_call_output');
    const serializedInput = JSON.stringify(input);

    // No semantic clipping: both user turns must survive.
    expect(serializedInput).toContain('first question');
    expect(serializedInput).toContain('second question');

    // Shape repair: missing tool output for call_a should be synthesized, call_b should still exist.
    expect(functionCalls.some((item) => String(item.call_id ?? '').includes('call_a'))).toBe(true);
    expect(functionCalls.some((item) => String(item.call_id ?? '').includes('call_b'))).toBe(true);
    expect(functionCallOutputs.some((item) => String(item.call_id ?? '').includes('call_a'))).toBe(true);
    expect(functionCallOutputs.some((item) => String(item.call_id ?? '').includes('call_b'))).toBe(true);
    expect(serializedInput).toContain('[RouteCodex] Tool call result unknown');
    expect(serializedInput).toContain('ok-b');
  });

  test('drops intermediate chat messages when roundtripping responses back to responses payload', () => {
    const responsesPayload = {
      model: 'glm-4.7',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '读取 README.md 内容' }
          ]
        },
        {
          type: 'function_call',
          id: 'fc_readme',
          call_id: 'fc_readme',
          name: 'exec_command',
          arguments: '{"cmd":"cat README.md","workdir":"/Users/example/project"}'
        },
        {
          type: 'function_call_output',
          call_id: 'fc_readme',
          output: [{ type: 'output_text', text: '# Demo\nThis is a sample project.' }]
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'exec_command',
          function: {
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: {
                cmd: { type: 'string' },
                workdir: { type: 'string' }
              },
              required: ['cmd']
            }
          },
          parameters: {
            type: 'object',
            properties: {
              cmd: { type: 'string' },
              workdir: { type: 'string' }
            },
            required: ['cmd']
          }
        }
      ]
    } as any;

    const chat = buildChatRequestFromResponses(responsesPayload, {
      requestId: 'responses-json-bridge',
      input: responsesPayload.input,
      toolsRaw: responsesPayload.tools
    } as any);

    const roundtrip = buildResponsesRequestFromChat(chat.request as Record<string, unknown>, {
      requestId: 'responses-json-bridge',
      toolsRaw: responsesPayload.tools
    } as any);

    expect(roundtrip.request.messages).toBeUndefined();
  });

  test('autoloads local image paths through native bridge helper without disturbing content order', () => {
    const imagePath = createTempPng();
    const chatPayload = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: `"${imagePath}" 根据图片 review 架构` }]
    };

    const result = buildResponsesRequestFromChat(chatPayload, { requestId: 'bridge-local-image' } as any);
    expect(result.request.input[0].content).toEqual([
      { type: 'input_text', text: `"${imagePath}" 根据图片 review 架构` }
    ]);

    const roundtripRequest = buildChatRequestFromResponses(
      {
        model: 'glm-4.7',
        input: result.request.input
      },
      {
        requestId: 'bridge-local-image',
        input: result.request.input,
        originalSystemMessages: []
      } as any
    );

    expect(roundtripRequest.request.messages[0].content[0]).toEqual({
      type: 'text',
      text: `"${imagePath}" 根据图片 review 架构`
    });
    expect(roundtripRequest.request.messages[0].content[1].type).toBe('image_url');
    expect(roundtripRequest.request.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  test('filters executed tool outputs from required_action and keeps completed when no pending calls remain', () => {
    const partial = buildResponsesPayloadFromChat(
      {
        id: 'resp_partial',
        model: 'glm-4.7',
        tool_outputs: [{ tool_call_id: 'fc_call_1', output: 'done' }],
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'done',
              tool_calls: [
                {
                  id: 'fc_call_1',
                  type: 'function',
                  function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
                },
                {
                  id: 'fc_call_2',
                  type: 'function',
                  function: { name: 'exec_command', arguments: '{"cmd":"ls"}' }
                }
              ]
            }
          }
        ]
      },
      { requestId: 'resp_partial' } as any
    ) as Record<string, any>;

    expect(partial.status).toBe('requires_action');
    expect(partial.required_action?.submit_tool_outputs?.tool_calls).toHaveLength(1);
    expect(partial.required_action?.submit_tool_outputs?.tool_calls[0]?.id).toBe('fc_call_2');

    const functionItems = (partial.output as Array<Record<string, unknown>>).filter((item) => item.type === 'function_call');
    expect(functionItems).toHaveLength(2);
    expect(functionItems[0]?.status).toBe('completed');
    expect(functionItems[1]?.status).toBe('in_progress');

    const completed = buildResponsesPayloadFromChat(
      {
        id: 'resp_completed',
        model: 'glm-4.7',
        tool_outputs: [
          { tool_call_id: 'fc_call_1', output: 'done-1' },
          { tool_call_id: 'fc_call_2', output: 'done-2' }
        ],
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'all done',
              tool_calls: [
                {
                  id: 'fc_call_1',
                  type: 'function',
                  function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
                },
                {
                  id: 'fc_call_2',
                  type: 'function',
                  function: { name: 'exec_command', arguments: '{"cmd":"ls"}' }
                }
              ]
            }
          }
        ]
      },
      { requestId: 'resp_completed' } as any
    ) as Record<string, any>;

    expect(completed.status).toBe('completed');
    expect(completed.required_action).toBeUndefined();
    const completedItems = (completed.output as Array<Record<string, unknown>>).filter((item) => item.type === 'function_call');
    expect(completedItems.every((item) => item.status === 'completed')).toBe(true);
  });

  test('normalizes tool call arguments through native alias and schema constraints', () => {
    const normalized = buildResponsesPayloadFromChat(
      {
        id: 'resp_args_alias',
        model: 'glm-4.7',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'run command',
              tool_calls: [
                {
                  id: 'fc_call_alias',
                  type: 'function',
                  function: {
                    name: 'exec_command',
                    arguments: JSON.stringify({ command: 'pwd', extra: 'drop-me' })
                  }
                }
              ]
            }
          }
        ]
      },
      {
        requestId: 'resp_args_alias',
        toolsRaw: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: {
                type: 'object',
                required: ['cmd'],
                additionalProperties: false,
                properties: {
                  cmd: { type: 'string' }
                }
              }
            }
          }
        ]
      } as any
    ) as Record<string, any>;

    const submitCall = normalized.required_action?.submit_tool_outputs?.tool_calls?.[0];
    expect(submitCall).toBeDefined();
    const parsedArgs = JSON.parse(String(submitCall.arguments));
    expect(parsedArgs).toEqual({ cmd: 'pwd' });
    expect(submitCall.function?.arguments).toBe(JSON.stringify({ cmd: 'pwd' }));
  });

  test('preserves retained source fields and backfills missing output details via native payload builder', () => {
    const normalized = buildResponsesPayloadFromChat(
      {
        id: 'resp_merge',
        model: 'glm-4.7',
        choices: [
          {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'hello' }]
            }
          }
        ]
      },
      {
        requestId: 'req_merge',
        metadata: {
          toolCallIdStyle: 'fc',
          keep: true,
          extraFields: { __rcc_debug: 'drop' }
        },
        parallel_tool_calls: true,
        tool_choice: 'required',
        include: ['reasoning.encrypted_content'],
        store: true
      } as any
    ) as Record<string, any>;

    normalized.output[0].summary = [];
    delete normalized.output[0].encrypted_content;

    const retained = buildResponsesPayloadFromChat(
      {
        id: 'resp_merge',
        model: 'glm-4.7',
        choices: [
          {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'hello' }]
            }
          }
        ],
        __responses_payload_snapshot: {
          request_id: 'req_merge',
          metadata: { source: true },
          temperature: 0.4,
          top_p: 0.8,
          prompt_cache_key: 'cache-key',
          reasoning: { effort: 'high' },
          output: [
            {
              id: normalized.output[0].id,
              type: normalized.output[0].type,
              summary: [{ type: 'summary_text', text: 'filled summary' }],
              encrypted_content: 'encrypted'
            }
          ]
        }
      },
      {
        requestId: 'req_merge',
        metadata: {
          toolCallIdStyle: 'fc',
          keep: true,
          extraFields: { __rcc_debug: 'drop' }
        },
        parallel_tool_calls: true,
        tool_choice: 'required',
        include: ['reasoning.encrypted_content'],
        store: true
      } as any
    ) as Record<string, any>;

    expect(retained.request_id).toBe('req_merge');
    expect(retained.metadata).toEqual({ keep: true });
    expect(retained.reasoning).toEqual({ effort: 'high' });
    expect(retained.temperature).toBe(0.4);
    expect(retained.top_p).toBe(0.8);
    expect(retained.prompt_cache_key).toBe('cache-key');
    expect(retained.parallel_tool_calls).toBe(true);
    expect(retained.tool_choice).toBe('required');
    expect(retained.include).toEqual(['reasoning.encrypted_content']);
    expect(retained.store).toBe(true);
    expect(retained.output[0].summary).toEqual([{ type: 'summary_text', text: 'filled summary' }]);
    expect(retained.output[0].encrypted_content).toBe('encrypted');
  });
});
