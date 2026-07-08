import {
  buildAnthropicFromOpenAIChatDirectNative as buildAnthropicFromOpenAIChat,
  buildAnthropicFromOpenAIChatDirectNative as buildAnthropicRequestFromOpenAIChat,
  buildOpenAIChatFromAnthropicDirectNative as buildOpenAIChatFromAnthropic,
  convertAnthropicRequestDirectNative,
  convertAnthropicResponseDirectNative,
} from '../../../../../../tests/sharedmodule/helpers/anthropic-codec-direct-native.js';

function findAnthropicToolOrderingViolation(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  const pending = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as any;
    const content = Array.isArray(message?.content) ? message.content : [];
    if (message?.role === 'assistant') {
      const toolUseIds = content
        .filter((block: any) => block?.type === 'tool_use' && typeof block.id === 'string')
        .map((block: any) => String(block.id));
      if (toolUseIds.length > 0) {
        if (pending.size > 0) return `assistant_tool_use_before_previous_results_at_${index}`;
        for (const id of toolUseIds) pending.add(id);
      } else if (pending.size > 0) {
        return `assistant_text_before_tool_results_at_${index}`;
      }
      continue;
    }
    if (message?.role === 'user') {
      const resultIds = content
        .filter((block: any) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
        .map((block: any) => String(block.tool_use_id));
      const hasNonResultContent = content.some((block: any) => block?.type !== 'tool_result');
      if (pending.size > 0) {
        if (resultIds.length === 0) return `non_tool_result_user_content_before_tool_results_at_${index}`;
        for (const id of resultIds) {
          if (!pending.has(id)) return `orphan_tool_result_at_${index}`;
          pending.delete(id);
        }
        if (hasNonResultContent && pending.size > 0) {
          return `mixed_user_content_before_all_tool_results_at_${index}`;
        }
      }
      continue;
    }
    if (pending.size > 0) return `non_tool_message_before_tool_results_at_${index}`;
  }
  return pending.size > 0 ? 'dangling_tool_use_at_end' : null;
}

