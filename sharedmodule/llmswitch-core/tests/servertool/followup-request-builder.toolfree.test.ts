import { describe, expect, test } from '@jest/globals';

import { buildServerToolFollowupChatPayloadFromInjection } from '../../src/servertool/handlers/followup-request-builder.js';
import { buildServertoolGenericFollowupPayloadWithNative } from '../../src/router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';

describe('servertool followup request builder', () => {
  test('preserves tools but strips tool-selection hints from the captured seed', () => {
    const capturedChatRequest: any = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ],
      parameters: {
        stream: true,
        tool_choice: 'auto',
        parallel_tool_calls: true,
        temperature: 0.7
      }
    };

    const followup: any = buildServerToolFollowupChatPayloadFromInjection({
      adapterContext: { capturedChatRequest },
      chatResponse: { id: 'resp', choices: [] } as any,
      injection: { ops: [{ op: 'append_user_text', text: '继续执行' }] } as any
    });

    expect(followup).toBeTruthy();
    expect(followup.model).toBe('gpt-test');
    expect(Array.isArray(followup.messages)).toBe(true);
    expect(followup.messages.length).toBe(2);

    expect(Array.isArray(followup.tools)).toBe(true);
    expect(followup.tools).toHaveLength(1);
    expect(followup.parameters).toBeTruthy();
    expect(followup.parameters.stream).toBeUndefined();
    expect(followup.parameters.tool_choice).toBeUndefined();
    expect(followup.parameters.parallel_tool_calls).toBe(true);
    expect(followup.parameters.temperature).toBe(0.7);
  });

  test('inject_vision_summary replaces image parts with placeholder', () => {
    const capturedChatRequest: any = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'look' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
          ]
        }
      ],
      parameters: {}
    };

    const followup: any = buildServerToolFollowupChatPayloadFromInjection({
      adapterContext: { capturedChatRequest },
      chatResponse: { id: 'resp', choices: [] } as any,
      injection: { ops: [{ op: 'inject_vision_summary', summary: 'a cat' }] } as any
    });

    expect(followup).toBeTruthy();
    const msg = followup.messages?.[0];
    expect(msg?.role).toBe('user');
    expect(Array.isArray(msg?.content)).toBe(true);
    const types = (msg.content as any[]).map((p) => (typeof p?.type === 'string' ? String(p.type).toLowerCase() : ''));
    expect(types.some((t) => t.includes('image'))).toBe(false);
    const texts = (msg.content as any[]).map((p) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean);
    expect(texts).toEqual(expect.arrayContaining(['[Image omitted]', '[Vision] a cat']));
  });

  test('append_user_text followup scrubs historical image payloads before marker analysis', () => {
    const capturedChatRequest: any = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'look' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
          ]
        },
        { role: 'assistant', content: 'ok' }
      ],
      parameters: {}
    };

    const followup: any = buildServerToolFollowupChatPayloadFromInjection({
      adapterContext: { capturedChatRequest },
      chatResponse: { id: 'resp', choices: [] } as any,
      injection: { ops: [{ op: 'append_user_text', text: '继续' }] } as any
    });

    expect(followup).toBeTruthy();
    expect(Array.isArray(followup.messages)).toBe(true);
    expect(followup.messages).toHaveLength(3);

    const historicalUser = followup.messages[0];
    expect(historicalUser?.role).toBe('user');
    expect(Array.isArray(historicalUser?.content)).toBe(true);
    const historicalTypes = (historicalUser.content as any[]).map((p) =>
      typeof p?.type === 'string' ? String(p.type).toLowerCase() : ''
    );
    expect(historicalTypes.some((t) => t.includes('image'))).toBe(false);
    const historicalTexts = (historicalUser.content as any[])
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean);
    expect(historicalTexts).toContain('[Image omitted]');

    expect(followup.messages[2]).toEqual({ role: 'user', content: '继续' });
  });

  test('ensure_standard_tools does not synthesize fake tools when captured seed has none', () => {
    const capturedChatRequest: any = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'review this change' }]
    };

    const followup: any = buildServerToolFollowupChatPayloadFromInjection({
      adapterContext: { capturedChatRequest },
      chatResponse: { id: 'resp', choices: [] } as any,
      injection: { ops: [{ op: 'ensure_standard_tools' }] } as any
    });

    expect(followup).toBeTruthy();
    expect(Array.isArray(followup.tools)).toBe(true);
    expect(followup.tools).toHaveLength(0);
  });

  test('ensure_standard_tools only appends reasoning.stop onto existing real tools', () => {
    const capturedChatRequest: any = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '继续执行' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ]
    };

    const followup: any = buildServerToolFollowupChatPayloadFromInjection({
      adapterContext: { capturedChatRequest },
      chatResponse: { id: 'resp', choices: [] } as any,
      injection: { ops: [{ op: 'ensure_standard_tools' }, { op: 'append_user_text', text: '继续' }] } as any
    });

    expect(followup).toBeTruthy();
    expect(Array.isArray(followup.tools)).toBe(true);
    expect((followup.tools as any[]).map((tool) => tool?.function?.name)).toEqual(['exec_command']);
  });

  test('falls back to adapterContext.modelId when captured model is missing', () => {
    const capturedChatRequest: any = {
      messages: [{ role: 'user', content: '继续做' }]
    };

    const followup: any = buildServerToolFollowupChatPayloadFromInjection({
      adapterContext: {
        capturedChatRequest,
        modelId: 'qwen3.6-plus'
      },
      chatResponse: { id: 'resp', choices: [] } as any,
      injection: { ops: [{ op: 'append_user_text', text: '继续执行' }] } as any
    });

    expect(followup).toBeTruthy();
    expect(followup.model).toBe('qwen3.6-plus');
    expect(Array.isArray(followup.messages)).toBe(true);
    expect(followup.messages.length).toBe(2);
  });

  test('prefers assigned model over captured seed model for pinned followup flows', () => {
    const capturedChatRequest: any = {
      model: 'glm-5.1',
      messages: [{ role: 'user', content: '继续做' }]
    };

    const followup: any = buildServerToolFollowupChatPayloadFromInjection({
      adapterContext: {
        capturedChatRequest,
        assignedModelId: 'kimi-k2.5',
        modelId: 'kimi-k2.5',
        originalModelId: 'glm-5.1'
      },
      chatResponse: { id: 'resp', choices: [] } as any,
      injection: { ops: [{ op: 'append_user_text', text: '继续执行' }] } as any
    });

    expect(followup).toBeTruthy();
    expect(followup.model).toBe('kimi-k2.5');
    expect(Array.isArray(followup.messages)).toBe(true);
    expect(followup.messages.length).toBe(2);
  });

  test('native generic followup payload builder matches generic assistant/tool output append semantics', () => {
    const payload = buildServertoolGenericFollowupPayloadWithNative({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ],
      parameters: {
        temperature: 0.7,
        parallel_tool_calls: true
      },
      assistantMessage: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'clock',
              arguments: '{}'
            }
          }
        ]
      },
      toolOutputs: [
        {
          tool_call_id: 'call_1',
          name: 'clock',
          content: '{"ok":true}'
        }
      ],
      followupInjectionOps: [
        { op: 'append_assistant_message', required: true },
        { op: 'append_tool_messages_from_tool_outputs', required: true }
      ]
    });

    expect(payload.model).toBe('gpt-test');
    expect(Array.isArray(payload.messages)).toBe(true);
    expect(payload.messages).toHaveLength(3);
    expect((payload.messages as any[])[1]?.role).toBe('assistant');
    expect((payload.messages as any[])[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      name: 'clock',
      content: '{"ok":true}'
    });
    expect(Array.isArray(payload.tools)).toBe(true);
    expect(payload.tools).toHaveLength(1);
    expect(payload.parameters?.parallel_tool_calls).toBe(true);
  });

  test('native generic followup payload builder supports append_user_text, inject_system_text, and drop_tool_by_name', () => {
    const payload = buildServertoolGenericFollowupPayloadWithNative({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'base system' },
        { role: 'user', content: 'hi' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        },
        {
          type: 'function',
          function: {
            name: 'web_search',
            parameters: { type: 'object', properties: { query: { type: 'string' } } }
          }
        }
      ],
      followupInjectionOps: [
        { op: 'inject_system_text', text: 'extra system' },
        { op: 'append_user_text', text: '继续执行' },
        { op: 'drop_tool_by_name', name: 'web_search' }
      ]
    });

    expect(payload.model).toBe('gpt-test');
    expect(Array.isArray(payload.messages)).toBe(true);
    expect((payload.messages as any[])[0]).toEqual({ role: 'system', content: 'base system' });
    expect((payload.messages as any[])[1]).toEqual({ role: 'system', content: 'extra system' });
    expect((payload.messages as any[])[3]).toEqual({ role: 'user', content: '继续执行' });
    expect((payload.tools as any[]).map((tool) => tool?.function?.name)).toEqual(['exec_command']);
  });

  test('native generic followup payload builder supports inject_vision_summary and compact_tool_content', () => {
    const payload = buildServertoolGenericFollowupPayloadWithNative({
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'look' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
          ]
        },
        { role: 'assistant', content: 'ok' },
        {
          role: 'tool',
          content: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        }
      ],
      followupInjectionOps: [
        { op: 'compact_tool_content', maxChars: 80 },
        { op: 'inject_vision_summary', summary: 'a cat' }
      ]
    });

    expect(payload.model).toBe('gpt-test');
    expect(Array.isArray(payload.messages)).toBe(true);
    expect(payload.messages).toHaveLength(3);
    const first = (payload.messages as any[])[0];
    expect(first?.role).toBe('user');
    expect(Array.isArray(first?.content)).toBe(true);
    const texts = (first.content as any[])
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean);
    expect(texts).toEqual(expect.arrayContaining(['[Image omitted]', '[Vision] a cat']));
    const toolContent = (payload.messages as any[]).find((entry) => entry?.role === 'tool')?.content;
    expect(typeof toolContent).toBe('string');
    expect(String(toolContent)).toContain('[tool_output_compacted omitted=');
  });

  test('native generic followup payload builder supports trim_openai_messages', () => {
    const payload = buildServertoolGenericFollowupPayloadWithNative({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'policy' },
        { role: 'user', content: 'turn-1' },
        { role: 'assistant', content: 'turn-2' },
        { role: 'user', content: 'turn-3' },
        { role: 'assistant', content: 'turn-4' }
      ],
      followupInjectionOps: [
        { op: 'trim_openai_messages', maxNonSystemMessages: 2 }
      ]
    });

    expect(payload.model).toBe('gpt-test');
    expect(Array.isArray(payload.messages)).toBe(true);
    expect(payload.messages).toHaveLength(3);
    expect((payload.messages as any[])[0]).toEqual({ role: 'system', content: 'policy' });
    expect((payload.messages as any[])[1]).toEqual({ role: 'user', content: 'turn-3' });
    expect((payload.messages as any[])[2]).toEqual({ role: 'assistant', content: 'turn-4' });
  });

  test('native generic followup payload builder supports ensure_standard_tools, append_tool_if_missing, and force_tool_choice', () => {
    const payload = buildServertoolGenericFollowupPayloadWithNative({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'continue' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ],
      parameters: {
        parallel_tool_calls: true
      },
      followupInjectionOps: [
        {
          op: 'ensure_standard_tools',
          includeReasoningStopTool: true,
          reasoningStopToolDefinition: {
            type: 'function',
            function: {
              name: 'reasoning.stop',
              parameters: { type: 'object' }
            }
          }
        },
        {
          op: 'append_tool_if_missing',
          toolName: 'web_search',
          toolDefinition: {
            type: 'function',
            function: {
              name: 'web_search',
              parameters: { type: 'object' }
            }
          }
        },
        {
          op: 'force_tool_choice',
          value: {
            type: 'function',
            function: {
              name: 'reasoning.stop'
            }
          }
        }
      ]
    });

    expect((payload.tools as any[]).map((tool) => tool?.function?.name)).toEqual([
      'exec_command',
      'reasoning.stop',
      'web_search'
    ]);
    expect(payload.parameters?.tool_choice).toEqual({
      type: 'function',
      function: {
        name: 'reasoning.stop'
      }
    });
    expect(payload.parameters?.parallel_tool_calls).toBe(false);
  });

  test('native generic followup payload builder supports replace_tools', () => {
    const payload = buildServertoolGenericFollowupPayloadWithNative({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'continue' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ],
      followupInjectionOps: [
        {
          op: 'replace_tools',
          tools: [
            {
              type: 'function',
              function: {
                name: 'web_search',
                parameters: { type: 'object' }
              }
            }
          ]
        }
      ]
    });

    expect((payload.tools as any[]).map((tool) => tool?.function?.name)).toEqual(['web_search']);
  });
});
