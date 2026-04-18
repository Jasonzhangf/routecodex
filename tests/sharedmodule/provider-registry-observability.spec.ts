import { describe, expect, it, jest } from '@jest/globals';

import { ProviderRegistry } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/provider-registry.js';

describe('provider registry non-blocking observability', () => {
  it('logs alias resolution miss cause', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new ProviderRegistry({
      'provider-a.alpha.model-x': {
        providerKey: 'provider-a.alpha.model-x',
        providerType: 'openai',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'x' },
        outboundProfile: 'openai-chat',
        modelId: 'model-x'
      } as any
    });

    expect(registry.resolveRuntimeKeyByAlias('provider-a', 'missing')).toBeNull();
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('stage=runtime_key_alias');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('operation=resolve_runtime_key_by_alias');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('"cause":"alias_not_found"');

    warnSpy.mockRestore();
  });

  it('logs model resolution miss cause', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new ProviderRegistry({
      'provider-a.alpha.model-x': {
        providerKey: 'provider-a.alpha.model-x',
        providerType: 'openai',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'x' },
        outboundProfile: 'openai-chat',
        modelId: 'model-x'
      } as any
    });

    expect(registry.resolveRuntimeKeyByModel('provider-a', 'model-y')).toBeNull();
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('stage=runtime_key_model');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('operation=resolve_runtime_key_by_model');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('"cause":"model_not_found"');

    warnSpy.mockRestore();
  });
});
