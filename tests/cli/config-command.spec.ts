import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';
import path from 'node:path';

import { createConfigCommand } from '../../src/cli/commands/config.js';
import { createInitCommand } from '../../src/cli/commands/init.js';
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
    expect(parsed?.virtualrouter?.providers?.openai).toBeTruthy();
    expect(parsed?.virtualrouter?.routing?.default?.[0]?.targets?.[0]).toContain('openai.');
  });

  it('init supports interactive flow via ctx.prompt', async () => {
    const writes = new Map<string, string>();
    const answers = ['1', '0.0.0.0', '8888'];
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

    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/config.json', '--force'], { from: 'node' });

    const parsed = JSON.parse(writes.get('/tmp/config.json') || '{}');
    expect(parsed.httpserver.host).toBe('0.0.0.0');
    expect(parsed.httpserver.port).toBe(8888);
    expect(parsed.virtualrouter.providers.openai).toBeTruthy();
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
});

describe('init-config', () => {
  it('returns exists when file exists and not forced', async () => {
    const result = await initializeConfigV1(
      {
        fsImpl: {
          existsSync: () => true,
          mkdirSync: () => {},
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
