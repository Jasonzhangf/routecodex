import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  decodeRouteCodexProviderConfigTextSync,
  decodeRouteCodexUserConfigTextSync,
} from '../../src/modules/llmswitch/bridge/routing-integrations.js';
import { parseTomlRecord } from '../../src/config/toml-basic.js';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function legacyDecodeUserConfig(raw: string, configPath: string): Record<string, unknown> {
  const ext = path.extname(configPath).trim().toLowerCase();
  if (ext !== '.toml') {
    throw new Error(`[config] user config JSON support removed; expected TOML file: ${configPath}`);
  }
  return raw.trim() ? parseTomlRecord(raw) : {};
}

function legacyDecodeProviderConfig(raw: string, configPath: string): Record<string, unknown> {
  if (!configPath.trim().toLowerCase().endsWith('.toml')) {
    throw new Error(`[config] provider config JSON support removed; expected TOML file: ${configPath}`);
  }
  return raw.trim() ? parseTomlRecord(raw) : {};
}

describe('config file codec rust parity', () => {
  it('matches pre-wire user config decode semantics', async () => {
    const root = await mkTmp('routecodex-user-config-rust-');
    const configPath = path.join(root, 'config.toml');
    const raw = ['version = "2.0.0"', 'virtualrouterMode = "v2"', ''].join('\n');
    await fs.writeFile(configPath, raw, 'utf8');

    const legacy = legacyDecodeUserConfig(raw, configPath);
    const native = decodeRouteCodexUserConfigTextSync({ raw, configPath }).parsed;

    expect(native).toEqual(legacy);
  });

  it('matches pre-wire provider config decode semantics', async () => {
    const root = await mkTmp('routecodex-provider-config-rust-');
    const configPath = path.join(root, 'config.v2.toml');
    const raw = [
      'version = "2.0.0"',
      'providerId = "demo"',
      '',
      '[provider]',
      'id = "demo"',
      'type = "openai"',
      '',
    ].join('\n');
    await fs.writeFile(configPath, raw, 'utf8');

    const legacy = legacyDecodeProviderConfig(raw, configPath);
    const native = decodeRouteCodexProviderConfigTextSync({ raw, configPath }).parsed;

    expect(native).toEqual(legacy);
  });

  it('matches pre-wire user config json rejection', async () => {
    const root = await mkTmp('routecodex-user-config-json-rust-');
    const configPath = path.join(root, 'config.json');
    await fs.writeFile(configPath, '{"version":"2.0.0"}\n', 'utf8');

    expect(() => legacyDecodeUserConfig('{"version":"2.0.0"}\n', configPath)).toThrow(
      'user config JSON support removed'
    );
    expect(() => decodeRouteCodexUserConfigTextSync({ raw: '{"version":"2.0.0"}\n', configPath })).toThrow(
      'user config JSON support removed'
    );
  });

  it('matches pre-wire provider config json rejection', async () => {
    const root = await mkTmp('routecodex-provider-config-json-rust-');
    const configPath = path.join(root, 'config.v2.json');
    await fs.writeFile(configPath, '{"version":"2.0.0"}\n', 'utf8');

    expect(() => legacyDecodeProviderConfig('{"version":"2.0.0"}\n', configPath)).toThrow(
      'provider config JSON support removed'
    );
    expect(() => decodeRouteCodexProviderConfigTextSync({ raw: '{"version":"2.0.0"}\n', configPath })).toThrow(
      'provider config JSON support removed'
    );
  });

  it('matches pre-wire user config text decode semantics', () => {
    const raw = ['version = "2.0.0"', 'virtualrouterMode = "v2"', ''].join('\n');
    const legacy = legacyDecodeUserConfig(raw, 'config.toml');
    const native = decodeRouteCodexUserConfigTextSync({ raw, configPath: 'config.toml' }).parsed;

    expect(native).toEqual(legacy);
  });

  it('matches pre-wire provider config text decode semantics', () => {
    const raw = [
      'version = "2.0.0"',
      'providerId = "demo"',
      '',
      '[provider]',
      'id = "demo"',
      'type = "openai"',
      '',
    ].join('\n');
    const legacy = legacyDecodeProviderConfig(raw, 'config.v2.toml');
    const native = decodeRouteCodexProviderConfigTextSync({ raw, configPath: 'config.v2.toml' }).parsed;

    expect(native).toEqual(legacy);
  });
});
