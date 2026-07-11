import path from 'node:path';

import { planProviderConfigRootWithNative } from '../sharedmodule/helpers/config-direct-native.js';

function legacyPlan(rootDir?: string): { rootDir?: string } {
  if (rootDir && rootDir.trim().length) {
    return { rootDir: path.resolve(rootDir.trim()) };
  }
  return {};
}

describe('provider v2 loader root rust parity', () => {
  it('matches pre-wire explicit provider root path planning', () => {
    const input = '  provider-root  ';
    expect(planProviderConfigRootWithNative(input)).toEqual(legacyPlan(input));
  });

  it('matches pre-wire blank provider root path planning', () => {
    expect(planProviderConfigRootWithNative('  ')).toEqual(legacyPlan('  '));
    expect(planProviderConfigRootWithNative()).toEqual(legacyPlan());
  });
});
