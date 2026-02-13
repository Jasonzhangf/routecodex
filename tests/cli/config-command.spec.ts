import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';
import path from 'node:path';

import { createConfigCommand } from '../../src/cli/commands/config.js';
import { createInitCommand } from '../../src/cli/commands/init.js';
import { installBundledDefaultConfigBestEffort } from '../../src/cli/config/bundled-default-config.js';
import { buildInitConfigObject, initializeConfigV1, parseProvidersArg } from '../../src/cli/config/init-config.js';
import { installBundledDocsBestEffort } from '../../src/cli/config/bundled-docs.js';

describe('cli config command', () => {
  it('validate reports invalid json', async () => {
    const errors: string[] = [];
    const success: string[] = [];

    const program = new Command();
    createConfigCommand(program, {
      logger: {
        info: () => {},
        warning: () => {},
        success: (msg) => success.push(msg),
        error: (msg) => errors.push(msg)
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => true,
        readFileSync: () => '{ not-json',
        writeFileSync: () => {},
        mkdirSync: () => {}
      }
    });

    await program.parseAsync(['node', 'routecodex', 'config', 'validate', '--config', '/tmp/config.json'], { from: 'node' });

    expect(success.join('\n')).toBe('');
    expect(errors.join('\n')).toContain('Configuration is invalid');
  });

  it('show prints config when file exists', async () => {
    const printed: string[] = [];
    const program = new Command();
    createConfigCommand(program, {
      logger: {
        info: () => {},
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({ server: { port: 5520 } }),
        writeFileSync: () => {},
        mkdirSync: () => {}
      },
      log: (line) => printed.push(line)
    });

    await program.parseAsync(['node', 'routecodex', 'config', 'show', '--config', '/tmp/config.json'], { from: 'node' });

    const parsed = JSON.parse(printed.join('\n'));
    expect(parsed.server.port).toBe(5520);
  });

  it('show reports missing config when file does not exist', async () => {
    const errors: string[] = [];
    const program = new Command();
    createConfigCommand(program, {
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: (msg) => errors.push(msg) },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => false,
        readFileSync: () => '',
        writeFileSync: () => {},
        mkdirSync: () => {}
      }
    });

    await program.parseAsync(['node', 'routecodex', 'config', 'show', '--config', '/tmp/missing.json'], { from: 'node' });
    expect(errors.join('\n')).toContain('Configuration file not found');
  });

  it('validate reports valid json', async () => {
    const errors: string[] = [];
    const success: string[] = [];
    const program = new Command();
    createConfigCommand(program, {
      logger: {
        info: () => {},
        warning: () => {},
        success: (msg) => success.push(msg),
        error: (msg) => errors.push(msg)
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({ httpserver: { port: 1 } }),
        writeFileSync: () => {},
        mkdirSync: () => {}
      }
    });

    await program.parseAsync(['node', 'routecodex', 'config', 'validate', '--config', '/tmp/config.json'], { from: 'node' });

    expect(errors.join('\n')).toBe('');
    expect(success.join('\n')).toContain('Configuration is valid');
  });

  it('validate reports missing config when file does not exist', async () => {
    const errors: string[] = [];
    const program = new Command();
    createConfigCommand(program, {
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: (msg) => errors.push(msg) },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => false,
        readFileSync: () => '',
        writeFileSync: () => {},
        mkdirSync: () => {}
      }
    });

    await program.parseAsync(['node', 'routecodex', 'config', 'validate', '--config', '/tmp/missing.json'], { from: 'node' });
    expect(errors.join('\n')).toContain('Configuration file not found');
  });

  it('unknown action reports error', async () => {
    const errors: string[] = [];
    const program = new Command();
    createConfigCommand(program, {
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: (msg) => errors.push(msg) },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any
    });

    await program.parseAsync(['node', 'routecodex', 'config', 'nope'], { from: 'node' });
    expect(errors.join('\n')).toContain('Unknown action');
  });

  it('top-level error is caught and reported', async () => {
    const errors: string[] = [];
    const program = new Command();
    createConfigCommand(program, {
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: (msg) => errors.push(msg) },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      pathImpl: {
        join: (() => {
          throw new Error('boom');
        }) as any,
        dirname: path.dirname,
        resolve: path.resolve
      } as any
    });

    await program.parseAsync(['node', 'routecodex', 'config', 'show'], { from: 'node' });
    expect(errors.join('\n')).toContain('Config command failed');
  });

  it('init (non-interactive) writes config when --providers is provided', async () => {
    const writes = new Map<string, string>();
    const program = new Command();
    createConfigCommand(program, {
      logger: {
        info: () => {},
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => false,
        readFileSync: () => '',
        writeFileSync: (p: any, content: any) => {
          writes.set(String(p), String(content));
        },
        mkdirSync: () => {}
      },
      pathImpl: path as any,
      getHomeDir: () => '/tmp'
    });

    await program.parseAsync(
      ['node', 'routecodex', 'config', 'init', '--config', '/tmp/config.json', '--providers', 'openai', '--force'],
      { from: 'node' }
    );

    expect(writes.has('/tmp/config.json')).toBe(true);
    const parsed = JSON.parse(writes.get('/tmp/config.json') || '{}');
    expect(parsed?.virtualrouter?.providers?.openai).toBeTruthy();
  });

  it('edit spawns editor with config path', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const program = new Command();
    createConfigCommand(program, {
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      env: { EDITOR: 'vim' },
      spawnImpl: ((cmd: any, args: any) => {
        calls.push({ cmd: String(cmd), args: Array.isArray(args) ? args.map(String) : [] });
        return {} as any;
      }) as any
    });

    await program.parseAsync(['node', 'routecodex', 'config', 'edit', '--config', '/tmp/config.json'], { from: 'node' });

    expect(calls.length).toBe(1);
    expect(calls[0].cmd).toBe('vim');
    expect(calls[0].args[0]).toBe('/tmp/config.json');
  });

  it('init reports error when non-interactive and no providers are provided', async () => {
    const errors: string[] = [];
    const program = new Command();
    createConfigCommand(program, {
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: (msg) => errors.push(msg) },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => false,
        readFileSync: () => '',
        writeFileSync: () => {},
        mkdirSync: () => {}
      }
    });

    await program.parseAsync(['node', 'routecodex', 'config', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    expect(errors.join('\n')).toContain('Non-interactive init requires --providers or --template');
  });

  it('init supports --template as provider id', async () => {
    const writes = new Map<string, string>();
    const program = new Command();
    createConfigCommand(program, {
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => false,
        readFileSync: () => '',
        writeFileSync: (p: any, content: any) => writes.set(String(p), String(content)),
        mkdirSync: () => {}
      }
    });

    await program.parseAsync(
      ['node', 'routecodex', 'config', 'init', '--config', '/tmp/config.json', '--template', 'openai', '--force'],
      { from: 'node' }
    );

    expect(JSON.parse(writes.get('/tmp/config.json') || '{}')?.virtualrouter?.providers?.openai).toBeTruthy();
  });
});

