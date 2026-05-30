/**
 * Auto-Retry Business Error Detection — 绿测
 *
 * 验证: provider_status_2056 这类业务错误在 provider 层是否被检测并触发自动重试。
 * 修复后: resolveProviderBusinessResponseError 在没有 family profile 时也能检测
 * base_resp.status_code / error.code / error_code 等通用业务错误模式，返回 Error。
 * 错误在 sendRequestInternal 内部被抛出 → BaseProvider.sendRequest() catch 块捕获
 * → 自动重试拦截器生效。
 */

import { describe, expect, it } from '@jest/globals';
import { resolveAutoRetryErrorCode } from '../../../../src/providers/core/runtime/auto-retry-error-codes.js';
import { resolveProviderBusinessResponseError } from '../../../../src/providers/core/runtime/provider-request-shaping-utils.js';

describe('Auto-retry business error detection', () => {
  describe('resolveAutoRetryErrorCode maps provider_status_2056', () => {
    it('maps MALFORMED_RESPONSE + upstreamCode=provider_status_2056 to 0.8200', () => {
      const error = Object.assign(new Error('[hub_response] Upstream provider returned structured business error at chat_process.response.entry: usage limit exceeded'), {
        code: 'MALFORMED_RESPONSE',
        upstreamCode: 'provider_status_2056',
      });
      const code = resolveAutoRetryErrorCode(error);
      expect(code).toBe('0.8200');
    });

    it('maps MALFORMED_RESPONSE + upstreamCode=PROVIDER_STATUS_2056 (upper) to 0.8200', () => {
      const error = Object.assign(new Error('business error'), {
        code: 'MALFORMED_RESPONSE',
        upstreamCode: 'PROVIDER_STATUS_2056',
      });
      const code = resolveAutoRetryErrorCode(error);
      expect(code).toBe('0.8200');
    });

    it('maps HTTP_429_2056 to 0.8200 before catalog normalization', () => {
      const error = Object.assign(new Error('business error'), {
        code: 'HTTP_429_2056',
        upstreamCode: 'provider_status_2056',
      });
      const code = resolveAutoRetryErrorCode(error);
      expect(code).toBe('0.8200');
    });

    it('returns undefined for unrelated upstreamCode', () => {
      const error = Object.assign(new Error('some other error'), {
        code: 'MALFORMED_RESPONSE',
        upstreamCode: 'SOMETHING_ELSE',
      });
      const code = resolveAutoRetryErrorCode(error);
      expect(code).toBeUndefined();
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
