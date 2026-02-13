import { describe, expect, it } from '@jest/globals';

import {
  encodeClockClientApiKey,
  extractClockClientDaemonIdFromApiKey,
  matchesExpectedClientApiKey
} from '../../src/utils/clock-client-token.js';

describe('clock client token helpers', () => {
  it('encodes and extracts daemon id suffix', () => {
    const encoded = encodeClockClientApiKey('sk-base', 'clockd_abc-123');
    expect(encoded).toBe('sk-base::rcc-clockd:clockd_abc-123');
    expect(extractClockClientDaemonIdFromApiKey(encoded)).toBe('clockd_abc-123');
  });

  it('matches plain and daemon-suffixed api key', () => {
    expect(matchesExpectedClientApiKey('sk-base', 'sk-base')).toBe(true);
    expect(matchesExpectedClientApiKey('sk-base::rcc-clockd:clockd_x', 'sk-base')).toBe(true);
    expect(matchesExpectedClientApiKey('sk-base::rcc-clockd:', 'sk-base')).toBe(false);
    expect(matchesExpectedClientApiKey('sk-other::rcc-clockd:clockd_x', 'sk-base')).toBe(false);
  });
});
