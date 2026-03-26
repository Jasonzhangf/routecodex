import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadProviderCommand, makeTempDir, mockProcessExit, swallowConsole } from './provider-update.command-test-helpers.js';

describe('provider-update command maintenance flows', () => {
  afterEach(() => {
    jest.restoreAllMocks();
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

  it('runs sync-capability-routes command success and failure branches', async () => {
    const { log, error } = swallowConsole();
    const { createProviderUpdateCommand, mocks } = await loadProviderCommand();
    const configPath = path.join(await makeTempDir('provider-capability-sync-'), 'config.json');
    await fs.writeFile(configPath, '{"version":"2.0.0"}\n', 'utf8');

    mocks.loadRouteCodexConfig.mockResolvedValueOnce({
      configPath,
      userConfig: {
        virtualrouter: {
          routing: {
            multimodal: [{ id: 'mm', targets: ['demo.qwen3.5-plus'] }],
            vision: [{ id: 'vs', targets: ['demo.qwen3.5-plus', 'demo.kimi-k2.5'] }],
            web_search: [{ id: 'ws', targets: ['demo.glm-5', 'demo.qwen3.5-plus'] }]
          }
        }
      },
      providerProfiles: { profiles: [], byId: {} }
    });

    await createProviderUpdateCommand().parseAsync(
      ['node', 'provider', 'sync-capability-routes', '--config', configPath],
      { from: 'node' }
    );
    expect(mocks.loadRouteCodexConfig).toHaveBeenCalledWith(path.resolve(configPath));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Capability route sync:'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('multimodal targets: 1'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('vision targets: 2'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('web_search targets: 2'));

    mocks.loadRouteCodexConfig.mockRejectedValueOnce(new Error('sync-failed'));
    const exit = mockProcessExit();
    await expect(
      createProviderUpdateCommand().parseAsync(
        ['node', 'provider', 'sync-capability-routes', '--config', configPath],
        { from: 'node' }
      )
    ).rejects.toThrow('process.exit:1');
    expect(error).toHaveBeenCalledWith('provider sync-capability-routes failed:', 'sync-failed');
    expect(exit).toHaveBeenCalledWith(1);
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
    const { createProviderUpdateCommand, answers } = await loadProviderCommand();
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
