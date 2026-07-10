import { jest } from '@jest/globals';

const nativeBridgeActions = await import(
  '../sharedmodule/helpers/native-hub-bridge-action-direct-native.js'
);

jest.unstable_mockModule(
  '../sharedmodule/helpers/native-hub-bridge-action-direct-native.js',
  () => ({
    ...nativeBridgeActions,
    runBridgeActionPipelineWithNative: ({ state }: { state?: { messages?: unknown[] } }) => ({
      messages: Array.isArray(state?.messages) ? state.messages : []
    })
  })
);

const { buildResponsesRequestFromChat, buildChatRequestFromResponses, captureResponsesContext } = await import(
  '../sharedmodule/helpers/responses-openai-bridge-direct-native.js'
);

function findOpenAiChatToolOrderingViolation(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  const pending = new Set<string>();
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray((message as any).tool_calls) && (message as any).tool_calls.length > 0) {
      if (pending.size > 0) return 'assistant_tool_calls_before_previous_results';
      for (const toolCall of (message as any).tool_calls) {
        if (typeof toolCall?.id === 'string') pending.add(toolCall.id);
      }
      continue;
    }
    if (message?.role === 'tool') {
      const id = (message as any).tool_call_id;
      if (typeof id !== 'string' || !pending.has(id)) return 'orphan_tool_result';
      pending.delete(id);
      continue;
    }
    if (pending.size > 0) return 'non_tool_message_before_tool_results';
  }
  return pending.size > 0 ? 'dangling_tool_call' : null;
}

describe('buildResponsesRequestFromChat (responses bridge)', () => {
  it('omits previous_response_id when outbound target protocol is not openai-responses', () => {
    const payload = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: '继续执行' }
      ],
      semantics: {
        continuation: {
          resumeFrom: {
            previousResponseId: 'resp_prev_not_for_chat'
          }
        }
      }
    };

    const result = buildResponsesRequestFromChat(payload, {
      targetProtocol: 'openai-chat'
    } as any);

    expect((result.request as any).previous_response_id).toBeUndefined();
  });

  it('strips previous_response_id when runtime target protocol is chat even if route semantics contains responses continuation', () => {
    const payload = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '继续执行' }],
      semantics: {
        continuation: {
          resumeFrom: {
            previousResponseId: 'resp_prev_wrongly_carried'
          }
        }
      }
    };

    const result = buildResponsesRequestFromChat(payload, {
      targetProtocol: 'openai-chat'
    } as any);

    expect((result.request as any).previous_response_id).toBeUndefined();
  });

  it('preserves apply_patch arguments when converting tool_calls to Responses input', () => {
    const patchText = [
      '*** Begin Patch',
      '*** Update File: demo.txt',
      '@@',
      '- foo',
      '+ bar',
      '*** End Patch'
    ].join('\n');

    const payload = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: '请修改文件' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_apply_patch',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: JSON.stringify({ patch: patchText })
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_apply_patch',
          name: 'apply_patch',
          content: 'patch applied'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            parameters: { type: 'object', properties: {} }
          }
        }
      ]
    };

    const result = buildResponsesRequestFromChat(payload, {});
    const inputEntries = Array.isArray((result.request as any).input) ? (result.request as any).input : [];
    const fnCall = inputEntries.find(
      (entry: any) => entry?.type === 'function_call' && entry?.name === 'apply_patch'
    );
    expect(fnCall).toBeTruthy();
    const parsedArgs = JSON.parse(fnCall.arguments);
    expect(parsedArgs.patch).toBe(patchText);
    expect(parsedArgs.input).toBeUndefined();
  });

  it('does not fail-close when apply_patch arguments are missing patch/input', () => {
    const payload = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_apply_patch_empty',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: '{}'
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_apply_patch_empty',
          name: 'apply_patch',
          content: 'empty patch result'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            parameters: { type: 'object', properties: {} }
          }
        }
      ]
    };

    expect(() => buildResponsesRequestFromChat(payload, {})).not.toThrow();
    const result = buildResponsesRequestFromChat(payload, {});
    const inputEntries = Array.isArray((result.request as any).input) ? (result.request as any).input : [];
    const fnCall = inputEntries.find(
      (entry: any) => entry?.type === 'function_call' && entry?.name === 'apply_patch'
    );
    expect(fnCall).toBeTruthy();
    expect(fnCall.arguments).toBe('{}');
  });

  it('fails fast when incoming history contains synthetic RouteCodex fallback tool ids', () => {
    const payload = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_servertool_fallback_1777378574502_510',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'echo hi' })
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_servertool_fallback_1777378574502_510',
          name: 'exec_command',
          content: 'ok'
        }
      ]
    };

    expect(() => buildResponsesRequestFromChat(payload, {})).toThrow(
      /synthetic.*fallback tool_call id/i
    );
  });

  it('fails fast when incoming history contains synthetic RouteCodex local control text', () => {
    const payload = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '[RouteCodex] assistant response became empty after response sanitization.' }
      ]
    };

    expect(() => buildResponsesRequestFromChat(payload, {})).toThrow(
      /synthetic RouteCodex local control text/i
    );
  });
});

