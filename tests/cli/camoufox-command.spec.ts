import { describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';

import { createCamoufoxCommand } from '../../src/cli/commands/camoufox.js';

describe('cli camoufox command', () => {
  it('registers camoufox command', () => {
    const program = new Command();
    createCamoufoxCommand(program, {
      env: {},
      fsImpl: { existsSync: () => false, statSync: () => ({ isFile: () => false }) as any },
      pathImpl: {
        resolve: (...p: string[]) => p.join('/'),
        join: (...p: string[]) => p.join('/'),
        basename: (p: string) => p.split('/').pop() || p,
        isAbsolute: (p: string) => p.startsWith('/')
      },
      homedir: () => '/home/test',
      findTokenBySelector: async () => null,
      openInCamoufox: async () => true,
      log: () => {},
      error: () => {},
      exit: () => {
        throw new Error('exit');
      }
    });
    expect(program.commands.some((c) => c.name() === 'camoufox')).toBe(true);
  });

  it('launches by selector (TokenDaemon match) and strips auto-mode env', async () => {
    const program = new Command();
    const calls: any[] = [];
    const env: Record<string, string | undefined> = {
      ROUTECODEX_CAMOUFOX_AUTO_MODE: 'antigravity',
      ROUTECODEX_CAMOUFOX_DEV_MODE: '1'
    };
    createCamoufoxCommand(program, {
      env,
      fsImpl: { existsSync: () => false, statSync: () => ({ isFile: () => false }) as any },
      pathImpl: {
        resolve: (...p: string[]) => p.join('/'),
        join: (...p: string[]) => p.join('/'),
        basename: (p: string) => p.split('/').pop() || p,
        isAbsolute: (p: string) => p.startsWith('/')
      },
      homedir: () => '/home/test',
      findTokenBySelector: async () => ({ provider: 'antigravity', alias: 'antonsoltan', filePath: '/x.json' }),
      openInCamoufox: async (opts) => {
        calls.push({ opts, env: { ...env } });
        return true;
      },
      log: () => {},
      error: () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'rcc', 'camoufox', 'antigravity-oauth-3-antonsoltan.json'], { from: 'node' });

    expect(calls).toHaveLength(1);
    expect(calls[0].opts.provider).toBe('antigravity');
    expect(calls[0].opts.alias).toBe('antonsoltan');
    expect(calls[0].env.ROUTECODEX_CAMOUFOX_AUTO_MODE).toBeUndefined();
    expect(calls[0].env.ROUTECODEX_CAMOUFOX_DEV_MODE).toBeUndefined();

    // Restored after command completes.
    expect(env.ROUTECODEX_CAMOUFOX_AUTO_MODE).toBe('antigravity');
    expect(env.ROUTECODEX_CAMOUFOX_DEV_MODE).toBe('1');
  });

  it('logs selector lookup failures before falling back to path resolution', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const program = new Command();

    createCamoufoxCommand(program, {
      env: {},
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isFile: () => true }) as any
      },
      pathImpl: {
        resolve: (...p: string[]) => p.join('/'),
        join: (...p: string[]) => p.join('/'),
        basename: (p: string) => p.split('/').pop() || p,
        isAbsolute: (p: string) => p.startsWith('/')
      },
      homedir: () => '/home/test',
      findTokenBySelector: async () => {
        throw new Error('selector boom');
      },
      openInCamoufox: async () => true,
      log: () => {},
      error: () => {},
      exit: (code) => {
        throw new Error(`exit:${code}`);
      }
    });

    await program.parseAsync(['node', 'rcc', 'camoufox', '/tmp/antigravity-oauth-3-antonsoltan.json'], { from: 'node' });

    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('stage=selector_resolution');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('operation=find_token_by_selector');

    warnSpy.mockRestore();
  });
});
