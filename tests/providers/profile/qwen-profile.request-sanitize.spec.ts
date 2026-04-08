import { describe, expect, test } from '@jest/globals';
import { qwenFamilyProfile } from '../../../src/providers/profile/families/qwen-profile.js';

describe('qwen profile request sanitization', () => {
  test('drops empty assistant/tool turns and backfills tool_call_id when unambiguous', () => {
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
    expect(Array.isArray(body?.messages)).toBe(true);
    expect(body.messages[0]?.role).toBe('system');

    const roles = body.messages.map((m: any) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);

    const assistant = body.messages[2];
    expect(Array.isArray(assistant.tool_calls)).toBe(true);
    expect(assistant.tool_calls[0]?.id).toBe('call_exec_1');
    expect(assistant.tool_calls[0]?.call_id).toBeUndefined();
    expect(assistant.tool_calls[0]?.tool_call_id).toBeUndefined();

    const tool = body.messages[3];
    expect(tool.tool_call_id).toBe('call_exec_1');
    expect(tool.call_id).toBeUndefined();
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
});
