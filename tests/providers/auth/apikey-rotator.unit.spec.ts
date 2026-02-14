/**
 * ApiKeyRotator 单元测试
 */

import { ApiKeyRotator, ApiKeyAuthProvider, createApiKeyRotator } from '../../../src/providers/auth/apikey-auth.js';
import type { ApiKeyAuthConfig } from '../../../src/providers/profile/provider-profile.js';

describe('ApiKeyRotator', () => {
  beforeEach(() => {
    // 清理环境变量
    delete process.env.TEST_KEY_1;
    delete process.env.TEST_KEY_2;
    delete process.env.TEST_KEY_3;
  });

  describe('基本功能', () => {
    it('应该正确获取当前 key', () => {
      const rotator = new ApiKeyRotator([
        { alias: 'key1', apiKey: 'sk-test1' },
        { alias: 'key2', apiKey: 'sk-test2' }
      ]);

      expect(rotator.getCurrentKey()).toBe('sk-test1');
      expect(rotator.getCurrentEntry()?.alias).toBe('key1');
    });

    it('应该支持轮询切换到下一个 key', () => {
      const rotator = new ApiKeyRotator([
        { alias: 'key1', apiKey: 'sk-test1' },
        { alias: 'key2', apiKey: 'sk-test2' },
        { alias: 'key3', apiKey: 'sk-test3' }
      ]);

      expect(rotator.getCurrentKey()).toBe('sk-test1');
      
      rotator.rotate();
      expect(rotator.getCurrentKey()).toBe('sk-test2');
      
      rotator.rotate();
      expect(rotator.getCurrentKey()).toBe('sk-test3');
      
      // 循环回到第一个
      rotator.rotate();
      expect(rotator.getCurrentKey()).toBe('sk-test1');
    });

    it('空 entries 应该返回 undefined', () => {
      const rotator = new ApiKeyRotator([]);
      expect(rotator.getCurrentKey()).toBeUndefined();
      expect(rotator.rotate()).toBeUndefined();
    });
  });

  describe('按别名选择', () => {
    it('应该支持按别名选择 key', () => {
      const rotator = new ApiKeyRotator([
        { alias: 'prod', apiKey: 'sk-prod' },
        { alias: 'dev', apiKey: 'sk-dev' }
      ]);

      expect(rotator.selectByAlias('dev')).toBe('sk-dev');
      expect(rotator.getCurrentEntry()?.alias).toBe('dev');
    });

    it('不存在的别名应该返回 undefined', () => {
      const rotator = new ApiKeyRotator([
        { alias: 'key1', apiKey: 'sk-test1' }
      ]);

      expect(rotator.selectByAlias('nonexistent')).toBeUndefined();
    });
  });

  describe('环境变量解析', () => {
    it('应该支持 ${VAR} 格式的环境变量', () => {
      process.env.TEST_KEY_1 = 'sk-from-env-1';
      process.env.TEST_KEY_2 = 'sk-from-env-2';

      const rotator = new ApiKeyRotator([
        { alias: 'key1', apiKey: '${TEST_KEY_1}' },
        { alias: 'key2', apiKey: '${TEST_KEY_2}' }
      ]);

      expect(rotator.getCurrentKey()).toBe('sk-from-env-1');
      
      rotator.rotate();
      expect(rotator.getCurrentKey()).toBe('sk-from-env-2');
    });

    it('应该支持 env 字段指定环境变量名', () => {
      process.env.MY_API_KEY = 'sk-my-key';

      const rotator = new ApiKeyRotator([
        { alias: 'key1', env: 'MY_API_KEY' }
      ]);

      expect(rotator.getCurrentKey()).toBe('sk-my-key');
    });

    it('缺失的环境变量应该返回空字符串', () => {
      const rotator = new ApiKeyRotator([
        { alias: 'key1', apiKey: '${MISSING_VAR}' }
      ]);

      expect(rotator.getCurrentKey()).toBe('');
    });
  });

  describe('混合配置', () => {
    it('应该支持 apiKey 和 env 混合配置', () => {
      process.env.ENV_KEY = 'sk-env';

      const rotator = new ApiKeyRotator([
        { alias: 'direct', apiKey: 'sk-direct' },
        { alias: 'fromEnv', env: 'ENV_KEY' }
      ]);

      expect(rotator.getCurrentKey()).toBe('sk-direct');
      
      rotator.rotate();
      expect(rotator.getCurrentKey()).toBe('sk-env');
    });
  });
});

