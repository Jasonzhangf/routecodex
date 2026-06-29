import { describe, expect, it } from '@jest/globals';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const { applyRequestCompat } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/compat/compat-engine.js'
);

function adapterContextWithProviderProtocol(providerProtocol: string): Record<string, unknown> {
  const adapterContext: Record<string, unknown> = { providerProtocol };
  const center = MetadataCenter.attach(adapterContext);
  center.writeRuntimeControl('providerProtocol', providerProtocol, {
    module: 'tests/sharedmodule/responses-function-tool-normalization.compat.spec.ts',
    symbol: 'adapterContextWithProviderProtocol',
    stage: 'req_outbound_compat_test'
  });
  return adapterContext;
}

describe('Responses function tool normalization compat shell', () => {
  it('normalizes chat-style function tools without an explicit compatibility profile', () => {
    const payload = {
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
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

    const out = applyRequestCompat(undefined, payload as any, {
      adapterContext: adapterContextWithProviderProtocol('openai-responses') as any
    }).payload as any;

    expect(out.tools[0]).toMatchObject({
      type: 'function',
      name: 'exec_command',
      description: 'Run shell command',
      parameters: {
        type: 'object',
        properties: { cmd: { type: 'string' } }
      }
    });
    expect(out.tools[0].function).toBeUndefined();
  });
});
