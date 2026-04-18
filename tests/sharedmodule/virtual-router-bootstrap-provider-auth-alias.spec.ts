import fs from 'fs';
import os from 'os';
import path from 'path';

import { bootstrapProvidersWithNative } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-virtual-router-bootstrap-providers.js';

describe('virtual-router native provider auth bootstrap', () => {
  const prevAuthDir = process.env.RCC_AUTH_DIR;
  const prevRoutecodexAuthDir = process.env.ROUTECODEX_AUTH_DIR;
  let authDir = '';

  beforeEach(() => {
    authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-qwen-auth-'));
    process.env.RCC_AUTH_DIR = authDir;
    process.env.ROUTECODEX_AUTH_DIR = authDir;
    fs.writeFileSync(path.join(authDir, 'qwen-oauth-1-default.json'), '{}\n');
    fs.writeFileSync(path.join(authDir, 'qwen-oauth-4-jasonqueque.json'), '{}\n');
  });

  afterEach(() => {
    if (prevAuthDir === undefined) {
      delete process.env.RCC_AUTH_DIR;
    } else {
      process.env.RCC_AUTH_DIR = prevAuthDir;
    }
    if (prevRoutecodexAuthDir === undefined) {
      delete process.env.ROUTECODEX_AUTH_DIR;
    } else {
      process.env.ROUTECODEX_AUTH_DIR = prevRoutecodexAuthDir;
    }
    if (authDir) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
  });

  it('keeps explicit qwen tokenFile providers single-entry instead of expanding the full oauth pool', () => {
    const result = bootstrapProvidersWithNative({
      providersSource: {
        'qwen-jasonqueque': {
          type: 'openai',
          baseURL: 'https://example.invalid/v1',
          compatibilityProfile: 'chat:qwen',
          auth: { type: 'qwen-oauth', tokenFile: 'qwen-oauth-4-jasonqueque' },
          models: {
            'qwen3.6-plus': {}
          }
        }
      }
    });

    expect(Object.keys(result.runtimeEntries).filter((key) => key.startsWith('qwen-jasonqueque.'))).toEqual([
      'qwen-jasonqueque.key1'
    ]);
    expect(result.runtimeEntries['qwen-jasonqueque.key1']?.auth?.tokenFile).toBe('qwen-oauth-4-jasonqueque');
    expect(result.aliasIndex.get('qwen-jasonqueque')).toEqual(['key1']);
  });

  it('injects qwen default headers with the current official qwen user-agent in native bootstrap', () => {
    const result = bootstrapProvidersWithNative({
      providersSource: {
        qwen: {
          id: 'qwen',
          type: 'openai',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          compatibilityProfile: 'chat:qwen',
          auth: { type: 'qwen-oauth', tokenFile: 'qwen-oauth-1-default' },
          models: {
            'qwen3.6-plus': {}
          }
        }
      }
    });

    const runtime = result.runtimeEntries['qwen.key1'];
    expect(runtime).toBeTruthy();
    expect(runtime?.headers?.['User-Agent']).toBe('QwenCode/0.14.3 (darwin; arm64)');
    expect(runtime?.headers?.['X-DashScope-UserAgent']).toBe('QwenCode/0.14.3 (darwin; arm64)');
    expect(runtime?.headers?.['X-DashScope-CacheControl']).toBe('enable');
    expect(runtime?.headers?.['X-DashScope-AuthType']).toBe('qwen-oauth');
  });
});
