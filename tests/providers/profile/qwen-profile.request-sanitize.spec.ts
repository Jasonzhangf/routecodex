import { describe, expect, test } from '@jest/globals';
import { qwenFamilyProfile } from '../../../src/providers/profile/families/qwen-profile.js';

describe('qwen profile request sanitization', () => {
  test('preserves non-system history shape and only injects qwen system envelope', () => {
    const body = qwenFamilyProfile.buildRequestBody?.({
      request: {
        metadata: { authType: 'qwen-oauth' }
      } as any,
      runtimeMetadata: { authType: 'qwen-oauth' } as any,
      defaultBody: {
        model: 'qwen3.6-plus',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: [{ type: 'text', text: 'run java -version' }] },
          { role: 'assistant', content: [{ type: 'text', text: '' }] },
          { role: 'tool', content: [{ type: 'text', text: '' }] },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            tool_calls: [
              {
                id: 'call_exec_1',
                type: 'function',
                function: { name: 'exec_command', arguments: '{"cmd":"java -version"}' }
              }
            ]
          },
          {
            role: 'tool',
            content: [{ type: 'text', text: '17.0.16' }]
          }
        ]
      } as any
    } as any) as any;

    expect(body?.model).toBe('coder-model');
    expect(body?.vl_high_resolution_images).toBe(true);
    expect(Array.isArray(body?.messages)).toBe(true);
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toEqual([
      { type: 'text', text: '', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }
    ]);

    expect(body.messages).toHaveLength(6);
    expect(body.messages[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'run java -version' }] });
    expect(body.messages[2]).toEqual({ role: 'assistant', content: [{ type: 'text', text: '' }] });
    expect(body.messages[3]).toEqual({ role: 'tool', content: [{ type: 'text', text: '' }] });
    expect(body.messages[4]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      tool_calls: [
        {
          id: 'call_exec_1',
          type: 'function',
          function: { name: 'exec_command', arguments: '{"cmd":"java -version"}' }
        }
      ]
    });
    expect(body.messages[5]).toEqual({
      role: 'tool',
      content: [{ type: 'text', text: '17.0.16' }]
    });
  });

  test('keeps non-empty tool turn without tool_call_id', () => {
    const body = qwenFamilyProfile.buildRequestBody?.({
      request: {
        metadata: { authType: 'qwen-oauth' }
      } as any,
      runtimeMetadata: { authType: 'qwen-oauth' } as any,
      defaultBody: {
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'last command output?' },
          { role: 'tool', content: [{ type: 'text', text: 'JAVA_HOME=' }] }
        ]
      } as any
    } as any) as any;

    const roles = body.messages.map((m: any) => m.role);
    expect(roles).toEqual(['system', 'user', 'tool']);
    expect(body.messages[2]?.content?.[0]?.text).toBe('JAVA_HOME=');
    expect(body.messages[2]?.tool_call_id).toBeUndefined();
  });

  test('clamps oversized max_tokens for qwen oauth followups', () => {
    const body = qwenFamilyProfile.buildRequestBody?.({
      request: {
        metadata: { authType: 'qwen-oauth' }
      } as any,
      runtimeMetadata: { authType: 'qwen-oauth' } as any,
      defaultBody: {
        model: 'qwen3.6-plus',
        max_tokens: 128000,
        messages: [{ role: 'user', content: 'continue' }]
      } as any
    } as any) as any;

    expect(body?.model).toBe('coder-model');
    expect(body?.max_tokens).toBe(65536);
  });

  test('promotes chat inbound qwen tool requests to structured reasoning and auto tool_choice', () => {
    const body = qwenFamilyProfile.buildRequestBody?.({
      request: {
        metadata: { authType: 'qwen-oauth' }
      } as any,
      runtimeMetadata: {
        authType: 'qwen-oauth',
        providerProtocol: 'openai-chat',
        reasoning_effort: 'high'
      } as any,
      defaultBody: {
        model: 'qwen3.6-plus',
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
            }
          }
        ],
        messages: [{ role: 'user', content: 'run pwd' }]
      } as any
    } as any) as any;

    expect(body?.tool_choice).toBe('auto');
    expect(body?.reasoning).toEqual({ effort: 'high', summary: 'detailed' });
    expect(body?.reasoning_effort).toBe('high');
  });

  test('backfills missing effort/summary on structured qwen chat reasoning', () => {
    const body = qwenFamilyProfile.buildRequestBody?.({
      request: {
        metadata: { authType: 'qwen-oauth' }
      } as any,
      runtimeMetadata: {
        authType: 'qwen-oauth',
        providerProtocol: 'openai-chat',
        reasoning_effort: 'high'
      } as any,
      defaultBody: {
        model: 'qwen3.6-plus',
        reasoning: {},
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
            }
          }
        ],
        messages: [{ role: 'user', content: 'continue' }]
      } as any
    } as any) as any;

    expect(body?.reasoning).toEqual({ effort: 'high', summary: 'detailed' });
    expect(body?.reasoning_effort).toBe('high');
  });

  test('adds DashScope cache_control to system and streaming tail message/tool', () => {
    const body = qwenFamilyProfile.buildRequestBody?.({
      request: {
        metadata: { authType: 'qwen-oauth' }
      } as any,
      runtimeMetadata: {
        authType: 'qwen-oauth',
        providerProtocol: 'openai-chat'
      } as any,
      defaultBody: {
        model: 'qwen3.6-plus',
        stream: true,
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
            }
          }
        ],
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'tail' }
        ]
      } as any
    } as any) as any;

    expect(body?.messages?.[0]?.content).toEqual([
      { type: 'text', text: '', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Be concise.', cache_control: { type: 'ephemeral' } }
    ]);
    expect(body?.messages?.[2]?.content).toEqual([
      { type: 'text', text: 'tail', cache_control: { type: 'ephemeral' } }
    ]);
    expect(body?.tools?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(body?.vl_high_resolution_images).toBe(true);
  });
});
