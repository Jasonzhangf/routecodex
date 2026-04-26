import { describe, expect, test } from '@jest/globals';

import {
  buildProviderRequestHeaders,
  finalizeProviderRequestHeaders
} from '../../../../src/providers/core/runtime/provider-request-header-orchestrator.js';
import { qwenFamilyProfile } from '../../../../src/providers/profile/families/qwen-profile.js';

describe('provider-request-header-orchestrator (qwen)', () => {
  test('emits qwen-aligned timeout and fingerprint headers', async () => {
    const baseHeaders = await buildProviderRequestHeaders({
      config: {
        providerType: 'openai',
        providerId: 'qwen',
        auth: { type: 'qwen-oauth', apiKey: 'test-key-1234567890' },
        overrides: {}
      } as any,
      authProvider: {
        buildHeaders: () => ({ Authorization: 'Bearer test-access-token' })
      } as any,
      oauthProviderId: 'qwen',
      serviceProfile: {
        headers: {
          'Accept': 'application/json'
        },
        timeout: 120000,
        maxRetries: 3
      } as any,
      runtimeMetadata: {
        providerId: 'qwen',
        providerType: 'openai',
        providerFamily: 'qwen'
      },
      runtimeHeaders: {},
      familyProfile: qwenFamilyProfile,
      isGeminiFamily: false,
      isAntigravity: false,
      providerType: 'openai'
    });

    const headers = await finalizeProviderRequestHeaders({
      headers: baseHeaders,
      request: {
        model: 'coder-model',
        messages: [{ role: 'user', content: 'Reply with exactly OK.' }]
      } as any,
      finalizeHeaders: (h) => h,
      runtimeMetadata: {
        providerId: 'qwen',
        providerType: 'openai',
        providerFamily: 'qwen'
      },
      familyProfile: qwenFamilyProfile,
      providerType: 'openai',
    });

    expect(headers['Authorization']).toBe('Bearer test-access-token');
    expect(headers['Accept']).toBe('application/json');
    expect(headers['X-Stainless-Timeout']).toBe('120');
    expect(headers['User-Agent']).toBe('QwenCode/0.14.3 (darwin; arm64)');
    expect(headers['X-DashScope-UserAgent']).toBe('QwenCode/0.14.3 (darwin; arm64)');
    expect(headers['X-DashScope-CacheControl']).toBe('enable');
    expect(headers['X-DashScope-AuthType']).toBe('qwen-oauth');
  });
});