describe('anthropic-openai codec direct native owner', () => {
  test('writes anthropicToolNameMap and maps anthropic tools into OpenAI chat request', async () => {
    const context = { requestId: 'req_codec_alias', metadata: {} } as any;

    const result = convertAnthropicRequestDirectNative(
      {
        model: 'claude-3-7-sonnet',
        system: [{ type: 'text', text: 'You are helpful' }],
        tools: [
          {
            name: 'Bash',
            description: 'Run shell commands',
            input_schema: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd']
            }
          }
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'pwd' },
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'Bash',
                input: { cmd: 'pwd' }
              }
            ]
          }
        ]
      },
      context
    );

    expect((context.metadata as any).anthropicToolNameMap).toEqual({
      bash: 'Bash'
    });
    expect((result as any).messages[0]).toMatchObject({ role: 'system', content: 'You are helpful' });
    expect((result as any).tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run shell commands',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd']
          }
        }
      }
    ]);
    expect((result as any).messages[1].tool_calls[0]).toMatchObject({
      id: 'toolu_1',
      call_id: 'toolu_1',
      tool_call_id: 'toolu_1',
      type: 'function',
      function: {
        name: 'bash',
        arguments: '{"cmd":"pwd"}'
      }
    });
  });

  test('buildOpenAIChatFromAnthropic returns native request payload', () => {
    const result = buildOpenAIChatFromAnthropic(
      {
        model: 'claude-3-7-sonnet',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'I should inspect the cwd.' },
              { type: 'text', text: 'Running pwd.' },
              {
                type: 'tool_use',
                id: 'toolu_2',
                name: 'exec_command',
                input: { cmd: 'pwd' }
              }
            ]
          }
        ]
      } as any,
      { includeToolCallIds: true }
    );

    expect((result as any).model).toBe('claude-3-7-sonnet');
    expect((result as any).messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Running pwd.',
      reasoning_content: 'I should inspect the cwd.'
    });
    expect((result as any).messages[0].tool_calls[0]).toMatchObject({
      id: 'toolu_2',
      call_id: 'toolu_2',
      tool_call_id: 'toolu_2'
    });
  });

  test('buildOpenAIChatFromAnthropic normalizes Bash.command/workdir into exec_command.cmd/workdir', () => {
    const result = buildOpenAIChatFromAnthropic(
      {
        model: 'claude-3-7-sonnet',
        tools: [
          {
            name: 'Bash',
            description: 'Run shell commands',
            input_schema: {
              type: 'object',
              properties: { command: { type: 'string' }, workdir: { type: 'string' } },
              required: ['command']
            }
          }
        ],
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_cmd_1',
                name: 'Bash',
                input: { command: 'pwd', workdir: '/' }
              }
            ]
          }
        ]
      } as any,
      { includeToolCallIds: true }
    );

    expect((result as any).messages[0].tool_calls[0]).toMatchObject({
      id: 'toolu_cmd_1',
      type: 'function',
      function: {
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'pwd', workdir: '/' })
      }
    });
  });

  test('preserves blank lines when converting anthropic request into openai chat', () => {
    const result = buildOpenAIChatFromAnthropic(
      {
        model: 'claude-3-7-sonnet',
        system: [{ type: 'text', text: 'system line 1\n\nsystem line 2\n' }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'alpha\n\nbeta' },
              { type: 'text', text: '\n\ngamma' }
            ]
          }
        ]
      } as any
    );

    expect((result as any).messages[0]).toMatchObject({
      role: 'system',
      content: 'system line 1\n\nsystem line 2\n'
    });
    expect((result as any).messages[1]).toMatchObject({
      role: 'user',
      content: 'alpha\n\nbeta\n\ngamma'
    });
  });

  test('preserves blank lines when converting openai chat back to anthropic request', () => {
    const result = buildAnthropicRequestFromOpenAIChat(
      {
        model: 'claude-3-7-sonnet',
        messages: [
          { role: 'system', content: 'system line 1\n\nsystem line 2\n' },
          { role: 'user', content: 'alpha\n\nbeta\n\ngamma' }
        ]
      } as any
    );

    expect((result as any).system).toEqual([
      { type: 'text', text: 'system line 1\n\nsystem line 2\n' }
    ]);
    expect((result as any).messages).toEqual([
      {
        role: 'user',
        content: 'alpha\n\nbeta\n\ngamma'
      }
    ]);
  });

  test('maps OpenAI function tool_choice shape into Anthropic tool selector shape', () => {
    const result = buildAnthropicRequestFromOpenAIChat(
      {
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'run tool' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
            }
          }
        ],
        tool_choice: {
          type: 'function',
          function: { name: 'exec_command' }
        }
      } as any
    );

    expect((result as any).tool_choice).toEqual({ type: 'tool', name: 'exec_command' });
  });

  test('converts governed chat response back to anthropic using stored alias map', async () => {
    const result = convertAnthropicResponseDirectNative(
      {
        id: 'chatcmpl_1',
        model: 'gpt-4.1',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: 'Command ready',
              tool_calls: [
                {
                  id: 'call_exec',
                  type: 'function',
                  function: {
                    name: 'bash',
                    arguments: '{"cmd":"pwd"}'
                  }
                }
              ]
            }
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 6
        }
      },
      {
        requestId: 'req_codec_response',
        entryEndpoint: '/v1/messages',
        metadata: {
          anthropicToolNameMap: {
            bash: 'Bash'
          }
        }
      } as any
    );

    expect((result as any).type).toBe('message');
    expect((result as any).stop_reason).toBe('tool_use');
    expect((result as any).usage).toMatchObject({ input_tokens: 10, output_tokens: 6 });
    expect((result as any).content).toEqual([
      { type: 'text', text: 'Command ready' },
      {
        type: 'tool_use',
        id: 'call_exec',
        name: 'Bash',
        input: { cmd: 'pwd' }
      }
    ]);
  });

  test('buildAnthropicFromOpenAIChat roundtrips tool alias map directly', () => {
    const result = buildAnthropicFromOpenAIChat(
      {
        id: 'chatcmpl_direct',
        model: 'gpt-4.1',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: 'Run it',
              tool_calls: [
                {
                  id: 'call_direct',
                  type: 'function',
                  function: { name: 'bash', arguments: '{"cmd":"pwd"}' }
                }
              ]
            }
          }
        ]
      } as any,
      {
        toolNameMap: { bash: 'Bash' },
        requestId: 'req_direct'
      }
    );

    expect((result as any).id).toBe('chatcmpl_direct');
    expect((result as any).content[1]).toEqual({
      type: 'tool_use',
      id: 'call_direct',
      name: 'Bash',
      input: { cmd: 'pwd' }
    });
  });

  test('keeps embedded image as anthropic base64 source when chat content uses data URL', () => {
    const result = buildAnthropicRequestFromOpenAIChat(
      {
        model: 'claude-3-7-sonnet',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'look' },
              {
                type: 'input_image',
                image_url: {
                  url: 'data:image/png;base64,QUJDRA=='
                }
              }
            ]
          }
        ]
      } as any
    );

    expect((result as any).messages[0].content).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'QUJDRA=='
        }
      },
      { type: 'text', text: 'look' }
    ]);
  });

  test('fails fast on malformed embedded image data URL', () => {
    expect(() =>
      buildAnthropicRequestFromOpenAIChat(
        {
          model: 'claude-3-7-sonnet',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_image',
                  image_url: {
                    url: 'data:image/png;base64'
                  }
                }
              ]
            }
          ]
        } as any
      )
    ).toThrow('malformed data URL image payload');
  });

  test('RED: preserves reopened apply_patch and exec_command history when mapping OpenAI chat to Anthropic messages', () => {
    const firstPatch = '*** Begin Patch\n*** Add File: apply_patch_test/01-add.txt\n+hello\n*** End Patch';
    const secondPatch = '*** Begin Patch\n*** Update File: apply_patch_test/01-add.txt\n@@\n-hello\n+hello world\n*** End Patch';

    const result = buildAnthropicRequestFromOpenAIChat(
      {
        model: 'claude-3-7-sonnet',
        messages: [
          { role: 'assistant', content: '先检查当前补丁状态。' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_patch_1',
                type: 'function',
                function: { name: 'apply_patch', arguments: JSON.stringify({ input: firstPatch }) }
              }
            ]
          },
          {
            role: 'tool',
            tool_call_id: 'call_patch_1',
            name: 'apply_patch',
            content: 'Exit code: 0\nOutput:\nSuccess. Updated the following files:\nA apply_patch_test/01-add.txt\n'
          },
          { role: 'assistant', content: '继续核对并追加修改。' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_exec_1',
                type: 'function',
                function: { name: 'exec_command', arguments: '{"cmd":"cat apply_patch_test/01-add.txt"}' }
              }
            ]
          },
          {
            role: 'tool',
            tool_call_id: 'call_exec_1',
            name: 'exec_command',
            content: 'hello\n'
          },
          { role: 'assistant', content: '准备第二次 apply_patch。' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_patch_2',
                type: 'function',
                function: { name: 'apply_patch', arguments: JSON.stringify({ input: secondPatch }) }
              }
            ]
          },
          {
            role: 'tool',
            tool_call_id: 'call_patch_2',
            name: 'apply_patch',
            content: 'Exit code: 0\nOutput:\nSuccess. Updated the following files:\nM apply_patch_test/01-add.txt\n'
          },
          { role: 'assistant', content: '完成，继续下一步。' }
        ],
        tools: [
          { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object', properties: {} } } },
          { type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: {} } } }
        ]
      } as any
    );

    expect(findAnthropicToolOrderingViolation((result as any).messages)).toBeNull();
    const serialized = JSON.stringify((result as any).messages);
    expect(serialized).toContain('call_patch_1');
    expect(serialized).toContain('call_exec_1');
    expect(serialized).toContain('call_patch_2');
    expect(serialized).toContain('hello world');
  });
});
