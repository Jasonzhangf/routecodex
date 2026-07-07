import { describe, expect, it } from '@jest/globals';
import { Command } from 'commander';
import path from 'node:path';

import { createInitCommand } from '../../src/cli/commands/init.js';
import { parseTomlRecord, serializeTomlRecord } from '../../src/config/toml-basic.js';
import { resolveRccProviderDir } from '../../src/config/user-data-paths.js';

type FsMock = {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  writeFileSync: (p: string, c: string) => void;
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
  readdirSync: (p: string, opts?: { withFileTypes?: boolean }) => Array<{ name: string; isDirectory: () => boolean }>;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (p: string) => void;
  rmdirSync: (p: string) => void;
  _files: Map<string, string>;
};

function createFsMock(initialFiles?: Record<string, string>): FsMock {
  const files = new Map<string, string>(Object.entries(initialFiles || {}));
  const dirs = new Set<string>();
  for (const filePath of files.keys()) {
    dirs.add(path.dirname(filePath));
  }
  return {
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    readFileSync: (p: string) => files.get(p) ?? '',
    writeFileSync: (p: string, c: string) => {
      files.set(p, c);
      dirs.add(path.dirname(p));
    },
    mkdirSync: (p: string) => {
      dirs.add(p);
    },
    readdirSync: (p: string) => {
      const names = Array.from(dirs)
        .filter((dirPath) => path.dirname(dirPath) === p)
        .map((dirPath) => path.basename(dirPath));
      return Array.from(new Set(names)).map((name) => ({ name, isDirectory: () => true }));
    },
    renameSync: (from: string, to: string) => {
      const content = files.get(from);
      if (content === undefined) {
        throw new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`);
      }
      files.delete(from);
      files.set(to, content);
      dirs.add(path.dirname(to));
    },
    unlinkSync: (p: string) => {
      files.delete(p);
    },
    rmdirSync: (p: string) => {
      dirs.delete(p);
    },
    _files: files
  };
}

function makePrompt(answers: string[]) {
  let index = 0;
  return async (_q: string) => {
    const next = answers[index];
    index += 1;
    return next ?? '';
  };
}

function readTomlFromStore(fsMock: FsMock, filePath: string): Record<string, any> {
  return parseTomlRecord(fsMock._files.get(filePath) || '') as Record<string, any>;
}

function writeTomlValue(value: Record<string, unknown>): string {
  return `${serializeTomlRecord(value)}\n`;
}

function createProgramForInit(options?: {
  fsMock?: FsMock;
  prompt?: (q: string) => Promise<string>;
}) {
  const infos: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const fsMock = options?.fsMock ?? createFsMock();
  const program = new Command();
  createInitCommand(program, {
    logger: {
      info: (msg) => infos.push(msg),
      warning: (msg) => warnings.push(msg),
      success: () => {},
      error: (msg) => errors.push(msg)
    },
    createSpinner: async () =>
      ({
        text: '',
        start: () => ({} as any),
        succeed: () => {},
        fail: () => {},
        warn: () => {},
        info: () => {},
        stop: () => {}
      }) as any,
    fsImpl: fsMock as any,
    pathImpl: path as any,
    getHomeDir: () => '/tmp/routecodex-home',
    ...(options?.prompt ? { prompt: options.prompt } : {})
  });
  return { program, infos, errors, warnings, fsMock };
}

describe('cli init command - additional coverage', () => {
  const providerRoot = resolveRccProviderDir('/tmp/routecodex-home');
  it('rejects unsupported init profile values', async () => {
    const { program, errors } = createProgramForInit();
    await program.parseAsync(['node', 'routecodex', 'init', 'custom', '--config', '/tmp/config.toml'], { from: 'node' });
    expect(errors.join('\n')).toContain('Unsupported init profile');
  });

  it('fails fast on invalid provider-source', async () => {
    const { program, errors } = createProgramForInit();
    await program.parseAsync(
      ['node', 'routecodex', 'init', '--config', '/tmp/config.toml', '--providers', 'openai', '--provider-source', 'oops'],
      { from: 'node' }
    );
    expect(errors.join('\n')).toContain('Invalid --provider-source');
  });

  it('requires providers in non-interactive missing-config mode when default-bootstrap path is disabled', async () => {
    const { program, errors } = createProgramForInit();
    await program.parseAsync(
      ['node', 'routecodex', 'init', '--config', '/tmp/config.toml', '--host', '0.0.0.0'],
      { from: 'node' }
    );
    expect(errors.join('\n')).toContain('Non-interactive init requires --providers');
  });

  it('validates default-provider membership and existing config overwrite guard', async () => {
    const invalidDefault = createProgramForInit();
    await invalidDefault.program.parseAsync(
      [
        'node',
        'routecodex',
        'init',
        '--config',
        '/tmp/a.toml',
        '--providers',
        'openai',
        '--default-provider',
        'missing-provider'
      ],
      { from: 'node' }
    );
    expect(invalidDefault.errors.join('\n')).toContain('defaultProvider "missing-provider" is not in selected providers');

    const existingConfigPath = '/tmp/existing-config.toml';
    const fsMock = createFsMock({
      [existingConfigPath]: writeTomlValue({ virtualrouterMode: 'v2' })
    });
    const originalExists = fsMock.existsSync;
    let configExistsChecks = 0;
    fsMock.existsSync = (p: string) => {
      if (p === existingConfigPath) {
        configExistsChecks += 1;
        return configExistsChecks >= 2;
      }
      return originalExists(p);
    };
    const overwriteGuard = createProgramForInit({ fsMock });
    await overwriteGuard.program.parseAsync(
      ['node', 'routecodex', 'init', '--config', existingConfigPath, '--providers', 'openai'],
      { from: 'node' }
    );
    expect(overwriteGuard.errors.join('\n')).toContain(`Configuration file already exists: ${existingConfigPath}`);
  });

  it('installs bundled default config when config is missing and no interactive args are provided', async () => {
    const { program, fsMock, infos } = createProgramForInit();
    await program.parseAsync(['node', 'routecodex', 'init', '--config', '/tmp/default-init.toml'], { from: 'node' });
    const config = readTomlFromStore(fsMock, '/tmp/default-init.toml');
    expect(config.virtualrouterMode).toBe('v2');
    const providerPath = `${providerRoot}/openai/config.v2.toml`;
    expect(fsMock._files.has(providerPath)).toBe(true);
    expect(infos.join('\n')).toContain('Created a minimal V2 config');
  });

  it('supports `rcc init default` profile and keeps base init successful', async () => {
    const { program, fsMock, warnings } = createProgramForInit();
    await program.parseAsync(['node', 'routecodex', 'init', 'default', '--config', '/tmp/default-profile.toml'], {
      from: 'node'
    });
    const config = readTomlFromStore(fsMock, '/tmp/default-profile.toml');
    expect(config.virtualrouterMode).toBe('v2');
    expect(warnings.join('\n')).toContain('Bundled provider template install skipped');
  });

  it('backs up existing config when --force is set and writes provider defaults', async () => {
    const configPath = '/tmp/force-config.toml';
    const fsMock = createFsMock({
      [configPath]: writeTomlValue({ virtualrouterMode: 'v2' })
    });
    const originalExists = fsMock.existsSync;
    let configExistsChecks = 0;
    fsMock.existsSync = (p: string) => {
      if (p === configPath) {
        configExistsChecks += 1;
        return configExistsChecks >= 2;
      }
      return originalExists(p);
    };
    const { program, fsMock: fileStore } = createProgramForInit({ fsMock });
    await program.parseAsync(
      ['node', 'routecodex', 'init', '--config', configPath, '--providers', 'openai', '--force', '--default-model', 'gpt-4.1-mini'],
      { from: 'node' }
    );
    const backupPath = `${configPath}.bak`;
    expect(fileStore._files.has(backupPath)).toBe(true);
    const providerPath = `${providerRoot}/openai/config.v2.toml`;
    const providerV2 = readTomlFromStore(fileStore, providerPath);
    expect(providerV2.provider.defaultModel).toBe('gpt-4.1-mini');
  });

  it('rejects removed JSON config migration flow', async () => {
    const skipConfigPath = '/tmp/v1-skip.json';
    const fsSkip = createFsMock({
      [skipConfigPath]: JSON.stringify({
        providers: { openai: { id: 'openai', models: { 'gpt-4.1': { supportsStreaming: true } } } }
      })
    });
    const skip = createProgramForInit({ fsMock: fsSkip, prompt: makePrompt(['n']) });
    await skip.program.parseAsync(['node', 'routecodex', 'init', '--config', skipConfigPath], { from: 'node' });
    expect(skip.errors.join('\n')).toContain('user config JSON support removed');
  });

  it('requires interactive mode for existing v2 maintenance', async () => {
    const configPath = '/tmp/v2-config.toml';
    const fsMock = createFsMock({
      [configPath]: writeTomlValue({ virtualrouterMode: 'v2' })
    });
    const { program, errors } = createProgramForInit({ fsMock });
    await program.parseAsync(['node', 'routecodex', 'init', '--config', configPath], { from: 'node' });
    expect(errors.join('\n')).toContain('V2 config maintenance is interactive');
  });
});
