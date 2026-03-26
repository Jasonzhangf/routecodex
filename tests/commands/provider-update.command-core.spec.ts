import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadProviderCommand, makeTempDir, mockProcessExit, swallowConsole } from './provider-update.command-test-helpers.js';

describe('provider-update command core flows', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs "provider update" success and failure branches', async () => {
    const { log, error } = swallowConsole();
    const { createProviderUpdateCommand, mocks } = await loadProviderCommand();
    const cmd = createProviderUpdateCommand();
    const configPath = path.join(await makeTempDir('provider-update-'), 'provider-input.json');
    await fs.writeFile(configPath, '{}\n', 'utf8');

    await cmd.parseAsync(['node', 'provider', 'update', '-c', configPath, '--provider', 'demo', '--write'], { from: 'node' });
    expect(mocks.updateProviderModels).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'demo',
        configPath: path.resolve(configPath),
        write: true
      })
    );
    expect(log).toHaveBeenCalledWith('Provider update summary:');

    mocks.updateProviderModels.mockRejectedValueOnce(new Error('upstream fail'));
    const cmdFail = createProviderUpdateCommand();
    const exit = mockProcessExit();
    await expect(
      cmdFail.parseAsync(['node', 'provider', 'update', '-c', configPath, '--provider', 'demo'], { from: 'node' })
    ).rejects.toThrow('process.exit:1');
    expect(error).toHaveBeenCalledWith('provider update failed:', 'upstream fail');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('runs "provider sync-models" with write + cache fallback', async () => {
    const { log } = swallowConsole();
    const { createProviderUpdateCommand, mocks } = await loadProviderCommand();
    const root = await makeTempDir('provider-sync-');
    const providerDir = path.join(root, 'demo');
    await fs.mkdir(providerDir, { recursive: true });
    const v2Path = path.join(providerDir, 'config.v2.json');
    await fs.writeFile(
      v2Path,
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'demo',
        provider: {
          type: 'demo',
          baseURL: 'https://api.example.com/v1',
          auth: { type: 'apikey', apiKey: '${DEMO_API_KEY}' },
          models: {
            'model-a': { supportsStreaming: true },
            'old-model': { supportsStreaming: true }
          }
        }
      }, null, 2)}\n`,
      'utf8'
    );

    mocks.readBlacklist.mockReturnValue({ models: ['blocked-model'] });
    mocks.fetchModelsFromUpstream.mockResolvedValueOnce({
      models: ['model-a', 'model-b', 'blocked-model'],
      raw: { source: 'upstream' }
    });
    const cmd = createProviderUpdateCommand();
    await cmd.parseAsync(
      [
        'node',
        'provider',
        'sync-models',
        'demo',
        '--root',
        root,
        '--write',
        '--blacklist-add',
        'extra-block',
        '--blacklist-remove',
        'blocked-model'
      ],
      { from: 'node' }
    );

    expect(mocks.writeBlacklist).toHaveBeenCalledWith(
      path.join(providerDir, 'blacklist.json'),
      expect.objectContaining({ models: ['extra-block'] })
    );
    const updated = JSON.parse(await fs.readFile(v2Path, 'utf8')) as { provider: { models: Record<string, unknown> } };
    expect(Object.keys(updated.provider.models)).toEqual(expect.arrayContaining(['model-a', 'model-b']));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Provider "demo" updated:'));

    const cachePath = path.join(providerDir, 'models-latest.json');
    await fs.writeFile(cachePath, `${JSON.stringify({ models: ['cached-model'] }, null, 2)}\n`, 'utf8');
    mocks.fetchModelsFromUpstream.mockRejectedValueOnce(new Error('network down'));
    const cmdCache = createProviderUpdateCommand();
    await cmdCache.parseAsync(['node', 'provider', 'sync-models', 'demo', '--root', root, '--use-cache'], { from: 'node' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[DRY RUN] Provider "demo" would be updated:'));
  });

  it('covers sync-models error branches (missing/invalid config, cache, empty models)', async () => {
    const { error } = swallowConsole();
    const { createProviderUpdateCommand, mocks } = await loadProviderCommand();
    const root = await makeTempDir('provider-sync-errors-');
    const providerDir = path.join(root, 'demo');
    await fs.mkdir(providerDir, { recursive: true });
    const v2Path = path.join(providerDir, 'config.v2.json');

    const exit = mockProcessExit();
    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'sync-models', 'demo', '--root', root], { from: 'node' })
    ).rejects.toThrow('process.exit:1');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('No config.v2.json found for provider "demo"'));

    await fs.writeFile(v2Path, '{invalid json', 'utf8');
    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'sync-models', 'demo', '--root', root], { from: 'node' })
    ).rejects.toThrow('process.exit:1');
    expect(error).toHaveBeenCalledWith('Failed to parse existing config.v2.json:', expect.any(String));

    await fs.writeFile(
      v2Path,
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'demo',
        provider: {
          type: 'demo',
          models: { blocked: { supportsStreaming: true } }
        }
      }, null, 2)}\n`,
      'utf8'
    );

    mocks.fetchModelsFromUpstream.mockRejectedValueOnce(new Error('upstream-err'));
    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'sync-models', 'demo', '--root', root], { from: 'node' })
    ).rejects.toThrow('upstream-err');

    await fs.writeFile(path.join(providerDir, 'models-latest.json'), `${JSON.stringify({ models: 'not-array' }, null, 2)}\n`, 'utf8');
    mocks.fetchModelsFromUpstream.mockRejectedValueOnce(new Error('cache-invalid'));
    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'sync-models', 'demo', '--root', root, '--use-cache'], { from: 'node' })
    ).rejects.toThrow('cache-invalid');

    mocks.readBlacklist.mockReturnValueOnce({ models: ['blocked'] });
    mocks.fetchModelsFromUpstream.mockResolvedValueOnce({ models: ['blocked'], raw: {} });
    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'sync-models', 'demo', '--root', root], { from: 'node' })
    ).rejects.toThrow('Upstream returned 0 models after blacklist filter');

    expect(exit).toHaveBeenCalled();
  });

  it('runs "provider probe-context" write flow and validates threshold guard', async () => {
    const { log, error } = swallowConsole();
    const { createProviderUpdateCommand, mocks } = await loadProviderCommand();
    const root = await makeTempDir('provider-probe-');
    const providerDir = path.join(root, 'demo');
    await fs.mkdir(providerDir, { recursive: true });
    const v2Path = path.join(providerDir, 'config.v2.json');
    await fs.writeFile(
      v2Path,
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'demo',
        provider: {
          type: 'demo',
          models: {
            'model-a': { supportsStreaming: true, maxContextTokens: 120000 },
            'model-b': { supportsStreaming: true }
          }
        }
      }, null, 2)}\n`,
      'utf8'
    );

    mocks.probeContextForModel
      .mockResolvedValueOnce({ maxPassedTokens: 180000 })
      .mockResolvedValueOnce({
        maxPassedTokens: null,
        firstFailure: {
          threshold: 200000,
          status: 400,
          message: 'too long',
          responseSnippet: 'payload-too-long'
        }
      });
    const cmd = createProviderUpdateCommand();
    await cmd.parseAsync(
      [
        'node',
        'provider',
        'probe-context',
        'demo',
        '--root',
        root,
        '--thresholds',
        '128000, 200000',
        '--models',
        'model-a,model-b',
        '--timeout-ms',
        '9000',
        '--write',
        '--verbose'
      ],
      { from: 'node' }
    );

    const updated = JSON.parse(await fs.readFile(v2Path, 'utf8')) as {
      provider: { models: Record<string, { maxContextTokens?: number; maxContext?: number }> };
    };
    expect(updated.provider.models['model-a'].maxContextTokens).toBe(180000);
    expect(updated.provider.models['model-a'].maxContext).toBe(180000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Probe results:'));

    const cmdInvalid = createProviderUpdateCommand();
    const exit = mockProcessExit();
    await expect(
      cmdInvalid.parseAsync(['node', 'provider', 'probe-context', 'demo', '--root', root, '--thresholds', 'oops'], { from: 'node' })
    ).rejects.toThrow('process.exit:1');
    expect(error).toHaveBeenCalledWith('No valid thresholds provided');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('covers probe-context endpoint + missing-file + invalid-json + no-models branches', async () => {
    const { log, error } = swallowConsole();
    const { createProviderUpdateCommand, mocks } = await loadProviderCommand();
    const root = await makeTempDir('provider-probe-errors-');
    const providerDir = path.join(root, 'demo');
    await fs.mkdir(providerDir, { recursive: true });
    const v2Path = path.join(providerDir, 'config.v2.json');
    const exit = mockProcessExit();

    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'probe-context', 'demo', '--root', root], { from: 'node' })
    ).rejects.toThrow('process.exit:1');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('No config.v2.json found for provider "demo"'));

    await fs.writeFile(v2Path, '{bad json', 'utf8');
    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'probe-context', 'demo', '--root', root], { from: 'node' })
    ).rejects.toThrow('process.exit:1');

    await fs.writeFile(
      v2Path,
      `${JSON.stringify({ version: '2.0.0', providerId: 'demo', provider: { type: 'demo', models: {} } }, null, 2)}\n`,
      'utf8'
    );
    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'probe-context', 'demo', '--root', root], { from: 'node' })
    ).rejects.toThrow('process.exit:1');
    expect(error).toHaveBeenCalledWith('No models found to probe');

    await fs.writeFile(
      v2Path,
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'demo',
        provider: { type: 'demo', models: { m1: { supportsStreaming: true } } }
      }, null, 2)}\n`,
      'utf8'
    );

    mocks.probeContextForModel.mockResolvedValue({ maxPassedTokens: 123000 });
    await createProviderUpdateCommand().parseAsync(
      ['node', 'provider', 'probe-context', 'demo', '--root', root, '--endpoint', 'http://127.0.0.1:5555/v1', '--thresholds', '128000'],
      { from: 'node' }
    );
    await createProviderUpdateCommand().parseAsync(
      ['node', 'provider', 'probe-context', 'demo', '--root', root, '--endpoint', 'http://127.0.0.1:5555/v1/responses', '--thresholds', '128000'],
      { from: 'node' }
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[DRY RUN] Provider "demo" would be updated:'));
    expect(exit).toHaveBeenCalled();
  });
});
