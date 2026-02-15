/**
 * Token Helpers Unit Tests
 */

import {
  hasNonEmptyString,
  extractAccessToken,
  extractApiKey,
  hasApiKeyField,
  hasStableQwenApiKey,
  hasAccessToken,
  getExpiresAt,
  resolveProjectId,
  coerceExpiryTimestampSeconds,
  hasNoRefreshFlag,
  evaluateTokenState,
  type StoredOAuthToken
} from '../../../../src/providers/auth/oauth-lifecycle/token-helpers.js';

describe('token-helpers', () => {
  describe('hasNonEmptyString', () => {
    it('returns true for non-empty string', () => {
      expect(hasNonEmptyString('hello')).toBe(true);
    });
    it('returns false for empty string', () => {
      expect(hasNonEmptyString('')).toBe(false);
      expect(hasNonEmptyString('   ')).toBe(false);
    });
    it('returns false for non-string', () => {
      expect(hasNonEmptyString(null)).toBe(false);
      expect(hasNonEmptyString(undefined)).toBe(false);
      expect(hasNonEmptyString(123)).toBe(false);
    });
  });

  describe('extractAccessToken', () => {
    it('extracts access_token', () => {
      const token: StoredOAuthToken = { access_token: 'abc123' };
      expect(extractAccessToken(token)).toBe('abc123');
    });
    it('extracts AccessToken (alternative field)', () => {
      const token: StoredOAuthToken = { AccessToken: 'xyz789' };
      expect(extractAccessToken(token)).toBe('xyz789');
    });
    it('prefers access_token over AccessToken', () => {
      const token: StoredOAuthToken = { access_token: 'abc', AccessToken: 'xyz' };
      expect(extractAccessToken(token)).toBe('abc');
    });
    it('returns undefined for null token', () => {
      expect(extractAccessToken(null)).toBeUndefined();
    });
  });

  describe('extractApiKey', () => {
    it('extracts api_key', () => {
      const token: StoredOAuthToken = { api_key: 'key123' };
      expect(extractApiKey(token)).toBe('key123');
    });
    it('extracts apiKey (alternative field)', () => {
      const token: StoredOAuthToken = { apiKey: 'key789' };
      expect(extractApiKey(token)).toBe('key789');
    });
    it('prefers apiKey over api_key', () => {
      const token: StoredOAuthToken = { apiKey: 'key1', api_key: 'key2' };
      expect(extractApiKey(token)).toBe('key1');
    });
  });

  describe('hasStableQwenApiKey', () => {
    it('returns true when apiKey differs from access_token', () => {
      const token: StoredOAuthToken = { apiKey: 'stable_key', access_token: 'temp_token' };
      expect(hasStableQwenApiKey(token)).toBe(true);
    });
    it('returns false when apiKey equals access_token', () => {
      const token: StoredOAuthToken = { apiKey: 'same', access_token: 'same' };
      expect(hasStableQwenApiKey(token)).toBe(false);
    });
    it('returns false when no apiKey', () => {
      const token: StoredOAuthToken = { access_token: 'temp' };
      expect(hasStableQwenApiKey(token)).toBe(false);
    });
  });

  describe('getExpiresAt', () => {
    it('extracts expires_at as number', () => {
      const token: StoredOAuthToken = { expires_at: 1234567890 };
      expect(getExpiresAt(token)).toBe(1234567890);
    });
    it('extracts expired field as fallback', () => {
      const token: StoredOAuthToken = { expired: '1234567890' };
      expect(getExpiresAt(token)).toBe(1234567890);
    });
    it('extracts expiry_date field as fallback', () => {
      const token: StoredOAuthToken = { expiry_date: 9876543210 };
      expect(getExpiresAt(token)).toBe(9876543210);
    });
    it('parses date string', () => {
      const token: StoredOAuthToken = { expires_at: '2025-12-31T00:00:00Z' };
      expect(getExpiresAt(token)).toBeGreaterThan(0);
    });
  });

  describe('evaluateTokenState', () => {
    it('returns validAccess true for apiKey', () => {
      const token: StoredOAuthToken = { apiKey: 'key' };
      const state = evaluateTokenState(token, 'qwen');
      expect(state.validAccess).toBe(true);
      expect(state.hasApiKey).toBe(true);
    });
    it('returns validAccess false for expired token', () => {
      const token: StoredOAuthToken = { access_token: 'expired', expires_at: Date.now() - 10000 };
      const state = evaluateTokenState(token, 'generic');
      expect(state.isExpired).toBe(true);
    });
  });

  describe('hasNoRefreshFlag', () => {
    it('returns true when norefresh is true', () => {
      const token: StoredOAuthToken = { norefresh: true };
      expect(hasNoRefreshFlag(token)).toBe(true);
    });
    it('returns false when norefresh is undefined', () => {
      const token: StoredOAuthToken = {};
      expect(hasNoRefreshFlag(token)).toBe(false);
    });
  });

  describe('resolveProjectId', () => {
    it('extracts project_id', () => {
      const token = { project_id: 'proj123' };
      expect(resolveProjectId(token)).toBe('proj123');
    });
    it('extracts projectId as fallback', () => {
      const token = { projectId: 'proj456' };
      expect(resolveProjectId(token)).toBe('proj456');
    });
  });

  describe('coerceExpiryTimestampSeconds', () => {
    it('converts milliseconds to seconds', () => {
      const token: StoredOAuthToken = { expires_at: 16000000000000 }; // > 10_000_000_000
      expect(coerceExpiryTimestampSeconds(token)).toBe(16000000000);
    });
    it('keeps seconds as-is', () => {
      const token: StoredOAuthToken = { expires_at: 1600000000 }; // < 10_000_000_000
      expect(coerceExpiryTimestampSeconds(token)).toBe(1600000000);
    });
  });
});
