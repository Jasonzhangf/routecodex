import { describe, expect, it } from '@jest/globals';
import { RouteCodexHttpServer } from '../../../../src/server/runtime/http-server/index.js';

describe('provider binding resolution', () => {
  it('resolves provider.alias.model binding to provider.alias runtime key when runtime key omits model', () => {
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
    (server as any).providerKeyToRuntimeKey = new Map();

    const resolved = (server as any).resolveRuntimeKeyForProviderBinding('dbittai-gpt.key1.gpt-5.4');
    expect(resolved).toBe('dbittai-gpt.key1');
  });

  it('resolves provider.alias.model binding to provider.alias runtime key when the registry only has the alias runtime key', () => {
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
    (server as any).providerKeyToRuntimeKey = new Map([
      ['DF.key1', 'DF.key1'],
      ['DF.key1.deepseek-v4-pro', 'DF.key1'],
    ]);

    const resolved = (server as any).resolveRuntimeKeyForProviderBinding('DF.key1.deepseek-v4-pro');
    expect(resolved).toBe('DF.key1');
  });

  it('treats alias runtime key as visible when allowedProviders only list the model-scoped provider key', () => {
    const server = new RouteCodexHttpServer({
      configPath: 'test-config.toml',
      server: { host: '127.0.0.1', port: 0 },
      pipeline: {},
      logging: { level: 'error', enableConsole: false },
      providers: {},
    } as any);

    const metadata = {
      allowedProviders: ['asxs.crsa.gpt-5.4-mini', 'minimax.key1.MiniMax-M3'],
    };

    expect((server as any).isProviderVisibleInMetadataScope('asxs.crsa.gpt-5.4-mini', metadata)).toBe(true);
    expect((server as any).isProviderVisibleInMetadataScope('asxs.crsa', metadata)).toBe(true);
  });
});
