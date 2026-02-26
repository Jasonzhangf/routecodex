/**
 * Error Detection Unit Tests
 */

import {
  extractStatusCode,
  isGoogleAccountVerificationRequiredMessage,
  extractGoogleAccountVerificationUrl
} from '../../../../src/providers/auth/oauth-lifecycle/error-detection.js';

describe('error-detection', () => {
  describe('extractStatusCode', () => {
    it('extracts statusCode directly', () => {
      const error = { statusCode: 401 };
      expect(extractStatusCode(error)).toBe(401);
    });

    it('extracts status field', () => {
      const error = { status: 403 };
      expect(extractStatusCode(error)).toBe(403);
    });

    it('extracts from response.status', () => {
      const error = { response: { status: 500 } };
      expect(extractStatusCode(error)).toBe(500);
    });

    it('extracts from response.statusCode', () => {
      const error = { response: { statusCode: 502 } };
      expect(extractStatusCode(error)).toBe(502);
    });

    it('extracts from response.data.upstream.status string', () => {
      const error = { response: { data: { upstream: { status: '434' } } } };
      expect(extractStatusCode(error)).toBe(434);
    });

    it('prefers response.data.upstream.status over wrapped response.status=400', () => {
      const error = { response: { status: 400, data: { upstream: { status: '434' } } } };
      expect(extractStatusCode(error)).toBe(434);
    });

    it('returns undefined for null/undefined', () => {
      expect(extractStatusCode(null)).toBeUndefined();
      expect(extractStatusCode(undefined)).toBeUndefined();
    });

    it('returns undefined for primitive values', () => {
      expect(extractStatusCode('error')).toBeUndefined();
      expect(extractStatusCode(123)).toBeUndefined();
    });
  });

  describe('isGoogleAccountVerificationRequiredMessage', () => {
    it('detects "verify your account"', () => {
      expect(isGoogleAccountVerificationRequiredMessage('please verify your account')).toBe(true);
    });

    it('detects "validation_required"', () => {
      expect(isGoogleAccountVerificationRequiredMessage('error: validation_required')).toBe(true);
    });

    it('detects accounts.google.com/signin/continue', () => {
      expect(isGoogleAccountVerificationRequiredMessage('visit accounts.google.com/signin/continue')).toBe(true);
    });

    it('detects support.google.com/accounts?p=al_alert', () => {
      expect(isGoogleAccountVerificationRequiredMessage('see support.google.com/accounts?p=al_alert')).toBe(true);
    });

    it('returns false for unrelated messages', () => {
      expect(isGoogleAccountVerificationRequiredMessage('invalid_token')).toBe(false);
      expect(isGoogleAccountVerificationRequiredMessage('rate limit exceeded')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isGoogleAccountVerificationRequiredMessage('')).toBe(false);
    });
  });

  describe('extractGoogleAccountVerificationUrl', () => {
    it('extracts accounts.google.com URL', () => {
      const msg = 'Please visit https://accounts.google.com/signin/continue?param=value';
      const url = extractGoogleAccountVerificationUrl(msg);
      expect(url).toContain('accounts.google.com');
    });

    it('extracts support.google.com URL', () => {
      const msg = 'See https://support.google.com/accounts?p=al_alert for more info';
      const url = extractGoogleAccountVerificationUrl(msg);
      expect(url).toContain('support.google.com');
    });

    it('normalizes escaped slashes', () => {
      const msg = 'Visit https:\\/\\/accounts.google.com\\/signin';
      const url = extractGoogleAccountVerificationUrl(msg);
      expect(url).toContain('accounts.google.com');
    });

    it('returns null for no URL found', () => {
      expect(extractGoogleAccountVerificationUrl('no url here')).toBeNull();
    });

    it('returns null for empty message', () => {
      expect(extractGoogleAccountVerificationUrl('')).toBeNull();
    });
  });
});
