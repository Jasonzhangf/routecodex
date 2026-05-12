/**
 * Throttle Helpers Unit Tests
 */

import {
  keyFor,
  shouldThrottle,
  updateThrottle,
  inFlight
} from '../../../../src/providers/auth/oauth-lifecycle/throttle.js';

describe('throttle', () => {
  beforeEach(() => {
    // Clear inFlight map between tests by deleting any leftover keys
    for (const k of ['key', 'test-key', 'key1']) {
      inFlight.delete(k);
    }
  });

  describe('keyFor', () => {
    it('creates key from providerType and tokenFile', () => {
      expect(keyFor('qwen', '/path/to/token.json')).toBe('qwen::/path/to/token.json');
    });

    it('handles undefined tokenFile', () => {
      expect(keyFor('qwen')).toBe('qwen::');
    });

    it('handles empty tokenFile', () => {
      expect(keyFor('glm', '')).toBe('glm::');
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
    it('has returns false initially', () => {
      expect(inFlight.has('key')).toBe(false);
    });

    it('set and has work together', () => {
      const promise = Promise.resolve();
      inFlight.set('key', promise);
      expect(inFlight.has('key')).toBe(true);
    });

    it('get returns set promise', async () => {
      const promise = Promise.resolve('value');
      inFlight.set('key', promise);
      expect(inFlight.get('key')).toBe(promise);
    });

    it('delete removes entry', () => {
      inFlight.set('key', Promise.resolve());
      inFlight.delete('key');
      expect(inFlight.has('key')).toBe(false);
    });

    it('inFlight object is exposed', () => {
      expect(inFlight).toBeDefined();
      expect(typeof inFlight.has).toBe('function');
      expect(typeof inFlight.get).toBe('function');
      expect(typeof inFlight.set).toBe('function');
      expect(typeof inFlight.delete).toBe('function');
    });
  });
});
