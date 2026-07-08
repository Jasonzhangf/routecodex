import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-config.js';
import type { ProviderRuntimeProfile } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.js';

function bootstrapProvider(providerId: string, provider: Record<string, unknown>, modelId: string): ProviderRuntimeProfile {
  const result = bootstrapVirtualRouterConfig({
    virtualrouter: {
      providers: {
        [providerId]: provider
      },
      routing: {
        default: [`${providerId}.${modelId}`]
      }
    }
  });
  const runtime = Object.values(result.runtime)[0];
  if (!runtime) {
    throw new Error(`runtime entry missing for ${providerId}`);
  }
  return runtime;
}

describe('provider streaming capability normalization', () => {
  test('treats model supportsStreaming as capability auto instead of forcing always', () => {
    const normalized = bootstrapProvider('provider-auto-streaming-model', {
      id: 'provider-auto-streaming-model',
      type: 'openai',
      baseURL: 'https://example.test/openai',
      auth: { type: 'apikey', apiKey: 'test-key' },
      models: {
        'streaming-model': { supportsStreaming: true },
        'nonstreaming-model': { supportsStreaming: false }
      }
    }, 'streaming-model');

    expect(normalized.streaming).toBeUndefined();
    expect(normalized.modelStreaming?.['streaming-model']).toBe('auto');
    expect(normalized.modelStreaming?.['nonstreaming-model']).toBe('never');
  });

  test('treats provider-level supportsStreaming as capability auto instead of forcing always', () => {
    const normalized = bootstrapProvider('provider-auto-stream', {
      id: 'provider-auto-stream',
      type: 'openai',
      baseURL: 'https://example.test/openai',
      auth: { type: 'apikey', apiKey: 'test-key' },
      supportsStreaming: true,
      models: {
        'default-model': { maxTokens: 4096 }
      }
    }, 'default-model');

    expect(normalized.streaming).toBe('auto');
  });

  test('rejects provider process passthrough because Hub Pipeline is chat-only', () => {
    expect(() =>
      bootstrapProvider('bad-passthrough', {
        id: 'bad-passthrough',
        type: 'openai',
        process: 'passthrough',
        baseURL: 'https://example.test/openai',
        auth: { type: 'apikey', apiKey: 'test-key' },
        models: { 'default-model': {} }
      }, 'default-model')
    ).toThrow(/Hub Pipeline only supports process="chat"/i);
  });
});
