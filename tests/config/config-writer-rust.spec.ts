import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  updateRouteCodexUserConfigStringScalarWithNative,
  writeRouteCodexProviderConfigFileWithNative,
  writeRouteCodexUserConfigFileWithNative,
} from '../sharedmodule/helpers/config-direct-native.js';
import { decodeProviderConfigFile } from '../../src/config/provider-config-codec.js';
import { decodeUserConfigFile } from '../../src/config/user-config-codec.js';
import { updateUserConfigStringScalar, writeUserConfigFile } from '../../src/config/user-config-writer.js';
import { writeProviderConfigFile } from '../../src/config/provider-config-writer.js';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('config writer rust parity', () => {
  it('matches pre-wire user config write and decode semantics', async () => {
    const root = await mkTmp('routecodex-user-writer-native-');
    const tsPath = path.join(root, 'ts', 'config.toml');
    const rustPath = path.join(root, 'rust', 'config.toml');
    const payload = {
      version: '2.0.0',
      virtualrouterMode: 'v2',
    };
    await fs.mkdir(path.dirname(tsPath), { recursive: true });
    await fs.mkdir(path.dirname(rustPath), { recursive: true });

    const tsWritten = await writeUserConfigFile(tsPath, payload);
    const rustWritten = writeRouteCodexUserConfigFileWithNative({ configPath: rustPath, parsed: payload });

    expect(rustWritten).toEqual({
      ...tsWritten,
      path: rustPath,
    });
    await expect(decodeUserConfigFile(rustPath)).resolves.toEqual(rustWritten);
  });

  it('matches pre-wire provider config write and decode semantics', async () => {
    const root = await mkTmp('routecodex-provider-writer-native-');
    const tsPath = path.join(root, 'ts', 'config.v2.toml');
    const rustPath = path.join(root, 'rust', 'config.v2.toml');
    const payload = {
      version: '2.0.0',
      providerId: 'demo',
      provider: {
        id: 'demo',
        type: 'openai',
        baseURL: 'https://example.test/v1',
      },
    };
    await fs.mkdir(path.dirname(tsPath), { recursive: true });
    await fs.mkdir(path.dirname(rustPath), { recursive: true });

    const tsWritten = await writeProviderConfigFile(tsPath, payload);
    const rustWritten = writeRouteCodexProviderConfigFileWithNative({ configPath: rustPath, parsed: payload });

    expect(rustWritten).toEqual({
      ...tsWritten,
      path: rustPath,
    });
    await expect(decodeProviderConfigFile(rustPath)).resolves.toEqual(rustWritten);
  });

  it('matches pre-wire user string scalar patch semantics', async () => {
    const root = await mkTmp('routecodex-user-patch-native-');
    const tsPath = path.join(root, 'ts', 'config.toml');
    const rustPath = path.join(root, 'rust', 'config.toml');
    const raw = ['# top comment', 'oauthBrowser = "chrome"', ''].join('\n');
    await fs.mkdir(path.dirname(tsPath), { recursive: true });
    await fs.mkdir(path.dirname(rustPath), { recursive: true });
    await fs.writeFile(tsPath, raw, 'utf8');
    await fs.writeFile(rustPath, raw, 'utf8');

    const tsPersisted = await updateUserConfigStringScalar({
      configPath: tsPath,
      tablePath: [],
      key: 'oauthBrowser',
      value: 'camoufox',
    });
    const rustPersisted = updateRouteCodexUserConfigStringScalarWithNative({
      configPath: rustPath,
      tablePath: [],
      key: 'oauthBrowser',
      value: 'camoufox',
    });

    expect(rustPersisted).toEqual({
      ...tsPersisted,
      path: rustPath,
    });
    expect(rustPersisted.raw).toContain('# top comment');
    expect(rustPersisted.raw).toContain('oauthBrowser = "camoufox"');
  });

  it('matches pre-wire JSON path rejection semantics', async () => {
    const root = await mkTmp('routecodex-writer-json-native-');
    const userPath = path.join(root, 'config.json');
    const providerPath = path.join(root, 'config.v2.json');

    expect(() => writeRouteCodexUserConfigFileWithNative({
      configPath: userPath,
      parsed: { version: '2.0.0' },
    })).toThrow('user config JSON support removed');
    expect(() => writeRouteCodexProviderConfigFileWithNative({
      configPath: providerPath,
      parsed: { version: '2.0.0' },
    })).toThrow('provider config JSON support removed');
  });
});
