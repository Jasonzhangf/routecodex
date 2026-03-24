import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type TestMocks = {
  updateProviderModels: jest.Mock<any>;
  fetchModelsFromUpstream: jest.Mock<any>;
  readBlacklist: jest.Mock<any>;
  writeBlacklist: jest.Mock<any>;
  probeContextForModel: jest.Mock<any>;
  runVercelAiProviderDoctor: jest.Mock<any>;
  getProviderTemplates: jest.Mock<any>;
  pickProviderTemplate: jest.Mock<any>;
  buildProviderFromTemplate: jest.Mock<any>;
  inspectProviderConfig: jest.Mock<any>;
  buildRoutingHintsConfigFragment: jest.Mock<any>;
  loadProviderConfigsV2: jest.Mock<any>;
  resolveRccProviderDir: jest.Mock<any>;
};

const makeReadlineInterface = (answers: string[]) => ({
  question: (_prompt: string, cb: (answer: string) => void) => cb(answers.shift() ?? ''),
  close: () => {}
});

async function loadProviderCommand(): Promise<{
  createProviderUpdateCommand: () => import('commander').Command;
  mocks: TestMocks;
  answers: string[];
}> {
  jest.resetModules();

  const answers: string[] = [];
  const template = {
    id: 'openai',
    label: 'OpenAI',
    source: 'bootstrap-generic',
    defaultBaseUrl: 'https://api.example.com/v1',
    defaultAuthType: 'apikey',
    defaultModel: 'gpt-4.1-mini',
    providerTypeHint: 'openai'
  };

  const mocks: TestMocks = {
    updateProviderModels: jest.fn(async () => ({
      providerId: 'demo',
      totalRemote: 3,
      filtered: 2,
      outputPath: '/tmp/provider/demo/config.v2.json',
      blacklistPath: '/tmp/provider/demo/blacklist.json'
    })),
    fetchModelsFromUpstream: jest.fn(async () => ({
      models: ['model-a', 'model-b'],
      raw: { ok: true }
    })),
    readBlacklist: jest.fn(() => ({ models: [] })),
    writeBlacklist: jest.fn(),
    probeContextForModel: jest.fn(async (_modelId: string) => ({
      maxPassedTokens: 256000
    })),
    runVercelAiProviderDoctor: jest.fn(async () => ({
      ok: true,
      message: 'ok',
      text: 'OK',
      baseURL: 'https://api.example.com/v1',
      binding: { family: 'openai', supported: true }
    })),
    getProviderTemplates: jest.fn(() => [template]),
    pickProviderTemplate: jest.fn(() => template),
    buildProviderFromTemplate: jest.fn(
      (
        providerId: string,
        _tpl: Record<string, unknown>,
        baseUrl: string,
        authType: string,
        apiKeyPlaceholder: string,
        tokenFile: string,
        modelId: string,
        extra?: { additionalModelIds?: string[]; defaultModelId?: string }
      ) => {
        const models = [modelId, ...(extra?.additionalModelIds ?? [])];
        return {
          type: providerId,
          baseURL: baseUrl,
          auth: authType.includes('apikey')
            ? { type: authType, apiKey: apiKeyPlaceholder || 'YOUR_API_KEY_HERE' }
            : { type: authType, tokenFile: tokenFile || '~/.rcc/auth/oauth.json' },
          models: Object.fromEntries(models.map((id) => [id, { supportsStreaming: true }])),
          defaultModel: extra?.defaultModelId || modelId
        };
      }
    ),
    inspectProviderConfig: jest.fn(() => ({
      providerId: 'demo',
      version: '2.0.0',
      providerType: 'openai',
      baseURL: 'https://api.example.com/v1',
      authType: 'apikey',
      compatibilityProfile: 'responses:v1',
      catalogId: 'openai',
      catalogLabel: 'OpenAI',
      defaultModel: 'gpt-4.1-mini',
      routeTargets: { default: 'default', webSearch: 'web_search' },
      modelCount: 2,
      models: ['gpt-4.1-mini', 'gpt-5.2-codex'],
      sdkBinding: { family: 'openai' },
      capabilities: { chat: true },
      webSearch: { enabled: true },
      routingHints: { provider: 'demo', route: 'default' }
    })),
    buildRoutingHintsConfigFragment: jest.fn(() => ({ providers: [{ id: 'demo' }] })),
    loadProviderConfigsV2: jest.fn(async () => ({})),
    resolveRccProviderDir: jest.fn(() => '/tmp/provider-root-default')
  };

  await jest.unstable_mockModule('node:readline', () => ({
    default: {
      createInterface: () => makeReadlineInterface(answers)
    },
    createInterface: () => makeReadlineInterface(answers)
  }));
  await jest.unstable_mockModule('../../src/tools/provider-update/index.js', () => ({
    updateProviderModels: mocks.updateProviderModels
  }));
  await jest.unstable_mockModule('../../src/tools/provider-update/fetch-models.js', () => ({
    fetchModelsFromUpstream: mocks.fetchModelsFromUpstream
  }));
  await jest.unstable_mockModule('../../src/tools/provider-update/blacklist.js', () => ({
    readBlacklist: mocks.readBlacklist,
    writeBlacklist: mocks.writeBlacklist
  }));
  await jest.unstable_mockModule('../../src/tools/provider-update/probe-context.js', () => ({
    probeContextForModel: mocks.probeContextForModel
  }));
  await jest.unstable_mockModule('../../src/provider-sdk/vercel-ai-doctor.js', () => ({
    runVercelAiProviderDoctor: mocks.runVercelAiProviderDoctor
  }));
  await jest.unstable_mockModule('../../src/provider-sdk/provider-add-template.js', () => ({
    getProviderTemplates: mocks.getProviderTemplates,
    pickProviderTemplate: mocks.pickProviderTemplate,
    buildProviderFromTemplate: mocks.buildProviderFromTemplate
  }));
  await jest.unstable_mockModule('../../src/provider-sdk/provider-inspect.js', () => ({
    inspectProviderConfig: mocks.inspectProviderConfig,
    buildRoutingHintsConfigFragment: mocks.buildRoutingHintsConfigFragment
  }));
  await jest.unstable_mockModule('../../src/config/provider-v2-loader.js', () => ({
    loadProviderConfigsV2: mocks.loadProviderConfigsV2
  }));
  await jest.unstable_mockModule('../../src/config/user-data-paths.js', () => ({
    resolveRccProviderDir: mocks.resolveRccProviderDir
  }));

  const mod = await import('../../src/commands/provider-update.js');
  return { createProviderUpdateCommand: mod.createProviderUpdateCommand, mocks, answers };
}

