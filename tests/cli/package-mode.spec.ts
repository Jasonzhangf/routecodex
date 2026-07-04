import { describe, expect, it } from '@jest/globals';

import { resolveCliIsDevPackage } from '../../src/cli/package-mode.js';

describe('cli package mode', () => {
  it('treats release-built routecodex snapshots as release runtime', () => {
    expect(resolveCliIsDevPackage({ pkgName: 'routecodex', buildMode: 'release' })).toBe(false);
  });

  it('keeps dev-built routecodex as the dev package', () => {
    expect(resolveCliIsDevPackage({ pkgName: 'routecodex', buildMode: 'dev' })).toBe(true);
  });

  it('treats rcc as release runtime regardless of build mode', () => {
    expect(resolveCliIsDevPackage({ pkgName: 'rcc', buildMode: 'release' })).toBe(false);
    expect(resolveCliIsDevPackage({ pkgName: 'rcc', buildMode: 'dev' })).toBe(false);
  });
});
