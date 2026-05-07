import { describe, expect, it } from '@jest/globals';
import {
  buildProviderLabel,
  normalizeProviderResponse
} from '../../../../../src/server/runtime/http-server/executor/provider-response-utils';

describe('buildProviderLabel', () => {
  it('deduplicates model suffix when providerKey already ends with model', () => {
    const label = buildProviderLabel('crs.key2.gpt-5.3-codex', 'gpt-5.3-codex');
    expect(label).toBe('crs.key2.gpt-5.3-codex');
  });

  it('keeps appending model when providerKey does not include model', () => {
    const label = buildProviderLabel('crs.key2', 'gpt-5.3-codex');
    expect(label).toBe('crs.key2.gpt-5.3-codex');
  });

  it('preserves provider response metadata for downstream usage extraction', () => {
    const normalized = normalizeProviderResponse({
      status: 200,
      data: { ok: true },
      metadata: {
        usage: {
          usageMetadata: {
            promptTokenCount: 8,
            candidatesTokenCount: 3,
            totalTokenCount: 11
          }
        }
      }
    });

    expect(normalized.metadata).toEqual({
      usage: {
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 3,
          totalTokenCount: 11
        }
      }
    });
  });
});
