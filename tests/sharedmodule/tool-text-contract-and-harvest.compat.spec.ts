import { describe, expect, it } from '@jest/globals';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

import { applyRequestCompatDirectNative as applyRequestCompat } from './helpers/compat-engine-direct-native.js';

function adapterContextWithProviderProtocol(providerProtocol: string): Record<string, unknown> {
  const adapterContext: Record<string, unknown> = { providerProtocol };
  const center = MetadataCenter.attach(adapterContext);
  center.writeRuntimeControl('providerProtocol', providerProtocol, {
    module: 'tests/sharedmodule/tool-text-contract-and-harvest.compat.spec.ts',
    symbol: 'adapterContextWithProviderProtocol',
    stage: 'req_outbound_compat_test'
  });
  return adapterContext;
}

describe('tool text request compat contract', () => {
  it('does not inject removed provider request guidance for chat:glm', () => {
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
      adapterContext: adapterContextWithProviderProtocol('openai-chat') as any
    }).payload as any;

    expect(Array.isArray(out.messages)).toBe(true);
    expect(out.messages[0]?.role).toBe('user');
    expect(JSON.stringify(out.messages)).not.toContain('Tool-call output contract (STRICT)');
  });

  it('keeps structured system content unchanged for chat:glm', () => {
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
      adapterContext: adapterContextWithProviderProtocol('openai-chat') as any
    }).payload as any;

    expect(Array.isArray(out.messages?.[0]?.content)).toBe(true);
    expect(String(out.messages[0].content[0]?.text || '')).toContain('base system rule');
    expect(out.messages[0].content).toEqual(payload.messages[0].content);
  });

});
