import { describe, expect, test } from '@jest/globals';

import { ProviderRegistry } from '../../src/router/virtual-router/provider-registry.js';

describe('virtual-router responses default capabilities', () => {
  test('responses provider keeps multimodal default when model explicitly declares only web_search', () => {
    const registry = new ProviderRegistry({
      'sdfv.key1.gpt-5.4': {
        providerKey: 'sdfv.key1.gpt-5.4',
        providerType: 'responses',
        endpoint: 'https://example.com/v1',
        auth: { type: 'apiKey', value: 'x' },
        outboundProfile: 'openai-responses',
        compatibilityProfile: 'compat:passthrough',
        modelId: 'gpt-5.4',
        modelCapabilities: {
          'gpt-5.4': ['web_search']
        }
      } as any
    });

    expect(registry.hasCapability('sdfv.key1.gpt-5.4', 'web_search')).toBe(true);
    expect(registry.hasCapability('sdfv.key1.gpt-5.4', 'multimodal')).toBe(true);
  });

  test('crs compatibility keeps web_search and multimodal defaults even without explicit multimodal', () => {
    const registry = new ProviderRegistry({
      'dibittai.crsa.gpt-5.4': {
        providerKey: 'dibittai.crsa.gpt-5.4',
        providerType: 'openai',
        endpoint: 'https://example.com/v1',
        auth: { type: 'apiKey', value: 'x' },
        outboundProfile: 'openai-chat',
        compatibilityProfile: 'responses:crs',
        modelId: 'gpt-5.4',
        modelCapabilities: {
          'gpt-5.4': ['web_search']
        }
      } as any
    });

    expect(registry.hasCapability('dibittai.crsa.gpt-5.4', 'web_search')).toBe(true);
    expect(registry.hasCapability('dibittai.crsa.gpt-5.4', 'multimodal')).toBe(true);
  });
});
