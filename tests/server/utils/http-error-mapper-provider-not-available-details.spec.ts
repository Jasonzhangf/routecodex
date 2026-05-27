import { describe, expect, it } from '@jest/globals';
import { mapErrorToHttp } from '../../../src/server/utils/http-error-mapper.js';

describe('mapErrorToHttp PROVIDER_NOT_AVAILABLE details passthrough', () => {
  it('preserves safe unavailableProviders details for routing diagnosis', () => {
    const mapped = mapErrorToHttp({
      message: 'No available providers after applying routing instructions',
      code: 'PROVIDER_NOT_AVAILABLE',
      requestId: 'req_provider_not_available_details',
      details: {
        candidateProviderCount: 1,
        candidateProviderKeys: ['sdfv.key1.gpt-5.4'],
        unavailableProviders: [
          {
            providerKey: 'sdfv.key1.gpt-5.4',
            reason: 'health_cooldown',
            health: {
              state: 'cooldown',
              failureCount: 3
            }
          }
        ],
        recoverableCooldownHints: [
          {
            providerKey: 'sdfv.key1.gpt-5.4',
            waitMs: 1800000
          }
        ],
        minRecoverableCooldownMs: 1800000,
        __rt: { secret: true }
      }
    });

    expect(mapped.status).toBe(502);
    expect(mapped.body.error.code).toBe('PROVIDER_NOT_AVAILABLE');
    expect(mapped.body.error).toMatchObject({
      request_id: 'req_provider_not_available_details'
    });
    expect((mapped.body.error as Record<string, unknown>).details).toMatchObject({
      candidateProviderCount: 1,
      candidateProviderKeys: ['sdfv.key1.gpt-5.4'],
      unavailableProviders: [
        expect.objectContaining({
          providerKey: 'sdfv.key1.gpt-5.4',
          reason: 'health_cooldown'
        })
      ],
      recoverableCooldownHints: [
        expect.objectContaining({
          providerKey: 'sdfv.key1.gpt-5.4',
          waitMs: 1800000
        })
      ],
      minRecoverableCooldownMs: 1800000
    });
    expect((mapped.body.error as Record<string, unknown>).details).not.toHaveProperty('__rt');
  });

  it('RED: strips internal metadata/auth/requestContext payloads from public details', () => {
    const mapped = mapErrorToHttp({
      message: 'HTTP 400: invalid image format',
      code: 'HTTP_400',
      requestId: 'req_public_detail_sanitize',
      providerKey: 'mimo.key1.mimo-v2.5',
      providerType: 'anthropic',
      routeName: 'multimodal',
      details: {
        status: 400,
        providerKey: 'mimo.key1.mimo-v2.5',
        routeName: 'multimodal',
        endpoint: '/v1/responses',
        metadata: {
          __rt: { secret: true },
          allowedProviders: ['sdfv', 'mimo', 'mini27']
        },
        requestContext: {
          providerProtocol: 'anthropic-messages',
          target: {
            auth: {
              type: 'apiKey',
              value: 'super-secret-token'
            }
          }
        },
        target: {
          auth: {
            value: 'super-secret-token'
          },
          providerKey: 'mimo.key1.mimo-v2.5'
        },
        response: {
          status: 400,
          data: {
            error: {
              code: 'HTTP_400',
              message: 'invalid image format'
            }
          }
        },
        rawError: '{"secret":true}',
        rawErrorSnippet: '{"secret":true}',
        __rt: { secret: true }
      }
    });

    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe('HTTP_400');
    expect((mapped.body.error as Record<string, unknown>).details).toMatchObject({
      status: 400,
      providerKey: 'mimo.key1.mimo-v2.5',
      routeName: 'multimodal',
      endpoint: '/v1/responses'
    });
    expect((mapped.body.error as Record<string, unknown>).details).not.toHaveProperty('metadata');
    expect((mapped.body.error as Record<string, unknown>).details).not.toHaveProperty('requestContext');
    expect((mapped.body.error as Record<string, unknown>).details).not.toHaveProperty('target');
    expect((mapped.body.error as Record<string, unknown>).details).not.toHaveProperty('response');
    expect((mapped.body.error as Record<string, unknown>).details).not.toHaveProperty('rawError');
    expect((mapped.body.error as Record<string, unknown>).details).not.toHaveProperty('rawErrorSnippet');
    expect((mapped.body.error as Record<string, unknown>).details).not.toHaveProperty('__rt');
    expect(JSON.stringify((mapped.body.error as Record<string, unknown>).details)).not.toContain('super-secret-token');
  });
});
