import { describe, expect, it } from '@jest/globals';

import {
  encodeSessionClientApiKey,
  extractSessionClientDaemonIdFromApiKey,
  extractSessionClientScopeIdFromApiKey,
  matchesExpectedClientApiKey
} from '../../src/utils/session-client-token.js';

describe('session client api key token codec', () => {
  it('encodes and decodes daemon + tmux suffix', () => {
    const encoded = encodeSessionClientApiKey('sk-base', 'sessiond_test_1', 'rcc_codex_test_1');
    expect(encoded).toContain('::rcc-sessiond:sessiond_test_1');
    expect(encoded).toContain('::rcc-session:rcc_codex_test_1');
    expect(extractSessionClientDaemonIdFromApiKey(encoded)).toBe('sessiond_test_1');
    expect(extractSessionClientScopeIdFromApiKey(encoded)).toBe('rcc_codex_test_1');
  });

  it('keeps daemon parsing stable when tmux suffix exists', () => {
    const encoded = 'sk-base::rcc-sessiond:sessiond_keep::rcc-session:rcc_codex_keep';
    expect(extractSessionClientDaemonIdFromApiKey(encoded)).toBe('sessiond_keep');
  });

  it('accepts suffixed token in expected-key matcher', () => {
    const encoded = encodeSessionClientApiKey('sk-base', 'sessiond_match_1', 'rcc_codex_match_1');
    expect(matchesExpectedClientApiKey(encoded, 'sk-base')).toBe(true);
  });
});
