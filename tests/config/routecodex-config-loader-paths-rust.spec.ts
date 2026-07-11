import path from 'node:path';

import { planRouteCodexConfigLoaderPathsWithNative } from '../sharedmodule/helpers/config-direct-native.js';

function legacyPlan(input: {
  explicitPath?: string;
  routecodexProviderDir?: string;
  rccProviderDir?: string;
}): {
  explicitPath?: string;
  providerRootDir?: string;
} {
  const explicitPath = typeof input.explicitPath === 'string' && input.explicitPath.trim()
    ? path.resolve(input.explicitPath.trim())
    : undefined;
  const candidates = [input.routecodexProviderDir, input.rccProviderDir];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return {
        ...(explicitPath ? { explicitPath } : {}),
        providerRootDir: path.resolve(candidate.trim()),
      };
    }
  }
  return {
    ...(explicitPath ? { explicitPath } : {}),
  };
}

describe('routecodex config loader path rust parity', () => {
  it('matches pre-wire explicit config path planning', () => {
    const input = { explicitPath: '  config.toml  ' };
    expect(planRouteCodexConfigLoaderPathsWithNative(input)).toEqual(legacyPlan(input));
  });

  it('matches pre-wire provider root env precedence', () => {
    const input = {
      routecodexProviderDir: '  routecodex-provider  ',
      rccProviderDir: 'rcc-provider',
    };
    expect(planRouteCodexConfigLoaderPathsWithNative(input)).toEqual(legacyPlan(input));
  });

  it('matches pre-wire provider root env fallback after blank primary', () => {
    const input = {
      explicitPath: '',
      routecodexProviderDir: '  ',
      rccProviderDir: 'rcc-provider',
    };
    expect(planRouteCodexConfigLoaderPathsWithNative(input)).toEqual(legacyPlan(input));
  });
});
