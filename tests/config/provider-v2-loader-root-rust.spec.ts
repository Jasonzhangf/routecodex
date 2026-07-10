import path from 'node:path';

import { planProviderConfigRootNativeSync } from '../../src/modules/llmswitch/bridge/routing-integrations.js';

function legacyPlan(rootDir?: string): { rootDir?: string } {
  if (rootDir && rootDir.trim().length) {
    return { rootDir: path.resolve(rootDir.trim()) };
  }
  return {};
}

describe('provider v2 loader root rust parity', () => {
  it('matches pre-wire explicit provider root path planning', () => {
    const input = '  provider-root  ';
    expect(planProviderConfigRootNativeSync(input)).toEqual(legacyPlan(input));
  });

  it('matches pre-wire blank provider root path planning', () => {
    expect(planProviderConfigRootNativeSync('  ')).toEqual(legacyPlan('  '));
    expect(planProviderConfigRootNativeSync()).toEqual(legacyPlan());
  });
});
