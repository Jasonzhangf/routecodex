import { describe, expect, it } from '@jest/globals';

import { runVercelAiProviderDoctor } from '../../src/provider-sdk/vercel-ai-doctor.js';

describe('provider-vercel-ai-doctor', () => {
  it('resolves bearer auth from env-backed api keys and uses the injected probe', async () => {
    process.env.TEST_OPENAI_KEY = 'sk-test-123';
    let called: Record<string, unknown> | null = null;

    const result = await runVercelAiProviderDoctor(
      {
        providerId: 'openai',
        modelId: 'gpt-5.2',
        providerNode: {
          type: 'openai',
          baseURL: 'https://api.example.com/v1',
          headers: { 'X-Test': '1' },
          auth: { type: 'apikey', apiKey: '${TEST_OPENAI_KEY}' }
        }
      },
      {
        executeProbe: async (args) => {
          called = args as unknown as Record<string, unknown>;
          return { text: 'OK' };
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(result.text).toBe('OK');
    expect(called?.apiKey).toBe('sk-test-123');
    expect(called?.baseURL).toBe('https://api.example.com/v1');
    expect((called?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-123');
    expect((called?.headers as Record<string, string>)['X-Test']).toBe('1');
  });

  it('marks runtime-only providers as unsupported for direct SDK probing', async () => {
    const result = await runVercelAiProviderDoctor({
      providerId: 'iflow',
      modelId: 'qwen3-coder-plus',
      providerNode: {
        type: 'iflow',
        baseURL: 'https://apis.iflow.cn/v1',
        auth: { type: 'iflow-cookie', cookieFile: '~/.routecodex/auth/iflow-work.cookie' }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.binding.supported).toBe(false);
    expect(result.message).toContain('runtime');
  });
});
