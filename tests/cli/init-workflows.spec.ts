import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { InitProviderTemplate } from '../../src/cli/config/init-provider-catalog.js';
import { getProviderV2Path, writeProviderV2 } from '../../src/cli/commands/init/basic.js';
import { migrateV1ToV2, runV2MaintenanceMenu } from '../../src/cli/commands/init/workflows.js';

function tmpDir(prefix = 'init-workflows-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function queuePrompt(answers: string[]) {
  let index = 0;
  return async (_question: string): Promise<string> => {
    const next = answers[index];
    index += 1;
    return next ?? '';
  };
}

function createSpinner(logs: string[]) {
  return {
    text: '',
    start(text?: string) {
      this.text = text || this.text;
      logs.push(`start:${this.text}`);
      return this as any;
    },
    stop() {
      logs.push('stop');
    },
    succeed(text?: string) {
      logs.push(`succeed:${text || ''}`);
    },
    fail(text?: string) {
      logs.push(`fail:${text || ''}`);
    },
    warn(text?: string) {
      logs.push(`warn:${text || ''}`);
    },
    info(text?: string) {
      logs.push(`info:${text || ''}`);
    }
  } as any;
}

function testCatalog(): InitProviderTemplate[] {
  return [
    {
      id: 'qwen',
      label: 'Qwen',
      description: 'managed template',
      provider: {
        id: 'qwen',
        enabled: true,
        type: 'openai',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        auth: { type: 'qwen-oauth', tokenFile: '~/.rcc/auth/qwen-oauth.json' },
        models: { 'qwen-plus': { supportsStreaming: true } }
      },
      defaultModel: 'qwen-plus'
    },
    {
      id: 'openai',
      label: 'OpenAI',
      description: 'standard template',
      provider: {
        id: 'openai',
        enabled: true,
        type: 'openai',
        baseURL: 'https://api.openai.com/v1',
        auth: { type: 'apikey', apiKey: '${OPENAI_API_KEY}' },
        models: { 'gpt-5.2': { supportsStreaming: true } }
      },
      defaultModel: 'gpt-5.2'
    }
  ];
}

