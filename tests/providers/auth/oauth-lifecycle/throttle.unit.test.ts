/**
 * Throttle Helpers Unit Tests
 */

import {
  keyFor,
  shouldThrottle,
  updateThrottle,
  getInFlight,
  setInFlight,
  deleteInFlight,
  hasInFlight,
  getInFlightPromise
} from '../../../../src/providers/auth/oauth-lifecycle/throttle.js';

describe('throttle', () => {
  beforeEach(() => {
    // Clear inFlight map between tests
    getInFlight().clear();
  });

  describe('keyFor', () => {
    it('creates key from providerType and tokenFile', () => {
      expect(keyFor('qwen', '/path/to/token.json')).toBe('qwen::/path/to/token.json');
    });

    it('handles undefined tokenFile', () => {
      expect(keyFor('qwen')).toBe('qwen::');
    });

    it('handles empty tokenFile', () => {
      expect(keyFor('iflow', '')).toBe('iflow::');
    });
  });

  describe('shouldThrottle', () => {
    it('returns false initially', () => {
      expect(shouldThrottle('test-key')).toBe(false);
    });

    it('returns true after updateThrottle', () => {
      updateThrottle('test-key');
      expect(shouldThrottle('test-key')).toBe(true);
    });

    it('returns false after throttle period expires', () => {
      updateThrottle('test-key');
      expect(shouldThrottle('test-key', 0)).toBe(false);
    });
  });

  describe('updateThrottle', () => {
    it('updates lastRunAt timestamp', () => {
      updateThrottle('key1');
      expect(shouldThrottle('key1')).toBe(true);
    });
  });

  describe('inFlight operations', () => {
    it('hasInFlight returns false initially', () => {
      expect(hasInFlight('key')).toBe(false);
    });

    it('setInFlight and hasInFlight work together', () => {
      const promise = Promise.resolve();
      setInFlight('key', promise);
      expect(hasInFlight('key')).toBe(true);
    });

    it('getInFlightPromise returns set promise', async () => {
      const promise = Promise.resolve('value');
      setInFlight('key', promise);
      expect(getInFlightPromise('key')).toBe(promise);
    });

    it('deleteInFlight removes entry', () => {
      setInFlight('key', Promise.resolve());
      deleteInFlight('key');
      expect(hasInFlight('key')).toBe(false);
    });

    it('getInFlight returns the map', () => {
      const map = getInFlight();
      expect(map).toBeInstanceOf(Map);
    });
  });
});
