import { describe, expect, it } from '@jest/globals';

import { readConfigApiKey, tryReadConfigHostPort } from '../../src/cli/commands/launcher/utils.js';

function createMemFs(initial: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    existsSync: (target: string) => files.has(String(target)),
    readFileSync: (target: string) => {
      const key = String(target);
      if (!files.has(key)) {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return String(files.get(key));
    }
  };
}

describe('launcher utils config parsing', () => {
  it('reads host and port from commented TOML config', () => {
    const configPath = '/tmp/config.toml';
    const fsImpl = createMemFs({
      [configPath]: `# launcher config
[httpserver]
port = 5520
host = "127.0.0.1"
`
    });

    expect(tryReadConfigHostPort(fsImpl as any, configPath)).toEqual({
      host: '127.0.0.1',
      port: 5520
    });
  });

  it('reads api key from TOML config', () => {
    const configPath = '/tmp/config.toml';
    const fsImpl = createMemFs({
      [configPath]: `# launcher config
[httpserver]
apikey = "secret-key"
`
    });

    expect(readConfigApiKey(fsImpl as any, configPath)).toBe('secret-key');
  });

  it('keeps legacy JSON parsing working', () => {
    const configPath = '/tmp/config.json';
    const fsImpl = createMemFs({
      [configPath]: JSON.stringify({
        httpserver: {
          port: 5555,
          host: '0.0.0.0',
          apikey: 'legacy-key'
        }
      })
    });

    expect(tryReadConfigHostPort(fsImpl as any, configPath)).toEqual({
      host: '0.0.0.0',
      port: 5555
    });
    expect(readConfigApiKey(fsImpl as any, configPath)).toBe('legacy-key');
  });
});