const swallowConsole = () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  return { log, error, warn };
};

const mockProcessExit = () =>
  jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code ?? 0)}`);
  }) as never);

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('provider-update command coverage', () => {
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

  it('runs inspect / doctor / list command variants', async () => {
    const { log } = swallowConsole();
    const { createProviderUpdateCommand, mocks } = await loadProviderCommand();
    const root = await makeTempDir('provider-inspect-');
    mocks.loadProviderConfigsV2.mockResolvedValue({
      demo: {
        version: '2.0.0',
        provider: {
          type: 'openai',
          baseURL: 'https://api.example.com/v1',
          auth: { type: 'apikey', apiKey: '${DEMO_API_KEY}' },
          defaultModel: 'gpt-4.1-mini',
          models: { 'gpt-4.1-mini': { supportsStreaming: true }, 'gpt-5.2-codex': { supportsStreaming: true } }
        }
      }
    });

    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'inspect', 'demo', '--root', root, '--routing-hints'], { from: 'node' });
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'inspect', 'demo', '--root', root, '--json'], { from: 'node' });
    expect(mocks.buildRoutingHintsConfigFragment).toHaveBeenCalled();

    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'doctor', 'demo', '--root', root], { from: 'node' });
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'doctor', 'demo', '--root', root, '--json'], { from: 'node' });
    expect(mocks.runVercelAiProviderDoctor).toHaveBeenCalled();

    mocks.runVercelAiProviderDoctor.mockResolvedValueOnce({
      ok: false,
      message: 'bad',
      binding: { family: 'openai', supported: true }
    });
    const exit = mockProcessExit();
    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'doctor', 'demo', '--root', root], { from: 'node' })
    ).rejects.toThrow('process.exit:1');
    expect(exit).toHaveBeenCalledWith(1);

    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'list', '--root', root], { from: 'node' });
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'list', '--root', root, '--json'], { from: 'node' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Provider v2 configs under'));
  });

  it('covers inspect/doctor/list missing-provider and empty-list branches', async () => {
    const { log, error } = swallowConsole();
    const { createProviderUpdateCommand, mocks } = await loadProviderCommand();
    const root = await makeTempDir('provider-inspect-errors-');
    const exit = mockProcessExit();

    mocks.loadProviderConfigsV2.mockResolvedValue({});
    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'inspect', 'demo', '--root', root], { from: 'node' })
    ).rejects.toThrow('process.exit:1');

    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'doctor', 'demo', '--root', root], { from: 'node' })
    ).rejects.toThrow('process.exit:1');

    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'list'], { from: 'node' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('No provider v2 configs found under'));

    mocks.loadProviderConfigsV2.mockResolvedValue({
      demo: {
        version: '2.0.0',
        provider: { type: 'openai', models: {} }
      }
    });
    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'doctor', 'demo', '--root', root], { from: 'node' })
    ).rejects.toThrow('process.exit:1');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('has no configured models'));
    expect(exit).toHaveBeenCalled();
  });

  it('runs add/change/delete interactive provider maintenance flows', async () => {
    const { log } = swallowConsole();
    const { createProviderUpdateCommand, answers, mocks } = await loadProviderCommand();
    const root = await makeTempDir('provider-maintain-');

    answers.push(
      'openai',
      'https://api.new.example/v1',
      'apikey',
      'DEMO_API_KEY',
      'gpt-4.1-mini,gpt-5.2-codex',
      'gpt-5.2-codex',
      'y'
    );
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'add', '--root', root, '--id', 'demo'], { from: 'node' });
    const createdPath = path.join(root, 'demo', 'config.v2.json');
    const created = JSON.parse(await fs.readFile(createdPath, 'utf8')) as { provider: { defaultModel?: string } };
    expect(created.provider.defaultModel).toBe('gpt-5.2-codex');

    answers.push(
      'https://api.changed.example/v1',
      'iflow-cookie',
      '~/.rcc/auth/iflow.cookie',
      'gpt-5.2-codex,gpt-4.1-mini',
      'gpt-4.1-mini',
      'y'
    );
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'change', 'demo', '--root', root], { from: 'node' });
    const changed = JSON.parse(await fs.readFile(createdPath, 'utf8')) as { provider: { auth?: Record<string, unknown>; defaultModel?: string } };
    expect(changed.provider.auth?.type).toBe('iflow-cookie');
    expect(changed.provider.auth?.cookieFile).toBe('~/.rcc/auth/iflow.cookie');
    expect(changed.provider.defaultModel).toBe('gpt-4.1-mini');

    answers.push('n');
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'delete', 'demo', '--root', root], { from: 'node' });
    expect(log).toHaveBeenCalledWith('Aborted');
    expect(await fs.stat(createdPath)).toBeTruthy();

    answers.length = 0;
    answers.push('y');
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'delete', 'demo', '--root', root], { from: 'node' });
    await expect(fs.stat(createdPath)).rejects.toThrow();

    const purgeDir = path.join(root, 'purge-me');
    await fs.mkdir(purgeDir, { recursive: true });
    await fs.writeFile(path.join(purgeDir, 'config.v2.json'), '{}\n', 'utf8');
    answers.push('y');
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'delete', 'purge-me', '--root', root, '--purge'], { from: 'node' });
    await expect(fs.stat(purgeDir)).rejects.toThrow();
  });

  it('covers add/change/delete error and abort branches', async () => {
    const { error } = swallowConsole();
    const { createProviderUpdateCommand, answers, mocks } = await loadProviderCommand();
    const root = await makeTempDir('provider-maintain-errors-');
    const exit = mockProcessExit();

    answers.push('');
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'add', '--root', root], { from: 'node' });
    await expect(fs.stat(path.join(root, 'glm', 'config.v2.json'))).resolves.toBeTruthy();

    const existingDir = path.join(root, 'existing');
    await fs.mkdir(existingDir, { recursive: true });
    await fs.writeFile(path.join(existingDir, 'config.v2.json'), '{}\n', 'utf8');
    answers.push('n');
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'add', '--root', root, '--id', 'existing'], { from: 'node' });

    mocks.pickProviderTemplate.mockReturnValueOnce({
      id: 'openai',
      label: 'OpenAI',
      source: 'bootstrap-generic',
      defaultBaseUrl: '',
      defaultAuthType: 'apikey',
      defaultModel: 'gpt-4.1-mini',
      providerTypeHint: 'openai'
    });
    answers.push('openai', '', 'apikey', 'DEMO_KEY', 'gpt-4.1-mini', 'gpt-4.1-mini', 'y');
    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'add', '--root', root, '--id', 'missing-base-url'], { from: 'node' })
    ).rejects.toThrow('process.exit:1');

    mocks.pickProviderTemplate.mockReturnValueOnce({
      id: 'openai',
      label: 'OpenAI',
      source: 'bootstrap-generic',
      defaultBaseUrl: 'https://api.example.com/v1',
      defaultAuthType: 'apikey',
      defaultModel: '',
      providerTypeHint: 'openai'
    });
    answers.push('openai', 'https://api.example.com/v1', 'apikey', 'DEMO_KEY', '', '', 'y');
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'add', '--root', root, '--id', 'missing-models'], { from: 'node' });

    const oauthDir = path.join(root, 'oauth-provider');
    await fs.mkdir(oauthDir, { recursive: true });
    await fs.writeFile(
      path.join(oauthDir, 'config.v2.json'),
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'oauth-provider',
        provider: {
          type: 'oauth-provider',
          baseURL: 'https://api.example.com/v1',
          auth: { type: 'apikey', apiKey: '${OLD_ENV}' },
          models: { m1: { supportsStreaming: true } },
          defaultModel: 'm1'
        }
      }, null, 2)}\n`,
      'utf8'
    );
    answers.push('', 'apikey', '', 'm2', 'm3', 'n');
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'change', 'oauth-provider', '--root', root], { from: 'node' });

    const accountDir = path.join(root, 'account-provider');
    await fs.mkdir(accountDir, { recursive: true });
    await fs.writeFile(
      path.join(accountDir, 'config.v2.json'),
      `${JSON.stringify({
        version: '2.0.0',
        providerId: 'account-provider',
        provider: {
          type: 'account-provider',
          auth: { type: 'deepseek-account', entries: [{ tokenFile: '~/.rcc/auth/old-account.json' }] },
          models: { m1: { supportsStreaming: true } },
          defaultModel: 'm1'
        }
      }, null, 2)}\n`,
      'utf8'
    );
    answers.push('', 'deepseek-account', '~/.rcc/auth/new-account.json', 'm1', 'm1', 'y');
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'change', 'account-provider', '--root', root], { from: 'node' });
    answers.push('', 'qwen-oauth', '', 'm1', 'm1', 'y');
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'change', 'account-provider', '--root', root], { from: 'node' });

    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'change', 'missing-provider', '--root', root], { from: 'node' })
    ).rejects.toThrow('process.exit:1');

    const brokenDir = path.join(root, 'broken-provider');
    await fs.mkdir(brokenDir, { recursive: true });
    await fs.writeFile(path.join(brokenDir, 'config.v2.json'), '{broken json', 'utf8');
    await expect(
      createProviderUpdateCommand().parseAsync(['node', 'provider', 'change', 'broken-provider', '--root', root], { from: 'node' })
    ).rejects.toThrow('process.exit:1');

    answers.push('n');
    await createProviderUpdateCommand().parseAsync(['node', 'provider', 'delete', 'missing-provider', '--root', root], { from: 'node' });
    expect(error).toHaveBeenCalled();
    expect(exit).toHaveBeenCalled();
  });
});
