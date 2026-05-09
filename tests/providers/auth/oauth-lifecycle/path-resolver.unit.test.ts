/**
 * Path Resolver Unit Tests
 */

import {
  expandHome,
  defaultTokenFile,
  resolveCamoufoxAliasForAuth,
  type ExtendedOAuthAuth
} from '../../../../src/providers/auth/oauth-lifecycle/path-resolver.js';

describe('path-resolver', () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = '/home/testuser';
  });

  afterAll(() => {
    process.env.HOME = originalHome;
  });

  describe('expandHome', () => {
    it('expands ~/ prefix', () => {
      expect(expandHome('~/path/to/file')).toBe('/home/testuser/path/to/file');
    });

    it('returns path unchanged if not starting with ~/', () => {
      expect(expandHome('/absolute/path')).toBe('/absolute/path');
      expect(expandHome('relative/path')).toBe('relative/path');
    });
  });

  describe('defaultTokenFile', () => {
    it('returns qwen default path under auth dir', () => {
      expect(defaultTokenFile('qwen')).toBe('/home/testuser/.rcc/auth/qwen-oauth-1-default.json');
    });

    it('returns deepseek-account default path under auth dir', () => {
      expect(defaultTokenFile('deepseek-account')).toBe('/home/testuser/.rcc/auth/deepseek-account-oauth-1-default.json');
    });

    it('returns generic default path for other providers under tokens dir', () => {
      expect(defaultTokenFile('glm')).toBe('/home/testuser/.rcc/tokens/glm-default.json');
      expect(defaultTokenFile('unknown')).toBe('/home/testuser/.rcc/tokens/unknown-default.json');
    });
  });

  describe('resolveCamoufoxAliasForAuth', () => {
    it('returns raw value if it looks like alias (no path)', () => {
      const auth: ExtendedOAuthAuth = { type: 'oauth', tokenFile: 'my-alias' };
      expect(resolveCamoufoxAliasForAuth('qwen', auth)).toBe('my-alias');
    });

    it('extracts alias from filename pattern', () => {
      const auth: ExtendedOAuthAuth = { type: 'oauth', tokenFile: '/path/to/qwen-oauth-1-custom.json' };
      expect(resolveCamoufoxAliasForAuth('qwen', auth)).toBe('custom');
    });

    it('returns default when no alias can be extracted', () => {
      const auth: ExtendedOAuthAuth = { type: 'oauth', tokenFile: '/path/to/some-file.json' };
      expect(resolveCamoufoxAliasForAuth('qwen', auth)).toBe('default');
    });

    it('returns default when tokenFile is undefined', () => {
      const auth: ExtendedOAuthAuth = { type: 'oauth' };
      expect(resolveCamoufoxAliasForAuth('qwen', auth)).toBe('default');
    });
  });
});