describe('init workflows', () => {
  it('migrates v1->v2 with per-provider merge strategy and backup', async () => {
    const dir = tmpDir();
    const providerRoot = path.join(dir, 'provider');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(providerRoot, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ legacy: true }), 'utf8');

    writeProviderV2(fs, path, providerRoot, 'openai', {
      id: 'openai',
      enabled: true,
      auth: { type: 'apikey', apiKey: '${OLD_KEY}' },
      models: { old: { supportsStreaming: true } }
    });

    const spinnerLogs: string[] = [];
    const loggerLogs: string[] = [];
    const result = await migrateV1ToV2({
      fsImpl: fs,
      pathImpl: path,
      configPath,
      providerRoot,
      v1Config: {
        virtualrouter: {
          providers: {
            openai: {
              id: 'openai',
              enabled: true,
              auth: { type: 'apikey', apiKey: '${NEW_KEY}' },
              models: { new: { supportsStreaming: true } }
            },
            qwen: {
              id: 'qwen',
              enabled: true,
              models: { 'qwen-plus': { supportsStreaming: true } }
            }
          }
        },
        httpserver: { host: '0.0.0.0', port: '6666' }
      },
      spinner: createSpinner(spinnerLogs),
      logger: {
        info: (msg) => loggerLogs.push(msg),
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      prompt: queuePrompt(['s', 'm'])
    });

    expect(result.convertedProviders.sort()).toEqual(['openai', 'qwen']);
    expect(result.backupPath).toContain('config.json.bak');
    expect(fs.existsSync(result.backupPath!)).toBe(true);

    const openaiPayload = JSON.parse(fs.readFileSync(getProviderV2Path(path, providerRoot, 'openai'), 'utf8'));
    expect(openaiPayload.provider.auth.apiKey).toBe('${OLD_KEY}');
    expect(openaiPayload.provider.models.new).toBeTruthy();
    expect(openaiPayload.provider.models.old).toBeTruthy();
    expect(fs.existsSync(`${getProviderV2Path(path, providerRoot, 'openai')}.bak`)).toBe(true);

    const nextConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(nextConfig.virtualrouterMode).toBe('v2');
    expect(nextConfig.httpserver.host).toBe('0.0.0.0');
    expect(nextConfig.httpserver.port).toBe(6666);
  });

  it('keeps duplicate providers in non-interactive mode when prompt is unavailable', async () => {
    const dir = tmpDir();
    const providerRoot = path.join(dir, 'provider');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(providerRoot, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    writeProviderV2(fs, path, providerRoot, 'openai', {
      id: 'openai',
      enabled: true,
      auth: { type: 'apikey', apiKey: '${KEEP_KEY}' },
      models: { kept: { supportsStreaming: true } }
    });

    const loggerLogs: string[] = [];
    const result = await migrateV1ToV2({
      fsImpl: fs,
      pathImpl: path,
      configPath,
      providerRoot,
      v1Config: {
        providers: {
          openai: {
            id: 'openai',
            enabled: true,
            auth: { type: 'apikey', apiKey: '${NEW_KEY}' },
            models: { new: { supportsStreaming: true } }
          }
        }
      },
      spinner: createSpinner([]),
      logger: {
        info: (msg) => loggerLogs.push(msg),
        warning: () => {},
        success: () => {},
        error: () => {}
      }
    });

    expect(result.convertedProviders).toEqual([]);
    expect(loggerLogs.join('\n')).toContain('keeping existing config.v2.json in non-interactive mode');

    const openaiPayload = JSON.parse(fs.readFileSync(getProviderV2Path(path, providerRoot, 'openai'), 'utf8'));
    expect(openaiPayload.provider.auth.apiKey).toBe('${KEEP_KEY}');
  });

  it('runs v2 maintenance menu for add/modify models+auth/save flow', async () => {
    const dir = tmpDir();
    const providerRoot = path.join(dir, 'provider');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(providerRoot, { recursive: true });
    const config = {
      virtualrouterMode: 'v2',
      httpserver: { host: '127.0.0.1', port: 5555 },
      virtualrouter: {
        routing: {
          default: [{ targets: ['openai.gpt-5.2'] }]
        }
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

    const logs: string[] = [];
    await runV2MaintenanceMenu({
      prompt: queuePrompt([
        '1', // add
        '3', // standard built-in only
        '1', // pick openai
        '3', // modify
        '1', // pick openai
        '5', // edit models/default
        '1', // add models
        'gpt-5.2-codex,gpt-4.1-mini',
        '3', // set default
        'gpt-5.2-codex',
        '2', // remove model
        'gpt-4.1-mini',
        '4', // back model editor
        '6', // auth editor
        '2', // api key env
        '', // use default OPENAI_API_KEY
        '1', // auth type
        'cookie-auth',
        '3', // token/cookie path
        '/tmp/openai.cookie',
        '4', // back auth editor
        '4', // save provider
        '6' // save config & exit
      ]),
      fsImpl: fs,
      pathImpl: path,
      configPath,
      providerRoot,
      config,
      catalog: testCatalog(),
      spinner: createSpinner(logs),
      logger: {
        info: (msg) => logs.push(`log:${msg}`),
        warning: () => {},
        success: () => {},
        error: () => {}
      }
    });

    const payload = JSON.parse(fs.readFileSync(getProviderV2Path(path, providerRoot, 'openai'), 'utf8'));
    expect(payload.provider.defaultModel).toBe('gpt-5.2-codex');
    expect(Object.keys(payload.provider.models).sort()).toEqual(['gpt-5.2', 'gpt-5.2-codex']);
    expect(payload.provider.auth.type).toBe('cookie-auth');
    expect(payload.provider.auth.cookieFile).toBe('/tmp/openai.cookie');
    expect(payload.provider.auth.apiKey).toBeUndefined();
    expect(logs.join('\n')).toContain('succeed:Configuration updated');
  });

  it('covers custom add/delete/list/missing-target warning flow', async () => {
    const dir = tmpDir();
    const providerRoot = path.join(dir, 'provider');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(providerRoot, { recursive: true });

    const config = {
      virtualrouterMode: 'v2',
      httpserver: { host: '127.0.0.1', port: 5555 },
      virtualrouter: {
        routing: {
          default: [{ targets: ['openai.gpt-5.2'] }]
        }
      }
    };

    writeProviderV2(fs, path, providerRoot, 'openai', {
      id: 'openai',
      enabled: true,
      type: 'openai',
      auth: { type: 'apikey', apiKey: '${OPENAI_API_KEY}' },
      models: { 'gpt-5.2': { supportsStreaming: true } }
    });

    const logs: string[] = [];
    await runV2MaintenanceMenu({
      prompt: queuePrompt([
        '1', // add
        '2', // custom provider
        'customp',
        '', // protocol default(openai)
        '', // base url
        '', // model ids default-model
        '', // env var
        '5', // list providers
        '2', // delete provider
        '2', // openai
        'n', // cancel
        '2', // delete provider again
        '2', // openai
        'y', // confirm
        '6', // save -> should warn missing target
        '7' // exit without saving
      ]),
      fsImpl: fs,
      pathImpl: path,
      configPath,
      providerRoot,
      config,
      catalog: testCatalog(),
      spinner: createSpinner(logs),
      logger: {
        info: (msg) => logs.push(`log:${msg}`),
        warning: () => {},
        success: () => {},
        error: () => {}
      }
    });

    const customPath = getProviderV2Path(path, providerRoot, 'customp');
    expect(fs.existsSync(customPath)).toBe(true);
    expect(fs.existsSync(getProviderV2Path(path, providerRoot, 'openai'))).toBe(false);
    expect(logs.join('\n')).toContain('warn:Routing has targets for missing providers: openai.gpt-5.2');
    expect(logs.join('\n')).toContain('info:Exit without saving changes to main config.');
  });

  it('covers menu back/invalid branches plus routing edit save path', async () => {
    const dir = tmpDir();
    const providerRoot = path.join(dir, 'provider');
    const configPath = path.join(dir, 'config.json');
    fs.mkdirSync(providerRoot, { recursive: true });

    writeProviderV2(fs, path, providerRoot, 'qwen', {
      id: 'qwen',
      enabled: true,
      type: 'openai',
      auth: { type: 'apikey', apiKey: '${QWEN_API_KEY}' },
      models: { 'qwen-plus': { supportsStreaming: true } }
    });
    writeProviderV2(fs, path, providerRoot, 'customx', {
      id: 'customx',
      enabled: true,
      type: 'openai',
      auth: { type: 'apikey', apiKey: '${CUSTOMX_API_KEY}' },
      models: { 'model-a': { supportsStreaming: true } }
    });

    const config = {
      virtualrouterMode: 'v2',
      httpserver: { host: '127.0.0.1', port: 5555 },
      virtualrouter: {
        routing: {
          default: [{ targets: ['qwen.qwen-plus'] }]
        }
      }
    };

    const logs: string[] = [];
    await runV2MaintenanceMenu({
      prompt: queuePrompt([
        '1', // add
        'b', // back to V2 menu
        '1', // add
        '9', // unknown mode
        '1', // add
        '3', // standard built-in
        'b', // back from selection
        '1', // add
        '3', // standard built-in
        '99', // invalid provider selection
        '1', // add
        '1', // managed mode
        '1', // qwen (exists)
        'x', // invalid resolution
        '1', // add
        '1', // managed mode
        '1', // qwen (exists)
        'k', // keep existing provider
        '2', // delete
        'b', // back
        '2', // delete
        '99', // invalid
        '2', // delete
        '1', // customx
        'b', // back on confirm
        '3', // modify
        'b', // back
        '3', // modify
        '99', // invalid
        '3', // modify
        '1', // customx
        '2', // set baseurl
        'b', // back in baseurl edit
        '3', // replace template (none)
        '5', // model editor
        '2', // remove model
        'missing', // model not found
        '2', // remove model
        'model-a', // cannot remove last model
        '3', // default model id
        '', // empty default
        '3', // default model id
        'missing-model', // missing model
        '1', // add model
        'b', // back from add model ids
        '9', // unknown model action
        '4', // back
        '6', // auth editor
        '1', // set auth type
        '', // empty auth type
        '1', // set auth type
        'b', // back
        '2', // set API env
        'b', // back
        '3', // set token/cookie
        '', // empty token path
        '9', // unknown auth action
        '4', // back
        '1', // toggle enabled
        '9', // unknown modify action
        'b', // exit modify without save
        '4', // modify routing
        'b', // cancel routing wizard
        '4', // modify routing again
        '', // keep default route
        '', // keep thinking route
        '', // keep tools route
        'save', // save routing wizard
        '6' // save and exit
      ]),
      fsImpl: fs,
      pathImpl: path,
      configPath,
      providerRoot,
      config,
      catalog: testCatalog(),
      spinner: createSpinner(logs),
      logger: {
        info: (msg) => logs.push(`log:${msg}`),
        warning: () => {},
        success: () => {},
        error: () => {}
      }
    });

    expect(logs.join('\n')).toContain('log:Back to V2 menu.');
    expect(logs.join('\n')).toContain('log:Unknown add mode.');
    expect(logs.join('\n')).toContain('log:Invalid choice. Use o / k / b.');
    expect(logs.join('\n')).toContain('log:Skipped existing provider: qwen');
    expect(logs.join('\n')).toContain('log:No managed-auth template for provider customx');
    expect(logs.join('\n')).toContain('log:Back to V2 menu without routing changes.');
    expect(logs.join('\n')).toContain(`succeed:Configuration updated: ${configPath}`);
  });
});