describe('createApiKeyRotator', () => {
  it('应该从 entries 数组创建', () => {
    const config: ApiKeyAuthConfig = {
      kind: 'apikey',
      entries: [
        { alias: 'k1', apiKey: 'sk-1' },
        { alias: 'k2', apiKey: 'sk-2' }
      ]
    };

    const rotator = createApiKeyRotator(config);
    expect(rotator).not.toBeNull();
    expect(rotator?.getEntryCount()).toBe(2);
    expect(rotator?.getCurrentKey()).toBe('sk-1');
  });

  it('应该兼容单 key 模式', () => {
    const config: ApiKeyAuthConfig = {
      kind: 'apikey',
      apiKey: 'sk-single'
    };

    const rotator = createApiKeyRotator(config);
    expect(rotator).not.toBeNull();
    expect(rotator?.getEntryCount()).toBe(1);
    expect(rotator?.getCurrentKey()).toBe('sk-single');
  });

  it('空配置应该返回 null', () => {
    const config: ApiKeyAuthConfig = {
      kind: 'apikey'
    };

    const rotator = createApiKeyRotator(config);
    expect(rotator).toBeNull();
  });
});

describe('ApiKeyAuthProvider with rotator', () => {
  it('应该支持多 key 初始化', async () => {
    const rotator = new ApiKeyRotator([
      { alias: 'key1', apiKey: 'sk-test-key-1' },
      { alias: 'key2', apiKey: 'sk-test-key-2' }
    ]);

    const provider = new ApiKeyAuthProvider(
      { type: 'apikey', apiKey: '' },
      rotator
    );

    await provider.initialize();
    
    const headers = provider.buildHeaders();
    expect(headers.Authorization).toBe('Bearer sk-test-key-1');
  });

  it('应该支持运行时切换 key', async () => {
    const rotator = new ApiKeyRotator([
      { alias: 'key1', apiKey: 'sk-test-key-1' },
      { alias: 'key2', apiKey: 'sk-test-key-2' }
    ]);

    const provider = new ApiKeyAuthProvider(
      { type: 'apikey', apiKey: '' },
      rotator
    );

    await provider.initialize();
    
    // 初始 key
    let headers = provider.buildHeaders();
    expect(headers.Authorization).toBe('Bearer sk-test-key-1');

    // 切换到下一个 key
    expect(provider.rotateKey()).toBe(true);
    headers = provider.buildHeaders();
    expect(headers.Authorization).toBe('Bearer sk-test-key-2');
  });

  it('单 key 模式下 rotateKey 应该返回 false', async () => {
    const provider = new ApiKeyAuthProvider({
      type: 'apikey',
      apiKey: 'sk-single-key'
    });

    await provider.initialize();
    
    expect(provider.rotateKey()).toBe(false);
  });

  it('应该能获取 rotator', async () => {
    const rotator = new ApiKeyRotator([
      { alias: 'key1', apiKey: 'sk-test' }
    ]);

    const provider = new ApiKeyAuthProvider(
      { type: 'apikey', apiKey: '' },
      rotator
    );

    expect(provider.getRotator()).toBe(rotator);
  });

  it('没有 rotator 时 getRotator 应该返回 null', async () => {
    const provider = new ApiKeyAuthProvider({
      type: 'apikey',
      apiKey: 'sk-test'
    });

    expect(provider.getRotator()).toBeNull();
  });
});
