import { describe, it, expect } from '@jest/globals';

const { applyRequestCompat } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.js'
);

describe('chat:iflow compat (tool text fallback)', () => {
  it('removes tools/tool_choice for glm-4.7 and injects tool markup instruction into system message', () => {
    const payload = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'run ls' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            description: 'Runs a shell command',
            parameters: { type: 'object', properties: { command: { type: 'string' } } }
          }
        }
      ],
      tool_choice: 'auto',
      stream: false
    };

    const out = applyRequestCompat('chat:iflow', payload as any, {
      adapterContext: { requestId: 't', entryEndpoint: '/v1/chat/completions', providerProtocol: 'openai-chat' } as any
    }).payload as any;

    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
    expect(Array.isArray(out.messages)).toBe(true);
    expect(out.messages[0].role).toBe('system');
    expect(String(out.messages[0].content || '')).toContain('Tool Calls (Text Markup Mode)');
    expect(String(out.messages[0].content || '')).toContain('<tool:exec_command>');
  });

  it('rewrites tool_calls/tool-role followups into plain text for glm-4.7 (even when tools/tool_choice are absent)', () => {
    const payload = {
      model: 'glm-4.7',
      messages: [
        { role: 'user', content: 'run ls' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc_1',
              type: 'function',
              function: { name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls -la', timeout_ms: 12345 }) }
            }
          ]
        },
        { role: 'tool', name: 'exec_command', tool_call_id: 'tc_1', content: 'ok' }
      ],
      stream: false
    };

    const out = applyRequestCompat('chat:iflow', payload as any, {
      adapterContext: { requestId: 't2', entryEndpoint: '/v1/chat/completions', providerProtocol: 'openai-chat' } as any
    }).payload as any;

    expect(Array.isArray(out.messages)).toBe(true);
    expect(out.messages[0].role).toBe('system');

    const assistant = out.messages.find((m: any) => m && m.role === 'assistant');
    expect(assistant).toBeTruthy();
    expect(assistant.tool_calls).toBeUndefined();
    expect(String(assistant.content || '')).toContain('<tool:exec_command>');
    expect(String(assistant.content || '')).toContain('<command>ls -la</command>');
    expect(String(assistant.content || '')).toContain('<timeout_ms>12345</timeout_ms>');

    const toolAsUser = out.messages.find((m: any) => m && m.role === 'user' && String(m.content || '').includes('Tool result:'));
    expect(toolAsUser).toBeTruthy();
    expect(toolAsUser.name).toBeUndefined();
    expect(toolAsUser.tool_call_id).toBeUndefined();
    expect(String(toolAsUser.content || '')).toContain('name: exec_command');
    expect(String(toolAsUser.content || '')).toContain('output:');
  });
});
