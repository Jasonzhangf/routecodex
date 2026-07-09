import { ServiceProfileResolver } from '../../../../src/providers/core/runtime/service-profile-resolver.js';

describe('ServiceProfileResolver', () => {
  it('carries stream timeout overrides into the resolved profile', () => {
    const profile = ServiceProfileResolver.resolve({
      profileKey: 'test-sdk-timeouts',
      providerType: 'openai',
      cfg: {
        baseUrl: 'https://example.com/v1',
        endpoint: '/chat/completions',
        defaultModel: 'glm-5.2',
        overrides: {
          streamIdleTimeoutMs: 1234,
          streamHeadersTimeoutMs: 456
        }
      }
    });

    expect(profile.streamIdleTimeoutMs).toBe(1234);
    expect(profile.streamHeadersTimeoutMs).toBe(456);
  });
});
