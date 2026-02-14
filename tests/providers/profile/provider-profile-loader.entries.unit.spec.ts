/**
 * Provider profile loader entries 解析单元测试
 */

import { buildProviderProfiles, extractApiKeyEntries } from '../../../src/providers/profile/provider-profile-loader.js';
import type { ApiKeyAuthConfig } from '../../../src/providers/profile/provider-profile.js';

describe('extractApiKeyEntries', () => {
  it('应该提取 entries 数组', () => {
    const config: ApiKeyAuthConfig = {
      kind: 'apikey',
      entries: [
        { alias: 'key1', apiKey: 'sk-1' },
        { alias: 'key2', apiKey: 'sk-2' }
      ]
    };

    const entries = extractApiKeyEntries(config);
    expect(entries).toHaveLength(2);
    expect(entries[0].alias).toBe('key1');
    expect(entries[1].alias).toBe('key2');
  });

  it('应该兼容单 key 模式', () => {
    const config: ApiKeyAuthConfig = {
      kind: 'apikey',
      apiKey: 'sk-single',
      env: 'API_KEY'
    };

    const entries = extractApiKeyEntries(config);
    expect(entries).toHaveLength(1);
    expect(entries[0].apiKey).toBe('sk-single');
    expect(entries[0].env).toBe('API_KEY');
  });

  it('entries 优先于单 key', () => {
    const config: ApiKeyAuthConfig = {
      kind: 'apikey',
      apiKey: 'sk-single',
      entries: [
        { alias: 'key1', apiKey: 'sk-1' }
      ]
    };

    const entries = extractApiKeyEntries(config);
    expect(entries).toHaveLength(1);
    expect(entries[0].apiKey).toBe('sk-1');
  });

  it('空配置应该返回空数组', () => {
    const config: ApiKeyAuthConfig = {
      kind: 'apikey'
    };

    const entries = extractApiKeyEntries(config);
    expect(entries).toHaveLength(0);
  });
});

describe('buildProviderProfiles with entries', () => {
  it('应该解析 auth.entries 数组', () => {
    const config = {
      providers: {
        'test-provider': {
          type: 'openai',
          baseUrl: 'https://api.test.com',
          auth: {
            type: 'apikey',
            entries: [
              { alias: 'key1', apiKey: 'sk-test-1' },
              { alias: 'key2', apiKey: 'sk-test-2' }
            ]
          }
        }
      }
    };

    const result = buildProviderProfiles(config);
    const profile = result.byId['test-provider'];

    expect(profile).toBeDefined();
    expect(profile.auth.kind).toBe('apikey');
    
    const auth = profile.auth as ApiKeyAuthConfig;
    expect(auth.entries).toBeDefined();
    expect(auth.entries).toHaveLength(2);
    expect(auth.entries![0].alias).toBe('key1');
    expect(auth.entries![1].alias).toBe('key2');
  });

  it('应该兼容单 apiKey 模式', () => {
    const config = {
      providers: {
        'test-provider': {
          type: 'openai',
          baseUrl: 'https://api.test.com',
          auth: {
            type: 'apikey',
            apiKey: 'sk-single-key'
          }
        }
      }
    };

    const result = buildProviderProfiles(config);
    const profile = result.byId['test-provider'];

    expect(profile).toBeDefined();
    expect(profile.auth.kind).toBe('apikey');

    const auth = profile.auth as ApiKeyAuthConfig;
    expect(auth.apiKey).toBe('sk-single-key');
    expect(auth.entries).toBeUndefined();
  });

  it('应该解析带环境变量的 entries', () => {
    const config = {
      providers: {
        'test-provider': {
          type: 'openai',
          baseUrl: 'https://api.test.com',
          auth: {
            type: 'apikey',
            entries: [
              { alias: 'key1', apiKey: '${API_KEY_1}' },
              { alias: 'key2', env: 'API_KEY_2' }
            ]
          }
        }
      }
    };

    const result = buildProviderProfiles(config);
    const profile = result.byId['test-provider'];
    const auth = profile.auth as ApiKeyAuthConfig;

    expect(auth.entries).toBeDefined();
    expect(auth.entries![0].apiKey).toBe('${API_KEY_1}');
    expect(auth.entries![1].env).toBe('API_KEY_2');
  });
});
