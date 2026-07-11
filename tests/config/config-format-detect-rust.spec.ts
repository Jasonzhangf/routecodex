import path from 'node:path';

import {
  detectRouteCodexProviderConfigFormatWithNative,
  detectRouteCodexUserConfigFormatWithNative,
} from '../sharedmodule/helpers/config-direct-native.js';

function legacyDetectUserConfigFormat(configPath: string): 'toml' {
  const ext = path.extname(configPath).trim().toLowerCase();
  if (ext !== '.toml') {
    throw new Error(`[config] user config JSON support removed; expected TOML file: ${configPath}`);
  }
  return 'toml';
}

function legacyDetectProviderConfigFormat(configPath: string): 'toml' {
  if (!configPath.trim().toLowerCase().endsWith('.toml')) {
    throw new Error(`[config] provider config JSON support removed; expected TOML file: ${configPath}`);
  }
  return 'toml';
}

describe('config format detect rust parity', () => {
  it.each([
    ['config.toml'],
    ['/tmp/routecodex/config.TOML'],
    ['  /tmp/routecodex/config.toml  '],
  ])('matches pre-wire user TOML detection for %s', (configPath) => {
    expect(detectRouteCodexUserConfigFormatWithNative(configPath)).toBe(legacyDetectUserConfigFormat(configPath));
  });

  it.each([
    ['config.v2.toml'],
    ['/tmp/provider/config.v2.TOML'],
    ['  /tmp/provider/config.v2.toml  '],
  ])('matches pre-wire provider TOML detection for %s', (configPath) => {
    expect(detectRouteCodexProviderConfigFormatWithNative(configPath)).toBe(legacyDetectProviderConfigFormat(configPath));
  });

  it.each([
    [''],
    ['config.json'],
    ['config.toml.bak'],
  ])('matches pre-wire user rejection for %s', (configPath) => {
    expect(() => legacyDetectUserConfigFormat(configPath)).toThrow('user config JSON support removed');
    expect(() => detectRouteCodexUserConfigFormatWithNative(configPath)).toThrow('user config JSON support removed');
  });

  it.each([
    [''],
    ['config.v2.json'],
    ['config.v2.toml.bak'],
  ])('matches pre-wire provider rejection for %s', (configPath) => {
    expect(() => legacyDetectProviderConfigFormat(configPath)).toThrow('provider config JSON support removed');
    expect(() => detectRouteCodexProviderConfigFormatWithNative(configPath)).toThrow('provider config JSON support removed');
  });
});