describe('cli init command', () => {
  it('init (non-interactive) writes config when --providers is provided', async () => {
    const writes = new Map<string, string>();
    const program = new Command();
    createInitCommand(program, {
      logger: {
        info: () => {},
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => false,
        readFileSync: () => '',
        writeFileSync: (p: any, content: any) => {
          writes.set(String(p), String(content));
        },
        mkdirSync: () => {}
      },
      pathImpl: path as any,
      getHomeDir: () => '/tmp'
    });

    await program.parseAsync(
      ['node', 'routecodex', 'init', '--config', '/tmp/config.json', '--providers', 'openai', '--force'],
      { from: 'node' }
    );

    expect(writes.has('/tmp/config.json')).toBe(true);
    const parsed = JSON.parse(writes.get('/tmp/config.json') || '{}');
    expect(parsed?.virtualrouterMode).toBe('v2');
    expect(parsed?.virtualrouter?.routing?.default?.[0]?.targets?.[0]).toContain('openai.');
    const providerV2 = JSON.parse(writes.get('/tmp/.routecodex/provider/openai/config.v2.json') || '{}');
    expect(providerV2?.providerId).toBe('openai');
  });

  it('init (non-interactive) injects model-less iflow webSearch defaults when iflow is selected', async () => {
    const writes = new Map<string, string>();
    const program = new Command();
    createInitCommand(program, {
      logger: {
        info: () => {},
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => false,
        readFileSync: () => '',
        writeFileSync: (p: any, content: any) => {
          writes.set(String(p), String(content));
        },
        mkdirSync: () => {}
      },
      pathImpl: path as any,
      getHomeDir: () => '/tmp'
    });

    await program.parseAsync(
      ['node', 'routecodex', 'init', '--config', '/tmp/config.json', '--providers', 'iflow', '--force'],
      { from: 'node' }
    );

    const parsed = JSON.parse(writes.get('/tmp/config.json') || '{}');
    expect(parsed?.virtualrouter?.routing?.web_search?.[0]?.targets?.[0]).toContain('iflow.');
    expect(parsed?.virtualrouter?.webSearch?.engines?.[0]?.id).toBe('iflow:web_search');
    expect(parsed?.virtualrouter?.webSearch?.engines?.[0]?.providerKey).toBe('iflow');
    expect(parsed?.virtualrouter?.webSearch?.search?.['iflow:web_search']?.providerKey).toBe('iflow');
  });

  it('init prepares camoufox environment when selected provider requires oauth/deepseek fingerprint', async () => {
    const writes = new Map<string, string>();
    let prepareCalls = 0;
    const program = new Command();
    createInitCommand(program, {
      logger: {
        info: () => {},
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => false,
        readFileSync: () => '',
        writeFileSync: (p: any, content: any) => {
          writes.set(String(p), String(content));
        },
        mkdirSync: () => {}
      },
      pathImpl: path as any,
      getHomeDir: () => '/tmp',
      prepareCamoufoxEnvironment: () => {
        prepareCalls += 1;
        return true;
      }
    });

    await program.parseAsync(
      ['node', 'routecodex', 'init', '--config', '/tmp/config.json', '--providers', 'deepseek-web', '--force'],
      { from: 'node' }
    );

    expect(writes.has('/tmp/config.json')).toBe(true);
    expect(prepareCalls).toBe(1);
  });

  it('init supports explicit --camoufox trigger even when selected provider does not require it', async () => {
    const writes = new Map<string, string>();
    let prepareCalls = 0;
    const program = new Command();
    createInitCommand(program, {
      logger: {
        info: () => {},
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => false,
        readFileSync: () => '',
        writeFileSync: (p: any, content: any) => {
          writes.set(String(p), String(content));
        },
        mkdirSync: () => {}
      },
      pathImpl: path as any,
      getHomeDir: () => '/tmp',
      prepareCamoufoxEnvironment: () => {
        prepareCalls += 1;
        return true;
      }
    });

    await program.parseAsync(
      ['node', 'routecodex', 'init', '--config', '/tmp/config.json', '--providers', 'openai', '--camoufox', '--force'],
      { from: 'node' }
    );

    expect(writes.has('/tmp/config.json')).toBe(true);
    expect(prepareCalls).toBe(1);
  });

  it('init copies bundled default config when config is missing and no providers are specified', async () => {
    const writes = new Map<string, string>();
    const infos: string[] = [];
    const warnings: string[] = [];
    const sourcePath = '/pkg/dist/configsamples/config.v1.quickstart.sanitized.json';
    const bundledContent = JSON.stringify({
      version: '1.0.0',
      virtualrouterMode: 'v1',
      httpserver: { host: '127.0.0.1', port: 5555 }
    });
    let promptCalls = 0;

    const program = new Command();
    createInitCommand(program, {
      logger: {
        info: (msg) => infos.push(msg),
        warning: (msg) => warnings.push(msg),
        success: () => {},
        error: () => {}
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: (p: any) => {
          const target = String(p);
          if (target === '/tmp/config.json') {
            return false;
          }
          return target.endsWith('/config.v1.quickstart.sanitized.json') || target === sourcePath;
        },
        readFileSync: (p: any) => {
          const target = String(p);
          if (target === sourcePath || target.endsWith('/config.v1.quickstart.sanitized.json')) {
            return bundledContent;
          }
          return '';
        },
        writeFileSync: (p: any, content: any) => {
          writes.set(String(p), String(content));
        },
        mkdirSync: () => {}
      } as any,
      pathImpl: path as any,
      getHomeDir: () => '/tmp',
      prompt: async () => {
        promptCalls += 1;
        return '';
      }
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    expect(writes.get('/tmp/config.json')).toBe(bundledContent);
    expect(infos.join('\n')).toContain('Default config copied');
    expect(warnings.length).toBe(0);
    expect(promptCalls).toBe(0);
  });

  it('init supports interactive flow via ctx.prompt', async () => {
    const writes = new Map<string, string>();
    const answers = ['0.0.0.0', '8888', '', '', '', 'save'];
    const program = new Command();
    createInitCommand(program, {
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => false,
        readFileSync: () => '',
        writeFileSync: (p: any, content: any) => writes.set(String(p), String(content)),
        mkdirSync: () => {}
      },
      getHomeDir: () => '/tmp',
      prompt: async () => String(answers.shift() ?? '')
    });

    await program.parseAsync(
      ['node', 'routecodex', 'init', '--config', '/tmp/config.json', '--providers', 'openai', '--force'],
      { from: 'node' }
    );

    const parsed = JSON.parse(writes.get('/tmp/config.json') || '{}');
    expect(parsed.httpserver.host).toBe('0.0.0.0');
    expect(parsed.httpserver.port).toBe(8888);
    expect(parsed.virtualrouterMode).toBe('v2');
    const providerV2 = JSON.parse(writes.get('/tmp/.routecodex/provider/openai/config.v2.json') || '{}');
    expect(providerV2?.providerId).toBe('openai');
  });

  it('list-providers prints provider ids and does not write config', async () => {
    const infos: string[] = [];
    let wrote = false;
    const program = new Command();
    createInitCommand(program, {
      logger: {
        info: (msg) => infos.push(msg),
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => false,
        readFileSync: () => '',
        writeFileSync: () => {
          wrote = true;
        },
        mkdirSync: () => {}
      }
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--list-providers'], { from: 'node' });

    expect(wrote).toBe(false);
    expect(infos.join('\n')).toContain('openai');
  });

  it('list-current-providers prints configured provider summary', async () => {
    const infos: string[] = [];
    const program = new Command();
    createInitCommand(program, {
      logger: {
        info: (msg) => infos.push(msg),
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: (p: any) => {
          const target = String(p);
          return (
            target === '/tmp/.routecodex/provider' ||
            target === '/tmp/.routecodex/provider/openai/config.v2.json' ||
            target === '/tmp/.routecodex/provider/glm/config.v2.json'
          );
        },
        readdirSync: () => [
          { name: 'openai', isDirectory: () => true },
          { name: 'glm', isDirectory: () => true }
        ],
        readFileSync: (p: any) => {
          const target = String(p);
          if (target.includes('/openai/config.v2.json')) {
            return JSON.stringify({
              version: '2.0.0',
              providerId: 'openai',
              provider: {
                enabled: true,
                baseURL: 'https://api.openai.com',
                auth: { type: 'apikey', keys: { key1: 'sk-live-abcdef123' } },
                models: { 'gpt-5.2': {}, 'gpt-5.3': {} }
              }
            });
          }
          if (target.includes('/glm/config.v2.json')) {
            return JSON.stringify({
              version: '2.0.0',
              providerId: 'glm',
              provider: {
                enabled: false,
                auth: {
                  type: 'gemini-cli-oauth',
                  entries: [
                    { alias: 'alice', tokenFile: '~/.routecodex/auth/gemini-oauth-1-alice.json' },
                    { alias: 'bob', tokenFile: '~/.routecodex/auth/gemini-oauth-2-bob.json' }
                  ]
                },
                models: { 'glm-4.7': {} }
              }
            });
          }
          return '';
        },
        writeFileSync: () => {},
        mkdirSync: () => {}
      } as any,
      getHomeDir: () => '/tmp',
      pathImpl: path as any
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--list-current-providers'], { from: 'node' });

    expect(infos.join('\n')).toContain('Configured providers (2):');
    expect(infos.join('\n')).toContain('openai | enabled | models=2 | keys=1 [****123] | oauth=- | baseURL=https://api.openai.com');
    expect(infos.join('\n')).toContain(
      'glm | disabled | models=1 | keys=0 | oauth=alice(gemini-oauth-1-alice.json), bob(gemini-oauth-2-bob.json) | baseURL=(unset)'
    );
  });

  it('v2 maintenance menu can list providers', async () => {
    const infos: string[] = [];
    const writes: string[] = [];
    const answers = ['5', '7'];
    const program = new Command();
    createInitCommand(program, {
      logger: {
        info: (msg) => infos.push(msg),
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: (msg: string) => infos.push(msg),
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: (p: any) => {
          const target = String(p);
          return (
            target === '/tmp/config.json' ||
            target === '/tmp/.routecodex/provider' ||
            target === '/tmp/.routecodex/provider/openai/config.v2.json'
          );
        },
        readdirSync: () => [{ name: 'openai', isDirectory: () => true }],
        readFileSync: (p: any) => {
          const target = String(p);
          if (target === '/tmp/config.json') {
            return JSON.stringify({
              version: '2.0.0',
              virtualrouterMode: 'v2',
              httpserver: { host: '127.0.0.1', port: 5520 },
              virtualrouter: { routing: { default: [{ id: 'primary', mode: 'priority', targets: ['openai.gpt-5.2'] }] } }
            });
          }
          if (target.includes('/openai/config.v2.json')) {
            return JSON.stringify({
              version: '2.0.0',
              providerId: 'openai',
              provider: {
                enabled: true,
                auth: { type: 'apikey', apiKey: 'sk-test-xyz789' },
                models: { 'gpt-5.2': {} }
              }
            });
          }
          return '';
        },
        writeFileSync: (p: any) => writes.push(String(p)),
        mkdirSync: () => {},
        rmdirSync: () => {},
        unlinkSync: () => {}
      } as any,
      getHomeDir: () => '/tmp',
      pathImpl: path as any,
      prompt: async () => String(answers.shift() ?? '')
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    expect(infos.join('\n')).toContain('Configured providers (1):');
    expect(infos.join('\n')).toContain('openai | enabled | models=1 | keys=1 [****789] | oauth=- | baseURL=(unset)');
    expect(infos.join('\n')).toContain('Exit without saving changes to main config.');
    expect(writes.some((item) => item === '/tmp/config.json')).toBe(false);
  });

  it('v2 maintenance add custom provider supports protocol selection and writes config.v2.json', async () => {
    const infos: string[] = [];
    const writes = new Map<string, string>();
    const answers = [
      '1',
      '2',
      'custom-gemini',
      '4',
      'https://gemini.example.com/v1beta',
      'gemini-2.5-pro',
      'CUSTOM_GEMINI_KEY',
      '7'
    ];
    const program = new Command();
    createInitCommand(program, {
      logger: {
        info: (msg) => infos.push(msg),
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: (p: any) => {
          const target = String(p);
          return target === '/tmp/config.json' || target === '/tmp/.routecodex/provider';
        },
        readdirSync: () => [],
        readFileSync: (p: any) => {
          const target = String(p);
          if (target === '/tmp/config.json') {
            return JSON.stringify({
              version: '2.0.0',
              virtualrouterMode: 'v2',
              httpserver: { host: '127.0.0.1', port: 5520 },
              virtualrouter: { routing: { default: [{ id: 'primary', mode: 'priority', targets: ['openai.gpt-5.2'] }] } }
            });
          }
          return '';
        },
        writeFileSync: (p: any, content: any) => writes.set(String(p), String(content)),
        mkdirSync: () => {},
        rmdirSync: () => {},
        unlinkSync: () => {}
      } as any,
      getHomeDir: () => '/tmp',
      pathImpl: path as any,
      prompt: async () => String(answers.shift() ?? '')
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    const customPath = '/tmp/.routecodex/provider/custom-gemini/config.v2.json';
    expect(writes.has(customPath)).toBe(true);
    const payload = JSON.parse(writes.get(customPath) || '{}');
    expect(payload.providerId).toBe('custom-gemini');
    expect(payload.provider?.type).toBe('gemini');
    expect(payload.provider?.baseURL).toBe('https://gemini.example.com/v1beta');
    expect(payload.provider?.auth?.apiKey).toBe('${CUSTOM_GEMINI_KEY}');
    expect(payload.provider?.models?.['gemini-2.5-pro']).toBeTruthy();
    expect(infos.join('\n')).toContain('Added custom provider: custom-gemini');
  });

  it('v2 maintenance add custom provider shows validation hints for invalid mode and protocol', async () => {
    const infos: string[] = [];
    const writes = new Map<string, string>();
    const answers = [
      '1',
      '9',
      '1',
      '2',
      'custom-openai',
      '9',
      '1',
      '',
      'gpt-5.2',
      '',
      '7'
    ];
    const program = new Command();
    createInitCommand(program, {
      logger: {
        info: (msg) => infos.push(msg),
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: (msg: string) => infos.push(msg),
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: (p: any) => {
          const target = String(p);
          return target === '/tmp/config.json' || target === '/tmp/.routecodex/provider';
        },
        readdirSync: () => [],
        readFileSync: (p: any) => {
          const target = String(p);
          if (target === '/tmp/config.json') {
            return JSON.stringify({
              version: '2.0.0',
              virtualrouterMode: 'v2',
              httpserver: { host: '127.0.0.1', port: 5520 },
              virtualrouter: { routing: { default: [{ id: 'primary', mode: 'priority', targets: ['openai.gpt-5.2'] }] } }
            });
          }
          return '';
        },
        writeFileSync: (p: any, content: any) => writes.set(String(p), String(content)),
        mkdirSync: () => {},
        rmdirSync: () => {},
        unlinkSync: () => {}
      } as any,
      getHomeDir: () => '/tmp',
      pathImpl: path as any,
      prompt: async () => String(answers.shift() ?? '')
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    expect(infos.join('\n')).toContain('Unknown add mode. Choose 1 (built-in), 2 (custom), or b (back).');
    expect(infos.join('\n')).toContain('Invalid protocol choice. Select 1/2/3/4.');
    expect(writes.has('/tmp/.routecodex/provider/custom-openai/config.v2.json')).toBe(true);
  });

  it('v2 maintenance add built-in provider can overwrite existing provider and supports back', async () => {
    const infos: string[] = [];
    const writes = new Map<string, string>();
    const answers = [
      '1',
      '1',
      '1',
      'o',
      '1',
      '1',
      '1',
      'k',
      '1',
      'b',
      '7'
    ];

    const program = new Command();
    createInitCommand(program, {
      logger: {
        info: (msg) => infos.push(msg),
        warning: () => {},
        success: () => {},
        error: () => {}
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: (p: any) => {
          const target = String(p);
          return (
            target === '/tmp/config.json' ||
            target === '/tmp/.routecodex/provider' ||
            target === '/tmp/.routecodex/provider/openai/config.v2.json'
          );
        },
        readdirSync: () => [{ name: 'openai', isDirectory: () => true }],
        readFileSync: (p: any) => {
          const target = String(p);
          if (target === '/tmp/config.json') {
            return JSON.stringify({
              version: '2.0.0',
              virtualrouterMode: 'v2',
              httpserver: { host: '127.0.0.1', port: 5520 },
              virtualrouter: { routing: { default: [{ id: 'primary', mode: 'priority', targets: ['openai.gpt-5.2'] }] } }
            });
          }
          if (target === '/tmp/.routecodex/provider/openai/config.v2.json') {
            return JSON.stringify({
              version: '2.0.0',
              providerId: 'openai',
              provider: { id: 'openai', enabled: true, type: 'openai', baseURL: 'https://old.example.com', models: { old: {} } }
            });
          }
          return '';
        },
        writeFileSync: (p: any, content: any) => writes.set(String(p), String(content)),
        mkdirSync: () => {},
        rmdirSync: () => {},
        unlinkSync: () => {}
      } as any,
      getHomeDir: () => '/tmp',
      pathImpl: path as any,
      prompt: async () => String(answers.shift() ?? '')
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    const openaiPath = '/tmp/.routecodex/provider/openai/config.v2.json';
    expect(writes.has(openaiPath)).toBe(true);
    const payload = JSON.parse(writes.get(openaiPath) || '{}');
    expect(payload.provider?.baseURL).toBe('https://api.openai.com/v1');
    expect(infos.join('\n')).toContain('Updated built-in provider template: openai');
    expect(infos.join('\n')).toContain('Skipped existing provider: openai');
    expect(infos.join('\n')).toContain('Back to V2 menu.');
  });

  it('v2 maintenance delete provider supports back and cancel', async () => {
    const infos: string[] = [];
    const writes: string[] = [];
    const answers = ['2', 'b', '2', '1', 'n', '7'];

    const program = new Command();
    createInitCommand(program, {
      logger: { info: (msg) => infos.push(msg), warning: () => {}, success: () => {}, error: () => {} },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: (p: any) => {
          const target = String(p);
          return (
            target === '/tmp/config.json' ||
            target === '/tmp/.routecodex/provider' ||
            target === '/tmp/.routecodex/provider/openai/config.v2.json'
          );
        },
        readdirSync: () => [{ name: 'openai', isDirectory: () => true }],
        readFileSync: (p: any) => {
          const target = String(p);
          if (target === '/tmp/config.json') {
            return JSON.stringify({
              version: '2.0.0',
              virtualrouterMode: 'v2',
              httpserver: { host: '127.0.0.1', port: 5520 },
              virtualrouter: { routing: { default: [{ id: 'primary', mode: 'priority', targets: ['openai.gpt-5.2'] }] } }
            });
          }
          if (target === '/tmp/.routecodex/provider/openai/config.v2.json') {
            return JSON.stringify({
              version: '2.0.0',
              providerId: 'openai',
              provider: { id: 'openai', enabled: true, type: 'openai', models: { 'gpt-5.2': {} } }
            });
          }
          return '';
        },
        writeFileSync: (p: any) => writes.push(String(p)),
        mkdirSync: () => {},
        rmdirSync: () => {},
        unlinkSync: (p: any) => writes.push(`unlink:${String(p)}`)
      } as any,
      getHomeDir: () => '/tmp',
      pathImpl: path as any,
      prompt: async () => String(answers.shift() ?? '')
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    expect(infos.join('\n')).toContain('Back to V2 menu.');
    expect(infos.join('\n')).toContain('Delete cancelled: openai');
    expect(writes.some((line) => line.startsWith('unlink:'))).toBe(false);
  });

  it('v2 maintenance modify provider supports back without saving', async () => {
    const infos: string[] = [];
    const writes = new Map<string, string>();
    const answers = ['3', '1', '2', 'b', 'b', '7'];

    const program = new Command();
    createInitCommand(program, {
      logger: { info: (msg) => infos.push(msg), warning: () => {}, success: () => {}, error: () => {} },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: (p: any) => {
          const target = String(p);
          return (
            target === '/tmp/config.json' ||
            target === '/tmp/.routecodex/provider' ||
            target === '/tmp/.routecodex/provider/openai/config.v2.json'
          );
        },
        readdirSync: () => [{ name: 'openai', isDirectory: () => true }],
        readFileSync: (p: any) => {
          const target = String(p);
          if (target === '/tmp/config.json') {
            return JSON.stringify({
              version: '2.0.0',
              virtualrouterMode: 'v2',
              httpserver: { host: '127.0.0.1', port: 5520 },
              virtualrouter: { routing: { default: [{ id: 'primary', mode: 'priority', targets: ['openai.gpt-5.2'] }] } }
            });
          }
          if (target === '/tmp/.routecodex/provider/openai/config.v2.json') {
            return JSON.stringify({
              version: '2.0.0',
              providerId: 'openai',
              provider: {
                id: 'openai',
                enabled: true,
                type: 'openai',
                baseURL: 'https://old.example.com',
                models: { 'gpt-5.2': {} }
              }
            });
          }
          return '';
        },
        writeFileSync: (p: any, content: any) => writes.set(String(p), String(content)),
        mkdirSync: () => {},
        rmdirSync: () => {},
        unlinkSync: () => {}
      } as any,
      getHomeDir: () => '/tmp',
      pathImpl: path as any,
      prompt: async () => String(answers.shift() ?? '')
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    expect(infos.join('\n')).toContain('Back to modify-provider menu.');
    expect(infos.join('\n')).toContain('Back to V2 menu without saving provider: openai');
    expect(writes.has('/tmp/.routecodex/provider/openai/config.v2.json')).toBe(false);
  });

  it('v2 maintenance modify routing supports back/cancel without changes', async () => {
    const infos: string[] = [];
    const writes = new Map<string, string>();
    const answers = ['4', 'b', '7'];

    const program = new Command();
    createInitCommand(program, {
      logger: { info: (msg) => infos.push(msg), warning: () => {}, success: () => {}, error: () => {} },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: (p: any) => {
          const target = String(p);
          return target === '/tmp/config.json' || target === '/tmp/.routecodex/provider' || target === '/tmp/.routecodex/provider/openai/config.v2.json';
        },
        readdirSync: () => [{ name: 'openai', isDirectory: () => true }],
        readFileSync: (p: any) => {
          const target = String(p);
          if (target === '/tmp/config.json') {
            return JSON.stringify({
              version: '2.0.0',
              virtualrouterMode: 'v2',
              httpserver: { host: '127.0.0.1', port: 5520 },
              virtualrouter: {
                routing: {
                  default: [{ id: 'primary', mode: 'priority', targets: ['openai.gpt-5.2'] }],
                  thinking: [{ id: 'thinking-primary', mode: 'priority', targets: ['openai.gpt-5.2'] }],
                  tools: [{ id: 'tools-primary', mode: 'priority', targets: ['openai.gpt-5.2'] }]
                }
              }
            });
          }
          if (target === '/tmp/.routecodex/provider/openai/config.v2.json') {
            return JSON.stringify({ version: '2.0.0', providerId: 'openai', provider: { id: 'openai', enabled: true, type: 'openai', models: { 'gpt-5.2': {} } } });
          }
          return '';
        },
        writeFileSync: (p: any, content: any) => writes.set(String(p), String(content)),
        mkdirSync: () => {},
        rmdirSync: () => {},
        unlinkSync: () => {}
      } as any,
      getHomeDir: () => '/tmp',
      pathImpl: path as any,
      prompt: async () => String(answers.shift() ?? '')
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    expect(infos.join('\n')).toContain('Back to V2 menu without routing changes.');
    expect(writes.has('/tmp/config.json')).toBe(false);
  });

  it('init reports error when non-interactive and no providers are provided', async () => {
    const errors: string[] = [];
    const program = new Command();
    createInitCommand(program, {
      logger: {
        info: () => {},
        warning: () => {},
        success: () => {},
        error: (msg) => errors.push(msg)
      },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: () => false,
        readFileSync: () => '',
        writeFileSync: () => {},
        mkdirSync: () => {}
      }
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    expect(errors.join('\n')).toContain('Non-interactive init requires --providers');
  });

  it('prompts before migrating v1 config to v2 (does not auto-convert)', async () => {
    const writes = new Map<string, string>();
    const answers = ['n'];
    const program = new Command();
    createInitCommand(program, {
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: (p: any) => String(p) === '/tmp/config.json',
        readFileSync: () =>
          JSON.stringify({
            version: '1.0.0',
            httpserver: { host: '127.0.0.1', port: 5520 },
            virtualrouter: { providers: { openai: { id: 'openai', type: 'openai', enabled: true, models: { 'gpt-5.2': {} } } } }
          }),
        writeFileSync: (p: any, content: any) => writes.set(String(p), String(content)),
        mkdirSync: () => {},
        readdirSync: () => [],
        rmdirSync: () => {},
        unlinkSync: () => {}
      } as any,
      pathImpl: path as any,
      getHomeDir: () => '/tmp',
      prompt: async () => String(answers.shift() ?? '')
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    expect(writes.size).toBe(0);
  });

  it('treats empty/undefined prompt answer as default yes for v1->v2 conversion', async () => {
    const writes = new Map<string, string>();
    const program = new Command();
    createInitCommand(program, {
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: (p: any) => String(p) === '/tmp/config.json',
        readFileSync: () =>
          JSON.stringify({
            version: '1.0.0',
            httpserver: { host: '127.0.0.1', port: 5520 },
            virtualrouter: { providers: { openai: { id: 'openai', type: 'openai', enabled: true, models: { 'gpt-5.2': {} } } } }
          }),
        writeFileSync: (p: any, content: any) => writes.set(String(p), String(content)),
        mkdirSync: () => {},
        readdirSync: () => [],
        rmdirSync: () => {},
        unlinkSync: () => {}
      } as any,
      pathImpl: path as any,
      getHomeDir: () => '/tmp',
      prompt: async () => undefined as any
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    const parsed = JSON.parse(writes.get('/tmp/config.json') || '{}');
    expect(parsed.virtualrouterMode).toBe('v2');
  });

  it('falls back to default yes when prompt interface closes unexpectedly', async () => {
    const writes = new Map<string, string>();
    const program = new Command();
    createInitCommand(program, {
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: (p: any) => String(p) === '/tmp/config.json',
        readFileSync: () =>
          JSON.stringify({
            version: '1.0.0',
            httpserver: { host: '127.0.0.1', port: 5520 },
            virtualrouter: { providers: { openai: { id: 'openai', type: 'openai', enabled: true, models: { 'gpt-5.2': {} } } } }
          }),
        writeFileSync: (p: any, content: any) => writes.set(String(p), String(content)),
        mkdirSync: () => {},
        readdirSync: () => [],
        rmdirSync: () => {},
        unlinkSync: () => {}
      } as any,
      pathImpl: path as any,
      getHomeDir: () => '/tmp',
      prompt: async () => ''
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    const parsed = JSON.parse(writes.get('/tmp/config.json') || '{}');
    expect(parsed.virtualrouterMode).toBe('v2');
  });

  it('prompts for duplicate provider handling during v1->v2 migration', async () => {
    const writes = new Map<string, string>();
    const answers = ['y', 's', 'k'];
    let startCount = 0;
    let stopCount = 0;
    const program = new Command();
    createInitCommand(program, {
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      createSpinner: async () =>
        ({
          start: () => {
            startCount += 1;
            return {} as any;
          },
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {
            stopCount += 1;
          },
          text: ''
        }) as any,
      fsImpl: {
        existsSync: (p: any) => {
          const path = String(p);
          if (path === '/tmp/config.json') {
            return true;
          }
          if (path === '/tmp/.routecodex/provider/openai/config.v2.json') {
            return true;
          }
          return false;
        },
        readdirSync: () => [{ name: 'openai', isDirectory: () => true }],
        readFileSync: (p: any) => {
          const path = String(p);
          if (path === '/tmp/config.json') {
            return JSON.stringify({
              version: '1.0.0',
              httpserver: { host: '127.0.0.1', port: 5520 },
              virtualrouter: {
                providers: {
                  openai: { id: 'openai', type: 'openai', enabled: true, models: { 'gpt-5.2': {} } }
                }
              }
            });
          }
          if (path === '/tmp/.routecodex/provider/openai/config.v2.json') {
            return JSON.stringify({
              version: '2.0.0',
              providerId: 'openai',
              provider: { id: 'openai', type: 'openai', enabled: true, baseURL: 'https://example.com', models: { 'gpt-5.2': {} } }
            });
          }
          return '';
        },
        writeFileSync: (p: any, content: any) => writes.set(String(p), String(content)),
        mkdirSync: () => {},
        rmdirSync: () => {},
        unlinkSync: () => {}
      } as any,
      pathImpl: path as any,
      getHomeDir: () => '/tmp',
      prompt: async (question) => {
        if (String(question).includes('Detected existing provider configs in provider dir')) {
          expect(stopCount).toBeGreaterThanOrEqual(2);
          expect(startCount).toBeGreaterThanOrEqual(1);
        }
        if (String(question).includes('Provider "openai" already exists')) {
          // Spinner should be stopped before asking how to handle duplicates.
          expect(stopCount).toBeGreaterThanOrEqual(2);
          expect(startCount).toBeGreaterThanOrEqual(1);
        }
        return String(answers.shift() ?? '');
      }
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    expect(startCount).toBeGreaterThanOrEqual(2);
    expect(stopCount).toBeGreaterThanOrEqual(2);

    // Kept existing provider.v2, but should still rewrite main config to v2.
    const parsed = JSON.parse(writes.get('/tmp/config.json') || '{}');
    expect(parsed.virtualrouterMode).toBe('v2');
    expect(writes.has('/tmp/.routecodex/provider/openai/config.v2.json')).toBe(false);
  });

  it('supports overwrite-all strategy during duplicate v1->v2 migration', async () => {
    const writes = new Map<string, string>();
    const answers = ['y', 'a'];
    const program = new Command();
    createInitCommand(program, {
      logger: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
      createSpinner: async () =>
        ({
          start: () => ({} as any),
          succeed: () => {},
          fail: () => {},
          warn: () => {},
          info: () => {},
          stop: () => {},
          text: ''
        }) as any,
      fsImpl: {
        existsSync: (p: any) => {
          const target = String(p);
          return target === '/tmp/config.json' || target === '/tmp/.routecodex/provider/openai/config.v2.json';
        },
        readdirSync: () => [{ name: 'openai', isDirectory: () => true }],
        readFileSync: (p: any) => {
          const target = String(p);
          if (target === '/tmp/config.json') {
            return JSON.stringify({
              version: '1.0.0',
              httpserver: { host: '127.0.0.1', port: 5520 },
              virtualrouter: {
                providers: {
                  openai: {
                    id: 'openai',
                    type: 'openai',
                    enabled: true,
                    baseURL: 'https://new.example.com',
                    models: { 'gpt-5.2': {} }
                  }
                }
              }
            });
          }
          if (target === '/tmp/.routecodex/provider/openai/config.v2.json') {
            return JSON.stringify({
              version: '2.0.0',
              providerId: 'openai',
              provider: {
                id: 'openai',
                type: 'openai',
                enabled: true,
                baseURL: 'https://old.example.com',
                models: { 'gpt-5.1': {} }
              }
            });
          }
          return '';
        },
        writeFileSync: (p: any, content: any) => writes.set(String(p), String(content)),
        mkdirSync: () => {},
        rmdirSync: () => {},
        unlinkSync: () => {}
      } as any,
      pathImpl: path as any,
      getHomeDir: () => '/tmp',
      prompt: async () => String(answers.shift() ?? '')
    });

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json'], { from: 'node' });

    const rewrittenProvider = JSON.parse(writes.get('/tmp/.routecodex/provider/openai/config.v2.json') || '{}');
    expect(rewrittenProvider?.provider?.baseURL).toBe('https://new.example.com');
  });
});

describe('init-config', () => {
  it('returns exists when file exists and not forced', async () => {
    const result = await initializeConfigV1(
      {
        fsImpl: {
          existsSync: () => true,
          mkdirSync: () => {},
          readFileSync: () => '',
          writeFileSync: () => {}
        },
        pathImpl: path as any
      },
      { configPath: '/tmp/config.json', force: false, providers: ['openai'] }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('exists');
    }
  });

  it('returns invalid_selection when defaultProvider is not selected', async () => {
    const result = await initializeConfigV1(
      {
        fsImpl: {
          existsSync: () => false,
          mkdirSync: () => {},
          readFileSync: () => '',
          writeFileSync: () => {}
        },
        pathImpl: path as any
      },
      { configPath: '/tmp/config.json', force: true, providers: ['openai'], defaultProvider: 'tab' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_selection');
    }
  });

  it('returns invalid_selection when provider id is unknown', async () => {
    const result = await initializeConfigV1(
      {
        fsImpl: {
          existsSync: () => false,
          mkdirSync: () => {},
          readFileSync: () => '',
          writeFileSync: () => {}
        },
        pathImpl: path as any
      },
      { configPath: '/tmp/config.json', force: true, providers: ['unknown-provider'] }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_selection');
    }
  });

  it('returns no_providers when providers are missing and non-interactive', async () => {
    const result = await initializeConfigV1(
      {
        fsImpl: {
          existsSync: () => false,
          mkdirSync: () => {},
          readFileSync: () => '',
          writeFileSync: () => {}
        },
        pathImpl: path as any
      },
      { configPath: '/tmp/config.json', force: true }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_providers');
    }
  });

  it('interactive init supports selecting providers + default provider + host/port', async () => {
    const writes = new Map<string, string>();
    const answers = ['1,2', '2', '0.0.0.0', '7777'];
    const result = await initializeConfigV1(
      {
        fsImpl: {
          existsSync: () => false,
          mkdirSync: () => {},
          readFileSync: () => '',
          writeFileSync: (p: any, content: any) => writes.set(String(p), String(content))
        },
        pathImpl: path as any
      },
      { configPath: '/tmp/config.json', force: true },
      {
        prompt: async () => String(answers.shift() ?? '')
      }
    );

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(writes.get('/tmp/config.json') || '{}');
    expect(parsed.httpserver.host).toBe('0.0.0.0');
    expect(parsed.httpserver.port).toBe(7777);
    expect(parsed.virtualrouter.providers.openai).toBeTruthy();
    expect(parsed.virtualrouter.providers.tab).toBeTruthy();
    expect(parsed.virtualrouter.routing.default[0].targets[0]).toContain('tab.');
  });

  it('writes model-less iflow webSearch defaults when iflow is selected', async () => {
    const writes = new Map<string, string>();
    const result = await initializeConfigV1(
      {
        fsImpl: {
          existsSync: () => false,
          mkdirSync: () => {},
          readFileSync: () => '',
          writeFileSync: (p: any, content: any) => writes.set(String(p), String(content))
        },
        pathImpl: path as any
      },
      { configPath: '/tmp/config.json', force: true, providers: ['iflow'] }
    );

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(writes.get('/tmp/config.json') || '{}');
    expect(parsed.webSearch.engines[0].id).toBe('iflow:web_search');
    expect(parsed.webSearch.engines[0].providerKey).toBe('iflow');
    expect(parsed.webSearch.search['iflow:web_search'].providerKey).toBe('iflow');
    expect(parsed.virtualrouter.routing.web_search[0].targets[0]).toContain('iflow.');
  });

  it('does not inject webSearch defaults when iflow is not selected', async () => {
    const writes = new Map<string, string>();
    const result = await initializeConfigV1(
      {
        fsImpl: {
          existsSync: () => false,
          mkdirSync: () => {},
          readFileSync: () => '',
          writeFileSync: (p: any, content: any) => writes.set(String(p), String(content))
        },
        pathImpl: path as any
      },
      { configPath: '/tmp/config.json', force: true, providers: ['openai'] }
    );

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(writes.get('/tmp/config.json') || '{}');
    expect(parsed.webSearch).toBeUndefined();
    expect(parsed.virtualrouter.routing.web_search).toBeUndefined();
  });

  it('buildInitConfigObject throws when providers list is empty', () => {
    expect(() =>
      buildInitConfigObject({ providers: [], defaultProviderId: 'openai', host: '127.0.0.1', port: 1 })
    ).toThrow('No providers selected');
  });

  it('interactive init uses defaults when host/port are empty, and defaults provider selection when blank', async () => {
    const writes = new Map<string, string>();
    // provider selection blank => default=1, default provider selection not asked (single provider),
    // host/port blank => defaults (127.0.0.1:5555)
    const answers = ['', '', '', ''];
    const result = await initializeConfigV1(
      {
        fsImpl: {
          existsSync: () => false,
          mkdirSync: () => {},
          readFileSync: () => '',
          writeFileSync: (p: any, content: any) => writes.set(String(p), String(content))
        },
        pathImpl: path as any
      },
      { configPath: '/tmp/config.json', force: true },
      {
        prompt: async () => String(answers.shift() ?? '')
      }
    );
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(writes.get('/tmp/config.json') || '{}');
    expect(parsed.httpserver.host).toBe('127.0.0.1');
    expect(parsed.httpserver.port).toBe(5555);
    expect(parsed.virtualrouter.providers.openai).toBeTruthy();
  });

  it('returns write_failed when writeFileSync throws', async () => {
    const result = await initializeConfigV1(
      {
        fsImpl: {
          existsSync: () => false,
          mkdirSync: () => {},
          readFileSync: () => '',
          writeFileSync: () => {
            throw new Error('disk full');
          }
        },
        pathImpl: path as any
      },
      { configPath: '/tmp/config.json', force: true, providers: ['openai'] }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('write_failed');
      expect(result.message).toContain('disk full');
    }
  });

  it('parseProvidersArg parses comma-separated list', () => {
    expect(parseProvidersArg(' openai, tab ,glm ')).toEqual(['openai', 'tab', 'glm']);
    expect(parseProvidersArg('')).toBeUndefined();
  });

  it('backs up existing config when forced', async () => {
    const writes = new Map<string, string>();
    const exists = new Set<string>(['/tmp/config.json']);

    const result = await initializeConfigV1(
      {
        fsImpl: {
          existsSync: (p: any) => exists.has(String(p)),
          mkdirSync: () => {},
          readFileSync: () => '{"old":true}',
          writeFileSync: (p: any, content: any) => {
            writes.set(String(p), String(content));
            exists.add(String(p));
          }
        },
        pathImpl: path as any
      },
      { configPath: '/tmp/config.json', force: true, providers: ['openai'] }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.backupPath).toBe('/tmp/config.json.bak');
      expect(writes.get('/tmp/config.json.bak')).toContain('"old"');
      expect(writes.get('/tmp/config.json')).toContain('"version"');
    }
  });
});

describe('bundled-docs', () => {
  it('returns missing_source when no source dir exists', () => {
    const result = installBundledDocsBestEffort({
      fsImpl: {
        existsSync: () => false,
        mkdirSync: () => {},
        readFileSync: () => '',
        writeFileSync: () => {}
      },
      pathImpl: path as any,
      docsSourceDir: undefined
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_source');
    }
  });

  it('copies docs into ~/.routecodex/docs (userDir override)', () => {
    const files = new Map<string, string>();
    const exists = new Set<string>();
    const docsSourceDir = '/pkg/docs';
    const userDir = '/home/u/.routecodex';
    const targetDir = `${userDir}/docs`;

    // Simulate all docs exist in source.
    exists.add(targetDir);
    for (const name of [
      'INSTALLATION_AND_QUICKSTART.md',
      'PROVIDERS_BUILTIN.md',
      'PROVIDER_TYPES.md',
      'INSTRUCTION_MARKUP.md',
      'PORTS.md',
      'CODEX_AND_CLAUDE_CODE.md'
    ]) {
      exists.add(`${docsSourceDir}/${name}`);
      files.set(`${docsSourceDir}/${name}`, `content:${name}`);
    }

    const result = installBundledDocsBestEffort({
      docsSourceDir,
      userDir,
      fsImpl: {
        existsSync: (p: any) => exists.has(String(p)),
        mkdirSync: (p: any) => {
          exists.add(String(p));
        },
        readFileSync: (p: any) => files.get(String(p)) || '',
        writeFileSync: (p: any, content: any) => {
          files.set(String(p), String(content));
        }
      },
      pathImpl: {
        join: (...parts: any[]) => parts.map(String).join('/'),
        resolve: (...parts: any[]) => parts.map(String).join('/')
      } as any
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetDir).toBe(targetDir);
      expect(result.copied.length).toBeGreaterThanOrEqual(1);
      expect(files.get(`${targetDir}/INSTALLATION_AND_QUICKSTART.md`)).toContain('INSTALLATION_AND_QUICKSTART.md');
    }
  });
});

describe('bundled-default-config', () => {
  it('returns missing_source when bundled default config cannot be found', () => {
    const result = installBundledDefaultConfigBestEffort({
      targetConfigPath: '/tmp/config.json',
      fsImpl: {
        existsSync: () => false,
        mkdirSync: () => {},
        readFileSync: () => '',
        writeFileSync: () => {}
      },
      pathImpl: path as any,
      sourceConfigPath: undefined
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_source');
    }
  });

  it('copies bundled default config to target path', () => {
    const files = new Map<string, string>();
    const exists = new Set<string>();
    const sourceConfigPath = '/pkg/configsamples/config.v1.quickstart.sanitized.json';
    files.set(sourceConfigPath, '{"version":"1.0.0"}');
    exists.add(sourceConfigPath);

    const result = installBundledDefaultConfigBestEffort({
      sourceConfigPath,
      targetConfigPath: '/tmp/.routecodex/config.json',
      fsImpl: {
        existsSync: (p: any) => exists.has(String(p)),
        mkdirSync: (p: any) => {
          exists.add(String(p));
        },
        readFileSync: (p: any) => files.get(String(p)) || '',
        writeFileSync: (p: any, content: any) => {
          files.set(String(p), String(content));
          exists.add(String(p));
        }
      },
      pathImpl: path as any
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetPath).toBe(path.resolve('/tmp/.routecodex/config.json'));
      expect(files.get(path.resolve('/tmp/.routecodex/config.json'))).toBe('{"version":"1.0.0"}');
    }
  });
});
