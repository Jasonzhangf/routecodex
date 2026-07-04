import { describe, expect, it } from '@jest/globals';
import { RouteCodexHttpServer } from '../../../../src/server/runtime/http-server/index.js';

describe('provider binding resolution', () => {
  it('resolves provider.alias.model binding only through an exact runtime-key map entry', () => {
    const server = new RouteCodexHttpServer({
      configPath: 'test-config.toml',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    (server as any).providerHandles = new Map([
      ['dbittai-gpt.key1', { runtimeKey: 'dbittai-gpt.key1' }],
    ]);
    (server as any).providerKeyToRuntimeKey = new Map([
      ['dbittai-gpt.key1.gpt-5.4', 'dbittai-gpt.key1'],
    ]);

    const resolved = (server as any).resolveRuntimeKeyForProviderBinding('dbittai-gpt.key1.gpt-5.4');
    expect(resolved).toBe('dbittai-gpt.key1');
  });

  it('does not fall back from provider.alias.model binding to provider.alias handle when the map entry is missing', () => {
    const server = new RouteCodexHttpServer({
      configPath: 'test-config.toml',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    (server as any).providerHandles = new Map([
      ['DF.key1', { runtimeKey: 'DF.key1' }],
    ]);
    (server as any).providerKeyToRuntimeKey = new Map();

    const resolved = (server as any).resolveRuntimeKeyForProviderBinding('DF.key1.deepseek-v4-pro');
    expect(resolved).toBeUndefined();
  });

  it('does not normalize key1 and numeric account segments during provider binding lookup', () => {
    const server = new RouteCodexHttpServer({
      configPath: 'test-config.toml',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    (server as any).providerHandles = new Map([
      ['xl.1', { runtimeKey: 'xl.1' }],
      ['cc.key1', { runtimeKey: 'cc.key1' }],
    ]);
    (server as any).providerKeyToRuntimeKey = new Map();

    expect((server as any).resolveRuntimeKeyForProviderBinding('xl.key1')).toBeUndefined();
    expect((server as any).resolveRuntimeKeyForProviderBinding('cc.1')).toBeUndefined();
  });
});
