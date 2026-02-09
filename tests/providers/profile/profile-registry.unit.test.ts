import { describe, expect, test } from '@jest/globals';
import { getProviderFamilyProfile, hasProviderFamilyProfile } from '../../../src/providers/profile/profile-registry.js';

describe('provider family profile registry', () => {
  test('resolves iflow profile from provider key prefix', () => {
    const profile = getProviderFamilyProfile({
      providerKey: 'iflow.3-138.kimi-k2.5'
    });

    expect(profile).toBeTruthy();
    expect(profile?.providerFamily).toBe('iflow');
    expect(hasProviderFamilyProfile({ providerKey: 'iflow.3-138.kimi-k2.5' })).toBe(true);
  });

  test('iflow profile resolves endpoint/body for web search requests', () => {
    const profile = getProviderFamilyProfile({ providerId: 'iflow' });
    expect(profile).toBeTruthy();

    const endpoint = profile?.resolveEndpoint?.({
      request: {
        metadata: {
          iflowWebSearch: true,
          entryEndpoint: '/chat/retrieve'
        }
      } as any,
      defaultEndpoint: '/chat/completions'
    });
    expect(endpoint).toBe('/chat/retrieve');

    const body = profile?.buildRequestBody?.({
      request: {
        metadata: { iflowWebSearch: true },
        data: { query: 'routecodex' }
      } as any,
      defaultBody: { model: 'kimi-k2.5', messages: [] } as any
    });
    expect(body).toEqual({ query: 'routecodex' });
  });

  test('iflow profile user-agent policy keeps config/service priority', () => {
    const profile = getProviderFamilyProfile({ providerId: 'iflow' });
    expect(profile).toBeTruthy();

    const fromService = profile?.resolveUserAgent?.({
      uaFromConfig: undefined,
      uaFromService: 'iFlow-Cli',
      inboundUserAgent: 'curl/8.7.1',
      defaultUserAgent: 'routecodex/default'
    });
    expect(fromService).toBe('iFlow-Cli');

    const fromFallback = profile?.resolveUserAgent?.({
      uaFromConfig: undefined,
      uaFromService: undefined,
      inboundUserAgent: undefined,
      defaultUserAgent: 'routecodex/default'
    });
    expect(fromFallback).toBe('routecodex/default');
  });
});
