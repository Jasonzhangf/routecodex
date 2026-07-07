import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { decodeProviderConfigFile } from '../../src/config/provider-config-codec.js';
import { writeProviderConfigFile } from '../../src/config/provider-config-writer.js';
import { decodeUserConfigFile } from '../../src/config/user-config-codec.js';
import { updateUserConfigStringScalar, writeUserConfigFile } from '../../src/config/user-config-writer.js';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('config writers', () => {
  it('writes user config as toml and can decode it back', async () => {
    const root = await mkTmp('routecodex-user-writer-');
    const filePath = path.join(root, 'config.toml');
    await writeUserConfigFile(filePath, {
      version: '2.0.0',
      virtualrouterMode: 'v2',
    });

    const decoded = await decodeUserConfigFile(filePath);
    expect(decoded.format).toBe('toml');
    expect(decoded.parsed.virtualrouterMode).toBe('v2');
  });

  it('rejects user config json writes', async () => {
    const root = await mkTmp('routecodex-user-writer-json-');
    const filePath = path.join(root, 'config.json');
    await expect(writeUserConfigFile(filePath, { version: '2.0.0' })).rejects.toThrow(
      'user config JSON support removed'
    );
  });

  it('patches toml string scalar through shared writer and keeps comments', async () => {
    const root = await mkTmp('routecodex-user-writer-toml-');
    const filePath = path.join(root, 'config.toml');
    await fs.writeFile(
      filePath,
      ['# top comment', 'oauthBrowser = "chrome"', ''].join('\n'),
      'utf8'
    );

    const persisted = await updateUserConfigStringScalar({
      configPath: filePath,
      tablePath: [],
      key: 'oauthBrowser',
      value: 'camoufox',
    });

    expect(persisted.format).toBe('toml');
    expect(persisted.raw).toContain('# top comment');
    expect(persisted.raw).toContain('oauthBrowser = "camoufox"');
  });

  it('writes provider config based on target extension', async () => {
    const root = await mkTmp('routecodex-provider-writer-');
    const filePath = path.join(root, 'config.v2.toml');
    await writeProviderConfigFile(filePath, {
      version: '2.0.0',
      providerId: 'demo',
      provider: {
        id: 'demo',
        type: 'openai',
        baseURL: 'https://example.test/v1',
      },
    });

    const decoded = await decodeProviderConfigFile(filePath);
    expect(decoded.format).toBe('toml');
    expect((decoded.parsed.provider as Record<string, unknown>).id).toBe('demo');
  });
});
