import { describe, expect, it } from '@jest/globals';
import {
  buildProviderLabel,
  extractClientModelId,
  normalizeProviderResponse
} from '../../../../../src/server/runtime/http-server/executor/provider-response-utils';
import { resolveProviderRequestContext } from '../../../../../src/server/runtime/http-server/executor/provider-request-context';
import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

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

  it('prefers target modelId over clientModelId for provider request context label', () => {
    const mergedMetadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(mergedMetadata);
    center.writeProviderObservation(
      'modelId',
      'gpt-5.4',
      {
        module: 'tests/server/runtime/http-server/executor/provider-response-utils.spec.ts',
        symbol: 'prefers target modelId over clientModelId for provider request context label',
        stage: 'test'
      }
    );
    center.writeProviderObservation(
      'clientModelId',
      'gpt-5.5',
      {
        module: 'tests/server/runtime/http-server/executor/provider-response-utils.spec.ts',
        symbol: 'prefers target modelId over clientModelId for provider request context label',
        stage: 'test'
      }
    );

    const resolved = resolveProviderRequestContext({
      providerRequestId: 'req_test',
      entryEndpoint: '/v1/responses',
      target: {
        providerKey: 'XL.key1.gpt-5.4',
        outboundProfile: 'openai-responses'
      },
      handle: {
        providerProtocol: 'openai-responses',
        providerId: 'XL'
      } as never,
      runtimeKey: 'XL',
      providerPayload: {},
      mergedMetadata
    });

    expect(resolved.providerModel).toBe('gpt-5.4');
    expect(resolved.providerLabel).toBe('XL.key1.gpt-5.4');
    expect(resolved.requestId).toBe('req_test');
  });

  it('extractClientModelId reads MetadataCenter provider observation before original request fields', () => {
    const metadata: Record<string, unknown> = {};
    const center = MetadataCenter.attach(metadata);
    center.writeProviderObservation(
      'clientModelId',
      'gpt-5.5-client',
      {
        module: 'tests/server/runtime/http-server/executor/provider-response-utils.spec.ts',
        symbol: 'extractClientModelId reads MetadataCenter provider observation before original request fields',
        stage: 'test'
      }
    );

    const resolved = extractClientModelId(metadata, {
      model: 'should-not-win'
    });

    expect(resolved).toBe('gpt-5.5-client');
  });
});
