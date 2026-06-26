/**
 * Provider business error detection — ErrorErr source input coverage
 *
 * provider_status_2056 must be detected as an explicit provider business error,
 * then handled by the unified ErrorErr01-06 chain. Provider runtime must not
 * consume it with local auto-retry.
 */

import { describe, expect, it } from '@jest/globals';
import { normalizeKnownProviderError } from '../../../../src/providers/core/runtime/provider-error-catalog.js';
import { resolveProviderBusinessResponseError } from '../../../../src/providers/core/runtime/provider-request-shaping-utils.js';

describe('Provider business error detection', () => {
  describe('provider_status_2056 enters unified provider error catalog', () => {
    it('maps MALFORMED_RESPONSE + upstreamCode=provider_status_2056 to recoverable catalog code', () => {
      const error = Object.assign(new Error('[hub_response] Upstream provider returned structured business error at chat_process.response.entry: usage limit exceeded'), {
        code: 'MALFORMED_RESPONSE',
        upstreamCode: 'provider_status_2056',
      });
      const normalized = normalizeKnownProviderError({
        code: error.code,
        upstreamCode: error.upstreamCode,
        message: error.message,
        statusCode: 429,
      });
      expect(normalized?.code).toBe('429.2056');
      expect(normalized?.class).toBe('recoverable');
    });

    it('maps MALFORMED_RESPONSE + upstreamCode=PROVIDER_STATUS_2056 (upper) to recoverable catalog code', () => {
      const error = Object.assign(new Error('business error'), {
        code: 'MALFORMED_RESPONSE',
        upstreamCode: 'PROVIDER_STATUS_2056',
      });
      const normalized = normalizeKnownProviderError({
        code: error.code,
        upstreamCode: error.upstreamCode,
        message: error.message,
        statusCode: 429,
      });
      expect(normalized?.code).toBe('429.2056');
      expect(normalized?.class).toBe('recoverable');
    });

    it('maps HTTP_429_2056 through the provider catalog', () => {
      const error = Object.assign(new Error('business error'), {
        code: 'HTTP_429_2056',
        upstreamCode: 'provider_status_2056',
      });
      const normalized = normalizeKnownProviderError({
        code: error.code,
        upstreamCode: error.upstreamCode,
        message: error.message,
        statusCode: 429,
      });
      expect(normalized?.code).toBe('429.2056');
    });

    it('returns undefined for unrelated upstreamCode', () => {
      const error = Object.assign(new Error('some other error'), {
        code: 'MALFORMED_RESPONSE',
        upstreamCode: 'SOMETHING_ELSE',
      });
      const normalized = normalizeKnownProviderError({
        code: error.code,
        upstreamCode: error.upstreamCode,
        message: error.message,
      });
      expect(normalized).toBeUndefined();
    });
  });

  describe('400 account-pool exhaustion is normalised to quota class', () => {
    it('maps HTTP 400 with "All available accounts exhausted" to INSUFFICIENT_QUOTA', () => {
      const normalized = normalizeKnownProviderError({
        statusCode: 400,
        message: 'All available accounts exhausted',
      });
      expect(normalized?.code).toBe('429.2000');
      expect(normalized?.class).toBe('unrecoverable');
      expect(normalized?.key).toBe('INSUFFICIENT_QUOTA');
    });

    it('does NOT mis-map a generic HTTP 400 without pool/exhaustion hints', () => {
      const normalized = normalizeKnownProviderError({
        statusCode: 400,
        message: 'Invalid request payload: missing field "input"',
      });
      expect(normalized).toBeUndefined();
    });
  });

  describe('resolveProviderBusinessResponseError generically detects business errors', () => {
    it('RED: detects provider errors wrapped in transport data envelope', () => {
      const responseWithDataEnvelope = {
        data: {
          base_resp: {
            status_code: 2056,
            status_msg: 'usage limit exceeded'
          },
          choices: null
        },
        status: 200
      };

      const result = resolveProviderBusinessResponseError({
        response: responseWithDataEnvelope,
        runtimeMetadata: undefined,
        familyProfile: undefined,
      });

      expect(result).toBeInstanceOf(Error);
      expect((result as Record<string, unknown>).upstreamCode).toBe('provider_status_2056');
      expect((result as Record<string, unknown>).code).toBe('MALFORMED_RESPONSE');
    });

    it('detects base_resp.status_code=2056 without family profile', () => {
      const responseWithBusinessError = {
        id: 'resp_123',
        object: 'chat.completion',
        base_resp: {
          status_code: 2056,
          status_message: 'usage limit exceeded'
        }
      };

      const result = resolveProviderBusinessResponseError({
        response: responseWithBusinessError,
        runtimeMetadata: undefined,
        familyProfile: undefined,
      });

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain('usage limit exceeded');
      expect((result as Record<string, unknown>).upstreamCode).toBe('provider_status_2056');
      expect((result as Record<string, unknown>).code).toBe('MALFORMED_RESPONSE');
    });

    it('detects nested error.code=2056 without family profile', () => {
      const responseWithNestedError = {
        error: {
          code: 2056,
          message: 'usage limit exceeded'
        }
      };

      const result = resolveProviderBusinessResponseError({
        response: responseWithNestedError,
        runtimeMetadata: undefined,
        familyProfile: undefined,
      });

      expect(result).toBeInstanceOf(Error);
      expect((result as Record<string, unknown>).upstreamCode).toBe('provider_status_2056');
    });

    it('detects OpenAI-compatible SSE error payload with string type', () => {
      const responseWithOpenAiError = {
        error: {
          message: '',
          type: 'server_error'
        }
      };

      const result = resolveProviderBusinessResponseError({
        response: responseWithOpenAiError,
        runtimeMetadata: undefined,
        familyProfile: undefined,
      });

      expect(result).toBeInstanceOf(Error);
      expect((result as Record<string, unknown>).code).toBe('MALFORMED_RESPONSE');
      expect((result as Record<string, unknown>).upstreamCode).toBe('server_error');
      expect((result as Error).message).toContain('server_error');
    });

    it('detects top-level error_code in response body without family profile', () => {
      const responseWithErrorCode = {
        error_code: 2056,
        error_msg: 'usage limit exceeded'
      };

      const result = resolveProviderBusinessResponseError({
        response: responseWithErrorCode,
        runtimeMetadata: undefined,
        familyProfile: undefined,
      });

      expect(result).toBeInstanceOf(Error);
      expect((result as Record<string, unknown>).upstreamCode).toBe('provider_status_2056');
    });

    it('returns undefined for successful response without business error', () => {
      const successResponse = {
        id: 'resp_123',
        object: 'chat.completion',
        choices: [{ message: { content: 'hello' } }]
      };

      const result = resolveProviderBusinessResponseError({
        response: successResponse,
        runtimeMetadata: undefined,
        familyProfile: undefined,
      });

      expect(result).toBeUndefined();
    });

    it('still delegates to family profile when available', () => {
      const mockProfileError = new Error('profile detected error');
      const mockProfile = {
        id: 'test',
        providerFamily: 'test',
        resolveBusinessResponseError: () => mockProfileError,
      };

      const response = { base_resp: { status_code: 2056, status_message: 'test' } };
      const result = resolveProviderBusinessResponseError({
        response,
        runtimeMetadata: undefined,
        familyProfile: mockProfile,
      });

      // Family profile takes priority
      expect(result).toBe(mockProfileError);
    });
  });
});