describe('buildChatRequestFromResponses (responses bridge)', () => {
  it('injects stopless schema contract from responses instructions into chat system message', () => {
    const stoplessInstruction = [
      '当你准备结束当前轮时，必须同时给出两部分：',
      '1. 简洁 summary，说明这轮完成了什么或为什么现在需要停止。',
      '2. 回复末尾附一段 JSON，字段必须按真实情况填写。',
      'stopreason 取值：0=finished，1=blocked，2=continue_needed。'
    ].join('\n');
    const payload = {
      model: 'gpt-test',
      instructions: stoplessInstruction,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续执行' }]
        }
      ]
    };

    const ctx = captureResponsesContext(payload as any, { route: { requestId: 'req_stopless_instruction_bridge' } } as any);
    const result = buildChatRequestFromResponses(payload as any, ctx);
    const messages = result.request.messages;

    expect(Array.isArray(messages)).toBe(true);
    expect(messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('stopreason 取值：0=finished，1=blocked，2=continue_needed')
    });
    expect(messages[1]).toMatchObject({
      role: 'user'
    });
  });

  it('restores tools from canonical responses resume contract when caller tools are empty', () => {
    const payload = {
      model: 'gpt-test',
      previous_response_id: 'resp_restore_tools_1',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续执行下一步' }]
        }
      ],
      tools: [],
      semantics: {
        responses: {
          resume: {
            restoredFromResponseId: 'resp_restore_tools_1',
            restored: true,
            fullInput: [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: '继续执行下一步' }]
              }
            ],
            restoredTools: [
              {
                type: 'function',
                name: 'exec_command',
                parameters: { type: 'object', properties: {} }
              }
            ]
          }
        }
      }
    };

    const ctx = captureResponsesContext(payload as any, { route: { requestId: 'req_restore_tools_bridge' } } as any);
    const result = buildChatRequestFromResponses(payload as any, ctx);

    expect(Array.isArray((result.request as any)?.tools)).toBe(true);
    expect(((result.request as any)?.tools as any)?.[0]).toMatchObject({
      type: 'function',
      function: expect.objectContaining({
        name: 'exec_command'
      })
    });
    expect(Array.isArray((result as any)?.toolsNormalized)).toBe(true);
    expect(((result as any)?.toolsNormalized as any)?.[0]).toMatchObject({
      type: 'function',
      function: expect.objectContaining({
        name: 'exec_command'
      })
    });
  });

  it('fails fast when previous_response_id history contains a dangling tool call before ordinary user content', () => {
    const payload = {
      model: 'gpt-test',
      previous_response_id: 'resp_prev_2013',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }]
        },
        {
          type: 'function_call',
          id: 'fc_missing_result_1',
          call_id: 'call_missing_result_1',
          name: 'exec_command',
          arguments: '{"cmd":"cat SKILL.md"}'
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '[Image omitted]' }]
        }
      ]
    };

    expect(() =>
      captureResponsesContext(payload as any, { route: { requestId: 'req_2013_guard' } } as any)
    ).toThrow(/dangling_tool_call/i);
  });

  it('RED: reopened apply_patch and exec_command history stays tool-ordered after prior assistant text', () => {
    const firstPatch = '*** Begin Patch\n*** Add File: apply_patch_test/01-add.txt\n+hello\n*** End Patch';
    const secondPatch = '*** Begin Patch\n*** Update File: apply_patch_test/01-add.txt\n@@\n-hello\n+hello world\n*** End Patch';
    const payload = {
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '先检查当前补丁状态。' }] },
        { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_patch_1', input: firstPatch },
        { type: 'custom_tool_call_output', call_id: 'call_patch_1', output: 'Exit code: 0\nOutput:\nSuccess. Updated the following files:\nA apply_patch_test/01-add.txt\n' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '继续核对并追加修改。' }] },
        { type: 'function_call', call_id: 'call_exec_1', name: 'exec_command', arguments: '{"cmd":"cat apply_patch_test/01-add.txt"}' },
        { type: 'function_call_output', call_id: 'call_exec_1', output: 'hello\n' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '准备第二次 apply_patch。' }] },
        { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_patch_2', input: secondPatch },
        { type: 'custom_tool_call_output', call_id: 'call_patch_2', output: 'Exit code: 0\nOutput:\nSuccess. Updated the following files:\nM apply_patch_test/01-add.txt\n' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成，继续下一步。' }] }
      ],
      tools: [
        { type: 'custom', name: 'apply_patch', description: 'Apply a patch.' },
        { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } }
      ]
    } as any;

    const ctx = captureResponsesContext(payload, { route: { requestId: 'req_reopened_apply_patch' } } as any);
    const result = buildChatRequestFromResponses(payload, ctx);
    const messages = result.request.messages;

    expect(findOpenAiChatToolOrderingViolation(messages)).toBeNull();
    expect(JSON.stringify(messages)).toContain('call_patch_1');
    expect(JSON.stringify(messages)).toContain('call_exec_1');
    expect(JSON.stringify(messages)).toContain('call_patch_2');
    expect(JSON.stringify(messages)).toContain('hello world');
  });
});
