import { describe, expect, it } from '@jest/globals';
import {
  buildProviderHttpRequestBody,
  resolveProviderWantsUpstreamSse
} from '../../../../src/providers/core/runtime/provider-request-shaping-utils.js';
import { ProviderRequestPreprocessor } from '../../../../src/providers/core/runtime/provider-request-preprocessor.js';
import { OpenAIChatProtocolClient } from '../../../../src/client/openai/chat-protocol-client.js';
import { ResponsesProtocolClient } from '../../../../src/client/responses/responses-protocol-client.js';

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

  it('preprocesses relay requests before OpenAI chat protocol body build so metadata never reaches provider wire', () => {
    const processedRequest = ProviderRequestPreprocessor.preprocess({
      model: 'gpt-5.4',
      data: {
        model: 'gpt-5.4',
        metadata: { sessionId: 'sess' },
        messages: [{ role: 'user', content: 'hi' }]
      },
      metadata: { entryEndpoint: '/v1/responses' },
      client_metadata: { session_id: 'sess' }
    });

    const body = buildProviderHttpRequestBody({
      request: processedRequest,
      protocolClient: new OpenAIChatProtocolClient()
    });

    expect(body.metadata).toBeUndefined();
    expect(body.client_metadata).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('preprocesses direct responses requests before Responses protocol body build so metadata never reaches provider wire', () => {
    const processedRequest = ProviderRequestPreprocessor.preprocess({
      model: 'gpt-5.5',
      data: {
        model: 'gpt-5.5',
        metadata: { sessionId: 'sess' },
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
      },
      metadata: { entryEndpoint: '/v1/responses' },
      client_metadata: { session_id: 'sess' }
    });

    const body = buildProviderHttpRequestBody({
      request: processedRequest,
      protocolClient: new ResponsesProtocolClient()
    });

    expect(body.metadata).toBeUndefined();
    expect(body.client_metadata).toBeUndefined();
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
  });
});
