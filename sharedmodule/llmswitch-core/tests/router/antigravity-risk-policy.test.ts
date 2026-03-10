import { describe, expect, test } from '@jest/globals';

import { ProviderHealthManager } from '../../src/router/virtual-router/health-manager.js';
import { ProviderRegistry } from '../../src/router/virtual-router/provider-registry.js';
import { applyAntigravityRiskPolicyImpl } from '../../src/router/virtual-router/engine-health.js';

function mkRegistry(): ProviderRegistry {
  const auth = { type: 'oauth' as const, tokenFile: '/tmp/fake.json' };
  return new ProviderRegistry({
    'antigravity.a.gemini-3-pro-high': {
      providerKey: 'antigravity.a.gemini-3-pro-high',
      providerType: 'gemini',
      endpoint: 'http://example.invalid',
      auth,
      outboundProfile: 'chat:gemini',
      runtimeKey: 'antigravity.a',
      modelId: 'gemini-3-pro-high'
    } as any,
    'antigravity.a.gemini-2.5-flash': {
      providerKey: 'antigravity.a.gemini-2.5-flash',
      providerType: 'gemini',
      endpoint: 'http://example.invalid',
      auth,
      outboundProfile: 'chat:gemini',
      runtimeKey: 'antigravity.a',
      modelId: 'gemini-2.5-flash'
    } as any,
    'antigravity.a.claude-sonnet-4-5-thinking': {
      providerKey: 'antigravity.a.claude-sonnet-4-5-thinking',
      providerType: 'gemini',
      endpoint: 'http://example.invalid',
      auth,
      outboundProfile: 'chat:gemini',
      runtimeKey: 'antigravity.a',
      modelId: 'claude-sonnet-4-5-thinking'
    } as any,
    'antigravity.b.gemini-3-pro-high': {
      providerKey: 'antigravity.b.gemini-3-pro-high',
      providerType: 'gemini',
      endpoint: 'http://example.invalid',
      auth,
      outboundProfile: 'chat:gemini',
      runtimeKey: 'antigravity.b',
      modelId: 'gemini-3-pro-high'
    } as any
  });
}

function mkHealth(keys: string[]): ProviderHealthManager {
  const mgr = new ProviderHealthManager();
  mgr.registerProviders(keys);
  return mgr;
}

describe('antigravity risk policy scoping', () => {
  test('scopes Google account verification required errors to the failing runtimeKey', () => {
    const registry = mkRegistry();
    const health = mkHealth(registry.listProviderKeys('antigravity'));
    const cooled: string[] = [];

    const event = {
      code: 'HTTP_403',
      status: 403,
      stage: 'provider.http.test_google_verify_scope',
      message:
        'HTTP 403: { "error": { "code": 403, "message": "To continue, verify your account at https://accounts.google.com/signin/continue?sarp=1" } }',
      timestamp: Date.now(),
      runtime: {
        requestId: 'req_test',
        providerId: 'antigravity',
        providerKey: 'antigravity.a.gemini-3-pro-high',
        target: { providerKey: 'antigravity.a.gemini-3-pro-high', runtimeKey: 'antigravity.a', modelId: 'gemini-3-pro-high' }
      }
    } as any;

    for (let i = 0; i < 3; i++) {
      applyAntigravityRiskPolicyImpl(event, registry as any, health as any, (providerKey) => cooled.push(providerKey));
    }

    expect(cooled.sort()).toEqual(['antigravity.a.gemini-3-pro-high', 'antigravity.a.gemini-2.5-flash', 'antigravity.a.claude-sonnet-4-5-thinking'].sort());
    expect(health.isAvailable('antigravity.a.gemini-3-pro-high')).toBe(false);
    expect(health.isAvailable('antigravity.a.gemini-2.5-flash')).toBe(false);
    expect(health.isAvailable('antigravity.a.claude-sonnet-4-5-thinking')).toBe(false);
    expect(health.isAvailable('antigravity.b.gemini-3-pro-high')).toBe(true);
  });

  test('keeps global risk cooldown for other 4xx policy failures', () => {
    const registry = mkRegistry();
    const health = mkHealth(registry.listProviderKeys('antigravity'));
    const cooled: string[] = [];

    const event = {
      code: 'HTTP_403',
      status: 403,
      stage: 'provider.http.test_global_scope',
      message: 'HTTP 403: { "error": { "code": 403, "message": "access denied" } }',
      timestamp: Date.now(),
      runtime: {
        requestId: 'req_test',
        providerId: 'antigravity',
        providerKey: 'antigravity.a.gemini-3-pro-high',
        target: { providerKey: 'antigravity.a.gemini-3-pro-high', runtimeKey: 'antigravity.a', modelId: 'gemini-3-pro-high' }
      }
    } as any;

    for (let i = 0; i < 3; i++) {
      applyAntigravityRiskPolicyImpl(event, registry as any, health as any, (providerKey) => cooled.push(providerKey));
    }

    expect(cooled.sort()).toEqual(
      ['antigravity.a.gemini-3-pro-high', 'antigravity.a.gemini-2.5-flash', 'antigravity.a.claude-sonnet-4-5-thinking', 'antigravity.b.gemini-3-pro-high'].sort()
    );
    expect(health.isAvailable('antigravity.a.gemini-3-pro-high')).toBe(false);
    expect(health.isAvailable('antigravity.a.gemini-2.5-flash')).toBe(false);
    expect(health.isAvailable('antigravity.a.claude-sonnet-4-5-thinking')).toBe(false);
    expect(health.isAvailable('antigravity.b.gemini-3-pro-high')).toBe(false);
  });

  test('freezes only gemini series immediately when thoughtSignature is missing', () => {
    const registry = mkRegistry();
    const health = mkHealth(registry.listProviderKeys('antigravity'));
    const cooled: string[] = [];

    const event = {
      code: 'HTTP_400',
      status: 400,
      stage: 'provider.http.test_signature_missing',
      message: 'HTTP 400: {"error":{"message":"Missing thoughtSignature for tool call"}}',
      timestamp: Date.now(),
      runtime: {
        requestId: 'req_test',
        providerId: 'antigravity',
        providerKey: 'antigravity.a.gemini-3-pro-high',
        target: { providerKey: 'antigravity.a.gemini-3-pro-high', runtimeKey: 'antigravity.a', modelId: 'gemini-3-pro-high' }
      }
    } as any;

    applyAntigravityRiskPolicyImpl(event, registry as any, health as any, (providerKey) => cooled.push(providerKey));

    // Should freeze only gemini-*, not claude-* for the same runtimeKey.
    expect(cooled.sort()).toEqual(['antigravity.a.gemini-3-pro-high', 'antigravity.a.gemini-2.5-flash'].sort());
    expect(health.isAvailable('antigravity.a.gemini-3-pro-high')).toBe(false);
    expect(health.isAvailable('antigravity.a.gemini-2.5-flash')).toBe(false);
    expect(health.isAvailable('antigravity.a.claude-sonnet-4-5-thinking')).toBe(true);
    expect(health.isAvailable('antigravity.b.gemini-3-pro-high')).toBe(true);
  });
});
