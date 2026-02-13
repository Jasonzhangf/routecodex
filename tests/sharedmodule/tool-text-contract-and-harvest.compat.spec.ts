import { describe, expect, it } from '@jest/globals';

const { applyRequestCompat, applyResponseCompat } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.js'
);

describe('tool text contract + harvest (action/config)', () => {
  it('injects request guidance for chat:glm when tools are present', () => {
    const payload = {
      model: 'glm-4.7',
      messages: [{ role: 'user', content: 'run bd status checks' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            description: 'Run shell command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } }
            }
          }
        }
      ],
      tool_choice: 'required'
    };

    const out = applyRequestCompat('chat:glm', payload as any, {
      adapterContext: { providerProtocol: 'openai-chat' } as any
    }).payload as any;

    expect(Array.isArray(out.messages)).toBe(true);
    expect(out.messages[0]?.role).toBe('system');
    expect(String(out.messages[0]?.content || '')).toContain('Tool-call output contract (STRICT)');
    expect(String(out.messages[0]?.content || '')).toContain('exec_command');
  });

  it('injects request guidance for chat:deepseek-web when tools are present', () => {
    const payload = {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'run bd status checks' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            description: 'Run shell command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } }
            }
          }
        }
      ],
      tool_choice: 'required'
    };

    const out = applyRequestCompat('chat:deepseek-web', payload as any, {
      adapterContext: { providerProtocol: 'openai-chat' } as any
    }).payload as any;

    expect(typeof out.prompt).toBe('string');
    const prompt = String(out.prompt || '');
    expect(prompt).toContain('Tool-call output contract (STRICT)');
    expect(prompt).toContain('exec_command');
    const markerHits = prompt.match(/Tool-call output contract \(STRICT\)/g) || [];
    expect(markerHits.length).toBe(1);
  });

  it('preserves structured system content shape when appending guidance', () => {
    const payload = {
      model: 'glm-4.7',
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: 'base system rule' }]
        },
        { role: 'user', content: 'run a tool' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            description: 'Run shell command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } }
            }
          }
        }
      ]
    };

    const out = applyRequestCompat('chat:glm', payload as any, {
      adapterContext: { providerProtocol: 'openai-chat' } as any
    }).payload as any;

    expect(Array.isArray(out.messages?.[0]?.content)).toBe(true);
    expect(String(out.messages[0].content[0]?.text || '')).toContain('base system rule');
    const serialized = JSON.stringify(out.messages[0].content);
    expect(serialized).toContain('Tool-call output contract (STRICT)');
  });

  it('harvests JSON text tool_calls for chat:glm response via compat action', () => {
    const payload = {
      id: 'chatcmpl_glm_harvest_1',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'glm-4.7',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '{"tool_calls":[{"name":"shell_command","input":{"command":"bd --no-db ready"}}]}'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out = applyResponseCompat('chat:glm', payload as any, {
      adapterContext: { providerProtocol: 'openai-chat' } as any
    }).payload as any;

    const call = out.choices?.[0]?.message?.tool_calls?.[0];
    expect(call?.function?.name).toBe('exec_command');
    const args = JSON.parse(String(call?.function?.arguments || '{}'));
    expect(args.cmd).toBe('bd --no-db ready');
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('applies same harvest shape repair for chat:deepseek-web response', () => {
    const payload = {
      id: 'chatcmpl_ds_harvest_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '{"tool_calls":[{"name":"shell_command","input":{"command":"bd --no-db ready"}}]}'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out = applyResponseCompat('chat:deepseek-web', payload as any, {
      adapterContext: {
        providerProtocol: 'openai-chat',
        capturedChatRequest: {
          tools: [{ type: 'function', function: { name: 'exec_command' } }],
          tool_choice: 'required'
        }
      } as any
    }).payload as any;

    const call = out.choices?.[0]?.message?.tool_calls?.[0];
    expect(call?.function?.name).toBe('exec_command');
    const args = JSON.parse(String(call?.function?.arguments || '{}'));
    expect(args.cmd).toBe('bd --no-db ready');
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
  });
});
