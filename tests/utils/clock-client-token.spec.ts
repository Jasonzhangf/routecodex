import { describe, expect, it } from '@jest/globals';

import {
  encodeClockClientApiKey,
  extractClockClientDaemonIdFromApiKey,
  extractClockClientTmuxSessionIdFromApiKey,
  matchesExpectedClientApiKey
} from '../../src/utils/clock-client-token.js';

describe('clock client api key token codec', () => {
  it('encodes and decodes daemon + tmux suffix', () => {
    const encoded = encodeClockClientApiKey('sk-base', 'clockd_test_1', 'rcc_codex_test_1');
    expect(encoded).toContain('::rcc-clockd:clockd_test_1');
    expect(encoded).toContain('::rcc-tmux:rcc_codex_test_1');
    expect(extractClockClientDaemonIdFromApiKey(encoded)).toBe('clockd_test_1');
    expect(extractClockClientTmuxSessionIdFromApiKey(encoded)).toBe('rcc_codex_test_1');
  });

  it('keeps daemon parsing stable when tmux suffix exists', () => {
    const encoded = 'sk-base::rcc-clockd:clockd_keep::rcc-tmux:rcc_codex_keep';
    expect(extractClockClientDaemonIdFromApiKey(encoded)).toBe('clockd_keep');
  });

  it('accepts suffixed token in expected-key matcher', () => {
    const encoded = encodeClockClientApiKey('sk-base', 'clockd_match_1', 'rcc_codex_match_1');
    expect(matchesExpectedClientApiKey(encoded, 'sk-base')).toBe(true);
  });
});
