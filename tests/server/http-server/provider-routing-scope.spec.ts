import { resolveProviderRoutingScope } from '../../../src/server/runtime/http-server/provider-routing-scope.js';

describe('provider routing scope resolver', () => {
  it('treats missing scope as unrestricted', () => {
    const resolved = resolveProviderRoutingScope(undefined);
    expect(resolved.hasRoutingProviderScope).toBe(false);
    expect(resolved.routedProviderKeys.size).toBe(0);
    expect(resolved.isInRoutingScope('mock.a.model')).toBe(true);
  });

  it('applies strict inclusion when scope providerKeys is present', () => {
    const resolved = resolveProviderRoutingScope({
      providerKeys: ['mock.a.model', ' mock.b.model ']
    });
    expect(resolved.hasRoutingProviderScope).toBe(true);
    expect(Array.from(resolved.routedProviderKeys.values()).sort()).toEqual([
      'mock.a.model',
      'mock.b.model'
    ]);
    expect(resolved.isInRoutingScope('mock.a.model')).toBe(true);
    expect(resolved.isInRoutingScope('mock.c.model')).toBe(false);
  });
});

