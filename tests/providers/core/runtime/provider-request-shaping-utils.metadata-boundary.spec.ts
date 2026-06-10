import { describe, expect, it } from '@jest/globals';
import {
  buildProviderHttpRequestBody,
  resolveProviderWantsUpstreamSse
} from '../../../../src/providers/core/runtime/provider-request-shaping-utils.js';
import { ProviderRequestPreprocessor } from '../../../../src/providers/core/runtime/provider-request-preprocessor.js';

const protocolClient = {
  buildRequestBody: () => ({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }] }),
  resolveEndpoint: (_request: unknown, defaultEndpoint: string) => defaultEndpoint,
  finalizeHeaders: (headers: Record<string, string>) => headers
};

describe('provider outbound metadata boundary', () => {
  it('fails fast when a protocol client returns provider body metadata', () => {
    expect(() => buildProviderHttpRequestBody({
      request: { model: 'gpt-5.4', messages: [] },
      protocolClient: {
        ...protocolClient,
        buildRequestBody: () => ({ model: 'gpt-5.4', messages: [], metadata: { leak: true } })
      }
    })).toThrow(/metadata is not allowed in provider outbound body/);
  });

  it('fails fast when a family profile returns provider body metadata', () => {
    expect(() => buildProviderHttpRequestBody({
      request: { model: 'gpt-5.4', messages: [] },
      protocolClient,
      familyProfile: {
        id: 'test/profile',
        providerFamily: 'test',
        buildRequestBody: () => ({ model: 'gpt-5.4', messages: [], metadata: { leak: true } })
      } as any
    })).toThrow(/familyProfile\.buildRequestBody/);
  });

  it('allows runtime metadata to drive stream intent without entering provider body', () => {
    const body = buildProviderHttpRequestBody({
      request: { model: 'gpt-5.4', messages: [], metadata: { stream: true } },
      protocolClient,
      runtimeMetadata: { metadata: { outboundStream: true } }
    });

    expect(body).toEqual({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true
    });
  });

  it('preserves positive SSE intent when a generated provider payload carries stream false', () => {
    const runtimeMetadata = { metadata: {} as Record<string, unknown> };
    const processedRequest = ProviderRequestPreprocessor.preprocess({
      model: 'gpt-5.4',
      messages: [],
      stream: false,
      metadata: {
        outboundStream: true
      }
    }, runtimeMetadata);

    expect(runtimeMetadata.metadata.stream).toBe(true);
    expect(resolveProviderWantsUpstreamSse({
      request: processedRequest,
      context: { metadata: { outboundStream: true } } as any,
      runtimeMetadata
    })).toBe(true);

    const body = buildProviderHttpRequestBody({
      request: processedRequest,
      protocolClient: {
        ...protocolClient,
        buildRequestBody: () => ({ model: 'gpt-5.4', messages: [], stream: false })
      },
      runtimeMetadata
    });

    expect(body).toEqual({
      model: 'gpt-5.4',
      messages: [],
      stream: true
    });
  });
});
