import { describe, it, expect } from '@jest/globals';

const { applyRequestCompat } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.js'
);

describe('chat:iflow compat (tool text fallback)', () => {
  it('applies text tool fallback for minimax-m2.5 (strip tools/tool_choice + inject instruction)', () => {
    const payload = {
      model: 'minimax-m2.5',
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
      adapterContext: { requestId: 'tm', entryEndpoint: '/v1/messages', providerProtocol: 'openai-chat' } as any
    }).payload as any;

    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
    expect(Array.isArray(out.messages)).toBe(true);
    expect(out.messages[0]?.role).toBe('system');
    expect(String(out.messages[0]?.content || '')).toContain('Tool Calls (Text Markup Mode)');
  });

  it('does not force text tool fallback for glm-4.7 (tools/tool_choice preserved)', () => {
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

    expect(Array.isArray(out.tools)).toBe(true);
    expect(out.tool_choice).toBeTruthy();
    expect(Array.isArray(out.messages)).toBe(true);
    expect(out.messages[0].role).toBe('user');
  });

  it('preserves tool_calls/tool-role followups for glm-4.7 (no rewrite)', () => {
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
    expect(out.messages[0].role).toBe('user');

    const assistant = out.messages.find((m: any) => m && m.role === 'assistant');
    expect(assistant).toBeTruthy();
    expect(Array.isArray(assistant.tool_calls)).toBe(true);
    expect(assistant.tool_calls[0]?.function?.name).toBe('exec_command');
    expect(String(assistant.tool_calls[0]?.function?.arguments || '')).toContain('ls -la');

    const toolMsg = out.messages.find((m: any) => m && m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg.name).toBe('exec_command');
    expect(toolMsg.tool_call_id).toBe('tc_1');
    expect(String(toolMsg.content || '')).toBe('ok');
  });

  it('keeps web_search route independent from model-gated fallback (no tool-text rewrite)', () => {
    const payload = {
      model: 'minimax-m2.5',
      messages: [{ role: 'user', content: 'search latest routecodex updates' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'clock',
            description: 'clock tool',
            parameters: { type: 'object', properties: { action: { type: 'string' } } }
          }
        }
      ],
      tool_choice: 'auto',
      web_search: { query: 'routecodex updates', recency: 'day', count: 5, engine: 'test' },
      stream: false
    };

    const out = applyRequestCompat('chat:iflow', payload as any, {
      adapterContext: { requestId: 't3', entryEndpoint: '/v1/messages', providerProtocol: 'openai-chat', routeId: 'web_search-primary' } as any
    }).payload as any;

    expect(Array.isArray(out.tools)).toBe(true);
    expect(out.tools).toHaveLength(1);
    expect(out.tools[0]?.function?.name).toBe('web_search');
    expect(out.web_search).toBeUndefined();
    expect(out.messages[0]?.role).toBe('user');
    expect(String(out.messages[0]?.content || '')).not.toContain('Tool Calls (Text Markup Mode)');
  });
});
