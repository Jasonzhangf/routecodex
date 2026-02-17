import { describe, expect, it } from '@jest/globals';
import { buildProviderLabel } from '../../../../../src/server/runtime/http-server/executor/provider-response-utils';

describe('buildProviderLabel', () => {
  it('deduplicates model suffix when providerKey already ends with model', () => {
    const label = buildProviderLabel('crs.key2.gpt-5.3-codex', 'gpt-5.3-codex');
    expect(label).toBe('crs.key2.gpt-5.3-codex');
  });

  it('keeps appending model when providerKey does not include model', () => {
    const label = buildProviderLabel('crs.key2', 'gpt-5.3-codex');
    expect(label).toBe('crs.key2.gpt-5.3-codex');
  });
});
