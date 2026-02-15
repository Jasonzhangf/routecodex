/**
 * Path Resolver Unit Tests
 */

import {
  isGeminiCliFamily,
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

  describe('isGeminiCliFamily', () => {
    it('returns true for gemini-cli', () => {
      expect(isGeminiCliFamily('gemini-cli')).toBe(true);
    });

    it('returns true for antigravity', () => {
      expect(isGeminiCliFamily('antigravity')).toBe(true);
    });

    it('returns true for uppercase variants', () => {
      expect(isGeminiCliFamily('GEMINI-CLI')).toBe(true);
      expect(isGeminiCliFamily('ANTIGRAVITY')).toBe(true);
    });

    it('returns false for other providers', () => {
      expect(isGeminiCliFamily('qwen')).toBe(false);
      expect(isGeminiCliFamily('iflow')).toBe(false);
    });
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
    it('returns iflow default path', () => {
      expect(defaultTokenFile('iflow')).toBe('/home/testuser/.iflow/oauth_creds.json');
    });

    it('returns qwen default path', () => {
      expect(defaultTokenFile('qwen')).toBe('/home/testuser/.routecodex/auth/qwen-oauth-1-default.json');
    });

    it('returns gemini-cli default path', () => {
      expect(defaultTokenFile('gemini-cli')).toBe('/home/testuser/.routecodex/auth/gemini-oauth.json');
    });

    it('returns antigravity default path', () => {
      expect(defaultTokenFile('antigravity')).toBe('/home/testuser/.routecodex/auth/antigravity-oauth.json');
    });

    it('returns generic default path for unknown providers', () => {
      expect(defaultTokenFile('unknown')).toBe('/home/testuser/.routecodex/tokens/unknown-default.json');
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
